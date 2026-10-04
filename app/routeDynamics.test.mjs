import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { analyzeRouteDynamics } from "./routeDynamics.ts";
import { analyzeGpxRoute, parseGpxText } from "./gpxAnalysis.ts";
import { applyRunnerFacingSectionSignificance, buildConsolidatedRouteSections, buildRouteSections, buildRouteSectionsWithSignificance, consolidateRoutePhases, mergeRoutePhases, sortRouteEmbeddedEventsForDisplay } from "./routeSectionEngine.ts";
import { createRouteKeyMoments } from "./routeKeyMoments.ts";
import { attachTerrainEvidenceToRouteSections } from "./routeEvidenceAdapter.ts";
import { getRouteImageryPresentation, getSurfaceEvidencePresentation, hasRenderableSectionMap } from "./routeSectionPresentation.ts";

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

function sectionFixtures(specs) {
  let startKm = 0;
  return specs.map((spec, index) => {
    const endKm = startKm + spec.distanceKm;
    const ascentM = spec.ascentM ?? 0;
    const descentM = spec.descentM ?? 0;
    const verticalM = ascentM + descentM;
    const directionBalance = verticalM ? (ascentM - descentM) / verticalM : 0;
    const section = {
      id: `fixture-section-${index + 1}`,
      startKm,
      endKm,
      distanceKm: spec.distanceKm,
      dominantRhythm: spec.rhythm,
      elevationStartM: 100,
      elevationEndM: 100 + ascentM - descentM,
      elevationMinM: 50,
      elevationMaxM: 500,
      ascentM,
      descentM,
      elevationProfile: [],
      embeddedEvents: [],
      dynamicsSummary: {
        verticalIntensityMPerKm: verticalM / spec.distanceKm,
        directionBalance,
        directionStrength: Math.abs(directionBalance),
        stability: spec.stability ?? 0.9,
      },
      description: spec.rhythm,
    };
    startKm = endKm;
    return section;
  });
}

function significanceFixture(specs) {
  return applyRunnerFacingSectionSignificance(sectionFixtures(specs));
}

function makeGeoSegment(id, startDistanceKm, endDistanceKm, surface, evidenceCoverage = 1) {
  const value = surface ?? null;
  const availability = value ? "available" : "unknown";
  const evidenceValue = { value, rawValue: value, provenance: "osm", availability };
  const notFound = { value: null, rawValue: null, provenance: "osm", availability: "not-found" };
  return {
    id, startDistanceKm, endDistanceKm, lengthKm: endDistanceKm - startDistanceKm, evidenceCoverage,
    matchQuality: value ? "high" : "unknown", osmWays: [], surface: evidenceValue,
    pathType: notFound, trackCondition: notFound, smoothness: notFound, hikingDifficulty: notFound,
    trailVisibility: notFound, incline: notFound, width: notFound, informal: notFound,
    trailblazed: notFound, assistedTrail: notFound,
  };
}

function makeGeoData(segments) {
  const hasSurface = segments.some((segment) => segment.surface.availability === "available");
  return {
    source: { type: "osm", name: "OpenStreetMap", attribution: "© OpenStreetMap contributors" },
    availability: hasSurface ? "available" : "unknown", matchedRoutePercent: hasSurface ? 30 : 0,
    segments, attribution: "© OpenStreetMap contributors",
  };
}

function routeSectionRange(startKm, endKm, id = "route-section-test") {
  return {
    id, startKm, endKm, distanceKm: endKm - startKm, dominantRhythm: "climb",
    elevationStartM: 100, elevationEndM: 300, elevationMinM: 100, elevationMaxM: 300,
    ascentM: 200, descentM: 0, elevationProfile: [{ distanceM: startKm * 1000, elevationM: 100 }, { distanceM: endKm * 1000, elevationM: 300 }],
    embeddedEvents: [], dynamicsSummary: { verticalIntensityMPerKm: 20, directionBalance: 1, directionStrength: 1, stability: 0.9 },
    description: "Predominantly climbing section", mapData: [
      { latitude: 45, longitude: 13, elevationM: 100, distanceM: startKm * 1000 },
      { latitude: 45.01, longitude: 13.01, elevationM: 300, distanceM: endKm * 1000 },
    ],
  };
}

