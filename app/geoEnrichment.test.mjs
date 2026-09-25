import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createGeoEnrichment, getRouteBoundingBoxes, getRouteCorridorWindows, isUsefulBoundingBox, normalizeOsmTags, thinRouteForMatching } from "./geoEnrichment.ts";
import { analyzeGpxRoute, parseGpxText } from "./gpxAnalysis.ts";
import { buildOverpassQuery, createOverpassCorridorQueries, enrichRouteWithOsm, MAX_CORRIDOR_BOXES_PER_QUERY, MAX_CORRIDOR_QUERIES_PER_ROUTE, mergeOsmWays, parseOverpassWays } from "./geoEnrichmentService.ts";
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

function makeLongRoute(totalKm, startLongitude = 0) {
  return Array.from({ length: totalKm + 1 }, (_, index) => ({
    latitude: 45 + Math.sin(index / 30) * 0.01,
    longitude: startLongitude + index * 0.014,
    distanceM: index * 1000,
  }));
}

function overpassResponse(ways) {
  return new Response(JSON.stringify({ elements: ways }), { status: 200, headers: { "Content-Type": "application/json" } });
}

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
  assert.match(query, /^\[out:json\]\[timeout:8\];\(/);
  assert.match(query, /way\["highway"~"\^\(path\|track/);
  assert.match(query, /\);out tags geom;$/);
  assert.equal((query.match(/way\["highway"/g) ?? []).length, boxes.length);
});

test("splits a short route into one query with bounded corridor boxes", () => {
  const queries = createOverpassCorridorQueries(makeLongRoute(4));
  assert.equal(queries?.length, 1);
  assert.ok(queries[0].boxes.length <= MAX_CORRIDOR_BOXES_PER_QUERY);
  assert.ok(queries[0].boxes.every(isUsefulBoundingBox));
});

test("splits a long route into a bounded number of small corridor queries", () => {
  const routePoints = makeLongRoute(180);
  const windows = getRouteCorridorWindows(routePoints);
  const queries = createOverpassCorridorQueries(routePoints);
  assert.equal(windows.length, 45);
  assert.equal(queries?.length, 6);
  assert.ok(queries.every((query) => query.boxes.length <= MAX_CORRIDOR_BOXES_PER_QUERY));
  assert.ok(queries.every((query) => query.boxes.every(isUsefulBoundingBox)));
  assert.ok(queries.length <= MAX_CORRIDOR_QUERIES_PER_ROUTE);
});

test("each corridor window bounds only its local GPX section", () => {
  const routePoints = makeLongRoute(24);
  const windows = getRouteCorridorWindows(routePoints);
  const wholeRoute = getRouteBoundingBoxes(routePoints, 100, 1)[0];
  assert.ok(windows.length > 1);
  assert.ok(windows.every((window) => window.box.east - window.box.west < wholeRoute.east - wholeRoute.west));
  for (const window of windows) {
    const localPoints = routePoints.filter((point) => point.distanceM / 1000 >= window.startDistanceKm && point.distanceM / 1000 <= window.endDistanceKm);
    assert.ok(localPoints.every((point) => point.latitude >= window.box.south && point.latitude <= window.box.north && point.longitude >= window.box.west && point.longitude <= window.box.east));
  }
});

test("corridor windows overlap by the existing one kilometre tolerance", () => {
  const windows = getRouteCorridorWindows(makeLongRoute(20));
  assert.ok(windows.length > 1);
  for (let index = 1; index < windows.length; index += 1) {
    assert.equal(windows[index - 1].endDistanceKm - windows[index].startDistanceKm, 1);
  }
});

test("refuses routes exceeding the safe corridor budget without making network requests", async (context) => {
  const routePoints = makeLongRoute(205);
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return overpassResponse([]); };
  context.after(() => { globalThis.fetch = originalFetch; });
  assert.ok(getRouteCorridorWindows(routePoints).length > MAX_CORRIDOR_BOXES_PER_QUERY * MAX_CORRIDOR_QUERIES_PER_ROUTE);
  assert.equal(createOverpassCorridorQueries(routePoints), null);
  const result = await enrichRouteWithOsm(routePoints);
  assert.equal(calls, 0);
  assert.equal(result.availability, "unknown");
  assert.match(result.note, /more safe OpenStreetMap corridor queries/);
});

