import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import { nearestRouteProfilePoint } from "./routeProfileInspection.ts";

const [explorer, routeAnalysisView, raceSection, sectionBrowser] = await Promise.all([
  readFile(new URL("./CourseExplorer.tsx", import.meta.url), "utf8"),
  readFile(new URL("./RouteAnalysisView.tsx", import.meta.url), "utf8"),
  readFile(new URL("./CourseSection.tsx", import.meta.url), "utf8"),
  readFile(new URL("./RouteSectionBrowser.tsx", import.meta.url), "utf8"),
]);
const require = createRequire(import.meta.url);

function loadProfilePresentationHelper() {
  const url = new URL("./routeProfilePresentation.ts", import.meta.url);
  const source = require("node:fs").readFileSync(url, "utf8");
  const js = ts.transpile(source, { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 });
  const transpiledModule = { exports: {} };
  new Function("exports", "require", "module", "__filename", "__dirname", js)(transpiledModule.exports, (specifier) => specifier === "./routeSectionSelection" ? { routeSectionSelectionKey: (section) => `${section.segmentIndex}:${section.id}` } : require(specifier), transpiledModule, url.pathname, new URL(".", url).pathname);
  return transpiledModule.exports;
}

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

test("section details present the full generated chronology under What to Expect without raw interval lists", () => {
  const heading = sectionBrowser.indexOf("<SectionSubheading>What to Expect</SectionSubheading>");
  const narrative = sectionBrowser.indexOf("whatToExpect.map(");
  const metrics = sectionBrowser.indexOf("<SectionMetric label=\"Ascent\"");
  const profile = sectionBrowser.indexOf("<RouteSectionProfile section={section} routePoints={routePoints} />");
  const map = sectionBrowser.indexOf("<SectionSubheading>Section map · GPX-derived</SectionSubheading>");
  assert.ok(heading >= 0 && heading < narrative && narrative < metrics && metrics < profile && profile < map);
  assert.match(sectionBrowser, /presentRouteSectionNarrativeV2\(gradientIntelligence, routeSections, section\)/);
  assert.doesNotMatch(sectionBrowser, /Detailed elevation changes|Measured route changes|sortRouteEmbeddedEventsForDisplay/);
  assert.doesNotMatch(sectionBrowser, /expectation\.paragraphs\.slice\(1\)/);
});

test("Race and Route Mode share compact measured Key Moment cards and a complete-route profile", async () => {
  const [raceView, routeView, keyMoment, helper] = await Promise.all([
    readFile(new URL("./CourseSection.tsx", import.meta.url), "utf8"),
    readFile(new URL("./RouteAnalysisView.tsx", import.meta.url), "utf8"),
    readFile(new URL("./KeyMoment.tsx", import.meta.url), "utf8"),
    readFile(new URL("./routeGradientMoments.ts", import.meta.url), "utf8"),
  ]);
  assert.match(raceView, /buildSustainedGradientKeyMoments\(routeAnalysis\.gradientIntelligence, routeAnalysis\.keyMoments\)/);
  assert.match(routeView, /buildSustainedGradientKeyMoments\(analysis\.gradientIntelligence, analysis\.keyMoments\)/);
  assert.match(keyMoment, /aria-pressed=\{selected\}/);
  assert.match(keyMoment, /card\.locationSentence/);
  assert.doesNotMatch(keyMoment, /<svg|position bar|startPercent/);
  const sharedMoments = await readFile(new URL("./KeyRouteMoments.tsx", import.meta.url), "utf8");
  assert.match(sharedMoments, /<ElevationProfile[\s\S]*?momentMarkers=\{markerInputs\}/);
  assert.match(sharedMoments, /Key Moments along the full route/);
  assert.match(routeView, /routePoints=\{analysis\.points\}/);
  assert.match(raceView, /routePoints=\{routeAnalysis\.points\}/);
  assert.doesNotMatch(raceView, /raceRecord\.intelligence\.keyMoments/);
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
  assert.match(component, /Course Takeaways/);
  assert.match(component, /Don’t just analyze the route\. Understand it\./);
  assert.match(component, /if \(!takeaways\.length\) return null/);
  assert.ok(routeView.indexOf("<RouteSectionBrowser") < routeView.indexOf("<KeyRouteMoments") && routeView.indexOf("<KeyRouteMoments") < routeView.indexOf("<RouteTakeaways"));
  assert.ok(raceSection.indexOf("<RouteSectionBrowser") < raceSection.indexOf("<KeyRouteMoments") && raceSection.indexOf("<KeyRouteMoments") < raceSection.indexOf("<RouteTakeaways"));
});

