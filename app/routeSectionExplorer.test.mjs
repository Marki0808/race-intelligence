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

test("the shared browser uses accessible selection controls and preserves the selected detail after the list", async () => {
  const source = await readFile(new URL("./RouteSectionBrowser.tsx", import.meta.url), "utf8");
  assert.match(source, /aria-pressed=\{isSelected\}/);
  assert.match(source, /aria-label=\{`Close Route Section/);
  assert.ok(source.indexOf("<ol") < source.indexOf("{selected &&"));
  assert.equal((source.match(/<SectionDetail\s/g) ?? []).length, 1);
  assert.match(source, /distanceKm\} km · \+\{section\.ascentM\} m \/ −\{section\.descentM\} m/);
  assert.match(source, /min-h-\[68px\]/);
});

test("Route Mode and Race Mode share the browser and clear the opposite map selection", async () => {
  const [routeView, raceView, map] = await Promise.all([
    readFile(new URL("./RouteAnalysisView.tsx", import.meta.url), "utf8"),
    readFile(new URL("./CourseSection.tsx", import.meta.url), "utf8"),
    readFile(new URL("./CourseExplorer.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(routeView, /<RouteSectionBrowser[\s\S]*?sections=\{displayedSections\}/);
  assert.match(raceView, /<RouteSectionBrowser[\s\S]*?sections=\{routeAnalysis\.routeSections\}/);
  assert.match(routeView, /function selectMoment[\s\S]*?setSelectedSectionKey\(null\)/);
  assert.match(routeView, /function selectSection[\s\S]*?setSelectedMoment\(null\)/);
  assert.match(raceView, /function selectMoment[\s\S]*?setSelection\(\{ editionKey, moment: title, sectionKey: null \}\)/);
  assert.match(raceView, /function selectSection[\s\S]*?moment: section \? null/);
  assert.match(map, /clipRoutePointsToSection\(points, selectedSection\)/);
  assert.match(map, /selectedSectionPoints/);
  assert.match(map, /groupAnalyzedPointsBySegment\(points\)/);
  assert.match(map, /stroke="#f2d675"/);
  assert.match(map, /color: "#a7c957"/);
  assert.match(map, /aria-expanded=\{mapExpanded\}/);
  assert.match(map, /invalidateSize/);
});
