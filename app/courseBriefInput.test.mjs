import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { buildCourseBriefInput } from "./courseBriefInput.ts";
import { analyzeGpxRoute, parseGpxText } from "./gpxAnalysis.ts";
import { createRouteKeyMoments, selectStructuredRouteKeyMomentEvents } from "./routeKeyMoments.ts";

const OPTIONS = { analysisVersion: 2 };

function makeAnalysis({
  components = [{ segmentIndex: 0, startDistanceM: 0, endDistanceM: 900, elevations: [100, 110] }],
  profile,
  events = [],
  sections = [],
} = {}) {
  const analyzedSegments = [];
  const points = [];
  for (const component of components) {
    const segmentPoints = component.elevations.map((elevationM, index) => {
      const ratio = component.elevations.length > 1 ? index / (component.elevations.length - 1) : 0;
      return {
        latitude: 45 + component.segmentIndex * 0.01,
        longitude: 13 + index * 0.001,
        elevationM,
        distanceM: component.startDistanceM + (component.endDistanceM - component.startDistanceM) * ratio,
        segmentIndex: component.segmentIndex,
      };
    });
    points.push(...segmentPoints);
    analyzedSegments.push({
      segmentIndex: component.segmentIndex,
      startDistanceM: component.startDistanceM,
      endDistanceM: component.endDistanceM,
      points: segmentPoints,
    });
  }

  const totalDistanceM = points.at(-1)?.distanceM ?? 0;
  let rawGainM = 0;
  let rawLossM = 0;
  for (const component of analyzedSegments) {
    for (let index = 1; index < component.points.length; index += 1) {
      const change = component.points[index].elevationM - component.points[index - 1].elevationM;
      if (change > 0) rawGainM += change;
      else rawLossM += Math.abs(change);
    }
  }
  const highest = points.reduce((best, point) => point.elevationM > best.elevationM ? point : best);
  const lowest = points.reduce((best, point) => point.elevationM < best.elevationM ? point : best);
  const resampledPoints = profile ?? analyzedSegments.flatMap((segment) => segment.points.map((point) => ({
    distanceM: point.distanceM,
    segmentIndex: point.segmentIndex,
    elevationM: point.elevationM,
    smoothedElevationM: point.elevationM,
  })));

  return {
    name: "private-upload-name.gpx",
    points,
    segments: analyzedSegments,
    metrics: {
      distanceKm: Number((totalDistanceM / 1000).toFixed(2)),
      elevationGainM: Math.round(rawGainM),
      elevationLossM: Math.round(rawLossM),
      highestPointM: highest.elevationM,
      highestPointDistanceKm: Number((highest.distanceM / 1000).toFixed(1)),
      lowestPointM: lowest.elevationM,
    },
    routeDynamics: { totalDistanceKm: totalDistanceM / 1000, resampledPoints, samples: [], events },
    routeSections: sections,
  };
}

function makeSection({
  segmentIndex = 0,
  startDistanceM = 0,
  endDistanceM = 900,
  rhythm = "climb",
  ascentM = 80,
  descentM = 10,
  id = "route-section-1",
  staleTerrainEvidence,
} = {}) {
  return {
    id,
    segmentIndex,
    startPosition: { distanceM: startDistanceM, segmentIndex },
    endPosition: { distanceM: endDistanceM, segmentIndex },
    startKm: Number((startDistanceM / 1000).toFixed(2)),
    endKm: Number((endDistanceM / 1000).toFixed(2)),
    distanceKm: Number(((endDistanceM - startDistanceM) / 1000).toFixed(2)),
    dominantRhythm: rhythm,
    ascentM,
    descentM,
    elevationStartM: 100,
    elevationEndM: 180,
    elevationMinM: 100,
    elevationMaxM: 180,
    elevationProfile: [],
    embeddedEvents: [],
    dynamicsSummary: { verticalIntensityMPerKm: 0, directionBalance: 0, directionStrength: 0, stability: 0 },
    description: "Test description that must not be serialized.",
    ...(staleTerrainEvidence ? {
      terrainEvidenceExactCoveragePercent: 0,
      terrainEvidenceCoveragePercent: 0,
      terrainEvidence: [{ terrain: "paved", evidenceSharePercent: 100, provenance: "osm" }],
    } : {}),
    mapData: [{ latitude: 45, longitude: 13, elevationM: 100, distanceM: startDistanceM, segmentIndex }],
    mapillaryEvidence: { availability: "available", imageCount: 4 },
  };
}

