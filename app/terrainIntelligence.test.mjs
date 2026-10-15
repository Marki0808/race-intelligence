import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createGeoEnrichment, createUnknownGeoEnrichment } from "./geoEnrichment.ts";
import { analyzeGpxRoute, parseGpxText } from "./gpxAnalysis.ts";
import { attachTerrainEvidenceToRouteSections } from "./routeEvidenceAdapter.ts";
import { getSurfaceEvidencePresentation, getTerrainSectionPresentation } from "./routeSectionPresentation.ts";
import { aggregateTerrainEvidenceV3 } from "./terrainAggregationV3.ts";
import { createOsmSnapshot, mergeOsmEnrichmentRecord } from "./routePersistence.ts";
import { buildTerrainIntelligenceV1 } from "./terrainIntelligence.ts";

const point = (latitude, longitude, distanceM, segmentIndex = 0) => ({ latitude, longitude, distanceM, segmentIndex });
const section = (id, segmentIndex, startM, endM) => ({
  id,
  segmentIndex,
  startKm: startM / 1000,
  endKm: endM / 1000,
  startPosition: { distanceM: startM, segmentIndex },
  endPosition: { distanceM: endM, segmentIndex },
});

function makeTwoComponentEvidence() {
  const points = [
    point(45, 13, 0, 0), point(45, 13.001, 100, 0), point(45, 13.002, 200, 0),
    point(46, 14, 200, 1), point(46, 14.001, 300, 1), point(46, 14.002, 400, 1),
  ];
  const ways = [
    { id: 11, type: "way", tags: { surface: "gravel", highway: "track" }, geometry: [{ lat: 45, lon: 13 }, { lat: 45, lon: 13.002 }] },
    { id: 22, type: "way", tags: { surface: "asphalt", highway: "service" }, geometry: [{ lat: 46, lon: 14 }, { lat: 46, lon: 14.002 }] },
  ];
  return { points, data: createGeoEnrichment(points, ways) };
}

function surfaceCategory(result, category) {
  return result.fields.surface.categories.find((entry) => entry.category === category);
}

test("two disconnected components retain their own raw evidence IDs and section-local terrain", () => {
  const { data } = makeTwoComponentEvidence();
  const sections = [section("section-a", 0, 0, 200), section("section-b", 1, 200, 400)];
  const v3 = aggregateTerrainEvidenceV3(data);
  assert.equal(v3.rawEvidence, data);
  assert.deepEqual(v3.rawEvidence.segments.map((item) => item.segmentIndex), [0, 1]);

  const attached = attachTerrainEvidenceToRouteSections(sections, data);
  const [first, second] = attached.map(({ terrainIntelligenceV1 }) => terrainIntelligenceV1);
  assert.equal(first.sectionId, "section-a");
  assert.equal(first.segmentIndex, 0);
  assert.deepEqual(first.sectionBounds, { startDistanceM: 0, endDistanceM: 200, lengthM: 200 });
  assert.deepEqual(second.sectionBounds, { startDistanceM: 0, endDistanceM: 200, lengthM: 200 });
  assert.equal(surfaceCategory(first, "gravel").supportedDistanceM, 200);
  assert.equal(surfaceCategory(second, "paved").supportedDistanceM, 200);
  assert.equal(surfaceCategory(first, "paved"), undefined);
  assert.equal(surfaceCategory(second, "gravel"), undefined);
  assert.ok(surfaceCategory(second, "paved").osmWayIds.includes("way/22"));
  assert.ok(surfaceCategory(second, "paved").sourceEvidence.some((item) => item.osmWayId === "way/22" && item.rawTags.surface === "asphalt"));
  assert.ok(second.fields.surface.intervals.some((interval) => interval.supportingSamples.some((sample) => sample.distanceM === 0 && sample.nearestWayDistanceM === 0)));
});

