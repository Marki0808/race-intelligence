import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createRouteSectionOverviewLayout } from "./routeSectionOverviewModel.ts";

function point(distanceM, elevationM, segmentIndex = 0) {
  return { latitude: 45, longitude: 14 + distanceM / 100_000, distanceM, elevationM, segmentIndex };
}

function section(startDistanceM, endDistanceM, segmentIndex = 0, endSegmentIndex = segmentIndex) {
  return {
    segmentIndex,
    startPosition: { distanceM: startDistanceM, segmentIndex },
    endPosition: { distanceM: endDistanceM, segmentIndex: endSegmentIndex },
  };
}

test("overview selection width stays proportional for short and long route sections", () => {
  const route = [point(0, 100), point(5_000, 400), point(15_000, 150)];
  const short = createRouteSectionOverviewLayout(route, section(1_000, 1_500), 900);
  const long = createRouteSectionOverviewLayout(route, section(1_000, 13_000), 900);
  assert.ok(short && long);
  const plotWidth = 900 - 42 - 12;
  assert.ok(Math.abs((short.selectedRange.endX - short.selectedRange.startX) / plotWidth - 500 / 15_000) < 1e-12);
  assert.ok(Math.abs((long.selectedRange.endX - long.selectedRange.startX) / plotWidth - 12_000 / 15_000) < 1e-12);
  assert.ok(short.selectedRange.endX - short.selectedRange.startX < long.selectedRange.endX - long.selectedRange.startX);
});

test("fractional boundaries are placed and clipped at their exact full-route distances", () => {
  const route = [point(0, 100), point(5_000, 300), point(10_000, 200)];
  const start = 1_234.25;
  const end = 8_765.75;
  const layout = createRouteSectionOverviewLayout(route, section(start, end), 1_000);
  assert.ok(layout?.selectedRange);
  assert.equal(layout.selectedRange.startDistanceM, start);
  assert.equal(layout.selectedRange.endDistanceM, end);
  assert.equal((layout.selectedRange.startX - 42) / (1_000 - 42 - 12), start / 10_000);
  assert.equal((layout.selectedRange.endX - 42) / (1_000 - 42 - 12), end / 10_000);
  assert.equal(layout.selectedRuns[0].points[0].distanceM, start);
  assert.equal(layout.selectedRuns.at(-1).points.at(-1).distanceM, end);
});

test("disconnected components stay separate and a cross-component selection is not highlighted", () => {
  const route = [point(0, 100, 0), point(5_000, 300, 0), point(5_000, 250, 1), point(10_000, 150, 1)];
  const selected = createRouteSectionOverviewLayout(route, section(6_000, 9_000, 1), 900);
  assert.deepEqual(selected.components.map((run) => run.segmentIndex), [0, 1]);
  assert.deepEqual(selected.selectedRuns.map((run) => run.segmentIndex), [1]);
  const invalid = createRouteSectionOverviewLayout(route, section(4_000, 6_000, 0, 1), 900);
  assert.equal(invalid.selectedRange, null);
  assert.deepEqual(invalid.selectedRuns, []);
});

test("full-route distance ticks retain route endpoints and follow Metric or US units", () => {
  const route = [point(0, 100), point(10_000, 500)];
  const metric = createRouteSectionOverviewLayout(route, section(2_000, 8_000), 900, "metric");
  const customary = createRouteSectionOverviewLayout(route, section(2_000, 8_000), 900, "us-customary");
  assert.ok(metric && customary);
  assert.equal(metric.totalDistanceM, 10_000);
  assert.equal(metric.distanceTicks[0].distanceM, 0);
  assert.equal(metric.distanceTicks.at(-1).distanceM, 10_000);
  assert.ok(metric.distanceTicks.every((tick) => Math.abs(tick.x - (42 + tick.distanceM / 10_000 * (900 - 42 - 12))) < 1e-10));
  assert.match(metric.distanceTicks[0].label, /km$/);
  assert.match(customary.distanceTicks[0].label, /mi$/);
  assert.notEqual(metric.distanceTicks.at(-1).label, customary.distanceTicks.at(-1).label);
});

test("overview uses the full route rather than section-clipped profile data", () => {
  const fullRoute = [point(0, 100), point(5_000, 400), point(15_000, 150)];
  const selected = section(1_000, 1_500);
  const full = createRouteSectionOverviewLayout(fullRoute, selected, 900);
  const clipped = createRouteSectionOverviewLayout([point(1_000, 160), point(1_500, 190)], selected, 900);
  assert.ok(full && clipped);
  assert.equal(full.totalDistanceM, 15_000);
  assert.equal(full.selectedRange.startDistanceM, 1_000);
  assert.equal(full.selectedRange.endDistanceM, 1_500);
  assert.equal(clipped.totalDistanceM, 1_500, "section-clipped input visibly loses the route-wide distance scale");
});

test("overview remains compact and responsive while detailed inspection behavior is retained", async () => {
  const [overview, detail, browser, profilePresentation, routeView, customSections] = await Promise.all([
    readFile(new URL("./RouteSectionOverview.tsx", import.meta.url), "utf8"),
    readFile(new URL("./RouteSectionProfile.tsx", import.meta.url), "utf8"),
    readFile(new URL("./RouteSectionBrowser.tsx", import.meta.url), "utf8"),
    readFile(new URL("./routeSectionProfilePresentation.ts", import.meta.url), "utf8"),
    readFile(new URL("./RouteAnalysisView.tsx", import.meta.url), "utf8"),
    readFile(new URL("./customRouteSections.ts", import.meta.url), "utf8"),
  ]);
  assert.match(overview, /FULL ROUTE OVERVIEW/);
  assert.match(overview, /Selected section highlighted/);
  assert.match(overview, /className="block h-\[124px\] w-full/);
  assert.match(overview, /preserveAspectRatio="none"/);
  assert.match(overview, /new ResizeObserver/);
  assert.ok(browser.indexOf("<RouteSectionOverview") < browser.indexOf("<RouteSectionProfile"));
  assert.match(browser, /<RouteSectionOverview section=\{section\} routePoints=\{routePoints\} units=\{units\} \/>/);
  assert.match(detail, /ZOOMED SECTION DETAIL · FULL-ROUTE DISTANCE/);
  assert.match(detail, /onPointerMove=\{pointerMove\}/);
  assert.match(detail, /nearestRouteProfilePoint\(samples, distanceM, elevationM\)/);
  assert.match(profilePresentation, /new Set<number>\(\[startDistanceM, endDistanceM\]\)/);
  assert.match(profilePresentation, /formatDistanceMeters\(distanceM, units, distanceM === startDistanceM \|\| distanceM === endDistanceM \? 2 : 0\)/);
  assert.match(routeView, /<RouteSectionBrowser sections=\{activeSections\} routePoints=\{analysis\.points\}/,
    "Automatic and Custom sections receive complete route points, not clipped section points");
  assert.match(routeView, /buildCustomRouteSections\(analysis, customPlan, units\)/,
    "manual distance and profile-picked boundaries share the same Custom Sections data path");
  assert.match(routeView, /insertProfileCustomBoundary\(customPlan, routeDistanceM, distanceM\)/);
  assert.match(routeView, /appendCustomSectionBoundary\(customPlan, routeDistanceM\)/);
  assert.match(customSections, /buildRouteSectionsFromIntervals\(analysis, definitions\)/);
});