function makeEvent({ id, segmentIndex = 0, rhythm, startKm, endKm, ascentM = 0, descentM = 0 }) {
  return {
    id,
    segmentIndex,
    startKm,
    endKm,
    startPosition: { distanceM: startKm * 1000, segmentIndex },
    endPosition: { distanceM: endKm * 1000, segmentIndex },
    rhythm,
    ascentM,
    descentM,
    netElevationM: ascentM - descentM,
    gradientPct: 0,
    verticalIntensity: 0,
    directionBalance: 0,
    directionStrength: 0,
    persistence: 1,
    significance: 0.5,
    confidence: 1,
  };
}

function profile(values, segmentIndex = 0) {
  return values.map(([distanceM, smoothedElevationM]) => ({
    distanceM,
    segmentIndex,
    elevationM: smoothedElevationM,
    smoothedElevationM,
  }));
}

function makeOsmData(segments, availability = "available") {
  const unavailableValue = {
    value: null,
    rawValue: null,
    provenance: "osm",
    availability: "not-found",
  };
  return {
    source: { type: "osm", name: "OpenStreetMap" },
    availability,
    segments: segments.map(({ id, segmentIndex = 0, startKm, endKm, surface = "gravel", evidenceCoverage = 1 }) => ({
      id,
      segmentIndex,
      startDistanceKm: startKm,
      endDistanceKm: endKm,
      lengthKm: endKm - startKm,
      evidenceCoverage,
      matchQuality: "high",
      osmWays: [{ source: "OpenStreetMap", sourceId: "way/private-test", segmentIndex, tags: { surface }, geometry: [{ latitude: 45, longitude: 13 }], startDistanceKm: startKm, endDistanceKm: endKm, matchQuality: "high" }],
      surface: { value: surface, rawValue: surface, provenance: "osm", availability: "available" },
      pathType: unavailableValue,
      trackCondition: unavailableValue,
      smoothness: unavailableValue,
      hikingDifficulty: unavailableValue,
      trailVisibility: unavailableValue,
      incline: unavailableValue,
      width: unavailableValue,
      informal: unavailableValue,
      trailblazed: unavailableValue,
      assistedTrail: unavailableValue,
    })),
    matchedRoutePercent: 100,
    attribution: "© OpenStreetMap contributors",
  };
}

function build(analysis, osm) {
  return buildCourseBriefInput(analysis, { ...OPTIONS, ...(osm ? { osm } : {}) });
}

test("CourseBriefInput is deterministic and does not mutate analysis", () => {
  const analysis = makeAnalysis({ sections: [makeSection()] });
  const before = structuredClone(analysis);
  const first = build(analysis);
  const second = build(analysis);
  assert.deepEqual(first, second);
  assert.deepEqual(analysis, before);
  assert.equal(first.schemaVersion, 1);
  assert.equal(first.analysisVersion, 2);
});