test("section clipping splits sample support exactly at the existing Route Section boundary", () => {
  const points = [point(45, 13, 0), point(45, 13.001, 100), point(45, 13.002, 200)];
  const data = createGeoEnrichment(points, [{ id: 1, type: "way", tags: { surface: "gravel" }, geometry: [{ lat: 45, lon: 13 }, { lat: 45, lon: 13.002 }] }]);
  const results = buildTerrainIntelligenceV1([section("left", 0, 0, 125), section("right", 0, 125, 200)], data);
  assert.deepEqual(results.map(({ terrainIntelligenceV1: item }) => item.sectionBounds), [
    { startDistanceM: 0, endDistanceM: 125, lengthM: 125 },
    { startDistanceM: 125, endDistanceM: 200, lengthM: 75 },
  ]);
  assert.ok(results.every(({ terrainIntelligenceV1: item }) => item.fields.surface.intervals.every((interval) =>
    interval.startDistanceM >= item.sectionBounds.startDistanceM && interval.endDistanceM <= item.sectionBounds.endDistanceM)));
  assert.equal(results[0].terrainIntelligenceV1.fields.surface.usableTagCoverage.distanceM, 125);
  assert.equal(results[1].terrainIntelligenceV1.fields.surface.usableTagCoverage.distanceM, 75);
});

test("sparse sample gaps remain unknown and supported plus unknown distances reconcile", () => {
  const points = [point(45, 13, 0), point(45, 13.001, 100), point(45, 13.02, 400)];
  const data = createGeoEnrichment(points, [{ id: 1, type: "way", tags: { surface: "gravel" }, geometry: [{ lat: 45, lon: 13 }, { lat: 45, lon: 13.001 }] }]);
  const [{ terrainIntelligenceV1: item }] = buildTerrainIntelligenceV1([section("sparse", 0, 0, 400)], data);
  const surface = item.fields.surface;
  assert.equal(surface.usableTagCoverage.distanceM, 150);
  assert.equal(surface.unknownDistanceM, 250);
  assert.ok(Math.abs(surface.usableTagCoverage.distanceM + surface.unknownDistanceM - 400) <= 0.05);
  assert.deepEqual(surface.unknownReasons.map(({ reason }) => reason).sort(), ["insufficient-sampling", "no-matching-way"]);
  assert.ok(surface.intervals.some(({ unknownReason }) => unknownReason === "insufficient-sampling"));
  assert.ok(surface.intervals.some(({ unknownReason }) => unknownReason === "no-matching-way"));
});

test("ambiguous parallel ways contribute route-match and ambiguity separately, not surface support", () => {
  const points = [point(45, 13, 0), point(45, 13.001, 100), point(45, 13.002, 200)];
  const ways = [
    { id: 1, type: "way", tags: { surface: "gravel" }, geometry: [{ lat: 45, lon: 13 }, { lat: 45, lon: 13.002 }] },
    { id: 2, type: "way", tags: { surface: "asphalt" }, geometry: [{ lat: 45.000018, lon: 13 }, { lat: 45.000018, lon: 13.002 }] },
  ];
  const data = createGeoEnrichment(points, ways);
  const [{ terrainIntelligenceV1: item }] = buildTerrainIntelligenceV1([section("ambiguous", 0, 0, 200)], data);
  assert.ok(item.routeMatchCoverage.distanceM > 0);
  assert.equal(item.ambiguousMatchCoverage.distanceM, item.routeMatchCoverage.distanceM);
  assert.equal(item.fields.surface.usableTagCoverage.distanceM, 0);
  assert.ok(item.fields.surface.unknownReasons.some(({ reason }) => reason === "ambiguous-or-conflicting-match"));
  assert.ok(item.fields.surface.intervals.every(({ status }) => status === "unknown"));
  assert.ok(item.fields.surface.intervals.some(({ osmWayIds }) => osmWayIds.includes("way/1") && osmWayIds.includes("way/2")));
});

test("overlapping source cells count distance once and contradictory tags fail closed", () => {
  const points = [point(45, 13, 0), point(45, 13.001, 100), point(45, 13.002, 200)];
  const data = createGeoEnrichment(points, [{ id: 1, type: "way", tags: { surface: "gravel" }, geometry: [{ lat: 45, lon: 13 }, { lat: 45, lon: 13.002 }] }]);
  const duplicate = structuredClone(data.segments[0]);
  duplicate.id = "overlapping-second-snapshot";
  duplicate.sourceSnapshotIds = ["snapshot-2"];
  duplicate.sampleEvidence = duplicate.sampleEvidence.map((sample) => ({
    ...sample,
    tags: { ...sample.tags, surface: "asphalt" },
    wayIds: ["way/2"],
    sourceWays: [{ sourceId: "way/2", tags: { surface: "asphalt" } }],
  }));
  data.segments.push(duplicate);
  const [{ terrainIntelligenceV1: item }] = buildTerrainIntelligenceV1([section("overlap", 0, 0, 200)], data);
  assert.equal(item.routeMatchCoverage.distanceM, 200);
  assert.ok(item.fields.surface.usableTagCoverage.distanceM <= 200);
  assert.equal(item.fields.surface.usableTagCoverage.distanceM, 0);
  assert.equal(item.fields.surface.unknownDistanceM, 200);
  assert.ok(item.fields.surface.unknownReasons.every(({ reason }) => reason === "ambiguous-or-conflicting-match"));
});