test("displayed embedded events are ordered chronologically with end distance as the tie-breaker", () => {
  const events = [
    { id: "later", rhythm: "descent", startKm: 8, endKm: 9, distanceKm: 1, ascentM: 0, descentM: 10, significance: 0.9 },
    { id: "same-start-later-end", rhythm: "climb", startKm: 3, endKm: 5, distanceKm: 2, ascentM: 20, descentM: 0, significance: 0.8 },
    { id: "same-start-earlier-end", rhythm: "flat", startKm: 3, endKm: 4, distanceKm: 1, ascentM: 0, descentM: 0, significance: 0.1 },
  ];

  assert.deepEqual(sortRouteEmbeddedEventsForDisplay(events).map((event) => event.id), [
    "same-start-earlier-end",
    "same-start-later-end",
    "later",
  ]);
  assert.deepEqual(events.map((event) => event.id), ["later", "same-start-later-end", "same-start-earlier-end"]);
});

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
  const firstSection = enriched[0];
  assert.equal(firstSection.startKm, route.sections[0].startKm);
  assert.equal(firstSection.endKm, route.sections[0].endKm);
  assert.equal(firstSection.ascentM, route.sections[0].ascentM);
  assert.equal(firstSection.descentM, route.sections[0].descentM);
  assert.ok(firstSection.mapData?.length >= 2);
  assert.deepEqual(getSurfaceEvidencePresentation(firstSection, true), {
    status: "mapped",
    coveragePercent: 100,
    coverageLabel: "Mapped evidence · 100% of section",
    distributionLabel: "Surface distribution among mapped evidence",
    categories: [{ label: "Gravel", sharePercent: 100 }],
  });
  assert.equal(getRouteImageryPresentation(null), null);

  const partialGeo = { ...geo, segments: geo.segments.map((segment) => ({ ...segment, evidenceCoverage: 0.35 })) };
  const partial = attachTerrainEvidenceToRouteSections(route.sections, partialGeo)[0];
  assert.equal(partial.terrainEvidenceCoveragePercent, 35);
  assert.deepEqual(getSurfaceEvidencePresentation(partial, true), {
    status: "mapped",
    coveragePercent: 35,
    coverageLabel: "Mapped evidence · 35% of section",
    distributionLabel: "Surface distribution among mapped evidence",
    categories: [{ label: "Gravel", sharePercent: 100 }],
  });

  const noEvidence = attachTerrainEvidenceToRouteSections(route.sections, {
    ...geo, availability: "unknown", segments: [],
  })[0];
  assert.deepEqual(getSurfaceEvidencePresentation(noEvidence, true), {
    status: "missing", message: "No reliable mapped surface evidence for this section.",
  });
  assert.equal(noEvidence.distanceKm, route.sections[0].distanceKm);
  assert.equal(noEvidence.dominantRhythm, route.sections[0].dominantRhythm);
  assert.equal(noEvidence.elevationProfile.length, route.sections[0].elevationProfile.length);
  assert.equal(getSurfaceEvidencePresentation(route.sections[0], false).status, "not-requested");

  const imageryOnly = {
    id: route.sections[0].id,
    availability: "available",
    images: [{ id: "photo-1", latitude: 45, longitude: 13, distanceAlongRouteKm: 2.4, capturedAt: null, sequenceId: null, thumbnailUrl: null, sourceUrl: "https://www.mapillary.com/app/?pKey=photo-1" }],
  };
  assert.equal(route.sections[0].terrainEvidence, undefined);
  assert.equal(getRouteImageryPresentation(imageryOnly).status, "available");
  const osmWithoutImagery = getRouteImageryPresentation({ id: route.sections[0].id, availability: "not-found", images: [] });
  assert.deepEqual(osmWithoutImagery, { status: "not-found", message: "No route imagery available for this section." });
});

