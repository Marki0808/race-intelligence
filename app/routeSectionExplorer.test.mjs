import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";

const require = createRequire(import.meta.url);
const selectionUrl = new URL("./routeSectionSelection.ts", import.meta.url);
const selectionSource = await readFile(selectionUrl, "utf8");
const selectionJs = ts.transpile(selectionSource, { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 });
const selectionModule = { exports: {} };
new Function("exports", "require", "module", "__filename", "__dirname", selectionJs)(selectionModule.exports, require, selectionModule, selectionUrl.pathname, new URL(".", selectionUrl).pathname);
const { clipRoutePointsToSection, findSelectedRouteSection, routeSectionSelectionKey } = selectionModule.exports;
const profileUrl = new URL("./routeProfilePresentation.ts", import.meta.url);
const profileSource = await readFile(profileUrl, "utf8");
const profileJs = ts.transpile(profileSource, { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 });
const profileModule = { exports: {} };
const profileRequire = (specifier) => specifier === "./routeSectionSelection" ? selectionModule.exports : require(specifier);
new Function("exports", "require", "module", "__filename", "__dirname", profileJs)(profileModule.exports, profileRequire, profileModule, profileUrl.pathname, new URL(".", profileUrl).pathname);
const { formatRouteDistanceTick, getNiceAxisScale, getPositionedRouteDistanceTicks, getRouteSectionBoundaryMarkers } = profileModule.exports;
const evidenceUrl = new URL("./routeSectionEvidence.ts", import.meta.url);
const evidenceSource = await readFile(evidenceUrl, "utf8");
const evidenceJs = ts.transpile(evidenceSource, { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 });
const evidenceModule = { exports: {} };
const localRequire = (specifier) => specifier === "./routeSectionSelection" ? selectionModule.exports : require(specifier);
new Function("exports", "require", "module", "__filename", "__dirname", evidenceJs)(evidenceModule.exports, localRequire, evidenceModule, evidenceUrl.pathname, new URL(".", evidenceUrl).pathname);
const { mapillaryEvidenceByRouteSection } = evidenceModule.exports;

const section = (id, segmentIndex, startM, endM) => ({ id, segmentIndex, startPosition: { distanceM: startM, segmentIndex }, endPosition: { distanceM: endM, segmentIndex } });
const point = (segmentIndex, distanceM, latitude) => ({ segmentIndex, distanceM, latitude, longitude: latitude * 2, elevationM: latitude * 10 });

test("section selection identity includes the GPX component as well as the stable section ID", () => {
  const first = section("route-section-1", 0, 0, 10);
  const second = section("route-section-1", 1, 10, 20);
  assert.notEqual(routeSectionSelectionKey(first), routeSectionSelectionKey(second));
  assert.equal(findSelectedRouteSection([first, second], routeSectionSelectionKey(second)), second);
  assert.equal(findSelectedRouteSection([first, second], "missing"), null);
});

test("section clipping returns only its component and exact interval with edge interpolation", () => {
  const points = [point(0, 0, 0), point(0, 10, 10), point(0, 20, 20), point(1, 20, 100), point(1, 30, 110)];
  const clipped = clipRoutePointsToSection(points, section("s", 0, 5, 15));
  assert.deepEqual(clipped.map(({ segmentIndex, distanceM, latitude }) => ({ segmentIndex, distanceM, latitude })), [
    { segmentIndex: 0, distanceM: 5, latitude: 5 },
    { segmentIndex: 0, distanceM: 10, latitude: 10 },
    { segmentIndex: 0, distanceM: 15, latitude: 15 },
  ]);
});

test("shared cumulative component boundary never adds a connector to the selected interval", () => {
  const points = [point(0, 0, 0), point(0, 10, 10), point(1, 10, 100), point(1, 20, 110)];
  const clipped = clipRoutePointsToSection(points, section("s", 1, 10, 20));
  assert.deepEqual(clipped.map(({ segmentIndex, distanceM, latitude }) => [segmentIndex, distanceM, latitude]), [[1, 10, 100], [1, 20, 110]]);
});

test("inconsistent section endpoint component identity produces no highlight geometry", () => {
  const points = [point(0, 0, 0), point(0, 10, 10), point(1, 10, 100), point(1, 20, 110)];
  const invalid = { ...section("s", 0, 0, 10), endPosition: { distanceM: 10, segmentIndex: 1 } };
  assert.deepEqual(clipRoutePointsToSection(points, invalid), []);
});

