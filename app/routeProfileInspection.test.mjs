import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { nearestRouteProfilePoint } from "./routeProfileInspection.ts";

const [explorer, routeAnalysisView, raceSection, sectionBrowser] = await Promise.all([
  readFile(new URL("./CourseExplorer.tsx", import.meta.url), "utf8"),
  readFile(new URL("./RouteAnalysisView.tsx", import.meta.url), "utf8"),
  readFile(new URL("./CourseSection.tsx", import.meta.url), "utf8"),
  readFile(new URL("./RouteSectionBrowser.tsx", import.meta.url), "utf8"),
]);

test("profile inspection returns the nearest measured GPX sample without interpolation", () => {
  const points = [
    { distanceM: 0, elevationM: 100, latitude: 45, longitude: 14, segmentIndex: 0 },
    { distanceM: 120, elevationM: 140, latitude: 45.1, longitude: 14.1, segmentIndex: 0 },
    { distanceM: 240, elevationM: 120, latitude: 45.2, longitude: 14.2, segmentIndex: 0 },
  ];
  assert.deepEqual(nearestRouteProfilePoint(points, 190, 125), points[2]);
  assert.equal(nearestRouteProfilePoint(points, Number.NaN, 125), null);
  assert.equal(nearestRouteProfilePoint([], 10, 100), null);
});

test("equal-distance disconnected samples are resolved by inspected elevation and retain component identity", () => {
  const first = { distanceM: 1000, elevationM: 300, latitude: 45, longitude: 14, segmentIndex: 0 };
  const second = { distanceM: 1000, elevationM: 900, latitude: 46, longitude: 15, segmentIndex: 1 };
  assert.deepEqual(nearestRouteProfilePoint([first, second], 1000, 880), second);
  assert.deepEqual(nearestRouteProfilePoint([first, second], 1000, 310), first);
});


test("Race and Route Mode use accurate analysis headings and a single five-metric profile row", () => {
  assert.match(raceSection, /heading=\{raceRecord\.race\.name \|\| "Race course"\}/);
  assert.match(raceSection, /showExtendedMetrics/);
  assert.match(routeAnalysisView, /heading="GPX Route Analysis"/);
  assert.match(routeAnalysisView, /eyebrow="YOUR ROUTE · GPX-DERIVED"/);
  assert.doesNotMatch(routeAnalysisView, /CourseAnalysis|analysis\.metrics\.distanceKm\.toFixed/);
  assert.match(explorer, /Full-route metrics/);
  assert.match(explorer, /selectedSection\.distanceKm/);
  assert.match(explorer, /selectedSection\.ascentM/);
  assert.match(explorer, /selectedSection\.descentM/);
  assert.match(explorer, /selectedSection\.elevationMaxM/);
  assert.match(explorer, /selectedSection\.elevationMinM/);
  assert.match(explorer, /Clear Route Section selection/);
});

test("profile inspection shows measured point values and distinguishes drags from interval selection", () => {
  assert.match(explorer, /nearestRouteProfilePoint\(points, distanceM, elevationM\)/);
  assert.match(explorer, /inspectedPoint\.distanceM \/ 1000/);
  assert.match(explorer, /inspectedPoint\.elevationM/);
  assert.match(explorer, /Math\.hypot\(event\.clientX - gesture\.startX, event\.clientY - gesture\.startY\) > 8/);
  assert.match(explorer, /gesture\.longPressed = true/);
  assert.match(explorer, /window\.setTimeout\(\(\) =>/);
  assert.match(explorer, /ignorePointerSelection\(event\)/);
  assert.match(explorer, /touch-pan-y/);
  assert.match(explorer, /aria-live="polite"/);
});

test("section profile selection toggles and clears without scrolling to the section list", () => {
  assert.match(explorer, /isSelected \? null : section/);
  assert.match(explorer, /onSelectSection\(null\)/);
  assert.doesNotMatch(sectionBrowser, /scrollIntoView/);
  assert.match(sectionBrowser, /aria-expanded=\{isSelected\}/);
});

test("section details keep one concise overview visible and place full chronology after metrics, profile and map", () => {
  const overview = sectionBrowser.indexOf("{expectation.paragraphs[0] ?? section.description}");
  const metrics = sectionBrowser.indexOf("<SectionMetric label=\"Ascent\"");
  const profile = sectionBrowser.indexOf("<MiniProfile section={section} />");
  const map = sectionBrowser.indexOf("<SectionSubheading>Section map · GPX-derived</SectionSubheading>");
  const detail = sectionBrowser.indexOf("<summary className=\"min-h-11 cursor-pointer py-3 text-sm font-semibold\">Detailed elevation changes");
  assert.ok(overview >= 0 && overview < metrics && metrics < profile && profile < map && map < detail);
  assert.match(sectionBrowser, /expectation\.paragraphs\.slice\(1\)/);
  assert.match(sectionBrowser, /<details className=/);
});

test("Race and Route Mode share the same evidence-bounded sustained-gradient moments and actual GPX profile cards", async () => {
  const [raceView, routeView, keyMoment, helper] = await Promise.all([
    readFile(new URL("./CourseSection.tsx", import.meta.url), "utf8"),
    readFile(new URL("./RouteAnalysisView.tsx", import.meta.url), "utf8"),
    readFile(new URL("./KeyMoment.tsx", import.meta.url), "utf8"),
    readFile(new URL("./routeGradientMoments.ts", import.meta.url), "utf8"),
  ]);
  assert.match(raceView, /buildSustainedGradientKeyMoments\(routeAnalysis\?\.gradientIntelligence, raceRecord\.intelligence\.keyMoments\)/);
  assert.match(routeView, /buildSustainedGradientKeyMoments\(analysis\.gradientIntelligence, analysis\.keyMoments\)/);
  assert.match(keyMoment, /getKeyMomentProfilePoints\(routePoints/);
  assert.match(keyMoment, /keyMomentProfilePolyline\(profilePoints\)/);
  assert.match(routeView, /routePoints=\{analysis\.points\}/);
  assert.match(helper, /interval\.confidence === 'high'/);
  assert.match(helper, /interval\.distanceM >= 1500/);
  assert.match(helper, /interval\.gradientBand === 'steep'/);
  assert.match(helper, /isAlreadyCovered/);
});

test("route character takeaways are shared by both modes and remain component local", async () => {
  const [raceView, routeView, component] = await Promise.all([
    readFile(new URL("./CourseSection.tsx", import.meta.url), "utf8"),
    readFile(new URL("./RouteAnalysisView.tsx", import.meta.url), "utf8"),
    readFile(new URL("./RouteTakeaways.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(raceView, /<RouteTakeaways analysis=\{routeAnalysis\}/);
  assert.match(routeView, /<RouteTakeaways analysis=\{analysis\}/);
  assert.match(component, /Understand the character of the course\./);
  assert.match(component, /Don’t just analyze the route\. Understand it\./);
});

test("map dims the full route and emphasizes only the selected component-scoped section", () => {
  assert.match(explorer, /color: "#718078", weight: 4, opacity: 0\.78/);
  assert.match(explorer, /clipRoutePointsToSection\(points, selectedSection\)/);
  assert.match(explorer, /color: "#17211c", weight: 8, opacity: 1/);
  assert.match(explorer, /key=\{`\$\{section\.segmentIndex\}:\$\{section\.id\}:profile-hit`\}/);
});