test("direct route facts retain metrics, first extrema positions, and component identity", () => {
  const analysis = makeAnalysis({
    components: [
      { segmentIndex: 0, startDistanceM: 0, endDistanceM: 400, elevations: [100, 120] },
      { segmentIndex: 1, startDistanceM: 400, endDistanceM: 800, elevations: [100, 120] },
      { segmentIndex: 2, startDistanceM: 800, endDistanceM: 800, elevations: [90] },
      { segmentIndex: 3, startDistanceM: 800, endDistanceM: 800, elevations: [] },
      { segmentIndex: 4, startDistanceM: 800, endDistanceM: 800, elevations: [95, 95] },
    ],
  });
  const result = build(analysis);
  assert.deepEqual(result.directFacts.distance, { factId: "route.distance", value: { km: 0.8 } });
  assert.equal(result.directFacts.rawGain.value.m, 40);
  assert.equal(result.directFacts.rawLoss.value.m, 0);
  assert.deepEqual(result.directFacts.highest.value, { elevationM: 120, atKm: 0.4, segmentIndex: 0 });
  assert.deepEqual(result.directFacts.lowest.value, { elevationM: 90, atKm: 0.8, segmentIndex: 2 });
  assert.deepEqual(result.directFacts.components.map(({ factId, segmentIndex, startKm, endKm, traversedDistanceKm, hasTraversedDistance }) => [
    factId, segmentIndex, startKm, endKm, traversedDistanceKm, hasTraversedDistance,
  ]), [
    ["route.component.0", 0, 0, 0.4, 0.4, true],
    ["route.component.1", 1, 0.4, 0.8, 0.4, true],
    ["route.component.2", 2, 0.8, 0.8, 0, false],
    ["route.component.3", 3, 0.8, 0.8, 0, false],
    ["route.component.4", 4, 0.8, 0.8, 0, false],
  ]);
});

test("extreme ties keep the first point in ordered component data", () => {
  const analysis = makeAnalysis({ components: [
    { segmentIndex: 3, startDistanceM: 0, endDistanceM: 50, elevations: [70, 150] },
    { segmentIndex: 4, startDistanceM: 50, endDistanceM: 100, elevations: [70, 150] },
  ] });
  const result = build(analysis);
  assert.equal(result.directFacts.highest.value.segmentIndex, 3);
  assert.equal(result.directFacts.lowest.value.segmentIndex, 3);
});

test("vertical progression allocates climbing to early, middle, and late thirds", () => {
  const cases = [
    { expected: "early", values: [[0, 0], [300, 300], [600, 300], [900, 300]] },
    { expected: "middle", values: [[0, 0], [300, 0], [600, 300], [900, 300]] },
    { expected: "late", values: [[0, 0], [300, 0], [600, 0], [900, 300]] },
  ];
  for (const { expected, values } of cases) {
    const result = build(makeAnalysis({ profile: profile(values) })).derivedFacts.verticalProgression;
    assert.ok(result);
    assert.equal(result[expected].gainM, 300);
    assert.deepEqual([result.early.gainM, result.middle.gainM, result.late.gainM].filter((gain) => gain > 0), [300]);
    assert.equal(result.basis, "route-dynamics-smoothed-profile");
  }
});

test("vertical progression allocates descending profile loss by course third", () => {
  const values = [[0, 900], [300, 900], [600, 600], [900, 600]];
  const result = build(makeAnalysis({ profile: profile(values) })).derivedFacts.verticalProgression;
  assert.ok(result);
  assert.equal(result.middle.lossM, 300);
  assert.equal(result.early.lossM + result.middle.lossM + result.late.lossM, 300);
});

test("vertical progression splits edges at exact third boundaries without double counting", () => {
  const atBoundaries = build(makeAnalysis({ profile: profile([[0, 0], [300, 30], [600, 60], [900, 90]]) })).derivedFacts.verticalProgression;
  assert.ok(atBoundaries);
  assert.deepEqual([atBoundaries.early.gainM, atBoundaries.middle.gainM, atBoundaries.late.gainM], [30, 30, 30]);

  const crossingBothBoundaries = build(makeAnalysis({ profile: profile([[0, 0], [900, 90]]) })).derivedFacts.verticalProgression;
  assert.ok(crossingBothBoundaries);
  assert.deepEqual([crossingBothBoundaries.early.gainM, crossingBothBoundaries.middle.gainM, crossingBothBoundaries.late.gainM], [30, 30, 30]);
});

