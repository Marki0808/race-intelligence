import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createGeoEnrichment, getRouteBoundingBoxes, isUsefulBoundingBox, normalizeOsmTags, thinRouteForMatching } from "./geoEnrichment.ts";
import { analyzeGpxRoute, parseGpxText } from "./gpxAnalysis.ts";
import { buildOverpassQuery, enrichRouteWithOsm, parseOverpassWays } from "./geoEnrichmentService.ts";
import { POST as postGeoEnrichment } from "./api/geo-enrichment/route.ts";

const fixtures = [
  { id: 101, type: "way", tags: { highway: "track", surface: "gravel", tracktype: "grade2" }, geometry: [{ lat: 45, lon: 0 }, { lat: 45, lon: 0.002 }] },
  { id: 102, type: "way", tags: { highway: "track", surface: "gravel", tracktype: "grade2" }, geometry: [{ lat: 45, lon: 0.002 }, { lat: 45, lon: 0.004 }] },
  { id: 103, type: "way", tags: { highway: "path", surface: "dirt", sac_scale: "hiking" }, geometry: [{ lat: 45, lon: 0.004 }, { lat: 45, lon: 0.006 }] },
  { id: 104, type: "way", tags: { highway: "residential", surface: "asphalt", smoothness: "good" }, geometry: [{ lat: 45, lon: 0.006 }, { lat: 45, lon: 0.008 }] },
  { id: 105, type: "way", tags: { highway: "path", trail_visibility: "good", incline: "10%", width: "1", informal: "yes", trailblazed: "yes", assisted_trail: "no" }, geometry: [{ lat: 45, lon: 0.008 }, { lat: 45, lon: 0.01 }] },
];
const route = Array.from({ length: 11 }, (_, index) => ({
  latitude: 45,
  longitude: index / 1000,
  distanceM: index * 100,
}));

test("normalizes OSM tags without collapsing their meanings or provenance", () => {
  const normalized = normalizeOsmTags({ highway: "track", surface: "gravel", tracktype: "grade2", sac_scale: "mountain_hiking" });
  assert.deepEqual(normalized.surface, { value: "gravel", rawValue: "gravel", provenance: "osm", availability: "available" });
  assert.equal(normalized.pathType.value, "track");
  assert.equal(normalized.trackCondition.value, "grade2");
  assert.equal(normalized.hikingDifficulty.value, "mountain_hiking");
  assert.equal(normalized.surface.provenance, "osm");
});

test("missing surface, sac_scale, and trail_visibility remain not-found OSM evidence", () => {
  const normalized = normalizeOsmTags({ highway: "path" });
  for (const key of ["surface", "hikingDifficulty", "trailVisibility"]) {
    assert.equal(normalized[key].value, null);
    assert.equal(normalized[key].availability, "not-found");
    assert.equal(normalized[key].provenance, "osm");
  }
});

test("builds route sections from tag changes and merges adjacent ways with matching tags", () => {
  const data = createGeoEnrichment(route, fixtures);
  assert.equal(data.availability, "available");
  assert.equal(data.matchedRoutePercent, 100);
  assert.equal(data.segments[0].surface.value, "gravel");
  assert.equal(data.segments[0].trackCondition.value, "grade2");
  assert.equal(data.segments[0].osmWays.length, 2);
  assert.equal(data.segments[0].osmWays[0].sourceId, "way/101");
  assert.deepEqual(data.segments[0].osmWays[0].geometry[0], { latitude: 45, longitude: 0 });
  assert.deepEqual(data.source, { type: "osm", name: "OpenStreetMap", attribution: "© OpenStreetMap contributors" });
  assert.equal(data.segments[1].pathType.value, "path");
  assert.equal(data.segments[1].hikingDifficulty.value, "hiking");
  assert.equal(data.segments[2].surface.value, "asphalt");
  assert.equal(data.segments[3].surface.availability, "not-found");
  assert.equal(data.segments[3].trailVisibility.value, "good");
  assert.equal(data.segments[3].incline.value, "10%");
  assert.equal(data.segments[3].width.value, "1");
  assert.equal(data.segments[3].informal.value, "yes");
  assert.equal(data.segments[3].trailblazed.value, "yes");
  assert.equal(data.segments[3].assistedTrail.value, "no");
  assert.ok(data.segments[0].lengthKm > 0);
});

test("keeps no-match values unknown and partial matches by route distance", () => {
  const shifted = route.map((point) => ({ ...point, latitude: point.latitude + 0.01 }));
  const missing = createGeoEnrichment(shifted, fixtures);
  assert.equal(missing.availability, "not-found");
  assert.equal(missing.segments[0].surface.availability, "unknown");
  assert.equal(missing.matchedRoutePercent, 0);

  const partial = createGeoEnrichment(route, [fixtures[0]]);
  assert.ok(partial.matchedRoutePercent > 0 && partial.matchedRoutePercent < 100);
  assert.ok(partial.segments.some((segment) => segment.surface.availability === "unknown"));
});

