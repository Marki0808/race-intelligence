import assert from "node:assert/strict";
import test from "node:test";
import { analyzeRouteDynamics } from "./routeDynamics.ts";
import { buildRouteSections, consolidateRoutePhases, mergeRoutePhases } from "./routeSectionEngine.ts";
import { createRouteKeyMoments } from "./routeKeyMoments.ts";
import { attachTerrainEvidenceToRouteSections } from "./routeEvidenceAdapter.ts";

function makeRoute(parts, { spacingM = 100, noise = 0 } = {}) {
  const points = [{ latitude: 45, longitude: 13, elevationM: 100, distanceM: 0 }];
  let distanceM = 0;
  let elevationM = 100;
  for (const [distanceKm, deltaM] of parts) {
    const steps = Math.round(distanceKm * 1000 / spacingM);
    const startElevationM = elevationM;
    for (let index = 1; index <= steps; index += 1) {
      distanceM += spacingM;
      const wiggle = noise ? Math.sin(distanceM / 37) * noise + Math.cos(distanceM / 19) * noise / 2 : 0;
      points.push({
        latitude: 45 + distanceM / 111_000,
        longitude: 13,
        elevationM: startElevationM + deltaM * index / steps + wiggle,
        distanceM,
      });
    }
    elevationM += deltaM;
  }
  return points;
}

const sectionsFor = (parts, options) => {
  const points = makeRoute(parts, options);
  const dynamics = analyzeRouteDynamics(points);
  return { points, dynamics, sections: buildRouteSections(dynamics, points) };
};

function explicitPhases(specs) {
  const samples = [];
  const resampledPoints = [];
  const phases = [];
  const events = [];
  let distanceM = 0;
  let elevationM = 100;
  samples.push(makeDynamicSample(distanceM, elevationM, "transition", 0, 0));
  resampledPoints.push({ distanceM, elevationM, smoothedElevationM: elevationM });

  for (const [phaseIndex, spec] of specs.entries()) {
    const steps = Math.round(spec.distanceKm * 10);
    const startIndex = samples.length - 1;
    const positiveSteps = Math.ceil(steps / 2);
    const negativeSteps = Math.floor(steps / 2);
    for (let step = 1; step <= steps; step += 1) {
      let change = 0;
      if (spec.rhythm === "climb") change = (spec.ascentM ?? 0) / steps;
      else if (spec.rhythm === "descent") change = -(spec.descentM ?? 0) / steps;
      else if (spec.rhythm === "rolling") change = step % 2
        ? (spec.ascentM ?? 0) / positiveSteps
        : -(spec.descentM ?? 0) / negativeSteps;
      distanceM += 100;
      elevationM += change;
      samples.push(makeDynamicSample(distanceM, elevationM, spec.rhythm, spec.ascentM ?? 0, spec.descentM ?? 0));
      resampledPoints.push({ distanceM, elevationM, smoothedElevationM: elevationM });
    }
    const endIndex = samples.length - 1;
    phases.push({ rhythm: spec.rhythm, startIndex, endIndex });
    events.push({
      id: `fixture-event-${phaseIndex}`,
      startKm: phases.at(-1).startIndex / 10,
      endKm: endIndex / 10,
      rhythm: spec.rhythm,
      ascentM: spec.ascentM ?? 0,
      descentM: spec.descentM ?? 0,
      netElevationM: (spec.ascentM ?? 0) - (spec.descentM ?? 0),
      gradientPct: 0,
      verticalIntensity: ((spec.ascentM ?? 0) + (spec.descentM ?? 0)) / spec.distanceKm,
      directionBalance: 0,
      directionStrength: 0,
      persistence: 1,
      significance: 0.1,
      confidence: 0.9,
    });
  }
  return {
    phases,
    dynamics: { totalDistanceKm: distanceM / 1000, samples, resampledPoints, events },
  };
}

function makeDynamicSample(distanceM, elevationM, rhythm, ascentM, descentM) {
  const vertical = ascentM + descentM;
  const directionBalance = vertical ? (ascentM - descentM) / vertical : 0;
  const metrics = {
    verticalIntensityMPerKm: vertical,
    directionStrength: Math.abs(directionBalance),
    directionBalance,
    directionChanges: rhythm === "rolling" ? 4 : 0,
    rhythm,
  };
  return { distanceM, elevationM, smoothedElevationM: elevationM, short: metrics, medium: metrics, long: metrics, rhythm, stability: 0.9 };
}

test("pure climb is a stable climbing Route Section", () => {
  const { sections } = sectionsFor([[10, 500]]);
  assert.equal(sections.length, 1);
  assert.equal(sections[0].dominantRhythm, "climb");
  assert.ok(sections[0].ascentM > sections[0].descentM * 5);
});