test("progression bins reconcile exactly with same-component profile edge totals", () => {
  const routeProfile = profile([[0, 0], [500, 500], [900, 200]]);
  const result = build(makeAnalysis({ profile: routeProfile })).derivedFacts.verticalProgression;
  assert.ok(result);
  const profileGain = 500;
  const profileLoss = 300;
  assert.equal(result.early.gainM + result.middle.gainM + result.late.gainM, profileGain);
  assert.equal(result.early.lossM + result.middle.lossM + result.late.lossM, profileLoss);
});

test("flat, short, and sparse profiles use the same progression rule", () => {
  const flat = build(makeAnalysis({ profile: profile([[0, 100], [5, 100]]) })).derivedFacts.verticalProgression;
  assert.ok(flat);
  assert.deepEqual([flat.early.gainM, flat.middle.gainM, flat.late.gainM, flat.early.lossM, flat.middle.lossM, flat.late.lossM], [0, 0, 0, 0, 0, 0]);

  const short = build(makeAnalysis({
    components: [{ segmentIndex: 0, startDistanceM: 0, endDistanceM: 50, elevations: [100, 125] }],
    profile: profile([[0, 100], [50, 125]]),
  })).derivedFacts.verticalProgression;
  assert.ok(short);
  assert.equal(short.early.gainM + short.middle.gainM + short.late.gainM, 25);

  const sparse = build(makeAnalysis({ profile: profile([[0, 0], [900, 90]]) })).derivedFacts.verticalProgression;
  assert.ok(sparse);
  assert.equal(sparse.early.gainM + sparse.middle.gainM + sparse.late.gainM, 90);
});

test("disconnected components do not bridge smoothed profile elevation gaps", () => {
  const analysis = makeAnalysis({
    components: [
      { segmentIndex: 0, startDistanceM: 0, endDistanceM: 400, elevations: [100, 110] },
      { segmentIndex: 1, startDistanceM: 400, endDistanceM: 900, elevations: [900, 890] },
    ],
    profile: [
      ...profile([[0, 100], [400, 110]], 0),
      ...profile([[400, 900], [900, 890]], 1),
    ],
  });
  const result = build(analysis).derivedFacts.verticalProgression;
  assert.ok(result);
  assert.equal(result.early.gainM + result.middle.gainM + result.late.gainM, 10);
  assert.equal(result.early.lossM + result.middle.lossM + result.late.lossM, 10);
});

test("vertical progression is null without a usable profile edge", () => {
  const analysis = makeAnalysis({ profile: [] });
  assert.equal(build(analysis).derivedFacts.verticalProgression, null);
});

test("structured Key Moments select longest and largest events independently", () => {
  const events = [
    makeEvent({ id: "segment-0-dynamic-event-1", rhythm: "climb", startKm: 1, endKm: 5, ascentM: 100 }),
    makeEvent({ id: "segment-0-dynamic-event-2", rhythm: "climb", startKm: 6, endKm: 8, ascentM: 250 }),
    makeEvent({ id: "segment-0-dynamic-event-3", rhythm: "descent", startKm: 9, endKm: 13, descentM: 80 }),
    makeEvent({ id: "segment-0-dynamic-event-4", rhythm: "descent", startKm: 14, endKm: 16, descentM: 240 }),
  ];
  const analysis = makeAnalysis({ events });
  const facts = build(analysis).derivedFacts.keyMoments;
  assert.deepEqual(facts.map(({ kind, roles }) => [kind, roles]), [
    ["climb", ["longest"]],
    ["climb", ["largest"]],
    ["descent", ["longest"]],
    ["descent", ["largest"]],
  ]);
  assert.deepEqual(facts.map(({ segmentIndex, startKm, endKm, distanceKm, elevationChangeM }) => [segmentIndex, startKm, endKm, distanceKm, elevationChangeM]), [
    [0, 1, 5, 4, 100], [0, 6, 8, 2, 250], [0, 9, 13, 4, 80], [0, 14, 16, 2, 240],
  ]);
});