test("Mapillary detail evidence cannot leak across repeated section IDs on disconnected components", () => {
  const first = section("reused-id", 0, 0, 1000);
  const second = section("reused-id", 1, 1000, 2000);
  const photo = { id: "photo", segmentIndex: 1, distanceAlongRouteKm: 1.5 };
  const mapped = mapillaryEvidenceByRouteSection([first, second], {
    source: { type: "mapillary", name: "Mapillary", attribution: "© Mapillary" },
    sections: [{ id: "reused-id", availability: "available", images: [photo] }],
  });
  assert.equal(mapped.get(routeSectionSelectionKey(first)), null);
  assert.deepEqual(mapped.get(routeSectionSelectionKey(second)).images, [photo]);
});

test("profile elevation axis uses rounded meter ticks and safely expands a flat elevation range", () => {
  const climbing = getNiceAxisScale(103, 127, 6);
  assert.equal(climbing.step, 5);
  assert.deepEqual(climbing.ticks, [100, 105, 110, 115, 120, 125, 130]);
  const flat = getNiceAxisScale(0, 0, 6);
  assert.ok(flat.maximum > flat.minimum);
  assert.ok(flat.ticks.length >= 2);
});

test("110.73 km profile axis preserves 20 km ticks and positions the finish at the full SVG-domain endpoint", () => {
  const ticks = getPositionedRouteDistanceTicks(110_730, 136, 1144, 7);
  assert.deepEqual(ticks.map(({ distanceM }) => distanceM), [0, 20_000, 40_000, 60_000, 80_000, 100_000, 110_730]);
  assert.deepEqual(ticks.map(({ label }) => label), ["0 km", "20 km", "40 km", "60 km", "80 km", "100 km", "110.7 km"]);
  assert.equal(ticks[0].x, 136);
  assert.equal(ticks.at(-1).x, 1144);
  assert.ok(ticks.every(({ x }, index) => x >= 136 && x <= 1144 && (index === 0 || x > ticks[index - 1].x)));
  assert.ok(Math.abs(ticks[5].x - (136 + (100_000 / 110_730) * (1144 - 136))) < 1e-9);
});

test("medium routes retain evenly spaced major ticks and a clearly positioned finish", () => {
  const ticks = getPositionedRouteDistanceTicks(12_500, 136, 1144, 7);
  assert.deepEqual(ticks.map(({ distanceM }) => distanceM), [0, 5_000, 10_000, 12_500]);
  assert.deepEqual(ticks.map(({ label }) => label), ["0 km", "5 km", "10 km", "12.5 km"]);
  assert.deepEqual(ticks.map(({ x }) => Math.round(x)), [136, 539, 942, 1144]);
});

test("short-route axis labels retain enough kilometer precision to remain distinct", () => {
  const ticks = getPositionedRouteDistanceTicks(50, 136, 1144, 7);
  const labels = ticks.map(({ label }) => label);
  assert.equal(labels[0], "0 km");
  assert.equal(labels.at(-1), "0.05 km");
  assert.deepEqual(ticks.map(({ distanceM }) => distanceM), [0, 10, 20, 30, 40, 50]);
  assert.deepEqual(ticks.map(({ x }) => Math.round(x)), [136, 338, 539, 741, 942, 1144]);
  assert.equal(new Set(labels).size, labels.length);
  assert.equal(formatRouteDistanceTick(20_000, 110_730), "20 km");
});

test("profile boundary markers preserve component and section identities at shared cumulative kilometers", () => {
  const first = { ...section("same-id", 0, 0, 1000), startKm: 0, endKm: 1 };
  const second = { ...section("same-id", 1, 1000, 2000), startKm: 1, endKm: 2 };
  const markers = getRouteSectionBoundaryMarkers([first, second]);
  const shared = markers.find((marker) => marker.distanceM === 1000);
  assert.deepEqual(shared.componentIndices, [0, 1]);
  assert.deepEqual(shared.sectionKeys, ["0:same-id", "1:same-id"]);
});

