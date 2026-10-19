import test from "node:test";
import assert from "node:assert/strict";
import { buildSustainedGradientKeyMoments } from "./routeGradientMoments.ts";
import { getKeyMomentProfilePoints, keyMomentProfilePolyline } from "./routeKeyMomentProfile.ts";
import { buildRouteTakeaways } from "./routeTakeawayFacts.ts";

const interval = (overrides = {}) => ({
  intervalId: "interval-1", segmentIndex: 0, startDistanceM: 2000, endDistanceM: 4000, distanceM: 2000,
  metrics: { netElevationChangeM: 220, netGradientPct: 11, ascentM: 230, descentM: 10, verticalIntensityMPerKm: 120, cellNetGradientMinimumPct: 8, cellNetGradientMaximumPct: 14, cellNetGradientSpreadPercentagePoints: 6 },
  direction: "climb", gradientBand: "steep", character: "sustained-steep-climb", confidence: "high", intervalLengthClass: "sustained", measurementAvailability: "available", ...overrides,
});
const intelligence = (intervals) => ({ schemaVersion: 1, algorithmVersion: 2, source: "route-dynamics-smoothed-profile", assumptions: { resampleIntervalM: 100, medianFilterRadiusM: 200, movingAverageRadiusM: 300 }, sections: [{ sectionId: "section-0", segmentIndex: 0, startDistanceM: 0, endDistanceM: 5000, status: "available", sectionCharacter: "climbing", progression: "steady", multiScaleMetrics: [], intervals }] });
const section = (id, segmentIndex, start, end, rhythm) => ({ id, segmentIndex, startPosition: { distanceM: start, segmentIndex }, endPosition: { distanceM: end, segmentIndex }, startKm: start / 1000, endKm: end / 1000, dominantRhythm: rhythm });

test("sustained climb and descent highlights use high-confidence existing intervals and preserve precise component identity", () => {
  const climb = intelligence([interval()]);
  const descent = interval({ intervalId: "down", segmentIndex: 1, startDistanceM: 8000, endDistanceM: 11000, distanceM: 3000, direction: "descent", gradientBand: "very-steep", metrics: { ...interval().metrics, netGradientPct: -17.4 } });
  climb.sections.push({ ...climb.sections[0], sectionId: "section-1", segmentIndex: 1, startDistanceM: 5000, endDistanceM: 12000, intervals: [descent] });
  const result = buildSustainedGradientKeyMoments(climb);
  assert.deepEqual(result.map(({ title }) => title), ["Sustained steep climb", "Sustained steep descent"]);
  assert.equal(result[0].focusStartPosition.distanceM, 2000);
  assert.equal(result[1].segmentIndex, 1);
  assert.match(result[1].text, /-17\.4% net grade downhill/);
  assert.equal(result[1].source, "GPX-derived smoothed profile");
});

test("short, moderate-confidence, unknown and incomplete intervals do not become sustained-grade highlights", () => {
  const result = buildSustainedGradientKeyMoments(intelligence([
    interval({ distanceM: 1000, endDistanceM: 3000, intervalLengthClass: "short" }),
    interval({ intervalId: "moderate-confidence", startDistanceM: 5000, endDistanceM: 7000, distanceM: 2000, confidence: "moderate" }),
    interval({ intervalId: "unknown", startDistanceM: 8000, endDistanceM: 10000, distanceM: 2000, confidence: "unknown" }),
    interval({ intervalId: "missing-grade", startDistanceM: 11000, endDistanceM: 13000, distanceM: 2000, gradientBand: null }),
  ]));
  assert.deepEqual(result, []);
});

test("an existing climb moment covering a gradient feature prevents a duplicate card", () => {
  const existing = [{ id: "existing", title: "Longest climb", focusStartKm: 1.8, focusEndKm: 4.2 }];
  assert.deepEqual(buildSustainedGradientKeyMoments(intelligence([interval()]), existing), []);
});

test("Key Moment sparkline uses only actual samples from its validated component and interval", () => {
  const points = [
    { distanceM: 0, elevationM: 10, latitude: 0, longitude: 0, segmentIndex: 0 },
    { distanceM: 1000, elevationM: 20, latitude: 0, longitude: 0, segmentIndex: 0 },
    { distanceM: 2000, elevationM: 40, latitude: 0, longitude: 0, segmentIndex: 0 },
    { distanceM: 3000, elevationM: 50, latitude: 0, longitude: 0, segmentIndex: 0 },
    { distanceM: 3000, elevationM: 500, latitude: 0, longitude: 0, segmentIndex: 1 },
    { distanceM: 4000, elevationM: 60, latitude: 0, longitude: 0, segmentIndex: 0 },
  ];
  const moment = { focusStartKm: 1, focusEndKm: 4, segmentIndex: 0 };
  const profile = getKeyMomentProfilePoints(points, moment);
  assert.deepEqual(profile.map(({ elevationM }) => elevationM), [20, 40, 50, 60]);
  assert.ok(keyMomentProfilePolyline(profile));
  assert.equal(getKeyMomentProfilePoints(points, { ...moment, segmentIndex: undefined }).length, 0);
  assert.equal(keyMomentProfilePolyline(profile.slice(0, 1)), null);
});

test("route takeaways preserve ordered rhythm within each disconnected component and never bridge components", () => {
  const result = buildRouteTakeaways({ routeSections: [
    section("a", 0, 0, 1000, "climb"), section("b", 0, 1000, 2000, "climb"), section("c", 0, 2000, 3000, "rolling"),
    section("d", 1, 3000, 4000, "descent"), section("e", 1, 4000, 5000, "flat"),
  ] });
  assert.deepEqual(result.map(({ text }) => text), [
    "Within Track segment 1, the analyzed sections progress from climb-led to rolling.",
    "Within Track segment 2, the analyzed sections progress from descent-led to low-vertical-change.",
  ]);
  assert.ok(result.length <= 3);
});