test("one event winning both climb roles is returned once with ordered roles", () => {
  const event = makeEvent({ id: "segment-2-dynamic-event-8", segmentIndex: 2, rhythm: "climb", startKm: 2, endKm: 4, ascentM: 80 });
  const facts = selectStructuredRouteKeyMomentEvents({ events: [event], totalDistanceKm: 4, resampledPoints: [], samples: [] });
  assert.equal(facts.length, 1);
  assert.deepEqual(facts[0].roles, ["longest", "largest"]);
  assert.equal(facts[0].segmentIndex, 2);
  assert.match(facts[0].factId, /^key\.climb\.s2\./);
});

test("one event winning both descent roles is returned once with ordered roles", () => {
  const event = makeEvent({ id: "segment-1-dynamic-event-3", segmentIndex: 1, rhythm: "descent", startKm: 2, endKm: 4, descentM: 80 });
  const facts = selectStructuredRouteKeyMomentEvents({ events: [event], totalDistanceKm: 4, resampledPoints: [], samples: [] });
  assert.equal(facts.length, 1);
  assert.deepEqual(facts[0].roles, ["longest", "largest"]);
  assert.equal(facts[0].elevationChangeM, 80);
});

test("event ties keep first event order and absent directions are omitted", () => {
  const first = makeEvent({ id: "segment-4-dynamic-event-2", segmentIndex: 4, rhythm: "climb", startKm: 0, endKm: 2, ascentM: 50 });
  const second = makeEvent({ id: "segment-5-dynamic-event-1", segmentIndex: 5, rhythm: "climb", startKm: 2, endKm: 4, ascentM: 50 });
  const facts = selectStructuredRouteKeyMomentEvents({ events: [first, second], totalDistanceKm: 4, resampledPoints: [], samples: [] });
  assert.equal(facts.length, 1);
  assert.equal(facts[0].segmentIndex, 4);
  assert.deepEqual(facts[0].roles, ["longest", "largest"]);
  assert.equal(selectStructuredRouteKeyMomentEvents({ events: [], totalDistanceKm: 0, resampledPoints: [], samples: [] }).length, 0);
});

test("existing Key Moment creation uses structured event selection and only deduplicates identical winners", () => {
  const same = makeEvent({ id: "segment-0-dynamic-event-1", rhythm: "climb", startKm: 1, endKm: 4, ascentM: 120 });
  const sameAnalysis = makeAnalysis({ events: [same] });
  const sameStructured = selectStructuredRouteKeyMomentEvents(sameAnalysis.routeDynamics);
  const sameUi = createRouteKeyMoments(sameAnalysis.points, sameAnalysis.metrics, sameAnalysis.routeDynamics);
  assert.equal(sameStructured.length, 1);
  assert.deepEqual(sameStructured[0].roles, ["longest", "largest"]);
  assert.equal(sameUi.filter(({ title }) => title === "Longest and biggest climb").length, 1);

  const distinctAnalysis = makeAnalysis({ events: [
    makeEvent({ id: "segment-0-dynamic-event-1", rhythm: "climb", startKm: 1, endKm: 5, ascentM: 100 }),
    makeEvent({ id: "segment-0-dynamic-event-2", rhythm: "climb", startKm: 6, endKm: 8, ascentM: 250 }),
  ] });
  const distinctUi = createRouteKeyMoments(distinctAnalysis.points, distinctAnalysis.metrics, distinctAnalysis.routeDynamics);
  assert.equal(distinctUi.filter(({ title }) => title === "Longest climb").length, 1);
  assert.equal(distinctUi.filter(({ title }) => title === "Biggest climb").length, 1);
});

