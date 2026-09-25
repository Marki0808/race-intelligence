import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { aggregateTerrainEvidence, classifyOsmSurface } from "./terrainAggregation.ts";
import { analyzeGpxRoute, parseGpxText } from "./gpxAnalysis.ts";

function makeData(runs, { availability = "available", matchedRoutePercent = 100 } = {}) {
  const segments = [];
  for (const run of runs) {
    const count = run.count ?? Math.max(1, Math.round((run.end - run.start) / 0.2));
    const surface = run.surface ?? null;
    const coverage = run.coverage ?? 1;
    for (let index = 0; index < count; index += 1) {
      const start = run.start + ((run.end - run.start) * index) / count;
      const end = run.start + ((run.end - run.start) * (index + 1)) / count;
      const surfaceValue = {
        value: surface,
        rawValue: surface,
        provenance: "osm",
        availability: surface ? "available" : run.surfaceAvailability ?? "not-found",
      };
      const empty = { value: null, rawValue: null, provenance: "osm", availability: "not-found" };
      segments.push({
        id: `segment-${segments.length + 1}`,
        startDistanceKm: start,
        endDistanceKm: end,
        lengthKm: end - start,
        evidenceCoverage: coverage,
        matchQuality: run.matchQuality ?? "high",
        osmWays: surface ? [{
          source: "OpenStreetMap",
          sourceId: `way/${segments.length + 1}`,
          tags: { surface },
          geometry: [],
          startDistanceKm: start,
          endDistanceKm: end,
          matchQuality: "high",
        }] : [],
        surface: surfaceValue,
        pathType: empty,
        trackCondition: empty,
        smoothness: empty,
        hikingDifficulty: empty,
        trailVisibility: empty,
        incline: empty,
        width: empty,
        informal: empty,
        trailblazed: empty,
        assistedTrail: empty,
      });
    }
  }
  return {
    source: { type: "osm", name: "OpenStreetMap", attribution: "© OpenStreetMap contributors" },
    availability,
    segments,
    matchedRoutePercent,
    attribution: "© OpenStreetMap contributors",
  };
}

test("classifies only explicit surface evidence and preserves unknown tags", () => {
  assert.equal(classifyOsmSurface("gravel"), "gravel");
  assert.equal(classifyOsmSurface("gravel;rock"), "mixed-trail");
  assert.equal(classifyOsmSurface(null), "unknown");
  assert.equal(classifyOsmSurface("path"), "unknown");
});

test("aggregates constant surface evidence into one meaningful section", () => {
  const result = aggregateTerrainEvidence(makeData([{ start: 0, end: 12, surface: "gravel" }]));
  assert.equal(result.sections.length, 1);
  assert.equal(result.sections[0].dominantTerrain, "gravel");
  assert.equal(result.sections[0].startDistanceKm, 0);
  assert.equal(result.sections[0].endDistanceKm, 12);
  assert.equal(result.evidenceCoverage, 1);
});

test("retains persistent terrain changes and sequential blocks", () => {
  const result = aggregateTerrainEvidence(makeData([
    { start: 0, end: 5, surface: "gravel" },
    { start: 5, end: 10, surface: "rock" },
    { start: 10, end: 15, surface: "asphalt" },
    { start: 15, end: 20, surface: "gravel" },
  ]));
  assert.deepEqual(result.sections.map((section) => section.dominantTerrain), [
    "gravel", "rocky-rough", "paved", "gravel",
  ]);
});

test("persistent block after short noise resolves to the sustained terrain regimes", () => {
  const result = aggregateTerrainEvidence(makeData([
    { start: 0, end: 3, surface: "gravel" },
    { start: 3, end: 3.2, surface: "asphalt" },
    { start: 3.2, end: 5, surface: "gravel" },
    { start: 5, end: 10, surface: "rock" },
  ]));
  assert.deepEqual(result.sections.map((section) => section.dominantTerrain), ["gravel", "rocky-rough"]);
});

