import assert from "node:assert/strict";
import test from "node:test";
import { analyzeGpxRoute, parseGpxText } from "./gpxAnalysis.ts";
import { createRouteFingerprint } from "./routeFingerprint.ts";
import { createAnalysisInputFingerprint } from "./analysisInputFingerprint.ts";
import {
  cacheMapillaryEnrichment,
  cacheOsmEnrichment,
  getCachedOsmEnrichment,
  getOrCreateRouteAnalysis,
  hasReusableMapillaryEvidence,
  mapMapillaryEvidenceToSections,
  OSM_ENRICHMENT_VERSION,
  ROUTE_ANALYSIS_VERSION,
  selectAnalysisForMatchingInput,
} from "./routePersistence.ts";

class MemoryStore {
  routes = new Map();
  analyses = new Map();
  osm = new Map();
  mapillary = new Map();
  references = new Map();
  getRoute(key, fingerprintVersion) { const value = this.routes.get(key); return Promise.resolve(value?.routeFingerprintVersion === fingerprintVersion ? value : null); }
  getAnalysis(key, fingerprintVersion, version, inputFingerprint) { const value = this.analyses.get(`${key}:${version}:${inputFingerprint}`); return Promise.resolve(value?.routeFingerprintVersion === fingerprintVersion && value.analysisInputFingerprint === inputFingerprint ? value : null); }
  async saveRouteAndAnalysis(route, analysis) { this.routes.set(route.routeFingerprint, route); this.analyses.set(`${analysis.routeFingerprint}:${analysis.analysisVersion}:${analysis.analysisInputFingerprint}`, analysis); }
  getOsm(key, fingerprintVersion, version) { const value = this.osm.get(`${key}:${version}`); return Promise.resolve(value?.routeFingerprintVersion === fingerprintVersion ? value : null); }
  putOsm(record) { this.osm.set(`${record.routeFingerprint}:${record.schemaVersion}`, record); return Promise.resolve(); }
  getMapillary(key, fingerprintVersion, version) { const value = this.mapillary.get(`${key}:${version}`); return Promise.resolve(value?.routeFingerprintVersion === fingerprintVersion ? value : null); }
  putMapillary(record) { this.mapillary.set(`${record.routeFingerprint}:${record.schemaVersion}`, record); return Promise.resolve(); }
  getRaceEditionReference(id, year) { return Promise.resolve(this.references.get(`${id}:${year}`) ?? null); }
  putRaceEditionReference(reference) { this.references.set(`${reference.raceId}:${reference.year}`, reference); return Promise.resolve(); }
}

const line = (length = 1000) => Array.from({ length: Math.floor(length / 100) + 1 }, (_, index) => ({ latitude: 45, longitude: 13 + index * 0.001 }));
const sampleAnalysis = (name = "a route") => analyzeGpxRoute({ name, points: [
  { latitude: 45, longitude: 13, elevationM: 100 },
  { latitude: 45.001, longitude: 13, elevationM: 130 },
  { latitude: 45.002, longitude: 13, elevationM: 110 },
] });

function geoData(startKm, endKm, surface = "gravel", { availability = "available", evidenceCoverage = 1, matchQuality = "high", retrievalRanges = [{ startDistanceKm: startKm, endDistanceKm: endKm }], unavailableRanges = [] } = {}) {
  const value = availability === "available" ? surface : null;
  const empty = (provenance = "osm") => ({ value: null, rawValue: null, provenance, availability: "not-found" });
  return {
    source: { type: "osm", name: "OpenStreetMap", attribution: "© OpenStreetMap contributors" },
    availability,
    segments: availability === "available" ? [{
      id: `seg-${startKm}-${endKm}-${surface}`, startDistanceKm: startKm, endDistanceKm: endKm, lengthKm: endKm - startKm,
      evidenceCoverage, matchQuality, osmWays: [{ source: "OpenStreetMap", sourceId: `way-${surface}`, tags: { surface }, geometry: [], startDistanceKm: startKm, endDistanceKm: endKm, matchQuality }],
      surface: { value, rawValue: value, provenance: "osm", availability }, pathType: empty(), trackCondition: empty(), smoothness: empty(), hikingDifficulty: empty(), trailVisibility: empty(), incline: empty(), width: empty(), informal: empty(), trailblazed: empty(), assistedTrail: empty(),
    }] : [],
    matchedRoutePercent: availability === "available" ? Math.round((endKm - startKm) * 100) : 0,
    attribution: "© OpenStreetMap contributors",
    retrieval: {
      queryAttempts: 1, requestsSent: 1, requestsSucceeded: availability === "available" ? 1 : 0, requestsFailed: availability === "available" ? 0 : 1,
      cacheHits: 0, retrievalCoveragePercent: Math.round(retrievalRanges.reduce((sum, range) => sum + range.endDistanceKm - range.startDistanceKm, 0) * 100),
      retrievedRanges: retrievalRanges, unavailableRanges,
      failureCounts: { http429: 0, http504: availability === "unknown" ? 1 : 0, timeout: 0, otherTransient: 0, permanent: 0, budgetExhausted: 0 },
    },
  };
}

