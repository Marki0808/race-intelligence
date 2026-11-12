import assert from "node:assert/strict";
import test from "node:test";
import { attachMapLibreWheelZoom } from "./mapLibreWheelZoom.ts";

class FakeDocument {
  listeners = new Map();
  addEventListener(type, listener) { const set = this.listeners.get(type) ?? new Set(); set.add(listener); this.listeners.set(type, set); }
  removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
  dispatch(type, event) { for (const listener of this.listeners.get(type) ?? []) listener(event); }
}

test("MapLibre wheel zoom is opt-in and exits on outside pointer or Escape", () => {
  const document = new FakeDocument();
  const handlers = new Map();
  const calls = { enabled: 0, disabled: 0 };
  const map = { on: (type, handler) => handlers.set(type, handler), off: (type) => handlers.delete(type), scrollZoom: { enable: () => calls.enabled++, disable: () => calls.disabled++ } };
  const container = { contains: (target) => target === "inside" };
  const states = [];
  const controller = attachMapLibreWheelZoom(map, container, (active) => states.push(active), document);
  assert.deepEqual(calls, { enabled: 0, disabled: 0 });
  handlers.get("click")();
  document.dispatch("pointerdown", { target: "inside" });
  assert.deepEqual(calls, { enabled: 1, disabled: 0 });
  document.dispatch("pointerdown", { target: "outside" });
  controller.activate();
  document.dispatch("keydown", { key: "Escape" });
  assert.deepEqual(calls, { enabled: 2, disabled: 2 });
  assert.deepEqual(states, [true, false, true, false]);
  controller.dispose();
  assert.equal(document.listeners.get("keydown").size, 0);
});
