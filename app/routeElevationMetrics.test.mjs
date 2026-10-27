import assert from "node:assert/strict";
import test from "node:test";
import { analyzeGpxRoute } from "./gpxAnalysis.ts";
import {
  buildRouteElevationMetricModel,
  measureRouteElevationInterval,
  ROUTE_ELEVATION_METRIC_INTERVAL_M,
  ROUTE_ELEVATION_METRIC_MEDIAN_RADIUS_M,
} from "./routeElevationMetrics.ts";
import { buildCustomRouteSections, createCustomSectionPlan } from "./customRouteSections.ts";

function points(samples, segmentIndex = 0) {
  return samples.map(([distanceM, elevationM]) => ({ distanceM, elevationM, segmentIndex, latitude: 45, longitude: 13 }));
}

function sum(sections) {
  return sections.reduce((total, section) => ({ ascentM: total.ascentM + section.ascentM, descentM: total.descentM + section.descentM }), { ascentM: 0, descentM: 0 });
}

test("elevation metric model documents fixed-distance sampling and its noise filter", () => {
  assert.equal(ROUTE_ELEVATION_METRIC_INTERVAL_M, 50);
  assert.equal(ROUTE_ELEVATION_METRIC_MEDIAN_RADIUS_M, 50);
});

test("isolated altitude spikes are filtered while a sustained climb and descent remain measurable", () => {
  const noisy = buildRouteElevationMetricModel(points([[0, 100], [50, 100], [100, 107], [150, 100], [200, 100], [250, 100]]));
  assert.deepEqual([noisy.ascentM, noisy.descentM], [0, 0]);

  const climb = buildRouteElevationMetricModel(points(Array.from({ length: 11 }, (_, index) => [index * 50, 100 + index * 5])));
  assert.deepEqual([climb.ascentM, climb.descentM], [50, 0]);
  const descent = buildRouteElevationMetricModel(points(Array.from({ length: 11 }, (_, index) => [index * 50, 150 - index * 5])));
  assert.deepEqual([descent.ascentM, descent.descentM], [0, 50]);
});

test("rolling elevation movement is retained and irregular point spacing yields the same linear grade totals", () => {
  const rolling = buildRouteElevationMetricModel(points([[0, 100], [50, 110], [100, 100], [150, 120], [200, 100], [250, 110], [300, 100]]));
  assert.ok(rolling.ascentM > 0 && rolling.descentM > 0);

  const regular = buildRouteElevationMetricModel(points([[0, 100], [50, 105], [100, 110], [150, 115], [200, 120], [250, 125], [300, 130]]));
  const irregular = buildRouteElevationMetricModel(points([[0, 100], [23, 102.3], [130, 113], [177, 117.7], [300, 130]]));
  assert.deepEqual([irregular.ascentM, irregular.descentM], [regular.ascentM, regular.descentM]);
});

test("arbitrary interval cuts allocate the same cumulative ascent and descent as the full route", () => {
  const model = buildRouteElevationMetricModel(points([
    [0, 100], [50, 106], [100, 112], [150, 110], [200, 108], [250, 114],
    [300, 125], [350, 130], [400, 126], [450, 120], [500, 135],
  ]));
  const cuts = [0, 37, 137, 299, 412, 500];
  const intervals = cuts.slice(0, -1).map((start, index) => measureRouteElevationInterval(model, 0, start, cuts[index + 1]));
  assert.ok(intervals.every(Boolean));
  assert.deepEqual(intervals.reduce((total, item) => ({ ascentM: total.ascentM + item.ascentM, descentM: total.descentM + item.descentM }), { ascentM: 0, descentM: 0 }), {
    ascentM: model.ascentM,
    descentM: model.descentM,
  });
  assert.equal(measureRouteElevationInterval(model, 0, -1, 100), null);
});

test("incomplete or unordered components are unavailable instead of bridging missing elevation samples", () => {
  const model = buildRouteElevationMetricModel([
    ...points([[0, 100], [50, 110], [100, Number.NaN], [150, 120], [200, 130]], 0),
    ...points([[0, 200], [50, 205], [100, 210]], 1),
  ]);
  assert.deepEqual([model.ascentM, model.descentM], [10, 0]);
  assert.equal(measureRouteElevationInterval(model, 0, 0, 200), null);
  assert.deepEqual(measureRouteElevationInterval(model, 1, 0, 100), { ascentM: 10, descentM: 0 });
  const unordered = buildRouteElevationMetricModel(points([[0, 100], [100, 120], [50, 110]]));
  assert.deepEqual([unordered.ascentM, unordered.descentM], [0, 0]);
});

test("disconnected components retain their own elevation changes without a synthetic connector", () => {
  const model = buildRouteElevationMetricModel([
    ...points([[0, 100], [50, 105], [100, 110]], 0),
    ...points([[100, 900], [150, 895], [200, 890]], 1),
  ]);
  assert.deepEqual([model.ascentM, model.descentM], [10, 10]);
  assert.deepEqual(measureRouteElevationInterval(model, 0, 0, 100), { ascentM: 10, descentM: 0 });
  assert.deepEqual(measureRouteElevationInterval(model, 1, 100, 200), { ascentM: 0, descentM: 10 });
  assert.equal(measureRouteElevationInterval(model, 0, 0, 200), null);

  const analysis = analyzeGpxRoute({ segments: [
    Array.from({ length: 21 }, (_, index) => ({ latitude: 45, longitude: index * 50 / 111_320, elevationM: 100 + index * 2 })),
    Array.from({ length: 21 }, (_, index) => ({ latitude: 46, longitude: index * 50 / 111_320, elevationM: 900 - index * 2 })),
  ] });
  assert.deepEqual(sum(analysis.routeSections), { ascentM: analysis.metrics.elevationGainM, descentM: analysis.metrics.elevationLossM });
  const custom = buildCustomRouteSections(analysis, createCustomSectionPlan());
  assert.equal(custom.available, true);
  assert.deepEqual(sum(custom.sections), { ascentM: analysis.metrics.elevationGainM, descentM: analysis.metrics.elevationLossM });
});

test("route totals, automatic Terrain Sections, Custom Sections, and multiple boundaries reconcile exactly", () => {
  const segments = [Array.from({ length: 61 }, (_, index) => ({
    latitude: 45,
    longitude: index * 25 / 111_320,
    elevationM: 300 + 2 * Math.sin(index / 3) + index * 0.75,
  }))];
  const analysis = analyzeGpxRoute({ segments });
  const automatic = sum(analysis.routeSections);
  assert.deepEqual(automatic, { ascentM: analysis.metrics.elevationGainM, descentM: analysis.metrics.elevationLossM });

  const distanceKm = analysis.metrics.distanceKm;
  const plan = {
    ...createCustomSectionPlan(),
    boundaries: [0.23, 0.51, 0.81].map((km, index) => ({ id: `custom-point-${index + 1}`, distanceKm: String(km), name: "" })),
  };
  assert.ok(plan.boundaries.every((boundary) => Number(boundary.distanceKm) < distanceKm));
  const custom = buildCustomRouteSections(analysis, plan);
  assert.equal(custom.available, true);
  assert.deepEqual(sum(custom.sections), { ascentM: analysis.metrics.elevationGainM, descentM: analysis.metrics.elevationLossM });
});