test("route fingerprint is stable for exact physical geometry and independent of metadata", async () => {
  const first = await createRouteFingerprint(line());
  const renamed = await createRouteFingerprint(line());
  assert.equal(first.routeFingerprint, renamed.routeFingerprint);
  assert.match(first.routeFingerprint, /^route-v2-sha256-[a-f0-9]{64}$/);
});

test("physical route fingerprint v2 preserves path boundaries, excludes elevation, and stores segmented geometry", async () => {
  const points = [
    { latitude: 45, longitude: 13, elevationM: 10 },
    { latitude: 45, longitude: 13.01, elevationM: 20 },
    { latitude: 45, longitude: 13.02, elevationM: 30 },
    { latitude: 45, longitude: 13.03, elevationM: 40 },
  ];
  const connected = await createRouteFingerprint([points.map(({ latitude, longitude }) => ({ latitude, longitude }))]);
  const split = await createRouteFingerprint([
    points.slice(0, 2).map(({ latitude, longitude }) => ({ latitude, longitude })),
    points.slice(2).map(({ latitude, longitude }) => ({ latitude, longitude })),
  ]);
  const changedElevation = await createRouteFingerprint([points.map(({ latitude, longitude }) => ({ latitude, longitude }))]);
  assert.equal(connected.routeFingerprintVersion, 2);
  assert.notEqual(connected.routeFingerprint, split.routeFingerprint);
  assert.equal(connected.routeFingerprint, changedElevation.routeFingerprint);
  assert.equal(split.normalizedGeometrySegments.length, 2);
});

test("legacy v1 route and enrichment identities cannot satisfy current v2 lookups", async () => {
  const current = await createRouteFingerprint(line());
  const legacyFingerprint = `route-v1-sha256-${"c".repeat(64)}`;
  const legacyRoute = {
    routeFingerprint: legacyFingerprint,
    routeFingerprintVersion: 1,
    normalizedGeometry: [],
    normalizedDistanceKm: 1,
    totalDistanceKm: 1,
    representativePointCount: 2,
    createdAt: 1,
    updatedAt: 1,
  };
  const store = new MemoryStore();
  store.routes.set(legacyFingerprint, legacyRoute);
  assert.equal(await store.getRoute(legacyFingerprint, 1), legacyRoute);
  assert.equal(await store.getRoute(current.routeFingerprint, current.routeFingerprintVersion), null);

  const analysis = sampleAnalysis();
  const inputFingerprint = await createAnalysisInputFingerprint(analysis.points);
  store.analyses.set(`${legacyFingerprint}:${ROUTE_ANALYSIS_VERSION}:${inputFingerprint}`, {
    routeFingerprint: legacyFingerprint,
    routeFingerprintVersion: 1,
    analysisVersion: ROUTE_ANALYSIS_VERSION,
    analysisInputFingerprint: inputFingerprint,
    generatedAt: 1,
    analysis,
  });
  let calculations = 0;
  const result = await getOrCreateRouteAnalysis(store, current, inputFingerprint, "current", () => {
    calculations += 1;
    return sampleAnalysis();
  });
  assert.equal(result.cacheHit, false);
  assert.equal(calculations, 1);

  await cacheOsmEnrichment(store, legacyFingerprint, geoData(0, 1), 1, { routeFingerprintVersion: 1 });
  const mapillaryData = { source: { type: "mapillary", name: "Mapillary", attribution: "© Mapillary" }, sections: [{ id: "s1", availability: "not-found", images: [] }] };
  await cacheMapillaryEnrichment(store, legacyFingerprint, mapillaryData, { routeFingerprintVersion: 1 });
  assert.equal(await getCachedOsmEnrichment(store, current.routeFingerprint, current.routeFingerprintVersion, 1, OSM_ENRICHMENT_VERSION), null);
  assert.equal(await store.getMapillary(current.routeFingerprint, current.routeFingerprintVersion, 1), null);
});