test("surface and highway remain separate and missing or unsupported tags stay explicit", () => {
  const points = [point(45, 13, 0), point(45, 13.001, 100), point(45, 13.002, 200)];
  const data = createGeoEnrichment(points, [{ id: 3, type: "way", tags: { highway: "track" }, geometry: [{ lat: 45, lon: 13 }, { lat: 45, lon: 13.002 }] }]);
  const [{ terrainIntelligenceV1: item }] = buildTerrainIntelligenceV1([section("tagless", 0, 0, 200)], data);
  assert.equal(item.fields.surface.categories.length, 0);
  assert.ok(item.fields.surface.unknownReasons.some(({ reason }) => reason === "matched-way-without-tag"));
  assert.ok(item.fields.highway.categories.some(({ category }) => category === "track"));
  assert.equal(item.fields.highway.categories[0].sourceEvidence[0].rawTags.highway, "track");
  assert.equal(item.fields.surface.unknownDistanceM, 200);

  const unsupported = createGeoEnrichment(points, [{ id: 4, type: "way", tags: { surface: "gravel;rock" }, geometry: [{ lat: 45, lon: 13 }, { lat: 45, lon: 13.002 }] }]);
  const [{ terrainIntelligenceV1: unsupportedItem }] = buildTerrainIntelligenceV1([section("unsupported", 0, 0, 200)], unsupported);
  assert.ok(unsupportedItem.fields.surface.unknownReasons.some(({ reason }) => reason === "unsupported-tag-value"));
  assert.ok(unsupportedItem.fields.surface.intervals.some(({ rawValues }) => rawValues.includes("gravel;rock")));
});

test("provider unavailable and not-requested evidence have distinct reasons", () => {
  const sections = [section("section", 0, 0, 100)];
  const [{ terrainIntelligenceV1: notRequested }] = buildTerrainIntelligenceV1(sections, null);
  const [{ terrainIntelligenceV1: unavailable }] = buildTerrainIntelligenceV1(sections, createUnknownGeoEnrichment("request failed"));
  assert.deepEqual(notRequested.fields.surface.unknownReasons, [{ reason: "not-requested", distanceM: 100 }]);
  assert.equal(notRequested.retrievalCoverage.distanceM, null);
  assert.deepEqual(unavailable.fields.surface.unknownReasons, [{ reason: "provider-unavailable", distanceM: 100 }]);
  assert.equal(unavailable.retrievalCoverage.distanceM, null);
});

test("persisted conflicting surface snapshots remain unknown with raw values and provenance", () => {
  const { data: original } = makeTwoComponentEvidence();
  const data = structuredClone(original);
  data.conflicts = [{ field: "surface", segmentIndex: 0, startDistanceKm: 0, endDistanceKm: 0.1, selectedSnapshotId: "snapshot-a", alternatives: [
    { snapshotId: "snapshot-a", value: "gravel", sourceWays: [{ osmWayId: "way/11", rawTags: { surface: "gravel" } }] },
    { snapshotId: "snapshot-b", value: "rock", sourceWays: [{ osmWayId: "way/12", rawTags: { surface: "rock" } }] },
  ] }, { field: "highway", segmentIndex: 0, startDistanceKm: 0, endDistanceKm: 0.1, selectedSnapshotId: "snapshot-c", alternatives: [
    { snapshotId: "snapshot-c", value: "track", sourceWays: [{ osmWayId: "way/11", rawTags: { highway: "track" } }] },
    { snapshotId: "snapshot-d", value: "path", sourceWays: [{ osmWayId: "way/13", rawTags: { highway: "path" } }] },
  ] }];
  const [{ terrainIntelligenceV1: item }] = buildTerrainIntelligenceV1([section("conflict", 0, 0, 200)], data);
  const conflicted = item.fields.surface.intervals.filter((interval) => interval.unknownReason === "ambiguous-or-conflicting-match");
  assert.ok(conflicted.length > 0);
  assert.ok(conflicted.some((interval) => interval.rawValues.includes("rock") && interval.rawValues.includes("gravel")));
  assert.ok(conflicted.every((interval) => interval.snapshotIds.includes("snapshot-a") && interval.snapshotIds.includes("snapshot-b")));
  assert.ok(conflicted.some((interval) => interval.osmWayIds.includes("way/12") && interval.sourceEvidence.some((item) => item.rawTags.surface === "rock")));
  const conflictedHighway = item.fields.highway.intervals.filter((interval) => interval.unknownReason === "ambiguous-or-conflicting-match");
  assert.ok(conflictedHighway.length > 0);
  assert.ok(conflictedHighway.every((interval) => interval.rawValues.includes("track") && interval.rawValues.includes("path")));
  assert.equal(item.fields.surface.categories.some(({ category }) => category === "rocky-rough" || category === "natural-trail" || category === "mixed-trail"), false);
});

