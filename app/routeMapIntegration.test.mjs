import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { clipRoutePointsToSection } from "./routeSectionSelection.ts";
import { buildRouteMapFeatures, buildSelectedSectionEndpointFeatures, getRouteMapLineStyles } from "./routeMapPresentation.ts";
import { DEFAULT_ROUTE_MAP_MODE, resolveRouteMapModeForAnalysis } from "./route-map-mode.ts";
import { expireTerrainLoadingHint, resolveTerrainReadiness, TERRAIN_LOADING_HINT_DELAY_MS } from "./mapLibreTerrainStatus.ts";

test("terrain status reports first successful DEM content without waiting for every camera tile", async () => {
  assert.equal(TERRAIN_LOADING_HINT_DELAY_MS, 5000);
  assert.equal(resolveTerrainReadiness("loading", { sourceId: "gpx-route", sourceDataType: "content" }), "loading");
  assert.equal(resolveTerrainReadiness("loading", { sourceId: "mapterhorn-dem", sourceDataType: "metadata" }), "loading");
  assert.equal(resolveTerrainReadiness("loading", { sourceId: "mapterhorn-dem", sourceDataType: "content" }), "ready");
  assert.equal(resolveTerrainReadiness("unavailable", { sourceId: "mapterhorn-dem", sourceDataType: "content" }), "unavailable", "a late success cannot erase a recorded terrain failure");
  assert.equal(expireTerrainLoadingHint("loading"), "pending", "an unresolved request stops showing a distracting indefinite spinner without claiming success");
  assert.equal(expireTerrainLoadingHint("ready"), "ready");
  const source = await readFile(new URL("./MapLibreRouteMap.tsx", import.meta.url), "utf8");
  assert.match(source, /TERRAIN_LOADING_HINT_DELAY_MS/);
  assert.match(source, /expireTerrainLoadingHint\(terrainStatusRef\.current\)/);
  assert.match(source, /resolveTerrainReadiness\(terrainStatusRef\.current, event\)/);
});

test("default map mode is 3D and a user's choice persists for the same analysis", () => {
  const analysis = {};
  assert.equal(DEFAULT_ROUTE_MAP_MODE, "3d");
  assert.equal(resolveRouteMapModeForAnalysis(analysis, analysis, "2d"), "2d");
  assert.equal(resolveRouteMapModeForAnalysis({}, analysis, "2d"), "3d");
});

test("map route overlays preserve disconnected components and fractional section endpoints", () => {
  const points = [
    { latitude: 45, longitude: 14, elevationM: 10, distanceM: 0, segmentIndex: 0 },
    { latitude: 45.01, longitude: 14.01, elevationM: 20, distanceM: 1000, segmentIndex: 0 },
    { latitude: 45.02, longitude: 14.02, elevationM: 30, distanceM: 2000, segmentIndex: 0 },
    { latitude: 45.5, longitude: 14.5, elevationM: 40, distanceM: 3000, segmentIndex: 1 },
    { latitude: 45.51, longitude: 14.51, elevationM: 50, distanceM: 4000, segmentIndex: 1 },
  ];
  const section = {
    segmentIndex: 0,
    startPosition: { distanceM: 250, segmentIndex: 0 },
    endPosition: { distanceM: 1750, segmentIndex: 0 },
  };
  const selectedPoints = clipRoutePointsToSection(points, section);
  const features = buildRouteMapFeatures(points, selectedPoints);

  assert.equal(features.route.geometry.type, "MultiLineString");
  assert.equal(features.route.geometry.coordinates.length, 2, "each GPX component stays separate");
  assert.deepEqual(features.selected.geometry.coordinates, [[
    [14.0025, 45.0025],
    [14.01, 45.01],
    [14.0175, 45.0175],
  ]], "selected overlay follows exact interpolated section limits");
});

test("selected section styling stands above a quieter route with an outlined warm highlight", () => {
  const normal = getRouteMapLineStyles(false);
  const selected = getRouteMapLineStyles(true);
  assert.equal(normal.contextLine.opacity, 1);
  assert.equal(selected.contextLine.opacity, 0.48);
  assert.ok(selected.contextLine.width < selected.selectedLine.width);
  assert.ok(selected.selectedHalo.width > selected.selectedLine.width);
  assert.equal(selected.selectedHalo.color, "#17211c");
  assert.equal(selected.selectedLine.color, "#f2a23a");
});