test("deduplicates overlapping OSM ways by identity while preserving combined tags and best geometry", () => {
  const shorter = { id: 42, type: "way", tags: { highway: "path", surface: "dirt" }, geometry: [{ lat: 45, lon: 0 }, { lat: 45, lon: 0.001 }] };
  const longer = { id: 42, type: "way", tags: { highway: "path", tracktype: "grade2" }, geometry: [{ lat: 45, lon: 0 }, { lat: 45, lon: 0.001 }, { lat: 45, lon: 0.002 }] };
  const merged = mergeOsmWays([[shorter], [longer], [{ ...shorter, id: 41 }]]);
  assert.deepEqual(merged.map((way) => way.id), [41, 42]);
  assert.deepEqual(merged[1].tags, { highway: "path", surface: "dirt", tracktype: "grade2" });
  assert.equal(merged[1].geometry.length, 3);
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

test("one short-route query returns OSM evidence through the existing match layer", async (context) => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  const routePoints = makeLongRoute(3, 2);
  globalThis.fetch = async () => {
    calls += 1;
    return overpassResponse([{ type: "way", id: 9201, tags: { highway: "track", surface: "gravel" }, geometry: routePoints.map((point) => ({ lat: point.latitude, lon: point.longitude })) }]);
  };
  context.after(() => { globalThis.fetch = originalFetch; });
  const result = await enrichRouteWithOsm(routePoints);
  assert.equal(calls, 1);
  assert.equal(result.availability, "available");
  assert.ok(result.segments.some((segment) => segment.osmWays.some((way) => way.sourceId === "way/9201")));
});

test("partial corridor success retains real matched ways and reports coverage", async (context) => {
  const originalFetch = globalThis.fetch;
  const routePoints = makeLongRoute(36, 3);
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) return overpassResponse([{ type: "way", id: 9301, tags: { highway: "path", surface: "dirt" }, geometry: routePoints.slice(0, 12).map((point) => ({ lat: point.latitude, lon: point.longitude })) }]);
    return new Response("Overpass unavailable", { status: 504 });
  };
  context.after(() => { globalThis.fetch = originalFetch; });
  const result = await enrichRouteWithOsm(routePoints);
  assert.equal(calls, 2);
  assert.ok(result.matchedRoutePercent > 0);
  assert.ok(result.matchedRoutePercent < 100);
  assert.match(result.note, /partial: 1 of 2 corridor queries succeeded/);
  assert.ok(result.segments.some((segment) => segment.osmWays.some((way) => way.sourceId === "way/9301")));
  assert.ok(result.segments.some((segment) => segment.surface.availability === "unknown"));
});

test("all corridor failures remain unknown and do not fabricate evidence", async (context) => {
  const originalFetch = globalThis.fetch;
  const routePoints = makeLongRoute(36, 4);
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return new Response("temporary failure", { status: 503 }); };
  context.after(() => { globalThis.fetch = originalFetch; });
  const result = await enrichRouteWithOsm(routePoints);
  assert.equal(calls, 2);
  assert.equal(result.availability, "unknown");
  assert.equal(result.matchedRoutePercent, 0);
  assert.equal(result.segments.length, 0);
  assert.match(result.note, /currently unavailable/);
});

test("multiple failures preserve real evidence from successful corridors", async (context) => {
  const originalFetch = globalThis.fetch;
  const routePoints = makeLongRoute(100, 5);
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 2 || calls === 4) return new Response("temporary failure", { status: 502 });
    const start = calls === 1 ? 0 : 48;
    return overpassResponse([{ type: "way", id: 9400 + calls, tags: { highway: "track", surface: "gravel" }, geometry: routePoints.slice(start, start + 12).map((point) => ({ lat: point.latitude, lon: point.longitude })) }]);
  };
  context.after(() => { globalThis.fetch = originalFetch; });
  const result = await enrichRouteWithOsm(routePoints);
  assert.equal(calls, 4);
  assert.ok(result.matchedRoutePercent > 0);
  assert.match(result.note, /partial: 2 of 4 corridor queries succeeded/);
  assert.ok(result.segments.some((segment) => segment.osmWays.length > 0));
});

test("the full Istria route reaches Overpass instead of hitting the route-window guard", async (context) => {
  const originalFetch = globalThis.fetch;
  const queries = [];
  const gpx = parseGpxText(readFileSync(new URL("../public/ISTRIA_110K_2027.gpx", import.meta.url), "utf8"));
  const analysis = analyzeGpxRoute(gpx);
  const routePoints = thinRouteForMatching(analysis.points);
  globalThis.fetch = async (_input, init) => {
    queries.push(new URLSearchParams(String(init?.body)).get("data") ?? "");
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
  assert.equal(queries.length, 4);
  assert.equal(queries.reduce((count, query) => count + (query.match(/way\["highway"/g) ?? []).length, 0), 28);
  assert.ok(queries.every((query) => (query.match(/way\["highway"/g) ?? []).length <= MAX_CORRIDOR_BOXES_PER_QUERY));
  assert.ok(result.matchedRoutePercent > 0);
  assert.ok(result.segments.some((segment) => segment.osmWays.some((way) => way.sourceId === "way/9001")));
  assert.notEqual(result.note, "The route covers too large an area for a safe OSM query.");
});
