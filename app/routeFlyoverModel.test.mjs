import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { analyzeGpxRoute, parseGpxText } from "./gpxAnalysis.ts";
import { isFlyoverManualMapInput, runWhenMapStyleReady } from "./routeFlyoverMapInteractions.ts";
import { FLYOVER_READOUT_MARKER_SIZE_CSS } from "./routeFlyoverPerformance.ts";
import {
  advanceFlyoverDistance,
  buildFlyoverPath,
  createFlyoverMarkerFeature,
  createFlyoverPlaybackState,
  formatFlyoverReadout,
  FLYOVER_CAMERA_PARAMETERS,
  getFlyoverCameraPlan,
  getFlyoverCameraSpeedProfile,
  getFlyoverBearing,
  reduceFlyoverPlayback,
  sampleFlyoverPath,
  smoothFlyoverBearing,
  smoothFlyoverCameraZoom,
} from "./routeFlyoverModel.ts";

const route = [
  { latitude: 45, longitude: 14, elevationM: 100, distanceM: 1000, segmentIndex: 0 },
  { latitude: 45.01, longitude: 14.01, elevationM: 200, distanceM: 2000, segmentIndex: 0 },
  { latitude: 45.02, longitude: 14.02, elevationM: 300, distanceM: 3000, segmentIndex: 0 },
];

test("Flyover samples interpolate route position and GPX elevation by cumulative distance", () => {
  const result = buildFlyoverPath(route);
  assert.equal(result.available, true);
  if (!result.available) return;
  const middle = sampleFlyoverPath(result.path, 1500);
  assert.ok(Math.abs(middle.latitude - 45.005) < 1e-10);
  assert.ok(Math.abs(middle.longitude - 14.005) < 1e-10);
  assert.equal(middle.elevationM, 150);
  assert.equal(middle.distanceM, 1500);
  assert.equal(middle.segmentIndex, 0);
  const marker = createFlyoverMarkerFeature(middle).features[0];
  assert.deepEqual(marker.geometry.coordinates, [middle.longitude, middle.latitude]);
  assert.deepEqual(marker.properties, { segmentIndex: 0 });
  assert.equal(sampleFlyoverPath(result.path, -50).distanceM, 1000);
  assert.equal(sampleFlyoverPath(result.path, 4000).distanceM, 3000);
});

test("Flyover retains exact clipped section boundaries and full-route cumulative distance", () => {
  const clipped = [
    { latitude: 45.002, longitude: 14.002, elevationM: 120, distanceM: 1200.5, segmentIndex: 0 },
    { latitude: 45.01, longitude: 14.01, elevationM: 200, distanceM: 2000, segmentIndex: 0 },
    { latitude: 45.018, longitude: 14.018, elevationM: 280, distanceM: 2800.25, segmentIndex: 0 },
  ];
  const result = buildFlyoverPath(clipped);
  assert.equal(result.available, true);
  if (!result.available) return;
  assert.equal(result.path.startDistanceM, 1200.5);
  assert.equal(result.path.endDistanceM, 2800.25);
  assert.equal(sampleFlyoverPath(result.path, 1200.5).distanceM, 1200.5);
  assert.equal(sampleFlyoverPath(result.path, 2800.25).distanceM, 2800.25);
});

test("Flyover refuses disconnected or invalid geometry instead of bridging GPX components", () => {
  assert.deepEqual(buildFlyoverPath([
    ...route.slice(0, 2),
    { ...route[2], segmentIndex: 1 },
  ]), { available: false, reason: "disconnected-components" });
  assert.deepEqual(buildFlyoverPath([
    route[0], { ...route[1], latitude: 92 }, route[2],
  ]), { available: false, reason: "invalid-geometry" });
  assert.deepEqual(buildFlyoverPath([
    route[0], { ...route[1], distanceM: 900 }, route[2],
  ]), { available: false, reason: "invalid-geometry" });
  assert.deepEqual(buildFlyoverPath([route[0], { ...route[0] }]), { available: false, reason: "insufficient-distance" });
});

