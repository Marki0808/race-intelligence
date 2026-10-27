import test from "node:test";
import assert from "node:assert/strict";
import { analyzeGpxRoute } from "./gpxAnalysis.ts";
import { buildAidStationSections } from "./aidStationSections.ts";
import { readFile } from "node:fs/promises";

function analysisFor({ components = 1 } = {}) {
  const segments = Array.from({ length: components }, (_, component) => Array.from({ length: 9 }, (_, index) => ({
    latitude: 45 + component * 0.2,
    longitude: 13 + index * 0.009,
    elevationM: [100, 160, 125, 230, 205, 125, 155, 80, 120][index],
  })));
  return analyzeGpxRoute({ segments, name: "Station test route" });
}

function discoveryFor(analysis, changes = {}) {
  const points = analysis.points.filter((point) => point.segmentIndex === 0);
  const names = ["Buzet", "Prapoće", "Shared", "Butoniga", "Livade", "Grožnjan", "Shared", "Buje", "Umag"];
  const visits = points.map((point, index) => ({
    visitId: `visit-${index}`,
    sourceOrder: index,
    name: names[index],
    sequenceRole: index === 0 ? "start" : index === points.length - 1 ? "finish" : "intermediate-candidate",
    roles: index === 0 ? ["start"] : index === points.length - 1 ? ["finish"] : ["aid-station"],
    position: { confidence: "verified", componentIndex: point.segmentIndex, distanceKm: point.distanceM / 1000 },
  }));
  return {
    schemaVersion: 1,
    status: "available",
    gpxProvenance: { bindingStatus: "verified" },
    completeness: { status: "complete", declaredCount: 7, extractedCount: 9 },
    stationSegmentation: { available: true, reasonCodes: [] },
    visits,
    ...changes,
  };
}

test("complete verified nine-visit sequence creates eight ordered full-route aid-station sections", () => {
  const analysis = analysisFor();
  const result = buildAidStationSections(discoveryFor(analysis), analysis);
  assert.equal(result.available, true);
  assert.equal(result.sections.length, 8);
  assert.deepEqual(result.sections.map((section) => [section.startPosition.distanceM, section.endPosition.distanceM]),
    result.sections.map((section, index) => [analysis.points[index].distanceM, analysis.points[index + 1].distanceM]));
  assert.equal(result.sections[0].startKm, 0);
  assert.equal(result.sections.at(-1).endPosition.distanceM, analysis.points.at(-1).distanceM);
  assert.ok(Math.abs(result.sections.reduce((sum, section) => sum + section.distanceKm, 0) - analysis.metrics.distanceKm) <= 0.03);
  assert.equal(result.labels.get(`0:${result.sections[0].id}`).from, "Buzet");
  assert.equal(result.labels.get(`0:${result.sections[0].id}`).to, "Prapoće");
  const repeated = result.sections.filter((section) => section.id.includes("-1-2") || section.id.includes("-6-7"));
  assert.equal(repeated.length, 2, "two visits with the same name remain separate ordered boundaries");
  assert.notEqual(repeated[0].id, repeated[1].id);
  assert.equal(result.labels.get(`0:${repeated[0].id}`).to, "Shared");
  assert.equal(result.labels.get(`0:${repeated[1].id}`).from, "Shared");
});

test("official cumulative kilometers enable a clearly approximate mode only with exact count, identity, order, and route compatibility", () => {
  const analysis = analysisFor();
  const evidence = discoveryFor(analysis, {
    gpxProvenance: { bindingStatus: "approximate" },
    selectedContext: { eventName: "Test Ultra", editionYear: 2027, courseLabel: "6.30 km", courseDistanceKm: analysis.metrics.distanceKm },
    reasonCodes: [],
    stationSegmentation: { available: true, reasonCodes: [], positionMode: "official-kilometer-approximate" },
  });
  evidence.visits = evidence.visits.map((visit, index) => ({
    ...visit,
    context: { eventName: "Test Ultra", editionYear: 2027, courseLabel: "6.30 km", courseDistanceKm: analysis.metrics.distanceKm },
    ...(index > 0 && index < evidence.visits.length - 1 ? {
      sourcePosition: { value: visit.position.distanceKm, unit: "km", normalizedKm: visit.position.distanceKm, qualifier: "exact", semantics: "cumulative" },
      position: { confidence: "approximate", componentIndex: visit.position.componentIndex, distanceKm: visit.position.distanceKm, method: "source-distance" },
    } : {
      position: { confidence: "verified", componentIndex: 0, distanceKm: index === 0 ? 0 : analysis.metrics.distanceKm, method: "route-endpoint" },
    }),
  }));
  const result = buildAidStationSections(evidence, analysis);
  assert.equal(result.available, true);
  assert.equal(result.positionMode, "official-kilometer-approximate");
  assert.equal(result.sections.length, 8);

  const wrongCount = structuredClone(evidence);
  wrongCount.completeness.declaredCount = 6;
  assert.equal(buildAidStationSections(wrongCount, analysis).available, false);
  const routeMismatch = structuredClone(evidence);
  routeMismatch.selectedContext.courseDistanceKm = analysis.metrics.distanceKm * 1.2;
  assert.equal(buildAidStationSections(routeMismatch, analysis).available, false);
  const disconnected = analysisFor({ components: 2 });
  assert.equal(buildAidStationSections(evidence, disconnected).available, false);
});