test("pure descent is a stable descending Route Section", () => {
  const { sections } = sectionsFor([[10, -500]]);
  assert.equal(sections.length, 1);
  assert.equal(sections[0].dominantRhythm, "descent");
});

test("balanced repeated direction changes are classified as rolling", () => {
  const { sections } = sectionsFor([[1, 100], [1, -80], [1, 120], [1, -90]]);
  assert.equal(sections.length, 1);
  assert.equal(sections[0].dominantRhythm, "rolling");
});

test("a locally rolling phase with a strongly directional whole profile is reconciled", () => {
  const elevations = [100, 101, 100, 101, 98, 99, 90, 75, 66, 60, 54, 48, 42, 36, 30, 24, 18];
  const dynamics = {
    totalDistanceKm: 1.6,
    resampledPoints: elevations.map((elevationM, index) => ({ distanceM: index * 100, elevationM, smoothedElevationM: elevationM })),
    samples: elevations.map((elevationM, index) => ({
      distanceM: index * 100,
      elevationM,
      smoothedElevationM: elevationM,
      short: { verticalIntensityMPerKm: 45, directionStrength: 0.3, directionBalance: -0.3 },
      medium: { verticalIntensityMPerKm: 45, directionStrength: 0.3, directionBalance: -0.3 },
      long: { verticalIntensityMPerKm: 45, directionStrength: 0.3, directionBalance: -0.3 },
      stability: 0.8,
    })),
    events: [],
  };
  const phases = mergeRoutePhases([
    { rhythm: "rolling", startIndex: 0, endIndex: 8 },
    { rhythm: "descent", startIndex: 8, endIndex: 16 },
  ], dynamics);
  assert.deepEqual(phases, [{ rhythm: "descent", startIndex: 0, endIndex: 16 }]);
});

test("a low-vertical-persistence route is flat", () => {
  const { sections } = sectionsFor([[6, 0]], { noise: 3 });
  assert.equal(sections.length, 1);
  assert.equal(sections[0].dominantRhythm, "flat");
});

test("small net gain over a long distance does not become an automatic climb", () => {
  const { dynamics, sections } = sectionsFor([[10, 30]]);
  assert.equal(sections.length, 1);
  assert.equal(sections[0].dominantRhythm, "flat");
  assert.ok(dynamics.samples.every((sample) => sample.medium.verticalIntensityMPerKm < 18));
});

test("a long climb absorbs a short descent as an embedded event", () => {
  const { sections } = sectionsFor([[4, 160], [0.5, -25], [5.5, 220]]);
  assert.equal(sections.length, 1);
  assert.equal(sections[0].dominantRhythm, "climb");
  assert.ok(sections[0].embeddedEvents.some((event) => event.rhythm === "descent"));
});

test("a long descent absorbs small climb interruptions", () => {
  const { sections } = sectionsFor([[8, -400], [0.6, 30], [8, -400], [0.6, 30], [8, -400]]);
  assert.equal(sections.length, 1);
  assert.equal(sections[0].dominantRhythm, "descent");
  assert.ok(sections[0].embeddedEvents.some((event) => event.rhythm === "climb"));
});

test("final consolidation embeds a short climb between dominant descents", () => {
  const { phases, dynamics } = explicitPhases([
    { rhythm: "descent", distanceKm: 5, descentM: 300 },
    { rhythm: "climb", distanceKm: 0.5, ascentM: 20 },
    { rhythm: "descent", distanceKm: 5, descentM: 300 },
  ]);
  const consolidated = consolidateRoutePhases(phases, dynamics);
  assert.deepEqual(consolidated.map((phase) => phase.rhythm), ["descent"]);
  assert.equal(dynamics.events.filter((event) => event.rhythm === "climb").length, 1);
});

test("final consolidation embeds a short descent between dominant climbs", () => {
  const { phases, dynamics } = explicitPhases([
    { rhythm: "climb", distanceKm: 5, ascentM: 300 },
    { rhythm: "descent", distanceKm: 0.5, descentM: 20 },
    { rhythm: "climb", distanceKm: 5, ascentM: 300 },
  ]);
  assert.deepEqual(consolidateRoutePhases(phases, dynamics).map((phase) => phase.rhythm), ["climb"]);
});