test("analysis input fingerprint v2 distinguishes segment structure and normalizes negative zero", async () => {
  const sequence = [
    { latitude: 45, longitude: 13, elevationM: -0 },
    { latitude: 45, longitude: 13.01, elevationM: 20 },
    { latitude: 45, longitude: 13.02, elevationM: 30 },
    { latitude: 45, longitude: 13.03, elevationM: 40 },
  ];
  const connected = await createAnalysisInputFingerprint([sequence]);
  const split = await createAnalysisInputFingerprint([sequence.slice(0, 2), sequence.slice(2)]);
  const normalizedZero = await createAnalysisInputFingerprint([[{ ...sequence[0], elevationM: 0 }, ...sequence.slice(1)]]);
  assert.match(connected, /^analysis-input-v2-sha256-/);
  assert.notEqual(connected, split);
  assert.equal(connected, normalizedZero);
});

test("different GPX filenames and metadata names preserve the same route fingerprint", async () => {
  const gpx = (name) => `<gpx><metadata><name>${name}</name></metadata><trk><trkseg><trkpt lat="45" lon="13"><ele>1</ele></trkpt><trkpt lat="45.001" lon="13"><ele>2</ele></trkpt></trkseg></trk></gpx>`;
  const firstUpload = parseGpxText(gpx("First title"));
  const renamedUpload = parseGpxText(gpx("Different title"));
  assert.notEqual(firstUpload.name, renamedUpload.name);
  assert.equal((await createRouteFingerprint(firstUpload.points)).routeFingerprint, (await createRouteFingerprint(renamedUpload.points)).routeFingerprint);
});

test("analysis input fingerprint ignores GPX metadata and is stable for identical parsed point sequences", async () => {
  const gpx = (name) => `<gpx><metadata><name>${name}</name></metadata><trk><trkseg><trkpt lat="45" lon="13"><ele>1</ele></trkpt><trkpt lat="45.001" lon="13"><ele>2</ele></trkpt></trkseg></trk></gpx>`;
  const first = parseGpxText(gpx("First title"));
  const renamed = parseGpxText(gpx("Different title"));
  assert.equal(await createAnalysisInputFingerprint(first.points), await createAnalysisInputFingerprint(renamed.points));
});

test("analysis input identity preserves point order and sampling density", async () => {
  const sparse = [{ latitude: 45, longitude: 13, elevationM: 10 }, { latitude: 45, longitude: 13.01, elevationM: 20 }];
  const dense = Array.from({ length: 11 }, (_, index) => ({ latitude: 45, longitude: 13 + index * 0.001, elevationM: 10 + index }));
  assert.notEqual(await createAnalysisInputFingerprint(sparse), await createAnalysisInputFingerprint(dense));
  assert.notEqual(await createAnalysisInputFingerprint(sparse), await createAnalysisInputFingerprint([...sparse].reverse()));
});

test("route fingerprint ignores denser sampling along the same straight route", async () => {
  const sparse = [{ latitude: 45, longitude: 13 }, { latitude: 45, longitude: 13.01 }];
  const dense = Array.from({ length: 101 }, (_, index) => ({ latitude: 45, longitude: 13 + index * 0.0001 }));
  assert.equal((await createRouteFingerprint(sparse)).routeFingerprint, (await createRouteFingerprint(dense)).routeFingerprint);
});

test("route fingerprint tolerates small route noise below the simplification tolerance", async () => {
  const base = Array.from({ length: 31 }, (_, index) => ({ latitude: 45 + index * 0.0001, longitude: 13 }));
  const noisy = base.map((point, index) => ({ ...point, longitude: point.longitude + (index % 2 ? 0.000005 : -0.000005) }));
  assert.equal((await createRouteFingerprint(base)).routeFingerprint, (await createRouteFingerprint(noisy)).routeFingerprint);
});

test("route fingerprint changes for a substantially different middle route geometry", async () => {
  const base = [{ latitude: 45, longitude: 13 }, { latitude: 45.01, longitude: 13 }, { latitude: 45.02, longitude: 13 }];
  const changed = [base[0], { latitude: 45.01, longitude: 13.01 }, base[2]];
  assert.notEqual((await createRouteFingerprint(base)).routeFingerprint, (await createRouteFingerprint(changed)).routeFingerprint);
});