test("smooths a short relative noise run without using a fixed kilometre interval", () => {
  const result = aggregateTerrainEvidence(makeData([
    { start: 0, end: 4, surface: "gravel" },
    { start: 4, end: 4.2, surface: "asphalt" },
    { start: 4.2, end: 9, surface: "gravel" },
  ]));
  assert.equal(result.sections.length, 1);
  assert.equal(result.sections[0].dominantTerrain, "gravel");
  assert.equal(result.sections[0].endDistanceKm, 9);
});

test("uses relative segmentation for both short and long routes", () => {
  const shortRoute = aggregateTerrainEvidence(makeData([
    { start: 0, end: 3, surface: "grass" },
    { start: 3, end: 6, surface: "rock" },
    { start: 6, end: 8, surface: "gravel" },
  ]));
  const longRoute = aggregateTerrainEvidence(makeData([
    { start: 0, end: 100, surface: "gravel" },
    { start: 100, end: 190, surface: "rock" },
    { start: 190, end: 250, surface: "asphalt" },
  ]));
  assert.deepEqual(shortRoute.sections.map((section) => section.dominantTerrain), ["natural-trail", "rocky-rough", "gravel"]);
  assert.deepEqual(longRoute.sections.map((section) => section.dominantTerrain), ["gravel", "rocky-rough", "paved"]);
});

test("reports missing and partial surface coverage without claiming terrain", () => {
  const missing = aggregateTerrainEvidence(makeData([
    { start: 0, end: 5, surface: null, surfaceAvailability: "not-found" },
  ], { availability: "available" }));
  assert.equal(missing.sections[0].dominantTerrain, "unknown");
  assert.equal(missing.sections[0].availability, "not-found");
  assert.equal(missing.evidenceCoverage, 0);

  const partial = aggregateTerrainEvidence(makeData([
    { start: 0, end: 4, surface: "gravel", coverage: 0.5 },
    { start: 4, end: 10, surface: null, surfaceAvailability: "unknown" },
  ]));
  assert.equal(partial.sections.length, 2);
  assert.ok(Math.abs(partial.evidenceCoverage - 0.2) < 0.001);
  const firstSection = partial.sections[0];
  const supportedLength = Math.min(4, firstSection.endDistanceKm) * 0.5;
  assert.ok(Math.abs(firstSection.evidenceCoverage - supportedLength / firstSection.lengthKm) < 0.001);
  assert.equal(partial.sections[1].dominantTerrain, "unknown");
});

test("ignores a short unknown gap between persistent matching terrain", () => {
  const result = aggregateTerrainEvidence(makeData([
    { start: 0, end: 3, surface: "gravel" },
    { start: 3, end: 3.2, surface: null, surfaceAvailability: "unknown" },
    { start: 3.2, end: 6.2, surface: "gravel" },
  ]));
  assert.equal(result.sections.length, 1);
  assert.equal(result.sections[0].dominantTerrain, "gravel");
});

test("retains a long unknown area between supported terrain regimes", () => {
  const result = aggregateTerrainEvidence(makeData([
    { start: 0, end: 3, surface: "gravel" },
    { start: 3, end: 8, surface: null, surfaceAvailability: "unknown" },
    { start: 8, end: 11, surface: "rock" },
  ]));
  assert.deepEqual(result.sections.map((section) => section.dominantTerrain), ["gravel", "unknown", "rocky-rough"]);
});

test("keeps the global mixed summary independent from persistent local sections", () => {
  const result = aggregateTerrainEvidence(makeData([
    { start: 0, end: 4, surface: "gravel" },
    { start: 4, end: 8, surface: "dirt" },
    { start: 8, end: 12, surface: "asphalt" },
  ]));
  assert.equal(result.dominantTerrain, "mixed-trail");
  assert.deepEqual(result.sections.map((section) => section.dominantTerrain), ["gravel", "dirt-ground", "paved"]);
});

test("summarizes diverse local surfaces as mixed while retaining an adjacent persistent change", () => {
  const mixedRuns = Array.from({ length: 20 }, (_, index) => ({
    start: index * 0.2,
    end: (index + 1) * 0.2,
    surface: index % 2 === 0 ? "gravel" : "dirt",
  }));
  const result = aggregateTerrainEvidence(makeData([
    ...mixedRuns,
    { start: 4, end: 8, surface: "asphalt" },
  ]));
  assert.equal(result.sections[0].dominantTerrain, "mixed-trail");
  assert.equal(result.sections.at(-1).dominantTerrain, "paved");
});