test("Route Section facts keep global course order and ordinals out of fact IDs", () => {
  const sections = [
    makeSection({ segmentIndex: 0, startDistanceM: 0, endDistanceM: 400, id: "route-section-1" }),
    makeSection({ segmentIndex: 1, startDistanceM: 400, endDistanceM: 900, rhythm: "descent", id: "route-section-1" }),
  ];
  const result = build(makeAnalysis({ sections }));
  assert.deepEqual(result.derivedFacts.sections.map(({ ordinal, segmentIndex }) => [ordinal, segmentIndex]), [[1, 0], [2, 1]]);
  assert.match(result.derivedFacts.sections[0].factId, /^section\.s0\.m0-400\.climb$/);
  assert.match(result.derivedFacts.sections[1].factId, /^section\.s1\.m400-900\.descent$/);
  const changedOrderMetadata = build(makeAnalysis({ sections: sections.slice(1) })).derivedFacts.sections[0];
  assert.equal(changedOrderMetadata.factId, result.derivedFacts.sections[1].factId);
  assert.equal(changedOrderMetadata.ordinal, 1);
  assert.deepEqual(build(makeAnalysis({ sections: [] })).derivedFacts.sections, []);

  const decimalPositionSection = makeSection({ startDistanceM: 12.5, endDistanceM: 120.25 });
  assert.match(build(makeAnalysis({ sections: [decimalPositionSection] })).derivedFacts.sections[0].factId, /^section\.s0\.m12p5-120p25\.climb$/);
  const negativeZeroSection = makeSection({ startDistanceM: -0, endDistanceM: 120.25 });
  const positiveZeroSection = makeSection({ startDistanceM: 0, endDistanceM: 120.25 });
  assert.equal(
    build(makeAnalysis({ sections: [negativeZeroSection] })).derivedFacts.sections[0].factId,
    build(makeAnalysis({ sections: [positiveZeroSection] })).derivedFacts.sections[0].factId,
  );
});

test("CourseBriefInput projects the real GPX analysis output without race or upload metadata", async () => {
  const gpx = await readFile(new URL("../public/ISTRIA_110K_2027.gpx", import.meta.url), "utf8");
  const parsed = parseGpxText(gpx);
  const analysis = analyzeGpxRoute(parsed);
  const result = buildCourseBriefInput(analysis, OPTIONS);
  assert.equal(result.directFacts.distance.value.km, analysis.metrics.distanceKm);
  assert.equal(result.directFacts.rawGain.value.m, analysis.metrics.elevationGainM);
  assert.ok(result.derivedFacts.sections.length > 0);
  assert.equal(result.directFacts.components.length, parsed.segments.length);
  assert.equal("name" in result, false);
  assert.equal(JSON.stringify(result).includes("latitude"), false);
});

test("OSM not-requested, unavailable, unknown, and not-found states remain distinct", () => {
  const analysis = makeAnalysis({ sections: [makeSection()] });
  const notRequested = build(analysis).evidenceScopedFacts.osmSurface;
  assert.equal(notRequested.requestState, "not-requested");
  assert.equal(notRequested.sections[0].status, "not-requested");
  assert.equal(notRequested.sections[0].classifiableCoveragePercent, null);

  const unavailable = build(analysis, { requestState: "unavailable" }).evidenceScopedFacts.osmSurface;
  assert.equal(unavailable.sections[0].status, "unavailable");
  assert.equal(unavailable.responseAvailability, null);

  const unknown = build(analysis, { requestState: "received", data: makeOsmData([], "unknown") }).evidenceScopedFacts.osmSurface;
  assert.equal(unknown.responseAvailability, "unknown");
  assert.equal(unknown.sections[0].status, "missing");

  const notFound = build(analysis, { requestState: "received", data: makeOsmData([], "not-found") }).evidenceScopedFacts.osmSurface;
  assert.equal(notFound.responseAvailability, "not-found");
  assert.equal(notFound.sections[0].status, "missing");
});

test("received zero coverage suppresses stale terrain categories", () => {
  const analysis = makeAnalysis({ sections: [makeSection({ staleTerrainEvidence: true })] });
  const result = build(analysis, { requestState: "received", data: makeOsmData([]) }).evidenceScopedFacts.osmSurface.sections[0];
  assert.equal(result.status, "missing");
  assert.equal(result.classifiableCoveragePercent, 0);
  assert.deepEqual(result.categories, []);
});