test("Flyover keeps missing GPX elevation unavailable through interpolation", () => {
  const result = buildFlyoverPath([
    route[0], { ...route[1], elevationM: Number.NaN }, route[2],
  ]);
  assert.equal(result.available, true);
  if (!result.available) return;
  assert.equal(sampleFlyoverPath(result.path, 1500).elevationM, null);
  assert.equal(sampleFlyoverPath(result.path, 3000).elevationM, 300);
  assert.deepEqual(formatFlyoverReadout(sampleFlyoverPath(result.path, 1500), "metric"), { distance: "1.5 km", elevation: "Unavailable" });
});

test("Flyover readouts use shared Metric and US Customary formatting", () => {
  const sample = { latitude: 45, longitude: 14, elevationM: 304.8, distanceM: 1609.344, segmentIndex: 0 };
  assert.deepEqual(formatFlyoverReadout(sample, "metric"), { distance: "1.61 km", elevation: "305 m" });
  assert.deepEqual(formatFlyoverReadout(sample, "us-customary"), { distance: "1 mi", elevation: "1,000 ft" });
});

test("circular Flyover readout uses cumulative distance, selected units and honest missing elevation", () => {
  const selectedSectionSample = { latitude: 45, longitude: 14, elevationM: 304.8, distanceM: 22_500, segmentIndex: 0 };
  assert.deepEqual(formatFlyoverReadout(selectedSectionSample, "metric"), { distance: "22.5 km", elevation: "305 m" });
  assert.deepEqual(formatFlyoverReadout(selectedSectionSample, "us-customary"), { distance: "13.98 mi", elevation: "1,000 ft" });
  assert.deepEqual(formatFlyoverReadout({ ...selectedSectionSample, elevationM: null }, "metric"), { distance: "22.5 km", elevation: "Unavailable" });
  assert.deepEqual(formatFlyoverReadout({ ...selectedSectionSample, elevationM: null }, "us-customary"), { distance: "13.98 mi", elevation: "Unavailable" });
});