test("route fingerprint distinguishes a parallel trail and opposite traversal", async () => {
  const route = [{ latitude: 45, longitude: 13 }, { latitude: 45.01, longitude: 13 }];
  const parallel = route.map((point) => ({ ...point, longitude: point.longitude + 0.001 }));
  assert.notEqual((await createRouteFingerprint(route)).routeFingerprint, (await createRouteFingerprint(parallel)).routeFingerprint);
  assert.notEqual((await createRouteFingerprint(route)).routeFingerprint, (await createRouteFingerprint([...route].reverse())).routeFingerprint);
});

test("route fingerprint rejects invalid or degenerate coordinates", async () => {
  await assert.rejects(() => createRouteFingerprint([{ latitude: 91, longitude: 0 }, { latitude: 45, longitude: 0 }]), RangeError);
  await assert.rejects(() => createRouteFingerprint([{ latitude: 45, longitude: 13 }, { latitude: 45, longitude: 13 }]), RangeError);
});

test("same parsed analysis inputs reuse analysis across filenames and use the current upload name", async () => {
  const store = new MemoryStore();
  const fingerprint = await createRouteFingerprint(line());
  const inputFingerprint = await createAnalysisInputFingerprint(sampleAnalysis().points);
  let calculations = 0;
  const compute = () => { calculations += 1; return sampleAnalysis("stored name"); };
  const first = await getOrCreateRouteAnalysis(store, fingerprint, inputFingerprint, "first upload", compute, { now: 10 });
  const second = await getOrCreateRouteAnalysis(store, fingerprint, inputFingerprint, "renamed upload", compute, { now: 20 });
  assert.equal(first.cacheHit, false);
  assert.equal(second.cacheHit, true);
  assert.equal(calculations, 1);
  assert.equal(second.analysis.name, "renamed upload");
});

test("analysis version change deterministically recomputes stale analysis", async () => {
  const store = new MemoryStore();
  const fingerprint = await createRouteFingerprint(line());
  const inputFingerprint = await createAnalysisInputFingerprint(sampleAnalysis().points);
  let calculations = 0;
  const compute = () => { calculations += 1; return sampleAnalysis(); };
  await getOrCreateRouteAnalysis(store, fingerprint, inputFingerprint, "A", compute, { analysisVersion: ROUTE_ANALYSIS_VERSION });
  const upgraded = await getOrCreateRouteAnalysis(store, fingerprint, inputFingerprint, "A", compute, { analysisVersion: ROUTE_ANALYSIS_VERSION + 1 });
  assert.equal(upgraded.cacheHit, false);
  assert.equal(calculations, 2);
});

test("local persistence failure does not prevent GPX analysis", async () => {
  const broken = new Proxy(new MemoryStore(), { get(target, key) { if (key === "getRoute" || key === "getAnalysis" || key === "saveRouteAndAnalysis") return () => Promise.reject(new Error("storage disabled")); return Reflect.get(target, key); } });
  const fingerprint = await createRouteFingerprint(line());
  const inputFingerprint = await createAnalysisInputFingerprint(sampleAnalysis().points);
  const result = await getOrCreateRouteAnalysis(broken, fingerprint, inputFingerprint, "A", () => sampleAnalysis());
  assert.equal(result.cacheHit, false);
  assert.equal(result.analysis.name, "A");
});

test("same geometry with changed elevation has a distinct analysis identity and recomputes", async () => {
  const points = line().map((point, index) => ({ ...point, elevationM: 100 + index * 10 }));
  const changedElevation = points.map((point, index) => ({ ...point, elevationM: point.elevationM + (index === 5 ? 40 : 0) }));
  const [physical, physicalChanged, inputA, inputB] = await Promise.all([
    createRouteFingerprint(points), createRouteFingerprint(changedElevation),
    createAnalysisInputFingerprint(points), createAnalysisInputFingerprint(changedElevation),
  ]);
  assert.equal(physical.routeFingerprint, physicalChanged.routeFingerprint);
  assert.notEqual(inputA, inputB);

  const store = new MemoryStore();
  let calculations = 0;
  const run = (inputFingerprint, sourcePoints, name) => getOrCreateRouteAnalysis(
    store, physical, inputFingerprint, name, () => { calculations += 1; return analyzeGpxRoute({ points: sourcePoints }); },
  );
  const first = await run(inputA, points, "first file");
  const repeat = await run(inputA, points, "renamed file");
  const corrected = await run(inputB, changedElevation, "corrected elevations");
  assert.equal(first.cacheHit, false);
  assert.equal(repeat.cacheHit, true);
  assert.equal(corrected.cacheHit, false);
  assert.equal(calculations, 2);
  assert.notEqual(corrected.analysis.metrics.elevationGainM, first.analysis.metrics.elevationGainM);
  assert.equal(store.analyses.size, 2);
});

