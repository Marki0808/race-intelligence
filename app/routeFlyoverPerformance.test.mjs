import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  FLYOVER_PERFORMANCE_SAMPLE_CAPACITY,
  FlyoverPerformanceSampler,
  shouldCollectFlyoverDiagnostics,
} from "./routeFlyoverPerformance.ts";

test("performance sampler reports rolling frame, camera, marker, readout, and map-render metrics", () => {
  const sampler = new FlyoverPerformanceSampler();
  for (let timestamp = 0; timestamp <= 5_000; timestamp += 16) {
    sampler.recordFrame(timestamp);
    sampler.recordMapRender(timestamp);
    sampler.recordCameraUpdate(timestamp);
    sampler.recordMarkerUpdate(timestamp);
    if (timestamp % 100 < 16) sampler.recordReadoutUpdate(timestamp);
  }
  sampler.recordMapRender(5_008);
  sampler.recordFrame(5_070);
  sampler.recordMainThreadLongTask(5_050, 72);
  const snapshot = sampler.snapshot(5_070);

  assert.ok(snapshot.fps > 0 && snapshot.fps <= 63);
  assert.ok(snapshot.frameAverageMs >= 15 && snapshot.frameAverageMs <= 17);
  assert.equal(snapshot.frameMaximumMs, 78);
  assert.equal(snapshot.framesOver33Ms, 1);
  assert.equal(snapshot.framesOver50Ms, 1);
  assert.ok(snapshot.cameraUpdatesPerSecond > 0);
  assert.ok(snapshot.markerUpdatesPerSecond > 0);
  assert.ok(snapshot.readoutUpdatesPerSecond > 0);
  assert.ok(snapshot.mapRendersPerSecond > 0);
  assert.equal(snapshot.mapRenderMaximumGapMs, 16);
  assert.equal(snapshot.significantMapRenderDelay, false, "RAF stalls and actual MapLibre render gaps are reported separately");
  assert.equal(snapshot.mainThreadLongTasksInWindow, 1);
  assert.equal(snapshot.mainThreadLongTaskMaximumMs, 72);

  sampler.recordMapRender(5_080);
  assert.equal(sampler.snapshot(5_080).significantMapRenderDelay, true, "a >50 ms MapLibre render gap is identified");
});

test("diagnostic sample buffers remain bounded over long playback", () => {
  const sampler = new FlyoverPerformanceSampler();
  for (let frame = 0; frame < FLYOVER_PERFORMANCE_SAMPLE_CAPACITY * 4; frame += 1) {
    const timestamp = frame * 16;
    sampler.recordFrame(timestamp);
    sampler.recordMapRender(timestamp);
    sampler.recordCameraUpdate(timestamp);
    sampler.recordMarkerUpdate(timestamp);
    sampler.recordReadoutUpdate(timestamp);
  }
  assert.equal(sampler.snapshot(FLYOVER_PERFORMANCE_SAMPLE_CAPACITY * 4 * 16).bufferedFrameSamples, FLYOVER_PERFORMANCE_SAMPLE_CAPACITY);
});

test("diagnostics are opt-in in development only, never render UI, and release listeners when Flyover exits", async () => {
  assert.equal(shouldCollectFlyoverDiagnostics("development", "true"), true);
  assert.equal(shouldCollectFlyoverDiagnostics("development", undefined), false);
  assert.equal(shouldCollectFlyoverDiagnostics("development", "false"), false);
  assert.equal(shouldCollectFlyoverDiagnostics("production", "true"), false);
  assert.equal(shouldCollectFlyoverDiagnostics(undefined, "true"), false);
  const source = await readFile(new URL("./RouteFlyover.tsx", import.meta.url), "utf8");
  assert.match(source, /process\.env\.NODE_ENV === "development" && process\.env\.NEXT_PUBLIC_FLYOVER_DIAGNOSTICS === "true"/, "diagnostics require an explicit development-only public build flag");
  assert.match(source, /if \(!flyoverSamplingActive \|\| !diagnosticsEnabled\)/, "sampling is disabled unless the opt-in flag is enabled and playback is active");
  assert.doesNotMatch(source, /Flyover diagnostics|FlyoverPerformancePanel|data-flyover-performance-diagnostics/, "diagnostic UI is absent in development and production");
  assert.match(source, /console\.debug\("\[Endurset Flyover performance\]"/, "opt-in diagnostics remain available in the development console");
  assert.match(source, /map\.on\("render", onMapRender\)/);
  assert.match(source, /map\.off\("render", onMapRender\)/);
  assert.match(source, /window\.clearInterval\(timer\)/);
  assert.match(source, /performanceSamplerRef\.current = null/);
  assert.match(source, /map\.isSourceLoaded\("mapterhorn-dem"\)/);
  assert.match(source, /map\.areTilesLoaded\(\)/);
  assert.match(source, /longTaskObserver\?\.disconnect\(\)/);
  assert.match(source, /context\.fillText\(text, center, y, maxTextWidth\)/, "long unit-formatted values are fitted to the circle width");
});

