import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { buildLiveCustomSectionMetrics, findCustomSectionEndingAtBoundary, resolveAutomaticSectionSelection, shouldReturnToAutomaticAfterEditing } from "./liveCustomSectionSummaryModel.ts";
import { calculateSectionGradeMetrics, formatSectionGradePercent } from "./sectionGradeMetrics.ts";
import { findSelectedRouteSection, routeSectionSelectionKey } from "./routeSectionSelection.ts";

function makeSection({ id, startM, endM, startElevation = 100, slope = 0.1, gaps = false }) {
  const elevations = gaps
    ? [{ distanceM: startM, elevationM: startElevation }, { distanceM: endM, elevationM: startElevation + (endM - startM) * slope }]
    : Array.from({ length: Math.floor((endM - startM) / 100) + 1 }, (_, index) => ({ distanceM: startM + index * 100, elevationM: startElevation + index * 100 * slope }));
  if (elevations.at(-1).distanceM !== endM) elevations.push({ distanceM: endM, elevationM: startElevation + (endM - startM) * slope });
  return {
    id, segmentIndex: 0, startPosition: { distanceM: startM, segmentIndex: 0 }, endPosition: { distanceM: endM, segmentIndex: 0 },
    startKm: startM / 1000, endKm: endM / 1000, distanceKm: (endM - startM) / 1000,
    ascentM: Math.max(0, (endM - startM) * slope), descentM: Math.max(0, -(endM - startM) * slope),
    elevationProfile: elevations,
  };
}

test("a newly added boundary selects the immediately completed interval in route order", () => {
  const boundaries = [{ id: "custom-point-2", distanceKm: "15" }, { id: "custom-point-1", distanceKm: "8" }];
  const sections = [
    makeSection({ id: "custom-section-start-custom-point-1-component-0", startM: 0, endM: 8000 }),
    makeSection({ id: "custom-section-custom-point-1-custom-point-2-component-0", startM: 8000, endM: 15000 }),
    makeSection({ id: "custom-section-custom-point-2-finish-component-0", startM: 15000, endM: 20000 }),
  ];
  assert.equal(findCustomSectionEndingAtBoundary(sections, boundaries, "custom-point-1"), sections[0]);
  assert.equal(findCustomSectionEndingAtBoundary(sections, boundaries, "custom-point-2"), sections[1]);
  assert.equal(findCustomSectionEndingAtBoundary(sections, boundaries, "removed-boundary"), null);
});

test("automatic section mode restores a valid highlight and clears stale keys; empty profile edits return to automatic", () => {
  const automatic = makeSection({ id: "automatic-section-1", startM: 0, endM: 8000 });
  const key = routeSectionSelectionKey(automatic);
  assert.deepEqual(resolveAutomaticSectionSelection([automatic], key), { segmentationMode: "terrain", selectedSectionKey: key });
  assert.deepEqual(resolveAutomaticSectionSelection([], key), { segmentationMode: "terrain", selectedSectionKey: null });
  assert.equal(shouldReturnToAutomaticAfterEditing([]), true);
  assert.equal(shouldReturnToAutomaticAfterEditing([{ id: "custom-point-1", distanceKm: "8" }]), false);
});

test("live summary matches detailed section grade metrics and formats both unit systems", () => {
  const section = makeSection({ id: "custom-section-start-custom-point-1-component-0", startM: 8000, endM: 15000, startElevation: 100, slope: 0.1 });
  const expected = calculateSectionGradeMetrics(section);
  assert.equal(expected.status, "available");
  const metric = buildLiveCustomSectionMetrics(section, "metric");
  const customary = buildLiveCustomSectionMetrics(section, "us-customary");
  const get = (metrics, label) => metrics.find((item) => item.label === label);
  assert.equal(get(metric, "Start").value, "8 km");
  assert.equal(get(metric, "End").value, "15 km");
  assert.equal(get(metric, "Length").value, "7 km");
  assert.equal(get(metric, "Average uphill grade").value, formatSectionGradePercent(expected.averageUphillGradePct));
  assert.equal(get(metric, "Steepest uphill 100 m").value, formatSectionGradePercent(expected.steepestUphill100m.gradePct));
  assert.equal(get(customary, "Start").value, "4.97 mi");
  assert.equal(get(customary, "Length").value, "4.35 mi");
  assert.equal(get(customary, "Steepest uphill 100 m").value, get(metric, "Steepest uphill 100 m").value);
});

