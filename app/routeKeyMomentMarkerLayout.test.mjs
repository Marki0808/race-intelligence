import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";

const require = createRequire(import.meta.url);
const url = new URL("./routeKeyMomentMarkerLayout.ts", import.meta.url);
const source = await readFile(url, "utf8");
const compiled = ts.transpile(source, { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 });
const markerLayoutModule = { exports: {} };
new Function("exports", "require", "module", "__filename", "__dirname", compiled)(markerLayoutModule.exports, require, markerLayoutModule, url.pathname, new URL(".", url).pathname);
const { layoutKeyMomentMarkerOffsets } = markerLayoutModule.exports;

test("nearby markers receive distinct deterministic screen offsets without changing their route positions", () => {
  const points = [{ id: "01", x: 100, y: 100 }, { id: "02", x: 103, y: 101 }, { id: "03", x: 106, y: 99 }];
  const first = layoutKeyMomentMarkerOffsets(points, 320, 240);
  const second = layoutKeyMomentMarkerOffsets(points, 320, 240);
  assert.deepEqual([...first], [...second]);
  assert.notDeepEqual(first.get("01"), first.get("02"));
  const displayed = points.map((point) => ({ x: point.x + first.get(point.id).x, y: point.y + first.get(point.id).y }));
  for (let left = 0; left < displayed.length; left += 1) {
    for (let right = left + 1; right < displayed.length; right += 1) {
      assert.ok(Math.hypot(displayed[left].x - displayed[right].x, displayed[left].y - displayed[right].y) >= 30);
    }
  }
  assert.deepEqual(points.map(({ x, y }) => [x, y]), [[100, 100], [103, 101], [106, 99]]);
});

test("camera projections recompute offsets and edge clusters stay inside the viewport", () => {
  const closeToEdge = [{ id: "01", x: 3, y: 4 }, { id: "02", x: 5, y: 5 }];
  const offsets = layoutKeyMomentMarkerOffsets(closeToEdge, 320, 240);
  const displayed = closeToEdge.map((point) => ({ x: point.x + offsets.get(point.id).x, y: point.y + offsets.get(point.id).y }));
  assert.ok(displayed.every(({ x, y }) => x >= 14 && x <= 306 && y >= 14 && y <= 226));

  const zoomedProjection = [{ id: "01", x: 100, y: 100 }, { id: "02", x: 160, y: 100 }];
  assert.deepEqual([...layoutKeyMomentMarkerOffsets(zoomedProjection, 320, 240)], [["01", { x: 0, y: 0 }], ["02", { x: 0, y: 0 }]]);
});

test("the shared MapLibre viewer updates screen layout on camera and resize events and preserves GPX anchors", async () => {
  const viewer = await readFile(new URL("./MapLibreRouteMap.tsx", import.meta.url), "utf8");
  assert.match(viewer, /map\.on\("move", scheduleKeyMomentLayout\)/);
  assert.match(viewer, /map\.on\("resize", scheduleKeyMomentLayout\)/);
  assert.match(viewer, /map!?\.project\(\[marker\.longitude, marker\.latitude\]\)/);
  assert.match(viewer, /map!?\.unproject\(\[position\.x \+ offset\.x, position\.y \+ offset\.y\]\)/);
  assert.match(viewer, /coordinates: \[\[marker\.longitude, marker\.latitude\], display\]/);
  assert.match(viewer, /cancelAnimationFrame\(keyMomentLayoutFrameRef\.current\)/);
});