test("single circular readout stays anchored to the sampled GPX position", async () => {
  const sample = sampleFlyoverPath(buildFlyoverPath(route).path, 1_750);
  const marker = createFlyoverMarkerFeature(sample).features[0];
  assert.deepEqual(marker.geometry.coordinates, [sample.longitude, sample.latitude]);
  assert.deepEqual(marker.properties, { segmentIndex: sample.segmentIndex });
  const source = await readFile(new URL("./RouteFlyover.tsx", import.meta.url), "utf8");
  assert.equal(FLYOVER_READOUT_MARKER_SIZE_CSS, 56);
  assert.match(source, /canvas\.width = FLYOVER_READOUT_MARKER_SIZE_CSS \* 2/);
  assert.match(source, /context\.arc\(center, center, center - 3/);
  assert.match(source, /context\.lineWidth = 2/);
  assert.match(source, /drawValue\(distance, 43, 21, 600\)/);
  assert.match(source, /drawValue\(elevation === "Unavailable" \? "N\/A" : elevation, 69, 18, 500\)/);
  const renderer = source.slice(source.indexOf("function createFlyoverReadoutImage"), source.indexOf("export default function RouteFlyover"));
  assert.doesNotMatch(renderer, /DISTANCE|ELEVATION|Distance|Elevation/);
  assert.match(source, /"icon-anchor": "bottom"/);
  assert.match(source, /"symbol-height-anchor": "ground"/);
  assert.match(source, /"icon-pitch-alignment": "viewport"/);
  assert.match(source, /"icon-allow-overlap": true/);
  assert.match(source, /"icon-ignore-placement": true/);
  assert.doesNotMatch(source, /createRunnerImage|createLiveInfoImage|FLYOVER_INFO_LAYER_ID|FLYOVER_INFO_ICON_ID/);
  assert.doesNotMatch(source, /getFlyoverBubblePlacement|map\.project\(/);
});

test("Flyover camera plan keeps the runner low in frame, looks ahead, and smoothly rounds turns", () => {
  const result = buildFlyoverPath(route);
  assert.equal(result.available, true);
  if (!result.available) return;
  const { path } = result;
  const sample = sampleFlyoverPath(path, 1_800);
  const initial = getFlyoverCameraPlan(path, sample, 1, null, 16, 280);
  const highSpeed = getFlyoverCameraPlan(path, sample, 32, initial.bearing, 16, 280);
  assert.equal(initial.pitch, 52);
  assert.equal(initial.center[0] !== sample.longitude || initial.center[1] !== sample.latitude, true, "camera center leads the runner to leave forward route visible");
  assert.ok(initial.centerDistanceM > sample.distanceM);
  assert.ok(initial.bearing !== highSpeed.bearing || initial.lookAheadDistanceM >= highSpeed.lookAheadDistanceM);
  assert.equal(FLYOVER_CAMERA_PARAMETERS.desiredRunnerScreenOffset, 0.16);
  assert.ok(Math.abs(smoothFlyoverBearing(358, 2, 0.1) - 358.4) < 1e-8, "bearing follows the short turn across north");
  assert.equal(getFlyoverCameraPlan(path, sampleFlyoverPath(path, path.endDistanceM), 32, 40, 16, 280).centerDistanceM, path.endDistanceM);
});

test("Flyover camera widens progressively at speed and preserves close framing at 1x–2x", () => {
  const longPath = buildFlyoverPath([
    { latitude: 45, longitude: 14, elevationM: 100, distanceM: 0, segmentIndex: 0 },
    { latitude: 45.5, longitude: 14.5, elevationM: 200, distanceM: 100_000, segmentIndex: 0 },
  ]);
  assert.equal(longPath.available, true);
  if (!longPath.available) return;
  const sample = sampleFlyoverPath(longPath.path, 10_000);
  const plans = [1, 2, 4, 8, 16, 32].map((speed) => getFlyoverCameraPlan(longPath.path, sample, speed, null, 16, 600));
  assert.equal(plans[0].zoom, plans[1].zoom, "1x and 2x retain the existing framing");
  for (let index = 2; index < plans.length; index += 1) assert.ok(plans[index].zoom < plans[index - 1].zoom, "higher speeds use wider framing");
  assert.deepEqual([1, 2, 4, 8, 16, 32].map((speed) => getFlyoverCameraSpeedProfile(speed).lookAheadSeconds), [2.5, 2.5, 3, 3.5, 4, 4.5]);
  assert.ok(plans[5].lookAheadDistanceM > plans[4].lookAheadDistanceM);
});

test("speed changes ease zoom and heading without resetting camera state", () => {
  const turnPath = buildFlyoverPath([
    { latitude: 45, longitude: 14, elevationM: 100, distanceM: 0, segmentIndex: 0 },
    { latitude: 45.01, longitude: 14, elevationM: 110, distanceM: 1000, segmentIndex: 0 },
    { latitude: 45.01, longitude: 14.01, elevationM: 120, distanceM: 2000, segmentIndex: 0 },
  ]);
  assert.equal(turnPath.available, true);
  if (!turnPath.available) return;
  const sample = sampleFlyoverPath(turnPath.path, 700);
  const before = getFlyoverCameraPlan(turnPath.path, sample, 1, null, 16, 600);
  const changed = getFlyoverCameraPlan(turnPath.path, sample, 32, before.bearing, 16, 600, before.zoom);
  assert.ok(Math.abs(changed.zoom - before.zoom) < 0.1, "the initial speed-change zoom step is eased");
  assert.ok(Math.abs(changed.zoom - before.zoom) < Math.abs(before.zoom - getFlyoverCameraPlan(turnPath.path, sample, 32, null, 16, 600).zoom));
  const unsmoothedBearing = getFlyoverCameraPlan(turnPath.path, sample, 32, null, 16, 600).bearing;
  const bearingStep = Math.abs(((changed.bearing - before.bearing + 540) % 360) - 180);
  const fullBearingChange = Math.abs(((unsmoothedBearing - before.bearing + 540) % 360) - 180);
  assert.ok(bearingStep < fullBearingChange, "bearing moves toward the new look-ahead heading without resetting");

  let zoom = before.zoom;
  for (let frame = 0; frame < 140; frame += 1) zoom = smoothFlyoverCameraZoom(zoom, 13, 16, FLYOVER_CAMERA_PARAMETERS.zoomSmoothingTimeMs);
  assert.ok(Math.abs(zoom - 13) < 0.08, "framing converges smoothly to its new target");
});

test("Flyover playback supports start, pause, resume, restart, seeking, speed and exact finish", () => {
  const result = buildFlyoverPath(route);
  assert.equal(result.available, true);
  if (!result.available) return;
  const { path } = result;
  let state = createFlyoverPlaybackState(path);
  state = reduceFlyoverPlayback(path, state, { type: "start" });
  assert.equal(state.phase, "playing");
  assert.equal(state.distanceM, path.startDistanceM);
  state = reduceFlyoverPlayback(path, state, { type: "advance", distanceM: path.startDistanceM + 50 });
  assert.equal(state.distanceM, path.startDistanceM + 50, "the playing state advances from the first animation frame");
  state = reduceFlyoverPlayback(path, state, { type: "set-speed", speedMultiplier: 32 });
  assert.equal(state.speedMultiplier, 32);
  assert.equal(state.distanceM, path.startDistanceM + 50, "changing speed preserves current progress");
  assert.equal(advanceFlyoverDistance(path, 1000, 100, state.speedMultiplier), 1080);
  assert.equal(advanceFlyoverDistance(path, path.endDistanceM - 10, 100, state.speedMultiplier), path.endDistanceM, "high-speed playback clamps to the exact path endpoint");
  const longPath = buildFlyoverPath([
    { latitude: 45, longitude: 14, elevationM: 100, distanceM: 0, segmentIndex: 0 },
    { latitude: 45.1, longitude: 14.1, elevationM: 200, distanceM: 10_000, segmentIndex: 0 },
  ]);
  assert.equal(longPath.available, true);
  if (!longPath.available) return;
  assert.equal(advanceFlyoverDistance(longPath.path, 0, 133, 8), 26.6, "RAF scheduling gaps do not silently reduce the selected visualization speed");
  assert.equal(advanceFlyoverDistance(longPath.path, 0, Number.NaN, 8), 0, "invalid elapsed time cannot corrupt playback progress");
  state = reduceFlyoverPlayback(path, state, { type: "advance", distanceM: 1800 });
  state = reduceFlyoverPlayback(path, state, { type: "pause" });
  assert.equal(state.phase, "paused");
  state = reduceFlyoverPlayback(path, state, { type: "resume" });
  assert.equal(state.phase, "playing");
  state = reduceFlyoverPlayback(path, state, { type: "advance", distanceM: path.endDistanceM });
  assert.equal(state.phase, "complete");
  assert.equal(state.distanceM, path.endDistanceM);
  state = reduceFlyoverPlayback(path, state, { type: "restart" });
  assert.equal(state.phase, "playing");
  assert.equal(state.distanceM, path.startDistanceM);
  state = reduceFlyoverPlayback(path, state, { type: "pause" });
  state = reduceFlyoverPlayback(path, state, { type: "seek", distanceM: path.endDistanceM + 1 });
  assert.equal(state.phase, "complete");
  assert.equal(state.distanceM, path.endDistanceM);
  const soughtSample = sampleFlyoverPath(path, state.distanceM);
  assert.deepEqual(createFlyoverMarkerFeature(soughtSample).features[0].geometry.coordinates, [soughtSample.longitude, soughtSample.latitude]);
  state = reduceFlyoverPlayback(path, state, { type: "exit" });
  assert.equal(state.phase, "idle");
  assert.equal(state.distanceM, path.startDistanceM);
});

test("Učka flyover begins at the route's actual GPX elevation", { skip: !existsSync(new URL("../test-routes/gradient-calibration/Učka Loop Challenge (42km2200m+) Official Route.gpx", import.meta.url)) }, async () => {
  const xml = await readFile(new URL("../test-routes/gradient-calibration/Učka Loop Challenge (42km2200m+) Official Route.gpx", import.meta.url), "utf8");
  const analysis = analyzeGpxRoute(parseGpxText(xml));
  const result = buildFlyoverPath(analysis.points);
  assert.equal(result.available, true);
  if (!result.available) return;
  const start = sampleFlyoverPath(result.path, result.path.startDistanceM);
  assert.equal(result.path.startDistanceM, 0);
  assert.equal(analysis.points[0].elevationM, 2);
  assert.equal(start.elevationM, 2);
});

test("Flyover pauses only for actual user map input, not MapLibre camera movement events", () => {
  const enabled = { scrollZoomEnabled: true, doubleClickZoomEnabled: true, keyboardEnabled: true };
  assert.equal(isFlyoverManualMapInput({ type: "movestart", endursetFlyoverCamera: true }, enabled), false);
  assert.equal(isFlyoverManualMapInput({ type: "rotatestart" }, enabled), false);
  assert.equal(isFlyoverManualMapInput({ type: "wheel" }, enabled), true);
  assert.equal(isFlyoverManualMapInput({ type: "wheel" }, { ...enabled, scrollZoomEnabled: false }), false);
  assert.equal(isFlyoverManualMapInput({ type: "dblclick" }, enabled), true);
  assert.equal(isFlyoverManualMapInput({ type: "touchstart", touches: { length: 1 } }, enabled), false);
  assert.equal(isFlyoverManualMapInput({ type: "touchstart", touches: { length: 2 } }, enabled), true);
  assert.equal(isFlyoverManualMapInput({ type: "pointerdown", button: 2 }, enabled), true);
  assert.equal(isFlyoverManualMapInput({ type: "pointerdown", button: 0, ctrlKey: true }, enabled), true);
  const control = { closest: (selector) => selector === ".maplibregl-ctrl button" };
  const canvas = { closest: (selector) => selector.includes(".maplibregl-canvas") };
  assert.equal(isFlyoverManualMapInput({ type: "click", target: control }, enabled), true);
  assert.equal(isFlyoverManualMapInput({ type: "keydown", key: "ArrowUp", target: canvas }, enabled), true);
  assert.equal(isFlyoverManualMapInput({ type: "keydown", key: "a", target: canvas }, enabled), false);
});

test("flyover marker setup waits for a loaded style and removes readiness listeners after setup or unmount", () => {
  let styleReady = false;
  let installs = 0;
  const listeners = new Map();
  const mockMap = {
    isStyleLoaded: () => styleReady,
    on: (event, listener) => listeners.set(event, listener),
    off: (event, listener) => { if (listeners.get(event) === listener) listeners.delete(event); },
  };
  const cleanup = runWhenMapStyleReady(mockMap, () => { installs += 1; return true; });
  assert.equal(installs, 0);
  assert.deepEqual([...listeners.keys()].sort(), ["idle", "styledata"]);
  styleReady = true;
  listeners.get("styledata")();
  assert.equal(installs, 1);
  assert.equal(listeners.size, 0);
  cleanup();
  assert.equal(installs, 1);

  styleReady = false;
  const cleanupBeforeReady = runWhenMapStyleReady(mockMap, () => { installs += 1; return true; });
  cleanupBeforeReady();
  styleReady = true;
  assert.equal(listeners.size, 0, "unmount removes listeners before style readiness");
  assert.equal(installs, 1);
});

test("Flyover headings are smoothed through north without a long rotation", () => {
  assert.ok(Math.abs(getFlyoverBearing({ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 1 }) - 90) < 0.01);
  const smoothed = smoothFlyoverBearing(350, 10, 0.5);
  assert.ok(smoothed < 1 || smoothed > 359);
});

test("flyover marker, animation frames and map interaction listeners are cleaned up", async () => {
  const source = await readFile(new URL("./RouteFlyover.tsx", import.meta.url), "utf8");
  assert.match(source, /map\.removeLayer\(FLYOVER_LAYER_ID\)/);
  assert.match(source, /map\.removeSource\(FLYOVER_SOURCE_ID\)/);
  assert.match(source, /"symbol-height-anchor": "ground"/);
  assert.match(source, /"symbol-height-offset": 2/);
  assert.match(source, /"icon-anchor": "bottom"/);
  assert.match(source, /"icon-rotation-alignment": "viewport"/);
  assert.match(source, /"icon-allow-overlap": true/);
  assert.match(source, /"icon-ignore-placement": true/);
  assert.match(source, /"icon-size": 1/);
  assert.match(source, /context\.fillStyle = "#17211c"/);
  assert.match(source, /context\.strokeStyle = "#a7c957"/);
  assert.match(source, /runWhenMapStyleReady\(map, installWhenStyleReady\)/);
  assert.match(source, /map\.removeImage\(FLYOVER_ICON_ID\)/);
  assert.match(source, /source\.updateData\(diff\)/, "unique runner feature updates are diffed through the GeoJSON source");
  assert.match(source, /source\.updateData\(\{ remove: \[FLYOVER_MARKER_FEATURE_ID\] \}\)/, "exit removes the live point feature");
  assert.match(source, /FLYOVER_MARKER_FEATURE_ID/);
  assert.doesNotMatch(source, /MARKER_UPDATE_INTERVAL_MS/);
  assert.match(source, /map\.updateImage\(FLYOVER_ICON_ID, createFlyoverReadoutImage/);
  assert.match(source, /elevation === "Unavailable" \? "N\/A"/);
  assert.match(source, /role="status" aria-live="polite"/);
  assert.equal((source.match(/map\.addLayer\(/g) ?? []).length, 1, "one symbol layer renders both live values in one marker");
  assert.equal((source.match(/map\.addImage\(/g) ?? []).length, 1, "only one marker sprite is registered");
  assert.match(source, /getFlyoverCameraPlan\(/);
  assert.match(source, /map\.jumpTo\(\{ center: plan\.center/);
  assert.match(source, /cancelAnimationFrame\(animationFrameRef\.current\)/);
  assert.match(source, /map\.off\("dragstart"/);
  assert.doesNotMatch(source, /map\.on\("movestart"/);
  assert.doesNotMatch(source, /map\.on\("rotatestart"/);
  assert.doesNotMatch(source, /map\.on\("pitchstart"/);
  assert.match(source, /visibilitychange/);
  const mapSource = await readFile(new URL("./MapLibreRouteMap.tsx", import.meta.url), "utf8");
  assert.match(mapSource, /showSelectedSectionMarkers \? selectedPoints : points/);
  const flyover = await readFile(new URL("./RouteFlyover.tsx", import.meta.url), "utf8");
  assert.match(flyover, /displayedSample\?\.distanceM \?\? playback\.distanceM/, "the slider follows the live readout without rerendering the map component");
  assert.match(flyover, /map\.jumpTo\(\{ center: plan\.center/);
  assert.match(flyover, /requestAnimationFrame\(frame\)/);
  assert.match(flyover, /aria-pressed=\{playback\.speedMultiplier === speed\}/);
  assert.match(flyover, /\[1, 2, 4, 8, 16, 32\] as const/);
  assert.match(flyover, /Distance from route start .*GPX elevation/);
  assert.doesNotMatch(flyover, /<div className="min-w-\[4\.25rem\]">.*Distance/);
  assert.doesNotMatch(flyover, /<select value=\{playback\.speedMultiplier\}/);
  assert.doesNotMatch(flyover, /absolute (?:left|right|inset-x|bottom|top)/, "flyover controls stay in normal flow below the map");
  assert.match(flyover, /const flyoverPanelClass = "mt-2/);
  assert.match(flyover, /grid-cols-2/);
  assert.match(flyover, /min-h-11 min-w-11/);
  assert.match(mapSource, /\{enableFlyover && styleReady && mapInstance && <RouteFlyover/);
  assert.ok(mapSource.indexOf("frameClassName") < mapSource.indexOf("<RouteFlyover"), "map frame is rendered before the playback controls");
  const fullMap = await readFile(new URL("./CourseExplorer.tsx", import.meta.url), "utf8");
  const sectionMap = await readFile(new URL("./TerrainSectionMap.tsx", import.meta.url), "utf8");
  assert.match(fullMap, /mapExpanded \? "h-\[26rem\] sm:h-\[32rem\] lg:h-\[38rem\]" : "h-56 sm:h-\[17\.5rem\] lg:h-\[17\.5rem\]"/);
  assert.match(fullMap, /frameClassName=\{`relative w-full min-w-0 overflow-hidden bg-\[#dfe3d8\] \$\{mapFrameHeightClass\}`\}/);
  assert.match(fullMap, /min-h-56 sm:min-h-\[17\.5rem\] lg:min-h-\[17\.5rem\]/);
  assert.match(sectionMap, /frameClassName="relative h-56 w-full min-w-0 overflow-hidden rounded-xl border border-black\/10 bg-\[#e7e8e2\] sm:h-64"/);
  assert.match(fullMap, /dynamic\(\(\) => import\("\.\/MapLibreRouteMap"\)/);
  assert.match(sectionMap, /dynamic\(\(\) => import\("\.\/MapLibreRouteMap"\)/);
});

