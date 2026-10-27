import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { analyzeGpxRoute } from "./gpxAnalysis.ts";
import {
  appendCustomSectionBoundary,
  buildCustomRouteSections,
  createCustomSectionPlan,
  MAX_CUSTOM_SECTION_BOUNDARIES,
  validateCustomSectionPlan,
} from "./customRouteSections.ts";
import { buildAidStationSections } from "./aidStationSections.ts";
import { routeSectionSelectionKey } from "./routeSectionSelection.ts";

function makeAnalysis({ components = 1, elevations = [100, 160, 125, 230, 205, 125, 155, 80, 120] } = {}) {
  const segments = Array.from({ length: components }, (_, component) => Array.from({ length: elevations.length }, (_, index) => ({
    latitude: 45 + component * 0.2,
    longitude: 13 + index * 0.009,
    elevationM: elevations[index],
  })));
  return analyzeGpxRoute({ segments, name: "Custom section test" });
}

test("new custom plan starts with locked route endpoints and no interior boundaries", () => {
  const analysis = makeAnalysis();
  const plan = createCustomSectionPlan();
  const built = buildCustomRouteSections(analysis, plan);
  assert.equal(plan.startName, "Start");
  assert.equal(plan.finishName, "Finish");
  assert.deepEqual(plan.boundaries, []);
  assert.equal(built.available, true);
  assert.equal(built.sections.length, 1);
  assert.equal(built.sections[0].startPosition.distanceM, 0);
  assert.equal(built.sections[0].endPosition.distanceM, analysis.points.at(-1).distanceM);
});

test("manual boundaries create ordered full-route intervals with named labels and component-scoped selection identities", () => {
  const analysis = makeAnalysis();
  const routeDistanceM = analysis.points.at(-1).distanceM;
  const plan = {
    startName: "Village",
    finishName: "Park",
    boundaries: [
      { id: "custom-point-1", distanceKm: "1.00", name: "Ridge" },
      { id: "custom-point-2", distanceKm: (routeDistanceM / 2000).toFixed(2), name: "Valley" },
    ],
  };
  const built = buildCustomRouteSections(analysis, plan);
  assert.equal(built.available, true);
  assert.equal(built.sections.length, 3);
  assert.deepEqual(built.sections.map((section) => [section.startPosition.distanceM, section.endPosition.distanceM]), [
    [0, 1000], [1000, Number(plan.boundaries[1].distanceKm) * 1000], [Number(plan.boundaries[1].distanceKm) * 1000, routeDistanceM],
  ]);
  assert.deepEqual(built.sections.map((section) => built.labels.get(routeSectionSelectionKey(section))), [
    { from: "Village", to: "Ridge" },
    { from: "Ridge", to: "Valley" },
    { from: "Valley", to: "Park" },
  ]);
  assert.equal(new Set(built.sections.map(routeSectionSelectionKey)).size, 3);
  for (const section of built.sections) {
    assert.equal(section.startPosition.segmentIndex, section.segmentIndex);
    assert.equal(section.endPosition.segmentIndex, section.segmentIndex);
    assert.ok(section.elevationProfile.length >= 2);
    assert.ok(section.mapData?.every((point) => point.segmentIndex === section.segmentIndex));
  }
});

test("boundary add chooses an unused midpoint and respects the count cap", () => {
  let plan = createCustomSectionPlan();
  plan = appendCustomSectionBoundary(plan, 10000);
  assert.equal(plan.boundaries[0].distanceKm, "5.00");
  plan = { ...plan, boundaries: [...plan.boundaries, { id: "custom-point-2", distanceKm: "2.50", name: "" }] };
  plan = appendCustomSectionBoundary(plan, 10000);
  assert.equal(plan.boundaries.at(-1).distanceKm, "7.50");
  const capped = { ...plan, boundaries: Array.from({ length: MAX_CUSTOM_SECTION_BOUNDARIES }, (_, index) => ({ id: `custom-point-${index + 1}`, distanceKm: `${index + 1}`, name: "" })) };
  assert.equal(appendCustomSectionBoundary(capped, 100000), capped);
});

test("invalid, duplicate, unordered and endpoint boundaries fail closed", () => {
  const routeDistanceM = makeAnalysis().points.at(-1).distanceM;
  const base = createCustomSectionPlan();
  for (const distances of [[""], ["NaN"], ["-1"], [String(routeDistanceM / 1000)], ["2", "1"], ["1", "1"]]) {
    const plan = { ...base, boundaries: distances.map((distanceKm, index) => ({ id: `custom-point-${index + 1}`, distanceKm, name: "" })) };
    assert.equal(validateCustomSectionPlan(plan, routeDistanceM).valid, false, `expected ${distances.join(",")} to fail`);
    assert.equal(buildCustomRouteSections(makeAnalysis(), plan).available, false);
  }
  assert.equal(validateCustomSectionPlan({ ...base, startName: "x".repeat(61) }, routeDistanceM).valid, false);
});

test("short custom intervals use existing smoothed profile interpolation", () => {
  const analysis = makeAnalysis();
  const boundary = "0.05";
  const plan = { ...createCustomSectionPlan(), boundaries: [{ id: "custom-point-1", distanceKm: boundary, name: "" }] };
  const result = buildCustomRouteSections(analysis, plan);
  // The existing 100 m resampling supports this interval by interpolation without inventing raw GPX points.
  assert.equal(result.available, true);
  assert.equal(result.sections[0].endPosition.distanceM, 50);
});