test("selected section markers use exact clipped endpoints and reject invalid or disconnected geometry", () => {
  const points = [
    { latitude: 45, longitude: 14, distanceM: 100, segmentIndex: 2 },
    { latitude: 45.01, longitude: 14.01, distanceM: 250, segmentIndex: 2 },
    { latitude: 45.02, longitude: 14.02, distanceM: 400, segmentIndex: 2 },
  ];
  const endpoints = buildSelectedSectionEndpointFeatures(points);
  assert.deepEqual(endpoints.features.map(({ properties, geometry }) => [properties.label, geometry.coordinates]), [
    ["START", [14, 45]],
    ["END", [14.02, 45.02]],
  ]);
  assert.deepEqual(buildSelectedSectionEndpointFeatures([
    points[0], { ...points[1], segmentIndex: 3 }, points[2],
  ]).features, []);
  assert.deepEqual(buildSelectedSectionEndpointFeatures([
    points[0], { ...points[1], latitude: Number.NaN }, points[2],
  ]).features, []);
  assert.deepEqual(buildSelectedSectionEndpointFeatures([
    points[0], { ...points[1], distanceM: 80 }, points[2],
  ]).features, []);
});

test("Route Analysis lazily selects 3D by default and keeps Leaflet limited to 2D mode", async () => {
  const [view, fullMap, sectionMap, mapLibre] = await Promise.all([
    readFile(new URL("./RouteAnalysisView.tsx", import.meta.url), "utf8"),
    readFile(new URL("./CourseExplorer.tsx", import.meta.url), "utf8"),
    readFile(new URL("./TerrainSectionMap.tsx", import.meta.url), "utf8"),
    readFile(new URL("./MapLibreRouteMap.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(view, /mapMode: DEFAULT_ROUTE_MAP_MODE/);
  assert.match(view, /resolveRouteMapModeForAnalysis/);
  assert.match(fullMap, /dynamic\(\(\) => import\("\.\/MapLibreRouteMap"\)/);
  assert.match(fullMap, /if \(mapMode !== "2d" \|\| !mapRef\.current/);
  assert.match(sectionMap, /if \(mapMode !== "2d" \|\| !containerRef\.current/);
  assert.match(fullMap, /tileLayer\("https:\/\/tile\.openstreetmap\.org\/\{z\}\/\{x\}\/\{y\}\.png"/);
  assert.match(sectionMap, /tileLayer\("https:\/\/tile\.openstreetmap\.org\/\{z\}\/\{x\}\/\{y\}\.png"/);
  assert.doesNotMatch(`${fullMap}\n${sectionMap}`, /\{s\}\.tile\.openstreetmap\.org/);
  assert.match(mapLibre, /setWorkerUrl\(MAPLIBRE_WORKER_URL\)/);
  assert.match(mapLibre, /scrollZoom:\s*false/);
  assert.match(mapLibre, /new ResizeObserver/);
  assert.match(mapLibre, /fullscreen \? "map-fullscreen-map-viewport w-full bg-\[#dfe3d8\]" : frameClassName/, "MapLibre keeps its bounded frame normally and expands the same instance in fullscreen");
  assert.match(fullMap, /mapExpanded \? "h-\[26rem\] sm:h-\[32rem\] lg:h-\[38rem\]" : "h-56 sm:h-\[17\.5rem\] lg:h-\[17\.5rem\]"/);
  assert.match(fullMap, /min-h-56 sm:min-h-\[17\.5rem\] lg:min-h-\[17\.5rem\]/, "full map wrapper grows to accommodate controls below the map");
  assert.match(sectionMap, /frameClassName="relative h-56 w-full min-w-0 overflow-hidden rounded-xl border border-black\/10 bg-\[#e7e8e2\] sm:h-64"/);
  assert.match(mapLibre, /setTerrain\(\{ source: "mapterhorn-dem", exaggeration: 1\.05 \}\)/);
  assert.match(mapLibre, /selectedFeature \?\? \{ type: "FeatureCollection", features: \[\] \}/);
  assert.match(mapLibre, /gpx-selected-endpoints/);
  assert.match(mapLibre, /endpointSource\?\.setData\(selectedEndpointFeature\)/);
  assert.match(mapLibre, /setPaintProperty\("gpx-route-line", "line-opacity", lineStyles\.contextLine\.opacity\)/);
  assert.match(mapLibre, /gpx-selected-endpoint-circles/);
  assert.match(mapLibre, /gpx-selected-endpoint-labels/);
  assert.match(fullMap, /showSelectedSectionMarkers=\{Boolean\(selectedSection\)\}/);
  assert.match(sectionMap, /showSelectedSectionMarkers/);
  assert.match(mapLibre, /if \(!focusOnKeyChange && previousFocusKeyRef\.current !== null\)/);
  assert.match(mapLibre, /Switch to 2D Map/);
  assert.match(mapLibre, /map\?\.remove\(\)/);
  assert.doesNotMatch(mapLibre, /dev\/terrain/);
});