test("partial retrieval coverage is independent of route matching and usable tags", () => {
  const points = [point(45, 13, 0), point(45, 13.001, 100), point(45, 13.002, 200)];
  const data = createGeoEnrichment(points, []);
  data.retrieval = {
    queryAttempts: 2, requestsSent: 2, requestsSucceeded: 1, requestsFailed: 1, cacheHits: 0,
    retrievalCoveragePercent: 50,
    retrievedRanges: [{ startDistanceKm: 0, endDistanceKm: 0.1, segmentIndex: 0 }],
    unavailableRanges: [{ startDistanceKm: 0.1, endDistanceKm: 0.2, segmentIndex: 0 }],
    failureCounts: { http429: 0, http504: 0, timeout: 0, otherTransient: 1, permanent: 0, budgetExhausted: 0 },
  };
  data.segments = [];
  const [{ terrainIntelligenceV1: item }] = buildTerrainIntelligenceV1([section("partial", 0, 0, 200)], data);
  assert.equal(item.retrievalCoverage.distanceM, 100);
  assert.equal(item.routeMatchCoverage.distanceM, 0);
  assert.equal(item.fields.surface.usableTagCoverage.distanceM, 0);
  assert.ok(item.fields.surface.unknownReasons.some(({ reason }) => reason === "provider-unavailable"));
});

test("matched samples cannot label failed or unretrieved distance ranges", () => {
  const points = [point(45, 13, 0), point(45, 13.001, 100), point(45, 13.002, 200)];
  const makeRetrieved = (unavailableRanges) => {
    const data = createGeoEnrichment(points, [{ id: 41, type: "way", tags: { surface: "gravel" }, geometry: [{ lat: 45, lon: 13 }, { lat: 45, lon: 13.002 }] }]);
    data.retrieval = {
      queryAttempts: 2, requestsSent: 2, requestsSucceeded: 1, requestsFailed: 1, cacheHits: 0,
      retrievalCoveragePercent: 50,
      retrievedRanges: [{ startDistanceKm: 0, endDistanceKm: 0.05, segmentIndex: 0 }, { startDistanceKm: 0.15, endDistanceKm: 0.2, segmentIndex: 0 }],
      unavailableRanges,
      failureCounts: { http429: 0, http504: 0, timeout: 0, otherTransient: 1, permanent: 0, budgetExhausted: 0 },
    };
    return data;
  };
  const failed = makeRetrieved([{ startDistanceKm: 0.05, endDistanceKm: 0.15, segmentIndex: 0 }]);
  const [{ terrainIntelligenceV1: failedItem }] = buildTerrainIntelligenceV1([section("failed-range", 0, 0, 200)], failed);
  assert.equal(failedItem.fields.surface.usableTagCoverage.distanceM, 100);
  assert.ok(failedItem.fields.surface.unknownReasons.some(({ reason, distanceM }) => reason === "provider-unavailable" && distanceM === 100));
  assert.ok(failedItem.fields.surface.intervals.filter(({ unknownReason }) => unknownReason === "provider-unavailable").every(({ osmWayIds, sourceEvidence }) => osmWayIds.length === 0 && sourceEvidence.length === 0));

  const unrequested = makeRetrieved([]);
  const [{ terrainIntelligenceV1: unrequestedItem }] = buildTerrainIntelligenceV1([section("unrequested-range", 0, 0, 200)], unrequested);
  assert.equal(unrequestedItem.fields.surface.usableTagCoverage.distanceM, 100);
  assert.ok(unrequestedItem.fields.surface.unknownReasons.some(({ reason, distanceM }) => reason === "not-requested" && distanceM === 100));
});

