import test from "node:test";
import assert from "node:assert/strict";
import { buildSustainedGradientKeyMoments } from "./routeGradientMoments.ts";
import { getKeyMomentProfilePoints, keyMomentProfilePolyline } from "./routeKeyMomentProfile.ts";
import { buildRouteTakeaways } from "./routeTakeawayFacts.ts";
import { orderKeyMomentsForDisplay, presentKeyMomentCard } from "./routeKeyMomentPresentation.ts";

const interval = (overrides = {}) => ({
  intervalId: "interval-1", segmentIndex: 0, startDistanceM: 2000, endDistanceM: 4000, distanceM: 2000,
  metrics: { netElevationChangeM: 220, netGradientPct: 11, ascentM: 230, descentM: 10, verticalIntensityMPerKm: 120, cellNetGradientMinimumPct: 8, cellNetGradientMaximumPct: 14, cellNetGradientSpreadPercentagePoints: 6 },
  direction: "climb", gradientBand: "steep", character: "sustained-steep-climb", confidence: "high", intervalLengthClass: "sustained", measurementAvailability: "available", ...overrides,
});
const intelligence = (intervals) => ({ schemaVersion: 1, algorithmVersion: 2, source: "route-dynamics-smoothed-profile", assumptions: { resampleIntervalM: 100, medianFilterRadiusM: 200, movingAverageRadiusM: 300 }, sections: [{ sectionId: "section-0", segmentIndex: 0, startDistanceM: 0, endDistanceM: 5000, status: "available", sectionCharacter: "climbing", progression: "steady", multiScaleMetrics: [], intervals }] });
const section = (id, segmentIndex, start, end, rhythm, ascentM = 0, descentM = 0) => ({ id, segmentIndex, startPosition: { distanceM: start, segmentIndex }, endPosition: { distanceM: end, segmentIndex }, startKm: start / 1000, endKm: end / 1000, dominantRhythm: rhythm, ascentM, descentM });

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

test("legacy Key Moment profile helper remains component-scoped for existing consumers", () => {
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

test("takeaways require a genuine majority insight and never expose internal labels or section chronology", () => {
  const none = buildRouteTakeaways({ routeSections: [section("a", 0, 0, 1000, "climb", 50, 50), section("b", 0, 1000, 2000, "rolling", 50, 50)] });
  assert.deepEqual(none, []);
  const insights = buildRouteTakeaways({ routeSections: [
    section("a", 0, 0, 1000, "climb", 70, 10), section("b", 0, 1000, 2000, "rolling", 20, 20), section("c", 1, 2000, 3000, "descent", 10, 70),
  ] });
  assert.equal(insights.length, 2);
  assert.match(insights[0].text, /More than half of the climbing measured/);
  assert.match(insights[1].text, /More than half of the descending measured/);
  assert.doesNotMatch(insights.map((item) => item.text).join(" "), /Track segment|climb-led|descent-led|progress from|rolling/);
  assert.ok(insights.every((item) => item.segmentIndex >= 0 && item.sectionId));
  assert.ok(insights.length <= 3);
});

test("Key Moment presentation preserves consistent measured values, exact positions and distinct point markers", () => {
  const points = [
    { distanceM: 0, elevationM: 10, latitude: 0, longitude: 0, segmentIndex: 0 },
    { distanceM: 2000, elevationM: 40, latitude: 0, longitude: 0, segmentIndex: 0 },
    { distanceM: 3000, elevationM: 60, latitude: 0, longitude: 0, segmentIndex: 0 },
    { distanceM: 5000, elevationM: 20, latitude: 0, longitude: 0, segmentIndex: 0 },
  ];
  const grade = { id: "grade", number: "", title: "Sustained steep climb", distance: "2–3 km", focusStartKm: 2, focusEndKm: 3, segmentIndex: 0, text: "Smoothed profile grade.", source: "GPX-derived", measurement: { kind: "gradient", direction: "climb", startDistanceM: 2000, endDistanceM: 3000, distanceM: 1000, averageNetGradientPct: 12.2, segmentIndex: 0 } };
  const card = presentKeyMomentCard(grade, points, 5000);
  assert.equal(card?.value, "+12.2%");
  assert.equal(card?.valueContext, "average net grade over 1.0 km uphill");
  assert.equal(card?.location, "2–3 km");
  assert.equal(presentKeyMomentCard({ ...grade, measurement: { ...grade.measurement, distanceM: 1700 } }, points, 5000), null);
  const high = { ...grade, id: "high", title: "Highest point", measurement: { kind: "point", distanceM: 3000, elevationM: 60, segmentIndex: 0 } };
  assert.deepEqual(orderKeyMomentsForDisplay([high, grade]).map((item) => item.id), ["grade", "high"]);
  assert.equal(presentKeyMomentCard(high, points, 5000)?.location, "At 3 km");
  assert.equal(presentKeyMomentCard({ ...high, measurement: { ...high.measurement, segmentIndex: 1 } }, points, 5000), null);
});