test("distance weighting avoids over-segmenting a denser mapped area", () => {
  const result = aggregateTerrainEvidence(makeData([
    { start: 0, end: 6, surface: "gravel", count: 120 },
    { start: 6, end: 12, surface: "rock", count: 3 },
  ]));
  assert.deepEqual(result.sections.map((section) => section.dominantTerrain), ["gravel", "rocky-rough"]);
  assert.equal(result.sections.length, 2);
  assert.ok(result.sections[0].rawEvidenceSegmentIds.length > result.sections[1].rawEvidenceSegmentIds.length);
});

test("reports unknown with no OSM terrain evidence", () => {
  const result = aggregateTerrainEvidence(makeData([], { availability: "unknown", matchedRoutePercent: 0 }));
  assert.equal(result.availability, "unknown");
  assert.equal(result.dominantTerrain, "unknown");
  assert.equal(result.evidenceCoverage, 0);
  assert.deepEqual(result.sections, []);
});

test("Istria GPX length supports multiple local regimes even when its global summary is mixed", () => {
  const gpx = parseGpxText(readFileSync(new URL("../public/ISTRIA_110K_2027.gpx", import.meta.url), "utf8"));
  const routeLengthKm = analyzeGpxRoute(gpx).metrics.distanceKm;
  const proportions = [0, 0.25, 0.5, 0.75, 1];
  const surfaces = ["gravel", "dirt", "gravel", "asphalt"];
  const syntheticEvidence = makeData(surfaces.map((surface, index) => ({
    start: routeLengthKm * proportions[index],
    end: routeLengthKm * proportions[index + 1],
    surface,
  })));
  const result = aggregateTerrainEvidence(syntheticEvidence);
  assert.equal(result.dominantTerrain, "mixed-trail");
  assert.ok(result.sections.length > 1);
  assert.ok(new Set(result.sections.map((section) => section.dominantTerrain)).size > 1);
  assert.equal(result.sections.at(-1).endDistanceKm, Number(routeLengthKm.toFixed(2)));
});

test("explains candidate decisions with distance, local support, and confidence", () => {
  const result = aggregateTerrainEvidence(makeData([
    { start: 0, end: 4, surface: "gravel" },
    { start: 4, end: 4.2, surface: "asphalt" },
    { start: 4.2, end: 8, surface: "gravel" },
  ]));
  assert.ok(result.changePoints.length > 0);
  assert.ok(result.changePoints.every((point) => Number.isFinite(point.distanceKm) && point.support >= 0 && point.support <= 1));
  assert.ok(result.changePoints.some((point) => point.decision === "ignored-as-noise"));
});

test("preserves raw OSM refs, provenance, and the untouched evidence object", () => {
  const input = makeData([{ start: 0, end: 2, surface: "gravel" }]);
  const rawBefore = structuredClone(input);
  const result = aggregateTerrainEvidence(input);
  assert.equal(result.rawEvidence, input);
  assert.deepEqual(input, rawBefore);
  assert.equal(result.sections[0].provenance, "osm-derived");
  assert.equal(result.sections[0].supportingTerrainEvidence[0].provenance, "osm");
  assert.deepEqual(result.sections[0].rawEvidenceSegmentIds, input.segments.map((segment) => segment.id));
  assert.deepEqual(result.sections[0].supportingTerrainEvidence[0].rawSurfaceValues, ["gravel"]);
  assert.match(input.segments[0].osmWays[0].sourceId, /^way\//);
});

test("does not infer terrain from path type or difficulty tags alone", () => {
  const input = makeData([{ start: 0, end: 3, surface: null, surfaceAvailability: "available" }]);
  input.segments[0].pathType = { value: "path", rawValue: "path", provenance: "osm", availability: "available" };
  input.segments[0].hikingDifficulty = { value: "demanding_mountain_hiking", rawValue: "demanding_mountain_hiking", provenance: "osm", availability: "available" };
  const result = aggregateTerrainEvidence(input);
  assert.equal(result.sections[0].dominantTerrain, "unknown");
  assert.equal(result.evidenceCoverage, 0);
});
