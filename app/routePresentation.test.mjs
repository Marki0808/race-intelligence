import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import { buildSustainedGradientKeyMoments } from "./routeGradientMoments.ts";
import { getKeyMomentProfilePoints, keyMomentProfilePolyline } from "./routeKeyMomentProfile.ts";
import { buildRouteTakeaways } from "./routeTakeawayFacts.ts";
import { expandKeyMomentsForDisplay, orderKeyMomentsForDisplay, presentKeyMomentCard } from "./routeKeyMomentPresentation.ts";
import { createRouteKeyMoments } from "./routeKeyMoments.ts";

const require = createRequire(import.meta.url);
const markerUrl = new URL("./routeKeyMomentProfileMarkers.ts", import.meta.url);
const markerSource = await readFile(markerUrl, "utf8");
const markerJs = ts.transpile(markerSource, { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 });
const markerModule = { exports: {} };
new Function("exports", "require", "module", "__filename", "__dirname", markerJs)(markerModule.exports, (specifier) => specifier === "./routeProfilePresentation.ts" ? { getNiceAxisScale: () => ({ minimum: 0, maximum: 1000 }) } : require(specifier), markerModule, markerUrl.pathname, new URL(".", markerUrl).pathname);
const { layoutKeyMomentProfileMarkers } = markerModule.exports;

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
  assert.deepEqual(result.map(({ title }) => title), ["Steepest sustained climb", "Steepest sustained descent"]);
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
  const grade = { id: "grade", number: "", title: "Steepest sustained climb", distance: "2–3 km", focusStartKm: 2, focusEndKm: 3, segmentIndex: 0, text: "Smoothed profile grade.", source: "GPX-derived", measurement: { kind: "gradient", direction: "climb", startDistanceM: 2000, endDistanceM: 3000, distanceM: 1000, averageNetGradientPct: 12.2, segmentIndex: 0 } };
  const card = presentKeyMomentCard(grade, points, 5000);
  assert.equal(card?.value, "+12.2%");
  assert.equal(card?.locationSentence, "This sustained climb runs from km 2 to km 3.");
  assert.equal(presentKeyMomentCard({ ...grade, measurement: { ...grade.measurement, distanceM: 1700 } }, points, 5000), null);
  const high = { ...grade, id: "high", title: "Highest point", measurement: { kind: "point", distanceM: 3000, elevationM: 60, segmentIndex: 0 } };
  assert.deepEqual(orderKeyMomentsForDisplay([high, grade]).map((item) => item.id), ["grade", "high"]);
  assert.equal(presentKeyMomentCard(high, points, 5000)?.locationSentence, "The highest point is at km 3.");
  assert.equal(presentKeyMomentCard({ ...high, measurement: { ...high.measurement, segmentIndex: 1 } }, points, 5000), null);
});

test("longest and biggest remain separate cards even when the same event holds both records", () => {
  const event = { id: "only-climb", segmentIndex: 0, startKm: 1, endKm: 6, startPosition: { distanceM: 1000, segmentIndex: 0 }, endPosition: { distanceM: 6000, segmentIndex: 0 }, rhythm: "climb", ascentM: 500, descentM: 10, netElevationM: 490, gradientPct: 9.8, verticalIntensity: 100, directionBalance: 0.9, directionStrength: 0.8, persistence: 0.8, significance: 1 };
  const moments = createRouteKeyMoments(
    Array.from({ length: 8 }, (_, index) => ({ distanceM: index * 1000, elevationM: index === 7 ? 50 : index === 0 ? 100 : 200 + index * 10, latitude: 45, longitude: 14, segmentIndex: 0 })),
    { distanceKm: 7, ascentM: 500, descentM: 500, highestPointM: 260, lowestPointM: 50 },
    { events: [event] },
  );
  const eventMoments = expandKeyMomentsForDisplay(moments).filter((moment) => moment.measurement?.kind === "event");
  assert.deepEqual(eventMoments.map((moment) => moment.title), ["Longest climb", "Biggest climb"]);
  const points = Array.from({ length: 8 }, (_, index) => ({ distanceM: index * 1000, elevationM: index === 7 ? 50 : index === 0 ? 100 : 200 + index * 10, latitude: 45, longitude: 14, segmentIndex: 0 }));
  const cards = eventMoments.map((moment) => presentKeyMomentCard(moment, points, 7000));
  assert.equal(cards[0]?.value, "5.0 km");
  assert.equal(cards[1]?.value, "+500 m");
  assert.equal(cards[0]?.locationSentence, "This climb runs from km 1 to km 6.");
  assert.equal(cards[1]?.locationSentence, cards[0]?.locationSentence);
});