test("OSM and Mapillary persistence continue to use physical route identity only", async () => {
  const points = line().map((point, index) => ({ ...point, elevationM: index * 5 }));
  const changedElevation = points.map((point) => ({ ...point, elevationM: point.elevationM + 100 }));
  const [physical, changedPhysical] = await Promise.all([
    createRouteFingerprint(points), createRouteFingerprint(changedElevation),
  ]);
  assert.equal(physical.routeFingerprint, changedPhysical.routeFingerprint);

  const store = new MemoryStore();
  await cacheOsmEnrichment(store, physical.routeFingerprint, geoData(0, 1), 1, { routeFingerprintVersion: physical.routeFingerprintVersion });
  const mapillary = { source: { type: "mapillary", name: "Mapillary", attribution: "© Mapillary" }, sections: [{ id: "s1", availability: "not-found", images: [] }] };
  await cacheMapillaryEnrichment(store, physical.routeFingerprint, mapillary, { routeFingerprintVersion: physical.routeFingerprintVersion });
  assert.ok(await store.getOsm(changedPhysical.routeFingerprint, changedPhysical.routeFingerprintVersion, OSM_ENRICHMENT_VERSION));
  assert.ok(await store.getMapillary(changedPhysical.routeFingerprint, changedPhysical.routeFingerprintVersion, 1));
});

test("legacy analysis records without an input fingerprint fail closed and regenerate", async () => {
  const fingerprint = await createRouteFingerprint(line());
  const inputFingerprint = await createAnalysisInputFingerprint(sampleAnalysis().points);
  const legacy = new MemoryStore();
  const oldRecord = {
    routeFingerprint: fingerprint.routeFingerprint,
    routeFingerprintVersion: fingerprint.routeFingerprintVersion,
    analysisVersion: ROUTE_ANALYSIS_VERSION,
    generatedAt: 1,
    analysis: sampleAnalysis(),
  };
  legacy.getAnalysis = async () => oldRecord;
  let calculations = 0;
  const result = await getOrCreateRouteAnalysis(legacy, fingerprint, inputFingerprint, "route", () => {
    calculations += 1;
    return sampleAnalysis();
  });
  assert.equal(result.cacheHit, false);
  assert.equal(calculations, 1);
  assert.equal(result.analysis.name, "route");
});

test("different analysis inputs coexist for one route and version while identical writes stay idempotent", async () => {
  const points = line().map((point, index) => ({ ...point, elevationM: index * 10 }));
  const changed = points.map((point, index) => ({ ...point, elevationM: point.elevationM + (index === 3 ? 20 : 0) }));
  const fingerprint = await createRouteFingerprint(points);
  const [firstInput, secondInput] = await Promise.all([createAnalysisInputFingerprint(points), createAnalysisInputFingerprint(changed)]);
  const store = new MemoryStore();
  let calculations = 0;
  const compute = (sourcePoints) => { calculations += 1; return analyzeGpxRoute({ points: sourcePoints }); };
  await getOrCreateRouteAnalysis(store, fingerprint, firstInput, "a", () => compute(points));
  await getOrCreateRouteAnalysis(store, fingerprint, firstInput, "a", () => compute(points));
  await getOrCreateRouteAnalysis(store, fingerprint, secondInput, "b", () => compute(changed));
  assert.equal(calculations, 2);
  assert.equal(store.analyses.size, 2);
  assert.equal(selectAnalysisForMatchingInput("registry analysis", firstInput, firstInput), "registry analysis");
  assert.equal(selectAnalysisForMatchingInput("registry analysis", firstInput, secondInput), null);
});