test("positive sub-one-percent surface coverage remains exact and scoped", () => {
  const analysis = makeAnalysis({
    components: [{ segmentIndex: 0, startDistanceM: 0, endDistanceM: 10000, elevations: [100, 110] }],
    sections: [makeSection({ startDistanceM: 0, endDistanceM: 10000 })],
  });
  const surface = build(analysis, {
    requestState: "received",
    data: makeOsmData([{ id: "tiny", startKm: 0, endKm: 0.04, surface: "gravel" }]),
  }).evidenceScopedFacts.osmSurface.sections[0];
  assert.equal(surface.status, "partial");
  assert.ok(surface.classifiableCoveragePercent > 0 && surface.classifiableCoveragePercent < 1);
  assert.deepEqual(surface.categories, [{ category: "gravel", shareOfClassifiableEvidencePercent: 100 }]);
});

test("partial and complete surface categories retain classifiable-evidence scope", () => {
  const analysis = makeAnalysis({
    components: [{ segmentIndex: 0, startDistanceM: 0, endDistanceM: 10000, elevations: [100, 110] }],
    sections: [makeSection({ startDistanceM: 0, endDistanceM: 10000 })],
  });
  const partial = build(analysis, {
    requestState: "received",
    data: makeOsmData([{ id: "partial", startKm: 0, endKm: 4, surface: "paved" }]),
  }).evidenceScopedFacts.osmSurface.sections[0];
  assert.equal(partial.status, "partial");
  assert.equal(partial.classifiableCoveragePercent, 40);
  assert.deepEqual(partial.categories, [{ category: "paved", shareOfClassifiableEvidencePercent: 100 }]);

  const mapped = build(analysis, {
    requestState: "received",
    data: makeOsmData([{ id: "full", startKm: 0, endKm: 10, surface: "gravel" }]),
  }).evidenceScopedFacts.osmSurface.sections[0];
  assert.equal(mapped.status, "mapped");
  assert.equal(mapped.classifiableCoveragePercent, 100);
  assert.deepEqual(mapped.categories, [{ category: "gravel", shareOfClassifiableEvidencePercent: 100 }]);
});

test("equal kilometer OSM ranges remain isolated by segment index", () => {
  const analysis = makeAnalysis({
    components: [
      { segmentIndex: 0, startDistanceM: 0, endDistanceM: 10000, elevations: [100, 110] },
      { segmentIndex: 1, startDistanceM: 0, endDistanceM: 10000, elevations: [800, 810] },
    ],
    sections: [
      makeSection({ segmentIndex: 0, startDistanceM: 0, endDistanceM: 10000 }),
      makeSection({ segmentIndex: 1, startDistanceM: 0, endDistanceM: 10000, rhythm: "descent" }),
    ],
  });
  const surface = build(analysis, {
    requestState: "received",
    data: makeOsmData([
      { id: "first", segmentIndex: 0, startKm: 0, endKm: 10, surface: "paved" },
      { id: "second", segmentIndex: 1, startKm: 0, endKm: 10, surface: "gravel" },
    ]),
  }).evidenceScopedFacts.osmSurface.sections;
  assert.deepEqual(surface.map(({ classifiableCoveragePercent, categories }) => [classifiableCoveragePercent, categories[0]?.category]), [
    [100, "paved"], [100, "gravel"],
  ]);
});

test("serialized CourseBriefInput excludes route identity, geometry, names, images, and raw OSM tags", () => {
  const analysis = makeAnalysis({ sections: [makeSection()] });
  const result = build(analysis, { requestState: "received", data: makeOsmData([{ id: "private", startKm: 0, endKm: 0.9 }]) });
  const serialized = JSON.stringify(result);
  for (const forbidden of [
    "latitude", "longitude", "private-upload-name.gpx", "route name", "<gpx", "thumbnailUrl",
    "Mapillary", "way/private-test", "\"tags\"", "raceContext", "POSTGRES_URL",
  ]) assert.equal(serialized.includes(forbidden), false, `unexpected serialized field/content: ${forbidden}`);
});
