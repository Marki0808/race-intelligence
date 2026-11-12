import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { FLYOVER_PREPARATION_TIMEOUT_MS, waitForFlyoverPreparation } from "./routeFlyoverPreparation.ts";

function createMap({ sourceLoaded = false } = {}) {
  const listeners = new Map();
  const map = {
    listeners,
    isSourceLoaded: () => sourceLoaded,
    on(event, listener) {
      const group = listeners.get(event) ?? new Set();
      group.add(listener);
      listeners.set(event, group);
      return map;
    },
    off(event, listener) {
      listeners.get(event)?.delete(listener);
      if (!listeners.get(event)?.size) listeners.delete(event);
      return map;
    },
    emit(event, payload) { for (const listener of [...(listeners.get(event) ?? [])]) listener(payload); },
  };
  return map;
}

test("startup waits for a post-camera render and first DEM content, then completes once and cleans listeners", () => {
  const map = createMap();
  let terrain = "loading";
  const outcomes = [];
  waitForFlyoverPreparation(map, () => terrain, (outcome) => outcomes.push(outcome));
  assert.deepEqual([...map.listeners.keys()].sort(), ["error", "render", "sourcedata"]);
  map.emit("render");
  assert.deepEqual(outcomes, [], "a rendered frame alone does not signal terrain readiness");
  map.emit("sourcedata", { sourceId: "mapterhorn-dem", sourceDataType: "content" });
  terrain = "ready";
  map.emit("render");
  map.emit("error", { sourceId: "mapterhorn-dem" });
  assert.deepEqual(outcomes, ["ready"]);
  assert.equal(map.listeners.size, 0);
});

test("already-ready and unavailable terrain proceed after a rendered frame without waiting for all tiles", () => {
  for (const [terrain, expected] of [["ready", "ready"], ["unavailable", "terrain-unavailable"]]) {
    const map = createMap();
    const outcomes = [];
    waitForFlyoverPreparation(map, () => terrain, (outcome) => outcomes.push(outcome));
    map.emit("render");
    assert.deepEqual(outcomes, [expected]);
    assert.equal(map.listeners.size, 0);
  }
  const loadedMap = createMap({ sourceLoaded: true });
  const loadedOutcomes = [];
  waitForFlyoverPreparation(loadedMap, () => "loading", (outcome) => loadedOutcomes.push(outcome));
  loadedMap.emit("render");
  assert.deepEqual(loadedOutcomes, ["ready"]);
});

test("preparation falls back after a bounded timeout and ignores later resource events", async () => {
  const map = createMap();
  const outcomes = [];
  assert.equal(FLYOVER_PREPARATION_TIMEOUT_MS, 1800);
  waitForFlyoverPreparation(map, () => "loading", (outcome) => outcomes.push(outcome), 10);
  await new Promise((resolve) => setTimeout(resolve, 20));
  map.emit("render");
  assert.deepEqual(outcomes, ["timeout"]);
  assert.equal(map.listeners.size, 0);
});

test("cancelling preparation cleans up without starting playback", async () => {
  const map = createMap();
  const outcomes = [];
  const cancel = waitForFlyoverPreparation(map, () => "loading", (outcome) => outcomes.push(outcome), 20);
  cancel();
  map.emit("render");
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(outcomes, []);
  assert.equal(map.listeners.size, 0);
});

test("Flyover preparation starts only one playback loop and exposes a cancellable preparing state", async () => {
  const source = await readFile(new URL("./RouteFlyover.tsx", import.meta.url), "utf8");
  assert.match(source, /waitForFlyoverPreparation\(/);
  assert.match(source, /setPreparingPath\(path\)/);
  assert.match(source, /onClick=\{cancelPreparation\}/);
  assert.match(source, /Preparing flyover…/);
  assert.match(source, /dispatch\(\{ type: "start" \}\)/);
  assert.match(source, /playbackRef\.current\.phase === "idle" && !restart/, "only a fresh initial start enters preparation");
  assert.match(source, /dispatch\(\{ type: "restart" \}, true\)/, "restarts on an existing map bypass preparation");
  assert.match(source, /playback\.phase !== "playing" \|\| !path/);
  assert.match(source, /animationFrameRef\.current = requestAnimationFrame\(frame\)/);
  assert.match(source, /preparationCancelRef\.current\?\.\(\)/);
  const mapSource = await readFile(new URL("./MapLibreRouteMap.tsx", import.meta.url), "utf8");
  assert.match(mapSource, /terrainStatus=\{terrainStatus\}/);
  const preparation = await readFile(new URL("./routeFlyoverPreparation.ts", import.meta.url), "utf8");
  assert.doesNotMatch(preparation, /areTilesLoaded/, "startup never waits for every map tile");
  const sections = await readFile(new URL("./RouteSectionBrowser.tsx", import.meta.url), "utf8");
  assert.match(sections, /\{isSelected && \(/, "switching sections mounts and removes the selected detail subtree");
  assert.match(mapSource, /map\?\.remove\(\)/, "remount cleanup removes the section map instance");
});