test("OSM cache unions non-overlapping successful route ranges", async () => {
  const store = new MemoryStore();
  const first = await cacheOsmEnrichment(store, "route-a", geoData(0, 2), 10, { now: 1 });
  const second = await cacheOsmEnrichment(store, "route-a", geoData(5, 7, "dirt"), 10, { now: 2 });
  assert.deepEqual(second.retrievedRanges, [{ startDistanceKm: 0, endDistanceKm: 2, segmentIndex: 0 }, { startDistanceKm: 5, endDistanceKm: 7, segmentIndex: 0 }]);
  assert.ok(second.classifiableCoveragePercent > first.classifiableCoveragePercent);
});

test("classifiable OSM evidence can be looked up and reused independently", async () => {
  const store = new MemoryStore();
  await cacheOsmEnrichment(store, "route-a", geoData(0, 3), 10);
  const cached = await getCachedOsmEnrichment(store, "route-a", 2, 10, OSM_ENRICHMENT_VERSION);
  assert.equal(cached.hasClassifiableEvidence, true);
  assert.equal(cached.record.mergedData.segments[0].surface.value, "gravel");
});

test("OSM retrieval coverage uses the union and duplicate overlaps do not inflate it", async () => {
  const store = new MemoryStore();
  await cacheOsmEnrichment(store, "route-a", geoData(0, 6), 10, { now: 1 });
  const repeated = await cacheOsmEnrichment(store, "route-a", geoData(0, 6), 10, { now: 2 });
  const overlapping = await cacheOsmEnrichment(store, "route-a", geoData(4, 8), 10, { now: 3 });
  assert.equal(repeated.retrievalCoveragePercent, 60);
  assert.equal(overlapping.retrievalCoveragePercent, 80);
});

test("failed OSM refresh cannot erase prior successful evidence", async () => {
  const store = new MemoryStore();
  await cacheOsmEnrichment(store, "route-a", geoData(0, 4), 10, { now: 1 });
  const afterFailure = await cacheOsmEnrichment(store, "route-a", geoData(0, 4, "gravel", { availability: "unknown", retrievalRanges: [], unavailableRanges: [{ startDistanceKm: 0, endDistanceKm: 4 }] }), 10, { now: 2 });
  assert.equal(afterFailure.classifiableCoveragePercent, 40);
  assert.equal(afterFailure.mergedData.segments[0].surface.value, "gravel");
  assert.deepEqual(afterFailure.unavailableRanges, []);
});

test("failed OSM subrange remains unavailable while supported evidence is retained", async () => {
  const store = new MemoryStore();
  const data = geoData(0, 2, "gravel", { retrievalRanges: [{ startDistanceKm: 0, endDistanceKm: 2 }], unavailableRanges: [{ startDistanceKm: 2, endDistanceKm: 8 }] });
  const record = await cacheOsmEnrichment(store, "route-a", data, 10, { now: 1 });
  assert.deepEqual(record.retrievedRanges, [{ startDistanceKm: 0, endDistanceKm: 2, segmentIndex: 0 }]);
  assert.deepEqual(record.unavailableRanges, [{ startDistanceKm: 2, endDistanceKm: 8, segmentIndex: 0 }]);
  assert.equal(record.mergedData.segments.length, 1);
  assert.equal(record.classifiableCoveragePercent, 20);
});

test("conflicting OSM surface snapshots are retained and winner is deterministic", async () => {
  const store = new MemoryStore();
  await cacheOsmEnrichment(store, "route-a", geoData(0, 4, "gravel"), 10, { now: 1 });
  const record = await cacheOsmEnrichment(store, "route-a", geoData(0, 4, "asphalt"), 10, { now: 2 });
  assert.equal(record.conflicts.length, 1);
  assert.deepEqual(record.conflicts[0].alternatives.map(({ surface }) => surface).sort(), ["asphalt", "gravel"]);
  assert.equal(record.mergedData.segments[0].surface.value, "asphalt");
});

test("OSM schema version is an independent cache key", async () => {
  const store = new MemoryStore();
  await cacheOsmEnrichment(store, "route-a", geoData(0, 2), 10);
  assert.ok(await store.getOsm("route-a", 2, OSM_ENRICHMENT_VERSION));
  assert.equal(await store.getOsm("route-a", 2, OSM_ENRICHMENT_VERSION + 1), null);
});

