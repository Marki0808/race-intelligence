import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";

const require = createRequire(import.meta.url);
const sourceUrl = new URL("./routeKeyMomentMapMarkers.ts", import.meta.url);
const source = await readFile(sourceUrl, "utf8");
const js = ts.transpile(source, { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 });
const markerModule = { exports: {} };
const localRequire = (specifier) => {
  if (specifier === "./routeKeyMomentPresentation.ts") return { presentKeyMomentCard };
  if (specifier === "./routeSectionSelection.ts") return selectionModule.exports;
  if (specifier === "./routeUnits.ts") return unitsModule.exports;
  return require(specifier);
};

const selectionUrl = new URL("./routeSectionSelection.ts", import.meta.url);
const selectionSource = await readFile(selectionUrl, "utf8");
const selectionModule = { exports: {} };
new Function("exports", "require", "module", "__filename", "__dirname", ts.transpile(selectionSource, { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }))(selectionModule.exports, require, selectionModule, selectionUrl.pathname, new URL(".", selectionUrl).pathname);
const unitsUrl = new URL("./routeUnits.ts", import.meta.url);
const unitsSource = await readFile(unitsUrl, "utf8");
const unitsModule = { exports: {} };
new Function("exports", "require", "module", "__filename", "__dirname", ts.transpile(unitsSource, { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }))(unitsModule.exports, require, unitsModule, unitsUrl.pathname, new URL(".", unitsUrl).pathname);
const presentationUrl = new URL("./routeKeyMomentPresentation.ts", import.meta.url);
const presentationSource = await readFile(presentationUrl, "utf8");
const presentationModule = { exports: {} };
const presentationRequire = (specifier) => specifier === "./routeUnits.ts" ? unitsModule.exports : require(specifier);
new Function("exports", "require", "module", "__filename", "__dirname", ts.transpile(presentationSource, { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }))(presentationModule.exports, presentationRequire, presentationModule, presentationUrl.pathname, new URL(".", presentationUrl).pathname);
const presentKeyMomentCard = presentationModule.exports.presentKeyMomentCard;
new Function("exports", "require", "module", "__filename", "__dirname", js)(markerModule.exports, localRequire, markerModule, sourceUrl.pathname, new URL(".", sourceUrl).pathname);
const { buildKeyMomentMapMarkers } = markerModule.exports;

const points = [
  { segmentIndex: 0, distanceM: 0, latitude: 45, longitude: 14, elevationM: 100 },
  { segmentIndex: 0, distanceM: 1000, latitude: 45.01, longitude: 14.02, elevationM: 300 },
  { segmentIndex: 1, distanceM: 2000, latitude: 45.02, longitude: 14.04, elevationM: 200 },
  { segmentIndex: 1, distanceM: 3000, latitude: 45.03, longitude: 14.06, elevationM: 400 },
];
function eventMoment(id, segmentIndex, startM, endM) {
  return {
    id, title: "Longest climb", segmentIndex, focusStartKm: startM / 1000, focusEndKm: endM / 1000,
    measurement: { kind: "event", direction: "climb", segmentIndex, startDistanceM: startM, endDistanceM: endM, distanceM: endM - startM, elevationChangeM: 80, roles: ["longest"] },
  };
}
function cardFor(moment, number, routePoints = points, units = "metric") {
  return { moment, card: presentKeyMomentCard(moment, routePoints, 3000, units), number };
}

test("range Key Moment markers use the exact start boundary while retaining the complete interval", () => {
  const moment = eventMoment("climb", 0, 250, 750);
  const marker = buildKeyMomentMapMarkers([cardFor(moment, "02")], points, 3000, "metric")[0];
  assert.equal(marker.number, "02");
  assert.equal(marker.kind, "range");
  assert.equal(marker.distanceM, 250);
  assert.equal(marker.startDistanceM, 250);
  assert.equal(marker.endDistanceM, 750);
  assert.ok(Math.abs(marker.longitude - 14.005) < 1e-10);
  assert.ok(Math.abs(marker.latitude - 45.0025) < 1e-10);
  assert.equal(marker.distanceLabel, "0.25 km");
  assert.deepEqual(marker.focusPoints.map((point) => point.distanceM), [250, 750]);
  assert.ok(marker.focusPoints.every((point) => point.segmentIndex === 0));
});

test("point Key Moments remain at the exact source coordinate and use active units", () => {
  const moment = { id: "high", title: "Highest point", segmentIndex: 1, focusStartKm: 2, focusEndKm: 2, measurement: { kind: "point", segmentIndex: 1, distanceM: 2000, elevationM: 200 } };
  const marker = buildKeyMomentMapMarkers([cardFor(moment, "01", points, "us-customary")], points, 3000, "us-customary")[0];
  assert.deepEqual([marker.longitude, marker.latitude, marker.distanceM], [14.04, 45.02, 2000]);
  assert.equal(marker.kind, "point");
  assert.equal(marker.startDistanceM, marker.endDistanceM);
  assert.equal(marker.distanceLabel, "1.24 mi");
});

test("unsupported, disconnected and stale Key Moment locations do not create markers", () => {
  const disconnected = eventMoment("gap", 0, 500, 2500);
  const stalePoint = { id: "stale", title: "Highest point", segmentIndex: 9, focusStartKm: 1, focusEndKm: 1, measurement: { kind: "point", segmentIndex: 9, distanceM: 1000, elevationM: 999 } };
  const invalid = { id: "malformed", title: "Longest climb", segmentIndex: 0, focusStartKm: 1.5, focusEndKm: 0.5, measurement: { kind: "event", direction: "climb", segmentIndex: 0, startDistanceM: 1500, endDistanceM: 500, distanceM: 1000, elevationChangeM: 80, roles: ["longest"] } };
  const markerInputs = [disconnected, stalePoint, invalid].map((moment, index) => cardFor(moment, String(index + 1)));
  assert.deepEqual(buildKeyMomentMapMarkers(markerInputs, points, 3000, "metric"), []);
});

test("Key Moments map is viewport-lazy, shares card selection, and omits Flyover", async () => {
  const component = await readFile(new URL("./KeyRouteMoments.tsx", import.meta.url), "utf8");
  const viewer = await readFile(new URL("./MapLibreRouteMap.tsx", import.meta.url), "utf8");
  assert.match(component, /new IntersectionObserver/);
  assert.match(component, /keyMomentMarkers=\{mapMarkers\}/);
  assert.match(component, /focusKey=\{selectedMapMarker\?\.id \?\? null\}/);
  assert.match(component, /onSelectKeyMoment=\{onSelect\}/);
  assert.match(component, /enableFlyover=\{false\}/);
  assert.match(component, /selectedMomentData\?\.measurement\?\.kind !== "point" \? selectedPoints : \[\]/);
  assert.match(component, /aria-pressed=\{selectedMoment === marker\.id\}/);
  assert.match(component, /<ElevationProfile[\s\S]*?<\/div>[\s\S]*?Key Moments in 3D Terrain/);
  assert.match(viewer, /id: "key-moment-circles"/);
  assert.match(viewer, /id: "key-moment-numbers"/);
  assert.match(viewer, /id: "key-moment-leaders-casing"/);
  assert.match(viewer, /id: "key-moment-leaders-line"/);
  assert.match(viewer, /"text-allow-overlap": true, "text-ignore-placement": true/);
  assert.match(viewer, /map\?\.remove\(\)/);
  assert.match(viewer, /enableFlyover && styleReady && mapInstance && <RouteFlyover/);
});