test("downhill grade signs and selected summary stay aligned with the detailed section selection", () => {
  const section = makeSection({ id: "custom-section-custom-point-1-custom-point-2-component-0", startM: 8000, endM: 15000, startElevation: 900, slope: -0.08 });
  const grades = calculateSectionGradeMetrics(section);
  const metrics = buildLiveCustomSectionMetrics(section, "metric");
  const value = (label) => metrics.find((item) => item.label === label).value;
  assert.equal(value("Average downhill grade"), formatSectionGradePercent(-grades.averageDownhillGradePct));
  assert.equal(value("Steepest downhill 100 m"), formatSectionGradePercent(grades.steepestDownhill100m.gradePct));
  const key = routeSectionSelectionKey(section);
  assert.equal(findSelectedRouteSection([section], key), section);
  assert.equal(findSelectedRouteSection([], key), null);
});

test("incomplete grade profiles are described as unavailable rather than zero", () => {
  const section = makeSection({ id: "incomplete", startM: 0, endM: 1000, gaps: true });
  const metrics = buildLiveCustomSectionMetrics(section, "metric");
  assert.equal(calculateSectionGradeMetrics(section).status, "unavailable");
  assert.match(metrics.find((item) => item.label === "Average uphill grade").value, /Unavailable/);
  assert.match(metrics.find((item) => item.label === "Steepest downhill 100 m").value, /Unavailable/);
  assert.doesNotMatch(metrics.map((item) => item.value).join(" "), /\b0\.0%/);
});

test("summary stays bound to the selected section, exposes a non-editing section selector, and links to details", async () => {
  const [profile, summary, analysis, numericControls, sectionBrowser] = await Promise.all([
    readFile(new URL("./CourseExplorer.tsx", import.meta.url), "utf8"),
    readFile(new URL("./LiveSectionSummary.tsx", import.meta.url), "utf8"),
    readFile(new URL("./RouteAnalysisView.tsx", import.meta.url), "utf8"),
    readFile(new URL("./CustomSectionControls.tsx", import.meta.url), "utf8"),
    readFile(new URL("./RouteSectionBrowser.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(profile, /selectedSection=\{selectedSection\}/);
  assert.match(profile, /stroke="#f2d675" strokeWidth="7"/);
  assert.match(profile, /sectionKind === "Custom Section"[\s\S]*customBoundaries\.length > 0[\s\S]*sectionKind === "Route Section" && selectedSection !== null/);
  assert.match(profile, /showLiveSectionSummary/);
  assert.match(summary, /<select/);
  assert.match(summary, /View full section analysis/);
  assert.match(analysis, /findCustomSectionEndingAtBoundary/);
  assert.match(analysis, /onBoundaryDistanceChange=\{editCustomBoundaryDistance\}/);
  assert.match(analysis, /Switch to automatic sections/);
  assert.match(analysis, /shouldReturnToAutomaticAfterEditing\(customPlan\.boundaries\)/);
  assert.match(analysis, /resolveAutomaticSectionSelection\(displayedSections, previousAutomaticKey\)/);
  assert.match(analysis, /updateViewState\(\{ segmentationMode: showingCustomSections \? "custom" : "terrain", selectedSectionKey: selectionKey/);
  assert.match(analysis, /function switchToAutomaticSections\(\)[\s\S]*resolveAutomaticSectionSelection/);
  assert.match(analysis, /function switchToAutomaticSections\(\)[\s\S]*updateViewState\(\{[\s\S]*selectedMoment: null/);
  const automaticSwitchBody = analysis.match(/function switchToAutomaticSections\(\) \{([\s\S]*?)\n  \}/)?.[1] ?? "";
  assert.doesNotMatch(automaticSwitchBody, /updateCustomPlan|setCustomPlanState|createCustomSectionPlan/);
  assert.match(numericControls, /onBoundaryDistanceChange\(nextPlan, boundary\.id\)/);
  assert.match(sectionBrowser, /data-route-section-selection-key/);
});