test("Mapillary evidence cache remains independent from OSM records", async () => {
  const store = new MemoryStore();
  const data = { source: { type: "mapillary", name: "Mapillary", attribution: "© Mapillary" }, sections: [{ id: "s1", availability: "not-found", images: [] }] };
  const record = await cacheMapillaryEnrichment(store, "route-a", data, { now: 5 });
  assert.equal(hasReusableMapillaryEvidence(record), true);
  assert.equal(await store.getOsm("route-a", 2, OSM_ENRICHMENT_VERSION), null);
  assert.equal((await store.getMapillary("route-a", 2, record.schemaVersion)).data.sections[0].availability, "not-found");
});

test("OSM writes do not modify an existing independent Mapillary cache", async () => {
  const store = new MemoryStore();
  const data = { source: { type: "mapillary", name: "Mapillary", attribution: "© Mapillary" }, sections: [{ id: "s1", availability: "not-found", images: [] }] };
  await cacheMapillaryEnrichment(store, "route-a", data);
  await cacheOsmEnrichment(store, "route-a", geoData(0, 2), 10);
  assert.equal((await store.getMapillary("route-a", 2, 1)).data.sections[0].availability, "not-found");
});

test("Mapillary unknown response cannot erase previously cached available images", async () => {
  const store = new MemoryStore();
  const image = { id: "image-1", latitude: 45, longitude: 13, distanceAlongRouteKm: 1, capturedAt: null, sequenceId: null, thumbnailUrl: null, sourceUrl: "https://www.mapillary.com/app/?pKey=image-1" };
  await cacheMapillaryEnrichment(store, "route-a", { source: { type: "mapillary", name: "Mapillary", attribution: "© Mapillary" }, sections: [{ id: "s1", availability: "available", images: [image] }] }, { now: 1 });
  const latest = await cacheMapillaryEnrichment(store, "route-a", { source: { type: "mapillary", name: "Mapillary", attribution: "© Mapillary" }, sections: [{ id: "s1", availability: "unknown", images: [] }] }, { now: 2 });
  assert.equal(latest.data.sections[0].availability, "available");
  assert.equal(latest.data.sections[0].images[0].id, "image-1");
});

test("Mapillary imagery remains reusable across Route Analysis versions", async () => {
  const image = { id: "image-1", latitude: 45, longitude: 13, distanceAlongRouteKm: 3, capturedAt: null, sequenceId: null, thumbnailUrl: null, sourceUrl: "https://www.mapillary.com/app/?pKey=image-1" };
  const record = { schemaVersion: 1, data: { source: { type: "mapillary", name: "Mapillary", attribution: "© Mapillary" }, sections: [{ id: "old", availability: "available", images: [image] }] } };
  const mapped = mapMapillaryEvidenceToSections(record, [{ id: "new", startKm: 2, endKm: 4 }]);
  const laterAnalysis = mapMapillaryEvidenceToSections(record, [{ id: "later", startKm: 2, endKm: 4 }]);
  assert.equal(mapped.sections[0].id, "new");
  assert.equal(mapped.sections[0].images[0].id, "image-1");
  assert.equal(laterAnalysis.sections[0].images[0].id, "image-1");
  assert.equal("analysisVersion" in record, false);
});

test("race edition associations remain a separate optional relationship store", async () => {
  const store = new MemoryStore();
  const routeFingerprint = (await createRouteFingerprint(line())).routeFingerprint;
  const firstEdition = { raceId: "some-race", raceName: "Some Race", year: 2029, routeFingerprint, routeFingerprintVersion: 2, createdAt: 1 };
  const nextEdition = { raceId: "some-race", raceName: "Some Race", year: 2030, routeFingerprint, routeFingerprintVersion: 2, createdAt: 2 };
  await store.putRaceEditionReference(firstEdition);
  await store.putRaceEditionReference(nextEdition);
  assert.deepEqual(await store.getRaceEditionReference("some-race", 2029), firstEdition);
  assert.deepEqual(await store.getRaceEditionReference("some-race", 2030), nextEdition);
  assert.equal(await store.getRaceEditionReference("other-race", 2030), null);
});

test("repeated persistence merge does not mutate its previous OSM record", async () => {
  const store = new MemoryStore();
  const original = await cacheOsmEnrichment(store, "route-a", geoData(0, 2), 10, { now: 1 });
  const oldTime = original.snapshots[0].retrievedAt;
  await cacheOsmEnrichment(store, "route-a", geoData(0, 2), 10, { now: 5 });
  assert.equal(original.snapshots[0].retrievedAt, oldTime);
});