test("short rolling bridges do not split same-rhythm climbs or descents", () => {
  for (const dominant of ["climb", "descent"]) {
    const { phases, dynamics } = explicitPhases([
      { rhythm: dominant, distanceKm: 5, ascentM: dominant === "climb" ? 300 : 10, descentM: dominant === "descent" ? 300 : 10 },
      { rhythm: "rolling", distanceKm: 0.8, ascentM: 20, descentM: 20 },
      { rhythm: dominant, distanceKm: 5, ascentM: dominant === "climb" ? 300 : 10, descentM: dominant === "descent" ? 300 : 10 },
    ]);
    assert.deepEqual(consolidateRoutePhases(phases, dynamics).map((phase) => phase.rhythm), [dominant]);
  }
});

test("a relatively significant opposite phase becomes its own section", () => {
  const { sections } = sectionsFor([[3, -112], [1.5, 250], [3.5, -131]]);
  assert.deepEqual(sections.map((section) => section.dominantRhythm), ["descent", "climb", "descent"]);
});

test("a climb with meaningful vertical contribution remains separate between descents", () => {
  const { phases, dynamics } = explicitPhases([
    { rhythm: "descent", distanceKm: 4, descentM: 200 },
    { rhythm: "climb", distanceKm: 2, ascentM: 350 },
    { rhythm: "descent", distanceKm: 4, descentM: 200 },
  ]);
  assert.deepEqual(consolidateRoutePhases(phases, dynamics).map((phase) => phase.rhythm), ["descent", "climb", "descent"]);
});

test("long dominant phase keeps multiple short opposite events embedded", () => {
  const { phases, dynamics } = explicitPhases([
    { rhythm: "climb", distanceKm: 8, ascentM: 400 },
    { rhythm: "descent", distanceKm: 0.5, descentM: 20 },
    { rhythm: "climb", distanceKm: 8, ascentM: 400 },
    { rhythm: "descent", distanceKm: 0.5, descentM: 20 },
    { rhythm: "climb", distanceKm: 8, ascentM: 400 },
  ]);
  const consolidated = consolidateRoutePhases(phases, dynamics);
  assert.deepEqual(consolidated.map((phase) => phase.rhythm), ["climb"]);
  assert.equal(dynamics.events.filter((event) => event.rhythm === "descent").length, 2);
});

test("a persistent, stable climb is not swallowed by much longer descents", () => {
  const elevations = [];
  for (let index = 0; index <= 200; index += 1) {
    elevations.push(index <= 80 ? 1000 - index * 2 : index <= 95 ? 840 + (index - 80) * 10 : 990 - (index - 95) * 2);
  }
  const makeSample = (index) => ({
    distanceM: index * 100,
    elevationM: elevations[index],
    smoothedElevationM: elevations[index],
    short: { verticalIntensityMPerKm: 100, directionStrength: 0.8, directionBalance: index > 80 && index <= 95 ? 0.8 : -0.8 },
    medium: { verticalIntensityMPerKm: 100, directionStrength: 0.8, directionBalance: index > 80 && index <= 95 ? 0.8 : -0.8 },
    long: { verticalIntensityMPerKm: 100, directionStrength: 0.8, directionBalance: index > 80 && index <= 95 ? 0.8 : -0.8 },
    stability: 0.9,
  });
  const dynamics = {
    totalDistanceKm: 20,
    resampledPoints: elevations.map((elevationM, index) => ({ distanceM: index * 100, elevationM, smoothedElevationM: elevationM })),
    samples: elevations.map((_, index) => makeSample(index)),
    events: [],
  };
  const phases = mergeRoutePhases([
    { rhythm: "descent", startIndex: 0, endIndex: 80 },
    { rhythm: "climb", startIndex: 81, endIndex: 95 },
    { rhythm: "descent", startIndex: 96, endIndex: 200 },
  ], dynamics);
  assert.deepEqual(phases.map((phase) => phase.rhythm), ["descent", "climb", "descent"]);
});

test("smoothed elevation noise does not create many false rhythm changes", () => {
  const { dynamics, sections } = sectionsFor([[12, 60]], { noise: 4 });
  assert.ok(sections.length <= 2);
  assert.ok(dynamics.samples.every((sample) => sample.stability >= 0));
});

test("multi-scale disagreement is retained as transition diagnostics", () => {
  const { dynamics } = sectionsFor([[4, 300], [4, -300], [4, 300]]);
  assert.ok(dynamics.samples.some((sample) => sample.rhythm === "transition"));
  assert.ok(dynamics.samples.some((sample) => sample.short.rhythm !== sample.long.rhythm));
});

test("a complex 100 km route preserves major phases without a section-count cap", () => {
  const parts = [[20, 800], [1, -30], [20, -800], [1, 30], [20, -800], [1, 30], [20, -800], [1, 30], [17, 680]];
  const { sections } = sectionsFor(parts);
  assert.ok(Math.abs(sections.at(-1).endKm - 101) < 0.1);
  assert.equal(sections[0].dominantRhythm, "climb");
  assert.ok(sections.some((section) => section.dominantRhythm === "descent" && section.distanceKm > 50));
  assert.equal(sections.at(-1).dominantRhythm, "climb");
  assert.ok(sections.some((section) => section.embeddedEvents.length > 0));
});