test("Route Sections contain the only course segmentation presentation", () => {
  const source = readFileSync(new URL("./RouteAnalysisView.tsx", import.meta.url), "utf8");
  assert.equal((source.match(/title="Route Sections"/g) ?? []).length, 1);
  assert.doesNotMatch(source, /title="Terrain Evidence"|<h[1-6][^>]*>Terrain Evidence<\/h[1-6]>/);
});

test("section maps depend only on GPX geometry across all OSM and Mapillary states", () => {
  const section = routeSectionRange(0, 10);
  const geometry = section.mapData;
  const states = [
    "OSM absent; Mapillary absent",
    "OSM absent; Mapillary present",
    "OSM present; Mapillary absent",
  ];
  for (const state of states) {
    assert.equal(hasRenderableSectionMap(geometry), true, state);
    assert.equal(hasRenderableSectionMap([]), false);
  }
  const mapSource = readFileSync(new URL("./TerrainSectionMap.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(mapSource, /Mapillary|images|selectedImage|onSelectImage/);
  const viewSource = readFileSync(new URL("./RouteAnalysisView.tsx", import.meta.url), "utf8");
  assert.equal((viewSource.match(/<TerrainSectionMap /g) ?? []).length, 1);
});

test("separated OSM ranges attach by clipped distance and normalize surfaces among mapped evidence", () => {
  const section = routeSectionRange(0, 30);
  const data = makeGeoData([
    makeGeoSegment("unknown-a", 0, 5.2, null, 0),
    makeGeoSegment("dirt-a", 5.2, 8.4, "dirt"),
    makeGeoSegment("gravel", 8.4, 12.7, "gravel"),
    makeGeoSegment("unknown-b", 12.7, 20.1, null, 0),
    makeGeoSegment("dirt-b", 20.1, 24.8, "earth"),
    makeGeoSegment("unknown-c", 24.8, 30, null, 0),
  ]);
  const [attached] = attachTerrainEvidenceToRouteSections([section], data);

  assert.equal(attached.startKm, 0);
  assert.equal(attached.endKm, 30);
  assert.equal(attached.distanceKm, 30);
  assert.equal(attached.terrainEvidenceCoveragePercent, 41);
  assert.deepEqual(attached.terrainEvidence.map(({ terrain, evidenceSharePercent }) => [terrain, evidenceSharePercent]), [
    ["dirt-ground", 65], ["gravel", 35],
  ]);
  assert.deepEqual(getSurfaceEvidencePresentation(attached, true), {
    status: "mapped",
    coveragePercent: 41,
    coverageLabel: "Mapped evidence · 41% of section",
    distributionLabel: "Surface distribution among mapped evidence",
    categories: [
      { label: "Dirt / ground", sharePercent: 65 },
      { label: "Gravel", sharePercent: 35 },
    ],
  });
});

test("tiny positive mapped coverage stays exact and presents as less than one percent", () => {
  const [attached] = attachTerrainEvidenceToRouteSections(
    [routeSectionRange(0, 100)],
    makeGeoData([makeGeoSegment("tiny-gravel", 0, 0.4, "gravel")]),
  );
  assert.equal(attached.terrainEvidenceCoveragePercent, 0);
  assert.equal(attached.terrainEvidenceExactCoveragePercent, 0.4);
  assert.equal(getSurfaceEvidencePresentation(attached, true).status, "mapped");
  assert.equal(getSurfaceEvidencePresentation(attached, true).coverageLabel, "Mapped evidence · <1% of section");
});

test("surface presentation treats exact zero as missing, even with stale categories", () => {
  const section = routeSectionRange(0, 10);
  const noCategories = {
    ...section,
    terrainEvidenceCoveragePercent: 0,
    terrainEvidenceExactCoveragePercent: 0,
    terrainEvidence: [],
  };
  const staleCategories = {
    ...noCategories,
    terrainEvidence: [{ terrain: "paved", evidenceSharePercent: 100, provenance: "osm" }],
  };

  assert.deepEqual(getSurfaceEvidencePresentation(noCategories, true), {
    status: "missing", message: "No reliable mapped surface evidence for this section.",
  });
  assert.deepEqual(getSurfaceEvidencePresentation(staleCategories, true), {
    status: "missing", message: "No reliable mapped surface evidence for this section.",
  });
});

test("normal surface evidence coverage keeps its mapped presentation", () => {
  const [attached] = attachTerrainEvidenceToRouteSections(
    [routeSectionRange(0, 10)],
    makeGeoData([makeGeoSegment("normal-gravel", 0, 2, "gravel")]),
  );

  assert.equal(attached.terrainEvidenceCoveragePercent, 20);
  assert.deepEqual(getSurfaceEvidencePresentation(attached, true), {
    status: "mapped",
    coveragePercent: 20,
    coverageLabel: "Mapped evidence · 20% of section",
    distributionLabel: "Surface distribution among mapped evidence",
    categories: [{ label: "Gravel", sharePercent: 100 }],
  });
});

test("OSM ranges crossing a Route Section boundary are clipped independently to each side", () => {
  const left = routeSectionRange(0, 10, "left");
  const right = routeSectionRange(10, 30, "right");
  const data = makeGeoData([
    makeGeoSegment("unknown-before", 0, 8, null, 0),
    makeGeoSegment("crossing-dirt", 8, 12, "dirt"),
    makeGeoSegment("unknown-after", 12, 30, null, 0),
  ]);
  const attached = attachTerrainEvidenceToRouteSections([left, right], data);

  assert.deepEqual(attached.map(({ startKm, endKm, terrainEvidenceCoveragePercent }) => [startKm, endKm, terrainEvidenceCoveragePercent]), [
    [0, 10, 20], [10, 30, 10],
  ]);
  assert.deepEqual(attached.map((section) => section.terrainEvidence[0]?.evidenceSharePercent), [100, 100]);
});

test("OSM Surface Evidence does not cross an equal-kilometer component boundary", () => {
  const segmentZero = { ...routeSectionRange(9, 10, "component-zero"), segmentIndex: 0 };
  const segmentOne = { ...routeSectionRange(10, 11, "component-one"), segmentIndex: 1 };
  const data = makeGeoData([
    { ...makeGeoSegment("segment-zero-evidence", 9, 11, "gravel"), segmentIndex: 0 },
  ]);

  const [first, second] = attachTerrainEvidenceToRouteSections([segmentZero, segmentOne], data);
  assert.ok(first.terrainEvidenceCoveragePercent > 0);
  assert.ok(first.terrainEvidence.some((evidence) => evidence.terrain === "gravel"));
  assert.equal(second.terrainEvidenceCoveragePercent, 0);
  assert.deepEqual(second.terrainEvidence, []);
});

test("overlapping OSM ranges count unique mapped distance once", () => {
  const section = routeSectionRange(0, 10);
  const data = makeGeoData([
    makeGeoSegment("unknown-before", 0, 2, null, 0),
    makeGeoSegment("dirt-overlap-left", 2, 6, "dirt"),
    makeGeoSegment("gravel-overlap-right", 4, 8, "gravel"),
    makeGeoSegment("unknown-after", 8, 10, null, 0),
  ]);
  const [attached] = attachTerrainEvidenceToRouteSections([section], data);

  assert.equal(attached.terrainEvidenceCoveragePercent, 60);
  assert.deepEqual(attached.terrainEvidence.map(({ terrain, evidenceSharePercent }) => [terrain, evidenceSharePercent]), [
    ["dirt-ground", 50], ["gravel", 50],
  ]);
});

test("Mapillary availability does not change OSM attachment and imagery stays independent without OSM", () => {
  const section = routeSectionRange(0, 10);
  const data = makeGeoData([
    makeGeoSegment("partial-dirt", 2, 4, "dirt"),
  ]);
  const withImageryAlreadyOnSection = {
    ...section,
    mapillaryEvidence: { availability: "available", imageCount: 1 },
  };
  const [withoutMapillary] = attachTerrainEvidenceToRouteSections([section], data);
  const [withMapillary] = attachTerrainEvidenceToRouteSections([withImageryAlreadyOnSection], data);
  assert.equal(withoutMapillary.terrainEvidenceCoveragePercent, withMapillary.terrainEvidenceCoveragePercent);
  assert.deepEqual(withoutMapillary.terrainEvidence, withMapillary.terrainEvidence);

  const [withoutOsm] = attachTerrainEvidenceToRouteSections([section], makeGeoData([]));
  const imagery = { id: section.id, availability: "available", images: [{ id: "photo-1", latitude: 45, longitude: 13, distanceAlongRouteKm: 3, capturedAt: null, sequenceId: null, thumbnailUrl: null, sourceUrl: "https://www.mapillary.com/app/?pKey=photo-1" }] };
  const imageryUnavailable = { id: section.id, availability: "unknown", images: [] };
  const states = [
    { section: withoutMapillary, imagery, surfaceStatus: "mapped", imageStatus: "available" },
    { section: withoutMapillary, imagery: null, surfaceStatus: "mapped", imageStatus: null },
    { section: withoutOsm, imagery, surfaceStatus: "missing", imageStatus: "available" },
    { section: withoutOsm, imagery: imageryUnavailable, surfaceStatus: "missing", imageStatus: "unavailable" },
  ];
  for (const state of states) {
    assert.equal(hasRenderableSectionMap(state.section.mapData), true);
    assert.equal(getSurfaceEvidencePresentation(state.section, true).status, state.surfaceStatus);
    assert.equal(getRouteImageryPresentation(state.imagery)?.status ?? null, state.imageStatus);
  }
  assert.equal(getSurfaceEvidencePresentation(withoutOsm, true).status, "missing");
  assert.equal(getRouteImageryPresentation(imagery).status, "available");
});

test("a small descent between long climbs becomes one climb section with a preserved event", () => {
  const { sections, decisions } = significanceFixture([
    { rhythm: "climb", distanceKm: 20, ascentM: 1000 },
    { rhythm: "descent", distanceKm: 1, descentM: 60 },
    { rhythm: "climb", distanceKm: 20, ascentM: 1000 },
  ]);
  assert.deepEqual(sections.map((section) => section.dominantRhythm), ["climb"]);
  assert.ok(sections[0].embeddedEvents.some((event) => event.rhythm === "descent" && event.distanceKm === 1 && event.descentM === 60));
  assert.equal(decisions[1].decision, "bridged");
});

test("a small climb between long descents becomes one descent section with a preserved event", () => {
  const { sections } = significanceFixture([
    { rhythm: "descent", distanceKm: 10, descentM: 600 },
    { rhythm: "climb", distanceKm: 1, ascentM: 70 },
    { rhythm: "descent", distanceKm: 10, descentM: 600 },
  ]);
  assert.deepEqual(sections.map((section) => section.dominantRhythm), ["descent"]);
  assert.ok(sections[0].embeddedEvents.some((event) => event.rhythm === "climb" && event.ascentM === 70));
});

test("a short but vertically meaningful climb between descents remains standalone", () => {
  const { sections, decisions } = significanceFixture([
    { rhythm: "descent", distanceKm: 10, descentM: 600 },
    { rhythm: "climb", distanceKm: 1.8, ascentM: 450 },
    { rhythm: "descent", distanceKm: 10, descentM: 600 },
  ]);
  assert.deepEqual(sections.map((section) => section.dominantRhythm), ["descent", "climb", "descent"]);
  assert.equal(decisions[1].decision, "kept");
});

test("an insignificant rolling bridge between climbs is absorbed", () => {
  const { sections } = significanceFixture([
    { rhythm: "climb", distanceKm: 20, ascentM: 1000 },
    { rhythm: "rolling", distanceKm: 1, ascentM: 35, descentM: 35 },
    { rhythm: "climb", distanceKm: 20, ascentM: 1000 },
  ]);
  assert.deepEqual(sections.map((section) => section.dominantRhythm), ["climb"]);
  assert.ok(sections[0].embeddedEvents.some((event) => event.rhythm === "rolling"));
});

test("an insignificant rolling bridge between descents is absorbed", () => {
  const { sections } = significanceFixture([
    { rhythm: "descent", distanceKm: 20, descentM: 1000 },
    { rhythm: "rolling", distanceKm: 1, ascentM: 35, descentM: 35 },
    { rhythm: "descent", distanceKm: 20, descentM: 1000 },
  ]);
  assert.deepEqual(sections.map((section) => section.dominantRhythm), ["descent"]);
  assert.ok(sections[0].embeddedEvents.some((event) => event.rhythm === "rolling"));
});

test("a long meaningful rolling phase stays standalone", () => {
  const { sections } = significanceFixture([
    { rhythm: "climb", distanceKm: 8, ascentM: 300 },
    { rhythm: "rolling", distanceKm: 12, ascentM: 240, descentM: 240 },
    { rhythm: "climb", distanceKm: 8, ascentM: 300 },
  ]);
  assert.deepEqual(sections.map((section) => section.dominantRhythm), ["climb", "rolling", "climb"]);
});

test("a long flat phase stays standalone", () => {
  const { sections } = significanceFixture([
    { rhythm: "climb", distanceKm: 10, ascentM: 500 },
    { rhythm: "flat", distanceKm: 12 },
    { rhythm: "descent", distanceKm: 10, descentM: 500 },
  ]);
  assert.deepEqual(sections.map((section) => section.dominantRhythm), ["climb", "flat", "descent"]);
});

test("a short, extremely intense climb stays standalone", () => {
  const { sections } = significanceFixture([
    { rhythm: "descent", distanceKm: 10, descentM: 700 },
    { rhythm: "climb", distanceKm: 1.8, ascentM: 450 },
    { rhythm: "descent", distanceKm: 10, descentM: 700 },
  ]);
  assert.deepEqual(sections.map((section) => section.dominantRhythm), ["descent", "climb", "descent"]);
});

test("a long steep descent remains significant at a small race-wide distance share", () => {
  const { sections, decisions } = significanceFixture([
    { rhythm: "climb", distanceKm: 40, ascentM: 4000 },
    { rhythm: "descent", distanceKm: 40, descentM: 5000 },
    { rhythm: "descent", distanceKm: 10, descentM: 1200 },
    { rhythm: "climb", distanceKm: 40, ascentM: 4000 },
    { rhythm: "descent", distanceKm: 44, descentM: 6000 },
  ]);
  assert.ok(decisions[2].distanceShare < 0.06);
  assert.equal(decisions[2].decision, "kept");
  assert.ok(sections.some((section) => section.startKm === 80 && section.endKm === 90));
});

test("a stable directional phase slightly above route-average intensity remains significant", () => {
  const { sections, decisions } = significanceFixture([
    { rhythm: "climb", distanceKm: 50, ascentM: 4000 },
    { rhythm: "descent", distanceKm: 40, descentM: 3000 },
    { rhythm: "rolling", distanceKm: 2.5, ascentM: 178, descentM: 211 },
    { rhythm: "climb", distanceKm: 3, ascentM: 347 },
    { rhythm: "descent", distanceKm: 7.28, descentM: 828 },
    { rhythm: "descent", distanceKm: 71.22, descentM: 8936 },
  ]);
  assert.ok(decisions[3].distanceShare < 0.02);
  assert.ok(decisions[3].verticalIntensityRatio > 1.1);
  assert.equal(decisions[3].decision, "kept");
  assert.ok(sections.some((section) => section.startKm === 92.5 && section.endKm === 95.5 && section.dominantRhythm === "climb"));
});

test("an insignificant opening section merges into its more coherent neighbor", () => {
  const { sections, decisions } = significanceFixture([
    { rhythm: "rolling", distanceKm: 0.5, ascentM: 3, descentM: 2 },
    { rhythm: "climb", distanceKm: 12, ascentM: 600 },
    { rhythm: "descent", distanceKm: 10, descentM: 500 },
  ]);
  assert.equal(sections[0].startKm, 0);
  assert.equal(sections[0].dominantRhythm, "climb");
  assert.equal(decisions[0].decision, "absorbed-next");
});

test("an insignificant final section merges into its more coherent neighbor", () => {
  const { sections, decisions } = significanceFixture([
    { rhythm: "climb", distanceKm: 12, ascentM: 600 },
    { rhythm: "descent", distanceKm: 10, descentM: 500 },
    { rhythm: "rolling", distanceKm: 0.5, ascentM: 3, descentM: 2 },
  ]);
  assert.equal(sections.at(-1).endKm, 22.5);
  assert.equal(sections.at(-1).dominantRhythm, "descent");
  assert.equal(decisions[2].decision, "absorbed-previous");
});

test("merge affinity can choose the next climb over a longer rolling neighbor", () => {
  const { sections, decisions } = significanceFixture([
    { rhythm: "rolling", distanceKm: 8, ascentM: 300, descentM: 300 },
    { rhythm: "descent", distanceKm: 0.5, descentM: 10 },
    { rhythm: "climb", distanceKm: 5, ascentM: 500 },
  ]);
  assert.equal(decisions[1].decision, "absorbed-next");
  assert.equal(sections[0].dominantRhythm, "rolling");
  assert.equal(sections[1].dominantRhythm, "climb");
  assert.ok(sections[1].embeddedEvents.some((event) => event.rhythm === "descent"));
});

test("long complex routes keep meaningful repeated phases without a section-count cap", () => {
  const specs = Array.from({ length: 32 }, (_, index) => ({
    rhythm: index % 2 === 0 ? "climb" : "descent",
    distanceKm: 3,
    ascentM: index % 2 === 0 ? 200 : 0,
    descentM: index % 2 === 0 ? 0 : 200,
  }));
  const { sections } = significanceFixture(specs);
  assert.equal(sections.length, 32);
  assert.equal(sections.at(-1).endKm, 96);
});

test("all absorbed phase facts and merge decisions remain inspectable", () => {
  const { sections, decisions } = significanceFixture([
    { rhythm: "climb", distanceKm: 20, ascentM: 1000 },
    { rhythm: "descent", distanceKm: 1, descentM: 60 },
    { rhythm: "climb", distanceKm: 20, ascentM: 1000 },
  ]);
  const absorbed = decisions[1];
  assert.equal(absorbed.startKm, 20);
  assert.equal(absorbed.endKm, 21);
  assert.equal(absorbed.distanceKm, 1);
  assert.equal(absorbed.ascentM, 0);
  assert.equal(absorbed.descentM, 60);
  assert.ok(absorbed.distanceShare > 0);
  assert.ok(absorbed.verticalShare > 0);
  assert.ok(absorbed.verticalIntensityMPerKm > 0);
  assert.equal(absorbed.decision, "bridged");
  assert.match(absorbed.mergeTarget, /same-rhythm bridge/);
  assert.ok(sections[0].embeddedEvents.some((event) => event.startKm === absorbed.startKm && event.endKm === absorbed.endKm));
});

test("checked-in Istria GPX absorbs the low-significance 47 km phase and preserves the major descent interruption", () => {
  const xml = readFileSync(new URL("../public/ISTRIA_110K_2027.gpx", import.meta.url), "utf8");
  const analysis = analyzeGpxRoute(parseGpxText(xml));
  const before = buildConsolidatedRouteSections(analysis.routeDynamics, analysis.points);
  const after = buildRouteSectionsWithSignificance(analysis.routeDynamics, analysis.points).sections;
  assert.equal(before.length, 17);
  assert.ok(!after.some((section) => section.startKm === 47.35 && section.endKm === 49.25));
  assert.ok(after.some((section) => section.startKm === 45.35 && section.endKm === 49.25));
  assert.ok(after.some((section) => section.embeddedEvents.some((event) => event.startKm === 23.6 && event.endKm === 26.2 && event.descentM === 283)));
  assert.equal(after[0].startKm, 0);
  assert.equal(after.at(-1).endKm, analysis.metrics.distanceKm);
});