test("sub-metre verified start and finish projection offsets close against the exact analyzed GPX endpoints", () => {
  const analysis = analysisFor();
  const evidence = discoveryFor(analysis);
  evidence.visits[0].position.distanceKm = 0.003;
  evidence.visits.at(-1).position.distanceKm = analysis.metrics.distanceKm + 0.004;
  const result = buildAidStationSections(evidence, analysis);
  assert.equal(result.available, true);
  assert.equal(result.sections[0].startPosition.distanceM, analysis.points[0].distanceM);
  assert.equal(result.sections.at(-1).endPosition.distanceM, analysis.points.at(-1).distanceM);
});

test("section ascent and descent use existing smoothed dynamics, not endpoint elevation differences", () => {
  const analysis = analysisFor();
  const result = buildAidStationSections(discoveryFor(analysis), analysis);
  assert.equal(result.available, true);
  for (const section of result.sections) {
    let ascent = 0;
    let descent = 0;
    for (let index = 1; index < section.elevationProfile.length; index += 1) {
      const delta = section.elevationProfile[index].elevationM - section.elevationProfile[index - 1].elevationM;
      if (delta > 0) ascent += delta;
      else descent += Math.abs(delta);
    }
    assert.equal(section.ascentM, Math.round(ascent));
    assert.equal(section.descentM, Math.round(descent));
    assert.ok(section.elevationProfile.length >= 2);
  }
});

test("incomplete, approximate, miscounted, duplicate, or out-of-route visits fail closed", () => {
  const analysis = analysisFor();
  const base = discoveryFor(analysis);
  assert.equal(buildAidStationSections(null, analysis).available, false);
  assert.equal(buildAidStationSections({ ...base, stationSegmentation: { available: false, reasonCodes: ["source-completeness-unverified"] } }, analysis).available, false);
  assert.equal(buildAidStationSections({ ...base, completeness: { ...base.completeness, status: "partial" } }, analysis).available, false);
  assert.equal(buildAidStationSections({ ...base, gpxProvenance: { bindingStatus: "approximate" } }, analysis).available, false);
  assert.equal(buildAidStationSections({ ...base, completeness: { ...base.completeness, declaredCount: 6 } }, analysis).available, false);
  const approximate = structuredClone(base);
  approximate.visits[2].position.confidence = "approximate";
  assert.equal(buildAidStationSections(approximate, analysis).available, false);
  const duplicate = structuredClone(base);
  duplicate.visits[2].position.distanceKm = duplicate.visits[1].position.distanceKm;
  assert.equal(buildAidStationSections(duplicate, analysis).available, false);
  const outOfOrder = structuredClone(base);
  outOfOrder.visits[3].position.distanceKm = outOfOrder.visits[2].position.distanceKm - 0.01;
  assert.equal(buildAidStationSections(outOfOrder, analysis).available, false);
  const missingRole = structuredClone(base);
  missingRole.visits[3].roles = [];
  assert.equal(buildAidStationSections(missingRole, analysis).available, false);
});

test("disconnected GPX components are not bridged by aid-station sections", () => {
  const analysis = analysisFor({ components: 2 });
  assert.equal(buildAidStationSections(discoveryFor(analysis), analysis).available, false);
});

test("Route Mode gates the view by validated station segmentation and switching does not reanalyze", async () => {
  const [view, routeMode, explorer] = await Promise.all([
    readFile(new URL("./RouteAnalysisView.tsx", import.meta.url), "utf8"),
    readFile(new URL("./RouteMode.tsx", import.meta.url), "utf8"),
    readFile(new URL("./CourseExplorer.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(view, /segmentationMode: "terrain"/);
  assert.match(view, /\{aidStationSections\.available && <button/);
  assert.match(view, /updateViewState\(\{ segmentationMode: "aid-station"/);
  assert.match(view, /selectionSections=\{activeSections\}/);
  assert.match(view, /sectionKind=\{showingAidStationSections \? "Aid Station Section"/);
  assert.match(view, /buildAidStationSections\(analysis\.aidStationDiscoveryV1, \{/);
  assert.doesNotMatch(view.match(/onClick=\{\(\) => updateViewState\(\{ segmentationMode: "aid-station"[^}]*\}\)/)?.[0] ?? "", /fetch\(|requestRouteTerrainEvidence|analyzeGpxRoute/);
  const raceMode = await readFile(new URL("./CourseSection.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(raceMode, /Aid Station Sections/, "the alternative view is limited to Route Mode");
  assert.match(routeMode, /analyzeGpxRoute\(parsed\)/, "Route Mode still performs its existing analysis once on input");
  assert.match(explorer, /const sections = selectionSections \?\? routeAnalysis\?\.routeSections/);
});