test("main and section maps retain full-route context and only overlay component-scoped selected geometry", async () => {
  const sectionMap = await readFile(new URL("./TerrainSectionMap.tsx", import.meta.url), "utf8");
  const mapStyles = await readFile(new URL("./routeMapStyles.ts", import.meta.url), "utf8");
  assert.match(explorer, /ROUTE_MAP_STYLES\.contextHalo/);
  assert.match(explorer, /ROUTE_MAP_STYLES\.context/);
  assert.match(explorer, /clipRoutePointsToSection\(points, selectedSection\)/);
  assert.match(explorer, /ROUTE_MAP_STYLES\.selectedSection/);
  assert.match(explorer, /ROUTE_MAP_STYLES\.selectedMoment/);
  assert.doesNotMatch(explorer, /fitBounds\(selectedSectionPoints/);
  assert.match(explorer, /lastMapSelectionRef/);
  assert.match(sectionMap, /groupAnalyzedPointsBySegment\(points\)/);
  assert.match(sectionMap, /clipRoutePointsToSection\(points, section\)/);
  assert.match(sectionMap, /ROUTE_MAP_STYLES\.contextHalo/);
  assert.match(sectionMap, /ROUTE_MAP_STYLES\.context/);
  assert.match(sectionMap, /ROUTE_MAP_STYLES\.selectedSection/);
  assert.match(mapStyles, /contextHalo: \{ color: "#f8f8f4", weight: 8/);
  assert.match(mapStyles, /context: \{ color: "#46514d", weight: 4/);
  assert.match(sectionMap, /zoomControl: true/);
});

test("section mini-profile uses absolute route bounds, elevation axes, actual samples and pointer/touch inspection", async () => {
  const [browser, profile, helperSource] = await Promise.all([
    readFile(new URL("./RouteSectionBrowser.tsx", import.meta.url), "utf8"),
    readFile(new URL("./RouteSectionProfile.tsx", import.meta.url), "utf8"),
    readFile(new URL("./routeSectionProfilePresentation.ts", import.meta.url), "utf8"),
  ]);
  assert.match(browser, /routePoints=\{routePoints\}/);
  assert.match(profile, /point\.segmentIndex === section\.segmentIndex/);
  assert.match(profile, /Elevation \(m\)/);
  assert.match(profile, /onPointerMove/);
  assert.match(profile, /event\.pointerType === "touch"/);
  assert.match(profile, /press and hold/);
  const presentation = loadProfilePresentationHelper();
  const helperUrl = new URL("./routeSectionProfilePresentation.ts", import.meta.url);
  const helperJs = ts.transpile(helperSource, { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 });
  const helperModule = { exports: {} };
  new Function("exports", "require", "module", "__filename", "__dirname", helperJs)(helperModule.exports, (specifier) => specifier === "./routeProfilePresentation" || specifier === "./routeProfilePresentation.ts" ? presentation : require(specifier), helperModule, helperUrl.pathname, new URL(".", helperUrl).pathname);
  const layout = helperModule.exports.createRouteSectionProfileLayout(30_450, 42_750, 100, 900, 360, 224);
  assert.ok(layout);
  assert.equal(layout.xForDistance(30_450), 62);
  assert.equal(layout.xForDistance(42_750), 344);
  assert.equal(layout.distanceTicks[0].label, "30.45 km");
  assert.equal(layout.distanceTicks.at(-1).label, "42.75 km");
  assert.ok(layout.distanceTicks.every((tick) => tick.x >= 62 && tick.x <= 344));
});
