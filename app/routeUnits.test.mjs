import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  distanceInputToKm,
  distanceKmToInput,
  formatDistanceMeters,
  formatNarrativeDistance,
  formatElevationMeters,
  readStoredRouteUnits,
  writeStoredRouteUnits,
} from "./routeUnits.ts";
import { getRouteElevationMetricDescription } from "./routeElevationMetrics.ts";
import { presentKeyMomentCard } from "./routeKeyMomentPresentation.ts";

test("metric is the safe default and valid unit preference can be persisted locally", () => {
  const values = new Map();
  const storage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  assert.equal(readStoredRouteUnits(null), "metric");
  assert.equal(readStoredRouteUnits(storage), "metric");
  assert.equal(writeStoredRouteUnits(storage, "us-customary"), true);
  assert.equal(readStoredRouteUnits(storage), "us-customary");
  assert.equal(writeStoredRouteUnits(null, "metric"), false);
  assert.equal(readStoredRouteUnits({ getItem() { throw new Error("storage unavailable"); } }), "metric");
  assert.equal(writeStoredRouteUnits({ setItem() { throw new Error("storage unavailable"); } }, "metric"), false);
  assert.equal(readStoredRouteUnits({ getItem: () => "unexpected" }), "metric");
});

test("central conversion helpers use exact mile and foot factors with readable rounding", () => {
  assert.equal(formatDistanceMeters(1609.344, "us-customary", 1), "1 mi");
  assert.equal(formatDistanceMeters(1000, "metric", 1), "1 km");
  assert.equal(formatDistanceMeters(1, "us-customary"), "0.001 mi");
  assert.equal(formatElevationMeters(304.8, "us-customary"), "1,000 ft");
  assert.equal(formatElevationMeters(304.8, "metric"), "305 m");
  assert.equal(distanceInputToKm("10", "metric"), "10");
  assert.equal(Number(distanceInputToKm("10", "us-customary")), 16.09344);
  assert.equal(Number(distanceInputToKm("5,5", "us-customary")), 8.851392);
  assert.equal(distanceInputToKm(" ", "us-customary"), " ");
  assert.equal(distanceInputToKm("invalid", "us-customary"), "invalid");
});

test("narrative distances use natural mile wording while compact values retain abbreviations", () => {
  assert.equal(formatNarrativeDistance(1609.344, "us-customary"), "mile 1");
  assert.equal(formatNarrativeDistance(35_405.568, "us-customary"), "miles 22");
  assert.equal(formatNarrativeDistance(22_047.016, "us-customary"), "miles 13.7");
  assert.equal(formatNarrativeDistance(22_000, "metric"), "km 22");
  assert.equal(formatDistanceMeters(22_000, "us-customary", 1), "13.7 mi");
});

test("elevation-method disclosure keeps its sampling distances in the selected unit system", () => {
  const metric = getRouteElevationMetricDescription("metric");
  const customary = getRouteElevationMetricDescription("us-customary");
  assert.match(metric, /every 50 m and a 50 m-radius/);
  assert.match(customary, /every 164 ft and a 164 ft-radius/);
  assert.doesNotMatch(customary, /50 m/);
});

test("Key Moment values and locations convert while measured gradients remain percentages", () => {
  const points = [
    { segmentIndex: 0, distanceM: 0, elevationM: 100 },
    { segmentIndex: 0, distanceM: 1609.344, elevationM: 300 },
    { segmentIndex: 0, distanceM: 3218.688, elevationM: 500 },
  ];
  const moment = {
    id: "long-climb", title: "Longest climb", focusStartKm: 0, focusEndKm: 3.218688,
    number: "01", distance: "", text: "", source: "GPX-derived", segmentIndex: 0,
    measurement: { kind: "event", direction: "climb", startDistanceM: 0, endDistanceM: 3218.688, distanceM: 3218.688, elevationChangeM: 400, segmentIndex: 0, roles: ["longest", "largest"] },
  };
  const card = presentKeyMomentCard(moment, points, 3218.688, "us-customary");
  assert.ok(card);
  assert.equal(card.value, "2.0 mi");
  assert.match(card.locationSentence, /0 mi to 2 mi/);
});

test("repeated unit switches preserve canonical custom boundaries without conversion drift", () => {
  const canonicalBoundaryKm = "37.123456789";
  let visibleValue = canonicalBoundaryKm;
  for (let index = 0; index < 100; index += 1) {
    visibleValue = distanceKmToInput(canonicalBoundaryKm, "us-customary");
    const convertedBack = Number(distanceInputToKm(visibleValue, "us-customary"));
    assert.ok(Math.abs(convertedBack - Number(canonicalBoundaryKm)) < 1e-10);
  }
  assert.equal(canonicalBoundaryKm, "37.123456789");
  assert.equal(distanceKmToInput(canonicalBoundaryKm, "metric"), canonicalBoundaryKm);
});

test("public Route Analysis uses one selector and unit-aware route, moment, profile, section, and narrative presenters", async () => {
  const filenames = ["RouteMode.tsx", "CourseExplorer.tsx", "RouteAnalysisView.tsx", "CourseSection.tsx", "KeyRouteMoments.tsx", "RouteSectionBrowser.tsx", "RouteSectionProfile.tsx", "CustomSectionControls.tsx", "CourseBriefView.tsx", "routeKeyMomentPresentation.ts", "routeSectionNarrativeV2.ts", "courseBriefWholeRouteNarrative.ts", "TerrainImageViewer.tsx"];
  const [routeMode, explorer, analysis, raceModeSection, keyMoments, sectionBrowser, sectionProfile, customControls, courseBrief, keyPresentation, narrative, briefNarrative, imageViewer] = await Promise.all(
    filenames.map((file) => readFile(new URL(`./${file}`, import.meta.url), "utf8")),
  );
  assert.equal((routeMode.match(/<RouteUnitPreferenceProvider>/g) ?? []).length, 1);
  assert.equal((explorer.match(/<RouteUnitToggle \/>/g) ?? []).length, 1);
  assert.match(analysis, /useRouteUnits/);
  assert.match(analysis, /showUnitToggle/);
  assert.doesNotMatch(raceModeSection, /showUnitToggle/);
  for (const source of [explorer, keyMoments, sectionBrowser, sectionProfile, customControls, keyPresentation, narrative, briefNarrative]) {
    assert.match(source, /routeUnits|useRouteUnits|RouteUnitSystem/);
  }
  assert.match(explorer, /showUnitToggle && points\.length > 0 && <RouteUnitToggle \/>/);
  assert.match(explorer, /units=\{units\}/);
  assert.match(keyMoments, /units=\{units\}/);
  assert.match(sectionProfile, /Elevation \(\{elevationUnit\(units\)\}\)/);
  assert.match(customControls, /distanceKmToInput\(boundary\.distanceKm, units\)/);
  assert.match(customControls, /distanceInputToKm\(value, units\)/);
  assert.match(customControls, /type="text" inputMode="decimal"/);
  assert.match(customControls, /canonicalValue === boundary\.distanceKm/);
  assert.match(imageViewer, /formatDistanceMeters\(image\.distanceAlongRouteKm \* 1000, units\)/);
  assert.match(courseBrief, /composeCourseBriefWholeRouteNarrative[\s\S]*units/);
  assert.match(sectionBrowser, /presentRouteSectionNarrativeV2\([\s\S]*units\)/);
});