test("current surface presentation uses explicit categories and approximate distance wording", () => {
  const { data } = makeTwoComponentEvidence();
  const [attached] = attachTerrainEvidenceToRouteSections([section("surface-view", 0, 0, 200)], data);
  const presentation = getSurfaceEvidencePresentation(attached, true);
  assert.equal(presentation.status, "mapped");
  assert.match(presentation.coverageLabel, /approximately/);
  assert.match(presentation.categories[0].label, /Gravel/);
  assert.match(presentation.categories[0].distanceLabel, /^~/);
  assert.doesNotMatch(JSON.stringify(presentation), /rough|technical|natural trail/i);
});

test("mapped terrain presentation uses full-section denominator, includes unknown distance, and separates highway tags", () => {
  const { data } = makeTwoComponentEvidence();
  const [attached] = attachTerrainEvidenceToRouteSections([section("surface-view-v1", 0, 0, 200)], data);
  const view = getTerrainSectionPresentation(attached, "ready");
  assert.equal(view.status, "available");
  if (view.status !== "available") return;
  assert.equal(view.surface.coverageLabel, "Mapped for approximately 0.2 km of 0.2 km section length · 100%");
  assert.deepEqual(view.surface.categories.map(({ label, distanceLabel, sharePercent }) => [label, distanceLabel, sharePercent]), [["Gravel", "~0.2 km", 100]]);
  assert.equal(view.surface.unknownLabel, "Unknown: ~0 km · 0% of section");
  assert.equal(view.highway?.heading, "Mapped way type · separate from surface");
  assert.deepEqual(view.highway?.categories.map(({ label, sharePercent }) => [label, sharePercent]), [["Track", 100]]);
  assert.match(view.sourceNote, /not current ground conditions/);
  assert.doesNotMatch(JSON.stringify(view), /technical|rough|natural trail/i);
});

test("partial terrain display counts unknown distance in the same full-section denominator", () => {
  const points = [point(45, 13, 0), point(45, 13.001, 100), point(45, 13.02, 400)];
  const data = createGeoEnrichment(points, [{ id: 1, type: "way", tags: { surface: "gravel" }, geometry: [{ lat: 45, lon: 13 }, { lat: 45, lon: 13.001 }] }]);
  const [attached] = attachTerrainEvidenceToRouteSections([section("partial-view", 0, 0, 400)], data);
  const view = getTerrainSectionPresentation(attached, "ready");
  assert.equal(view.status, "available");
  if (view.status !== "available") return;
  assert.deepEqual(view.surface.categories.map(({ distanceLabel, sharePercent }) => [distanceLabel, sharePercent]), [["~0.15 km", 37.5]]);
  assert.equal(view.surface.unknownLabel, "Unknown: ~0.25 km · 62.5% of section");
  assert.ok(view.surface.reasons.some((reason) => /sampling|matched/.test(reason)));
});

test("terrain section UI states distinguish not checked, loading, unavailable and evidence-empty results", () => {
  const bare = section("state", 0, 0, 100);
  assert.deepEqual(getTerrainSectionPresentation(bare, "not-requested"), { status: "not-requested", message: "Mapped terrain has not been checked for this route." });
  assert.equal(getTerrainSectionPresentation(bare, "loading").status, "loading");
  assert.equal(getTerrainSectionPresentation(bare, "unavailable").status, "unavailable");
  const [unavailable] = attachTerrainEvidenceToRouteSections([bare], createUnknownGeoEnrichment("ignored provider detail"));
  const view = getTerrainSectionPresentation(unavailable, "ready");
  assert.equal(view.status, "available");
  if (view.status === "available") {
    assert.equal(view.surface.categories.length, 0);
    assert.equal(view.surface.unknownLabel, "Unknown: ~0.1 km · 100% of section");
    assert.ok(view.surface.reasons.some((reason) => /Map data was unavailable/.test(reason)));
  }
  const wrongBounds = { ...unavailable, terrainIntelligenceV1: { ...unavailable.terrainIntelligenceV1, sectionBounds: { ...unavailable.terrainIntelligenceV1.sectionBounds, lengthM: 99 } } };
  assert.equal(getTerrainSectionPresentation(wrongBounds, "ready").status, "unsupported");
});