test("sub-sample custom intervals use the nearest existing dynamics samples without adding elevation samples", () => {
  const analysis = makeAnalysis();
  const plan = {
    ...createCustomSectionPlan(),
    boundaries: [
      { id: "custom-point-1", distanceKm: "0.02", name: "" },
      { id: "custom-point-2", distanceKm: "0.08", name: "" },
    ],
  };
  const result = buildCustomRouteSections(analysis, plan);
  assert.equal(result.available, true);
  assert.equal(result.sections[1].startPosition.distanceM, 20);
  assert.equal(result.sections[1].endPosition.distanceM, 80);
  assert.deepEqual(result.sections[1].elevationProfile.map((point) => point.distanceM), [20, 80]);
});

test("disconnected GPX components remain separate and are never joined by a custom section", () => {
  const analysis = makeAnalysis({ components: 2 });
  const built = buildCustomRouteSections(analysis, createCustomSectionPlan());
  assert.equal(built.available, true);
  assert.equal(built.sections.length, 2);
  assert.deepEqual([...new Set(built.sections.map((section) => section.segmentIndex))], [0, 1]);
  assert.ok(built.sections.every((section) => section.mapData?.every((point) => point.segmentIndex === section.segmentIndex)));
  assert.ok(built.sections.every((section) => section.elevationProfile.every((point) => Number.isFinite(point.elevationM))));
  const builtDistanceM = built.sections.reduce((sum, section) => sum + section.endPosition.distanceM - section.startPosition.distanceM, 0);
  assert.ok(Math.abs(builtDistanceM - analysis.points.at(-1).distanceM) < 0.001);
});

test("section interval statistics use the shared smoothed profile model and preserve aid-station interval regressions", () => {
  const analysis = makeAnalysis();
  const customPlan = {
    ...createCustomSectionPlan(),
    boundaries: analysis.points.slice(1, -1).map((point, index) => ({
      id: `custom-point-${index + 1}`, distanceKm: String(point.distanceM / 1000), name: `Visit ${index + 1}`,
    })),
  };
  const custom = buildCustomRouteSections(analysis, customPlan);
  const stationVisits = analysis.points.map((point, index) => ({
    visitId: `visit-${index}`, sourceOrder: index, name: `Visit ${index}`,
    sequenceRole: index === 0 ? "start" : index === analysis.points.length - 1 ? "finish" : "intermediate-candidate",
    roles: index === 0 ? ["start"] : index === analysis.points.length - 1 ? ["finish"] : ["aid-station"],
    position: { confidence: "verified", method: index === 0 || index === analysis.points.length - 1 ? "route-endpoint" : "coordinate-projection", componentIndex: 0, distanceKm: point.distanceM / 1000 },
  }));
  const stationResult = buildAidStationSections({
    schemaVersion: 1, status: "available", gpxProvenance: { bindingStatus: "verified" },
    completeness: { status: "complete", declaredCount: stationVisits.length - 2, extractedCount: stationVisits.length },
    stationSegmentation: { available: true, reasonCodes: [] }, visits: stationVisits,
  }, analysis);
  assert.equal(custom.available, true);
  assert.equal(stationResult.available, true);
  assert.deepEqual(custom.sections.map((section) => section.elevationProfile), stationResult.sections.map((section) => section.elevationProfile));
  assert.deepEqual(custom.sections.map((section) => section.ascentM), stationResult.sections.map((section) => section.ascentM));
  assert.deepEqual(custom.sections.map((section) => section.descentM), stationResult.sections.map((section) => section.descentM));
  assert.ok(Math.abs(custom.sections.reduce((sum, section) => sum + section.ascentM, 0) - analysis.metrics.elevationGainM) > 0 || Math.abs(custom.sections.reduce((sum, section) => sum + section.descentM, 0) - analysis.metrics.elevationLossM) > 0,
    "smoothed section totals remain distinct from raw point-to-point whole-route metrics rather than distributing the discrepancy");
});

test("existing local Istria route boundaries are unaffected by custom interval generation", async () => {
  const source = await readFile(new URL("../public/ISTRIA_110K_2027.gpx", import.meta.url), "utf8");
  const { parseGpxText } = await import("./gpxAnalysis.ts");
  const analysis = analyzeGpxRoute(parseGpxText(source));
  const before = analysis.routeSections.map((section) => [section.id, section.segmentIndex, section.startPosition.distanceM, section.endPosition.distanceM]);
  const custom = buildCustomRouteSections(analysis, createCustomSectionPlan());
  assert.equal(custom.available, true);
  assert.deepEqual(analysis.routeSections.map((section) => [section.id, section.segmentIndex, section.startPosition.distanceM, section.endPosition.distanceM]), before);
});

test("Route Analysis presents the shared custom section browser without changing Race Mode or analysis execution", async () => {
  const [view, browser, raceMode] = await Promise.all([
    readFile(new URL("./RouteAnalysisView.tsx", import.meta.url), "utf8"),
    readFile(new URL("./RouteSectionBrowser.tsx", import.meta.url), "utf8"),
    readFile(new URL("./CourseSection.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(view, /segmentationMode: "terrain" \| "custom" \| "aid-station"/);
  assert.match(view, /customPlanState\.analysis === analysis \? customPlanState\.plan : createCustomSectionPlan\(\)/, "the plan remains separate from the selected view mode");
  assert.match(view, /CustomSectionControls/);
  assert.match(view, /selectionSections=\{activeSections\}/);
  assert.match(view, /buildCustomRouteSections\(analysis, customPlan\)/);
  assert.match(view, /selectedMoment=\{selectedMoment\}/);
  assert.match(browser, /sectionKind === "Custom Section" \? \[section\.description\]/);
  assert.match(browser, /aria-pressed=\{isSelected\}/);
  assert.doesNotMatch(raceMode, /Custom Sections/);
});