test("eight independently supported Key Moment categories order consistently and use one location sentence each", () => {
  const points = Array.from({ length: 21 }, (_, index) => ({ distanceM: index * 1000, elevationM: 500 + Math.sin(index) * 200, latitude: 45, longitude: 14, segmentIndex: 0 }));
  const events = [
    { id: "climb-long", segmentIndex: 0, startKm: 1, endKm: 6.3, startPosition: { distanceM: 1000, segmentIndex: 0 }, endPosition: { distanceM: 6300, segmentIndex: 0 }, rhythm: "climb", ascentM: 400, descentM: 0 },
    { id: "climb-big", segmentIndex: 0, startKm: 7, endKm: 10, startPosition: { distanceM: 7000, segmentIndex: 0 }, endPosition: { distanceM: 10000, segmentIndex: 0 }, rhythm: "climb", ascentM: 526, descentM: 0 },
    { id: "descent-long", segmentIndex: 0, startKm: 12, endKm: 16.2, startPosition: { distanceM: 12000, segmentIndex: 0 }, endPosition: { distanceM: 16200, segmentIndex: 0 }, rhythm: "descent", ascentM: 0, descentM: 350 },
    { id: "descent-big", segmentIndex: 0, startKm: 17, endKm: 19.4, startPosition: { distanceM: 17000, segmentIndex: 0 }, endPosition: { distanceM: 19400, segmentIndex: 0 }, rhythm: "descent", ascentM: 0, descentM: 480 },
  ].map((event) => ({ netElevationM: event.ascentM - event.descentM, gradientPct: 8, verticalIntensity: 80, directionBalance: 0.9, directionStrength: 0.8, persistence: 0.8, significance: 1, confidence: 1, ...event }));
  const base = expandKeyMomentsForDisplay(createRouteKeyMoments(points, { distanceKm: 20, ascentM: 1000, descentM: 1000, highestPointM: Math.max(...points.map((point) => point.elevationM)), lowestPointM: Math.min(...points.map((point) => point.elevationM)) }, { events }));
  const gradeMoment = (id, direction, startDistanceM, endDistanceM, averageNetGradientPct) => ({ id, number: "", title: `Steepest sustained ${direction}`, distance: "", focusStartKm: startDistanceM / 1000, focusEndKm: endDistanceM / 1000, segmentIndex: 0, text: "", source: "GPX-derived", measurement: { kind: "gradient", direction, startDistanceM, endDistanceM, distanceM: endDistanceM - startDistanceM, averageNetGradientPct, segmentIndex: 0 } });
  const moments = orderKeyMomentsForDisplay([...base, gradeMoment("grade-climb", "climb", 6000, 8000, 12.2), gradeMoment("grade-descent", "descent", 10000, 12000, -11.4)]);
  const cards = moments.map((moment) => presentKeyMomentCard(moment, points, 20000));
  assert.deepEqual(cards.map((card) => card?.title), ["Longest climb", "Biggest climb", "Longest descent", "Biggest descent", "Steepest sustained climb", "Steepest sustained descent", "Highest point", "Lowest point"]);
  assert.equal(cards.filter(Boolean).length, 8);
  assert.ok(cards.every((card) => card && card.locationSentence.endsWith(".")));
  assert.equal(cards[4]?.value, "+12.2%");
  assert.equal(cards[5]?.value, "−11.4%");
});

test("shared profile marker layout preserves true component anchors and offsets colliding labels deterministically", () => {
  const points = [
    { distanceM: 0, elevationM: 100, latitude: 45, longitude: 14, segmentIndex: 0 },
    { distanceM: 1000, elevationM: 300, latitude: 45, longitude: 14, segmentIndex: 0 },
    { distanceM: 2000, elevationM: 500, latitude: 45, longitude: 14, segmentIndex: 0 },
    { distanceM: 1000, elevationM: 900, latitude: 46, longitude: 15, segmentIndex: 1 },
  ];
  const makeMoment = (id, segmentIndex, kind = "event") => ({
    moment: { id, number: "", title: "Biggest climb", distance: "0–2 km", focusStartKm: 0, focusEndKm: 2, segmentIndex, text: "", source: "GPX", measurement: kind === "point" ? { kind: "point", distanceM: 1000, elevationM: 900, segmentIndex } : { kind: "event", direction: "climb", startDistanceM: 0, endDistanceM: 2000, distanceM: 2000, elevationChangeM: 400, segmentIndex, roles: ["largest"] } },
    card: { kind, title: id, value: "", locationSentence: "At a measured position.", startPercent: 0, endPercent: 0, exactDistanceM: 0 },
    number: id,
  });
  const inputs = [makeMoment("01", 0), makeMoment("02", 0), makeMoment("03", 1, "point")];
  const layout = layoutKeyMomentProfileMarkers(inputs, points, 2000, 320, 288);
  assert.equal(layout.length, 3);
  assert.equal(layout[0].anchorX, layout[1].anchorX);
  assert.notEqual(layout[0].markerY, layout[1].markerY);
  assert.equal(layout[2].segmentIndex, 1);
  assert.equal(layout[2].anchorX, layout[0].anchorX);
  assert.deepEqual(layout, layoutKeyMomentProfileMarkers(inputs, points, 2000, 320, 288));
  assert.ok(layout.every((marker) => marker.markerX >= 56 && marker.markerX <= 300 && marker.markerY < 250));
});