test("final Route Sections cover the route continuously with no missing transition gaps", () => {
  const { sections } = sectionsFor([[3, 120], [2, -20], [4, -150], [3, 130]]);
  for (let index = 1; index < sections.length; index += 1) {
    assert.equal(sections[index - 1].endKm, sections[index].startKm);
  }
});

test("different GPX point densities produce equivalent dynamics after distance resampling", () => {
  const shape = [[4, 180], [1.5, -35], [5, 225]];
  const regular = sectionsFor(shape, { spacingM: 100 });
  const dense = sectionsFor(shape, { spacingM: 25 });
  assert.deepEqual(dense.sections.map((section) => section.dominantRhythm), regular.sections.map((section) => section.dominantRhythm));
  assert.equal(dense.dynamics.resampledPoints.length, regular.dynamics.resampledPoints.length);
  assert.ok(Math.abs(dense.sections[0].distanceKm - regular.sections[0].distanceKm) < 0.15);
});

test("Route Sections are produced without OSM or Mapillary evidence", () => {
  const { points, dynamics, sections } = sectionsFor([[5, 250], [5, -250]]);
  assert.ok(sections.length > 0);
  assert.ok(sections.every((section) => section.terrainEvidence === undefined && section.mapillaryEvidence === undefined));
  const moments = createRouteKeyMoments(points, {
    distanceKm: 10, elevationGainM: 250, elevationLossM: 250, highestPointM: 350, highestPointDistanceKm: 5, lowestPointM: 100,
  }, dynamics);
  assert.ok(moments.length >= 2 && moments.length <= 8);
});

test("Key Route Moments distinguish longest from biggest climbs and descents", () => {
  const points = makeRoute([[3, 90], [1, -30], [1, 150], [4, -100], [1, 35], [1, -180], [3, 35]]);
  const dynamics = analyzeRouteDynamics(points);
  const moments = createRouteKeyMoments(points, {
    distanceKm: points.at(-1).distanceM / 1000, elevationGainM: 310, elevationLossM: 310,
    highestPointM: 350, highestPointDistanceKm: 5, lowestPointM: 100,
  }, dynamics);
  assert.ok(moments.some((moment) => moment.title === "Longest climb"));
  assert.ok(moments.some((moment) => moment.title === "Biggest climb"));
  assert.notDeepEqual(
    moments.find((moment) => moment.title === "Longest climb")?.distance,
    moments.find((moment) => moment.title === "Biggest climb")?.distance,
  );
});

test("OSM evidence attaches by overlap without defining Route Section boundaries", () => {
  const route = sectionsFor([[5, 250], [5, -250]]);
  const geo = {
    source: { type: "osm", name: "OpenStreetMap", attribution: "© OpenStreetMap contributors" },
    availability: "available", matchedRoutePercent: 100, attribution: "© OpenStreetMap contributors",
    segments: [{
      id: "geo-1", startDistanceKm: 0, endDistanceKm: 10, lengthKm: 10, evidenceCoverage: 1,
      matchQuality: "high", osmWays: [],
      surface: { value: "gravel", rawValue: "gravel", provenance: "osm", availability: "available" },
      pathType: { value: null, rawValue: null, provenance: "osm", availability: "not-found" },
      trackCondition: { value: null, rawValue: null, provenance: "osm", availability: "not-found" },
      smoothness: { value: null, rawValue: null, provenance: "osm", availability: "not-found" },
      hikingDifficulty: { value: null, rawValue: null, provenance: "osm", availability: "not-found" },
      trailVisibility: { value: null, rawValue: null, provenance: "osm", availability: "not-found" },
      incline: { value: null, rawValue: null, provenance: "osm", availability: "not-found" },
      width: { value: null, rawValue: null, provenance: "osm", availability: "not-found" },
      informal: { value: null, rawValue: null, provenance: "osm", availability: "not-found" },
      trailblazed: { value: null, rawValue: null, provenance: "osm", availability: "not-found" },
      assistedTrail: { value: null, rawValue: null, provenance: "osm", availability: "not-found" },
    }],
  };
  const enriched = attachTerrainEvidenceToRouteSections(route.sections, geo);
  assert.deepEqual(enriched.map((section) => [section.startKm, section.endKm]), route.sections.map((section) => [section.startKm, section.endKm]));
  assert.ok(enriched.some((section) => section.terrainEvidence?.some((evidence) => evidence.terrain === "gravel")));
});