test("cached sample evidence retains snapshot provenance through the section adapter", () => {
  const { data } = makeTwoComponentEvidence();
  const snapshot = createOsmSnapshot(data, 0.4, 1000, 1);
  const cached = mergeOsmEnrichmentRecord(null, snapshot, "fingerprint", 2, 0.4, 2, 1000);
  const attached = attachTerrainEvidenceToRouteSections([section("cached-b", 1, 200, 400)], cached.mergedData);
  const paved = surfaceCategory(attached[0].terrainIntelligenceV1, "paved");
  assert.ok(paved.snapshotIds.includes(snapshot.snapshotId));
  assert.ok(paved.sourceEvidence.some((item) => item.osmWayId === "way/22" && item.snapshotIds.includes(snapshot.snapshotId)));
});

test("cached sample support is clipped to the retrieved route range", () => {
  const points = [point(45, 13, 0), point(45, 13.001, 100), point(45, 13.002, 200)];
  const data = createGeoEnrichment(points, [{ id: 31, type: "way", tags: { surface: "gravel" }, geometry: [{ lat: 45, lon: 13 }, { lat: 45, lon: 13.002 }] }]);
  data.retrieval = {
    queryAttempts: 1, requestsSent: 1, requestsSucceeded: 1, requestsFailed: 0, cacheHits: 0,
    retrievalCoveragePercent: 50,
    retrievedRanges: [{ startDistanceKm: 0.05, endDistanceKm: 0.15, segmentIndex: 0 }],
    unavailableRanges: [],
    failureCounts: { http429: 0, http504: 0, timeout: 0, otherTransient: 0, permanent: 0, budgetExhausted: 0 },
  };
  const snapshot = createOsmSnapshot(data, 0.2, 5, 1);
  const cached = mergeOsmEnrichmentRecord(null, snapshot, "fingerprint", 2, 0.2, 2, 5);
  const [{ terrainIntelligenceV1: item }] = buildTerrainIntelligenceV1([section("retrieved", 0, 0, 200)], cached.mergedData);
  assert.equal(item.retrievalCoverage.distanceM, 100);
  assert.equal(item.fields.surface.usableTagCoverage.distanceM, 100);
  assert.ok(item.fields.surface.intervals.filter(({ status }) => status === "supported").every((interval) => interval.startDistanceM >= 50 && interval.endDistanceM <= 150));
});

test("checked-in Istria multi-section route uses identical V1 attachment in Route and Race Mode flows with mocked OSM", () => {
  const xml = readFileSync(new URL("../public/ISTRIA_110K_2027.gpx", import.meta.url), "utf8");
  const analysis = analyzeGpxRoute(parseGpxText(xml));
  const componentPoints = new Map();
  for (const routePoint of analysis.points) {
    const points = componentPoints.get(routePoint.segmentIndex) ?? [];
    points.push(routePoint);
    componentPoints.set(routePoint.segmentIndex, points);
  }
  const ways = [...componentPoints.entries()].map(([segmentIndex, points]) => ({
    id: 1000 + segmentIndex,
    type: "way",
    tags: { surface: "gravel", highway: "track" },
    geometry: points.map(({ latitude, longitude }) => ({ lat: latitude, lon: longitude })),
  }));
  const evidence = createGeoEnrichment(analysis.points, ways);
  const routeModeSections = attachTerrainEvidenceToRouteSections(analysis.routeSections, evidence);
  const raceModeSections = attachTerrainEvidenceToRouteSections(analysis.routeSections, evidence);
  assert.ok(routeModeSections.length > 1);
  assert.deepEqual(raceModeSections, routeModeSections);
  const attached = routeModeSections;
  assert.ok(attached.length > 0);
  for (const routeSection of attached) {
    const terrain = routeSection.terrainIntelligenceV1;
    assert.equal(terrain.sectionId, routeSection.id);
    assert.equal(terrain.segmentIndex, routeSection.segmentIndex);
    for (const field of Object.values(terrain.fields)) {
      const supported = field.usableTagCoverage.distanceM ?? 0;
      assert.ok(Math.abs(supported + field.unknownDistanceM - terrain.sectionBounds.lengthM) <= 0.05);
    }
  }
  assert.ok(attached.some((routeSection) => routeSection.terrainIntelligenceV1.fields.surface.categories.some(({ category }) => category === "gravel")));
});