test("ambiguous nearby ways preserve raw alternatives and do not claim a surface", () => {
  const parallel = {
    id: 999,
    type: "way",
    tags: { highway: "path", surface: "rock" },
    geometry: [{ lat: 45.00002, lon: 0 }, { lat: 45.00002, lon: 0.01 }],
  };
  const data = createGeoEnrichment(route, [fixtures[0], parallel]);
  assert.ok(data.segments[0].osmWays.length >= 2);
  assert.equal(data.segments[0].matchQuality, "moderate");
  assert.equal(data.segments[0].surface.availability, "unknown");
});

test("builds an Overpass query with the Istria GPX bounds in south,west,north,east order", () => {
  const gpx = parseGpxText(readFileSync(new URL("../public/ISTRIA_110K_2027.gpx", import.meta.url), "utf8"));
  const routeAnalysis = analyzeGpxRoute(gpx);
  const boxes = getRouteBoundingBoxes(thinRouteForMatching(routeAnalysis.points));
  assert.equal(boxes.length, 28);
  assert.equal(boxes.every(isUsefulBoundingBox), true);
  const query = buildOverpassQuery(boxes);
  assert.match(query, /^\[out:json\]\[timeout:20\];\(/);
  assert.match(query, /way\["highway"~"\^\(path\|track/);
  assert.match(query, /\);out tags geom;$/);
  assert.equal((query.match(/way\["highway"/g) ?? []).length, boxes.length);
});

test("parses actual Overpass JSON way geometry in latitude/longitude order", () => {
  const ways = parseOverpassWays({
    elements: [{
      type: "way",
      id: 456,
      tags: { highway: "track", surface: "gravel" },
      geometry: [{ lat: 45.4, lon: 13.9 }, { lat: 45.401, lon: 13.901 }],
    }],
  });
  assert.deepEqual(ways[0], {
    id: 456,
    type: "way",
    tags: { highway: "track", surface: "gravel" },
    geometry: [{ lat: 45.4, lon: 13.9 }, { lat: 45.401, lon: 13.901 }],
  });
  const matched = createGeoEnrichment([
    { latitude: 45.4, longitude: 13.9, distanceM: 0 },
    { latitude: 45.401, longitude: 13.901, distanceM: 100 },
  ], ways);
  assert.equal(matched.availability, "available");
  assert.equal(matched.segments[0].surface.value, "gravel");
});

test("rejects malformed Overpass ways instead of silently treating them as no coverage", () => {
  assert.throws(() => parseOverpassWays({ elements: [{ type: "way", id: 1, tags: { highway: "path" } }] }), /Malformed Overpass way geometry/);
});

test("uses the 35 metre match tolerance and rejects geometry beyond it", () => {
  const point = { latitude: 45, longitude: 0, distanceM: 0 };
  const endpoint = { latitude: 45, longitude: 0.01, distanceM: 1000 };
  const closeWay = { id: 1, type: "way", tags: { highway: "path", surface: "dirt" }, geometry: [{ lat: 45.0002, lon: 0 }, { lat: 45.0002, lon: 0.01 }] };
  const distantWay = { ...closeWay, id: 2, geometry: [{ lat: 45.0005, lon: 0 }, { lat: 45.0005, lon: 0.01 }] };
  assert.equal(createGeoEnrichment([point, endpoint], [closeWay]).availability, "available");
  assert.equal(createGeoEnrichment([point, endpoint], [distantWay]).availability, "not-found");
});

test("the route API returns matched OSM evidence and a non-cacheable API response", async (context) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    elements: [{
      type: "way",
      id: 789,
      tags: { highway: "track", surface: "gravel" },
      geometry: [{ lat: 45, lon: 0 }, { lat: 45, lon: 0.001 }],
    }],
  }), { status: 200, headers: { "Content-Type": "application/json" } });
  context.after(() => { globalThis.fetch = originalFetch; });

  const request = new Request("http://localhost/api/geo-enrichment", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ points: [
      { latitude: 45, longitude: 0, distanceM: 0 },
      { latitude: 45, longitude: 0.001, distanceM: 100 },
    ] }),
  });
  const response = await postGeoEnrichment(request);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(body.availability, "available");
  assert.equal(body.matchedRoutePercent, 100);
  assert.equal(body.segments[0].surface.value, "gravel");
});

test("the full Istria route reaches Overpass instead of hitting the route-window guard", async (context) => {
  const originalFetch = globalThis.fetch;
  let query = "";
  const gpx = parseGpxText(readFileSync(new URL("../public/ISTRIA_110K_2027.gpx", import.meta.url), "utf8"));
  const analysis = analyzeGpxRoute(gpx);
  const routePoints = thinRouteForMatching(analysis.points);
  globalThis.fetch = async (_input, init) => {
    query = new URLSearchParams(String(init?.body)).get("data") ?? "";
    return new Response(JSON.stringify({
      elements: [{
        type: "way",
        id: 9001,
        tags: { highway: "path", surface: "gravel" },
        geometry: routePoints.slice(0, 20).map((point) => ({ lat: point.latitude, lon: point.longitude })),
      }],
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  context.after(() => { globalThis.fetch = originalFetch; });

  const result = await enrichRouteWithOsm(routePoints);
  assert.equal((query.match(/way\["highway"/g) ?? []).length, 28);
  assert.ok(result.matchedRoutePercent > 0);
  assert.ok(result.segments.some((segment) => segment.osmWays.some((way) => way.sourceId === "way/9001")));
  assert.notEqual(result.note, "The route covers too large an area for a safe OSM query.");
});