test("the shared browser exposes accessible inline details with a bounded reduced-motion-aware scroll", async () => {
  const source = await readFile(new URL("./RouteSectionBrowser.tsx", import.meta.url), "utf8");
  assert.match(source, /aria-pressed=\{isSelected\}/);
  assert.match(source, /aria-expanded=\{isSelected\}/);
  assert.match(source, /aria-label=\{`Close Route Section/);
  assert.ok(source.indexOf("{isSelected && (") < source.indexOf("<SectionDetail"));
  assert.ok(source.indexOf("<SectionDetail") < source.indexOf("</li>"));
  assert.equal((source.match(/<SectionDetail\s/g) ?? []).length, 1);
  assert.match(source, /distanceKm\} km · \+\{section\.ascentM\} m \/ −\{section\.descentM\} m/);
  assert.match(source, /min-h-\[68px\]/);
  assert.match(source, /onSelectSection\(isSelected \? null : section\)/);
  assert.match(source, /scrollIntoView\(\{ behavior: reducedMotion \? "auto" : "smooth", block: "nearest" \}\)/);
  assert.match(source, /getBoundingClientRect\(\)/);
});

test("Route Mode and Race Mode share the browser and clear the opposite map selection", async () => {
  const [routeView, raceView, map] = await Promise.all([
    readFile(new URL("./RouteAnalysisView.tsx", import.meta.url), "utf8"),
    readFile(new URL("./CourseSection.tsx", import.meta.url), "utf8"),
    readFile(new URL("./CourseExplorer.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(routeView, /<RouteSectionBrowser[\s\S]*?sections=\{displayedSections\}/);
  assert.match(routeView, /gradientIntelligence=\{analysis\.gradientIntelligence\}/);
  assert.match(raceView, /<RouteSectionBrowser[\s\S]*?sections=\{routeAnalysis\.routeSections\}/);
  assert.match(raceView, /gradientIntelligence=\{routeAnalysis\.gradientIntelligence\}/);
  assert.match(routeView, /function selectMoment[\s\S]*?setSelectedSectionKey\(null\)/);
  assert.match(routeView, /function selectSection[\s\S]*?setSelectedMoment\(null\)/);
  assert.match(raceView, /function selectMoment[\s\S]*?setSelection\(\{ editionKey, moment: title, sectionKey: null \}\)/);
  assert.match(raceView, /function selectSection[\s\S]*?moment: section \? null/);
  assert.match(map, /clipRoutePointsToSection\(points, selectedSection\)/);
  assert.match(map, /selectedSectionPoints/);
  assert.match(map, /groupAnalyzedPointsBySegment\(points\)/);
  assert.match(map, /stroke="#f2d675"/);
  assert.match(map, /color: "#a7c957"/);
  assert.match(map, /getNiceAxisScale\(minElevation, maxElevation/);
  assert.match(map, /getPositionedRouteDistanceTicks\(totalDistance/);
  assert.match(map, /const plot = \{ left: 136, right: 56, top: 24, bottom: 72 \}/);
  assert.match(map, /fontSize="22" textAnchor=\{anchor\}/);
  assert.match(map, /getRouteSectionBoundaryMarkers\(sections\)/);
  assert.match(map, /onClick=\{\(\) => onSelectSection\(section\)\}/);
  assert.match(map, /aria-label=\{`Select Route Section/);
  assert.match(map, /segmentIndex\}:\$\{section\.id\}:profile-hit/);
  assert.match(map, /aria-pressed=\{mapExpanded\}/);
  assert.match(map, /const \[mapExpanded, setMapExpanded\] = useState\(false\)/);
  assert.match(map, /Expand map/);
  assert.match(map, /Reduce map/);
  assert.match(map, /h-56 sm:h-\[17\.5rem\] lg:h-\[17\.5rem\]/);
  assert.doesNotMatch(map, /hidden=\{!mapExpanded\}/);
  assert.match(map, /invalidateSize/);
  assert.match(routeView, /onSelectSection=\{selectSection\}/);
  assert.match(raceView, /onSelectSection=\{selectSection\}/);
  const browser = await readFile(new URL("./RouteSectionBrowser.tsx", import.meta.url), "utf8");
  assert.match(browser, /What to expect · GPX elevation profile/);
  assert.match(browser, /presentRouteSectionNarrativeV1\(gradientIntelligence, routeSections, section\)/);
});
