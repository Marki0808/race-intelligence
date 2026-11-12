import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { attachMapWheelZoom } from "./mapWheelZoom.ts";

class FakeEventDocument {
  listeners = new Map();

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(type, event) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  count(type) {
    return this.listeners.get(type)?.size ?? 0;
  }
}

function fakeMap() {
  const handlers = new Map();
  const calls = { enable: 0, disable: 0 };
  return {
    handlers,
    calls,
    scrollWheelZoom: {
      enable: () => calls.enable++,
      disable: () => calls.disable++,
    },
    on(type, handler) { handlers.set(type, handler); return this; },
    off(type, handler) { if (handlers.get(type) === handler) handlers.delete(type); return this; },
  };
}

test("wheel zoom starts disabled, activates on map interaction, and exits on outside click or Escape", () => {
  const eventDocument = new FakeEventDocument();
  const map = fakeMap();
  const container = { contains: (target) => target === "inside" };
  const states = [];
  const controller = attachMapWheelZoom(map, container, (active) => states.push(active), eventDocument);

  assert.equal(map.calls.enable, 0);
  map.handlers.get("click")();
  assert.equal(map.calls.enable, 1);
  assert.deepEqual(states, [true]);

  eventDocument.dispatch("pointerdown", { target: "inside" });
  assert.equal(map.calls.disable, 0, "interactions inside the map do not exit zoom mode");
  eventDocument.dispatch("pointerdown", { target: "outside" });
  assert.equal(map.calls.disable, 1);
  assert.deepEqual(states, [true, false]);

  controller.activate();
  eventDocument.dispatch("keydown", { key: "Escape" });
  assert.equal(map.calls.disable, 2);
  assert.deepEqual(states, [true, false, true, false]);
});

test("wheel zoom activation is independent per map and listeners are removed on disposal", () => {
  const eventDocument = new FakeEventDocument();
  const first = fakeMap();
  const second = fakeMap();
  const firstContainer = { contains: (target) => target === "first" };
  const secondContainer = { contains: (target) => target === "second" };
  const firstController = attachMapWheelZoom(first, firstContainer, () => {}, eventDocument);
  const secondController = attachMapWheelZoom(second, secondContainer, () => {}, eventDocument);

  firstController.activate();
  assert.equal(first.calls.enable, 1);
  assert.equal(second.calls.enable, 0);
  eventDocument.dispatch("pointerdown", { target: "second" });
  assert.equal(first.calls.disable, 1);
  assert.equal(second.calls.disable, 0);

  secondController.activate();
  secondController.dispose();
  firstController.dispose();
  assert.equal(eventDocument.count("pointerdown"), 0);
  assert.equal(eventDocument.count("keydown"), 0);
  assert.equal(first.handlers.size, 0);
  assert.equal(second.handlers.size, 0);
  assert.equal(second.calls.disable, 1, "disposing an active map disables its wheel handler");
});

test("both Leaflet maps keep opt-in wheel zoom, accessible activation, and existing zoom controls", async () => {
  const [fullMap, sectionMap] = await Promise.all([
    readFile(new URL("./CourseExplorer.tsx", import.meta.url), "utf8"),
    readFile(new URL("./TerrainSectionMap.tsx", import.meta.url), "utf8"),
  ]);
  for (const source of [fullMap, sectionMap]) {
    assert.match(source, /scrollWheelZoom:\s*false/);
    assert.match(source, /aria-pressed=\{\w+\}/);
    assert.match(source, /Enable map scroll-wheel zoom/);
    assert.match(source, /Disable map scroll-wheel zoom/);
    assert.match(source, /Scroll to zoom · Esc to exit/);
  }
  assert.match(sectionMap, /zoomControl:\s*true/);
  assert.doesNotMatch(sectionMap, /touchZoom:\s*false/);
  assert.doesNotMatch(fullMap, /touchZoom:\s*false/);
  assert.match(fullMap, /lastMapSelectionRef/);
  assert.match(fullMap, /fitBounds\(selectedMomentFocusPoints/);
  assert.doesNotMatch(fullMap, /fitBounds\(selectedSectionPoints/);
});
