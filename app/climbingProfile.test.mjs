import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { calculateClimbingProfile, calculateGradientDistribution } from "./climbingProfileModel.ts";
import { analyzeRouteDynamics } from "./routeDynamics.ts";
import { formatDistanceMeters } from "./routeUnits.ts";

function dynamicsFromGrades(grades, segmentIndex = 0, startDistanceM = 0, startElevationM = 100) {
  const resampledPoints = [{ segmentIndex, distanceM: startDistanceM, elevationM: startElevationM, smoothedElevationM: startElevationM }];
  let elevation = startElevationM;
  for (let index = 0; index < grades.length; index += 1) {
    elevation += grades[index];
    resampledPoints.push({ segmentIndex, distanceM: startDistanceM + (index + 1) * 100, elevationM: elevation, smoothedElevationM: elevation });
  }
  return { resampledPoints };
}

function makeRoutePoints({ distanceM = 10_000, spacingM = 50, gradePct = 5, noiseM = 0 } = {}) {
  const points = [];
  for (let distance = 0; distance <= distanceM; distance += spacingM) {
    const noise = noiseM ? Math.sin(distance / 37) * noiseM + Math.cos(distance / 19) * noiseM / 2 : 0;
    points.push({
      segmentIndex: 0,
      distanceM: distance,
      latitude: 45 + distance / 111_000,
      longitude: 13,
      elevationM: 100 + distance * gradePct / 100 + noise,
    });
  }
  return points;
}

test("uphill grade boundaries are mutually exclusive and measured uphill shares total 100%", () => {
  const grades = [
    ...Array(10).fill(5),
    ...Array(10).fill(10),
    ...Array(10).fill(10.01),
    ...Array(10).fill(20),
    ...Array(10).fill(20.01),
  ];
  const result = calculateClimbingProfile(dynamicsFromGrades(grades));
  assert.equal(result.status, "available");
  assert.deepEqual(result.categories, {
    gentle: { distanceM: 2000, percent: 40 },
    moderate: { distanceM: 2000, percent: 40 },
    steep: { distanceM: 1000, percent: 20 },
  });
  assert.equal(Object.values(result.categories).reduce((sum, category) => sum + category.distanceM, 0), result.measuredUphillDistanceM);
  assert.equal(Object.values(result.categories).reduce((sum, category) => sum + category.percent, 0), 100);
});

test("downhill and flat intervals do not enter the uphill-distance denominator", () => {
  const result = calculateClimbingProfile(dynamicsFromGrades([
    ...Array(10).fill(5), ...Array(10).fill(-30), ...Array(10).fill(0), ...Array(10).fill(5),
  ]));
  assert.equal(result.status, "available");
  assert.equal(result.measuredUphillDistanceM, 2000);
  assert.deepEqual(Object.values(result.categories).map(({ distanceM }) => distanceM), [2000, 0, 0]);
});

test("downhill uses absolute negative grades with the same exact category boundaries", () => {
  const grades = [
    ...Array(10).fill(-5),
    ...Array(10).fill(-10),
    ...Array(10).fill(-10.01),
    ...Array(10).fill(-20),
    ...Array(10).fill(-20.01),
  ];
  const result = calculateGradientDistribution(dynamicsFromGrades(grades), "downhill");
  assert.equal(result.status, "available");
  assert.deepEqual(result.categories, {
    gentle: { distanceM: 2000, percent: 40 },
    moderate: { distanceM: 2000, percent: 40 },
    steep: { distanceM: 1000, percent: 20 },
  });
  assert.equal(Object.values(result.categories).reduce((sum, category) => sum + category.distanceM, 0), result.measuredDistanceM);
  assert.equal(Object.values(result.categories).reduce((sum, category) => sum + category.percent, 0), 100);
});

test("cumulative category distances format in selected units without changing percentages", () => {
  const result = calculateGradientDistribution(dynamicsFromGrades([
    ...Array(10).fill(5), ...Array(10).fill(15), ...Array(10).fill(25),
  ]), "uphill");
  assert.equal(result.status, "available");
  const metricPresentation = Object.fromEntries(Object.entries(result.categories).map(([key, value]) => [key, {
    percent: value.percent,
    distance: formatDistanceMeters(value.distanceM, "metric", 1),
  }]));
  const usPresentation = Object.fromEntries(Object.entries(result.categories).map(([key, value]) => [key, {
    percent: value.percent,
    distance: formatDistanceMeters(value.distanceM, "us-customary", 1),
  }]));
  assert.deepEqual(Object.fromEntries(Object.entries(metricPresentation).map(([key, value]) => [key, value.percent])),
    Object.fromEntries(Object.entries(usPresentation).map(([key, value]) => [key, value.percent])));
  assert.equal(metricPresentation.gentle.distance, "1 km");
  assert.equal(usPresentation.gentle.distance, "0.6 mi");
  assert.equal(Object.values(result.categories).reduce((sum, category) => sum + category.distanceM, 0), result.measuredDistanceM);
});

test("mixed route directions use separate uphill and downhill distance denominators", () => {
  const dynamics = dynamicsFromGrades([
    ...Array(10).fill(5), ...Array(10).fill(-15), ...Array(10).fill(-5), ...Array(10).fill(25),
  ]);
  const uphill = calculateGradientDistribution(dynamics, "uphill");
  const downhill = calculateGradientDistribution(dynamics, "downhill");
  assert.equal(uphill.status, "available");
  assert.equal(downhill.status, "available");
  assert.equal(uphill.measuredDistanceM, 2000);
  assert.equal(downhill.measuredDistanceM, 2000);
  assert.deepEqual(Object.values(uphill.categories).map(({ distanceM }) => distanceM), [1000, 0, 1000]);
  assert.deepEqual(Object.values(downhill.categories).map(({ distanceM }) => distanceM), [1000, 1000, 0]);
});

test("each direction can be available independently of the opposite direction", () => {
  const uphillOnly = dynamicsFromGrades(Array(10).fill(12));
  assert.equal(calculateGradientDistribution(uphillOnly, "uphill").status, "available");
  assert.deepEqual(calculateGradientDistribution(uphillOnly, "downhill"), { status: "unavailable", reason: "insufficient-downhill-distance" });
  const downhillOnly = dynamicsFromGrades(Array(10).fill(-12));
  assert.equal(calculateGradientDistribution(downhillOnly, "downhill").status, "available");
  assert.deepEqual(calculateGradientDistribution(downhillOnly, "uphill"), { status: "unavailable", reason: "insufficient-uphill-distance" });
});

test("uses Route Dynamics smoothed samples so high-frequency GPX noise does not become raw point gradients", () => {
  const routeDynamics = analyzeRouteDynamics(makeRoutePoints({ noiseM: 6 }));
  const result = calculateClimbingProfile(routeDynamics);
  assert.equal(result.status, "available");
  assert.ok(result.categories.gentle.percent + result.categories.moderate.percent >= 95);
  assert.ok(result.categories.steep.percent <= 5);
});

test("disconnected components are classified separately with no synthetic elevation transition", () => {
  const first = dynamicsFromGrades(Array(10).fill(5), 0, 0, 100).resampledPoints;
  const second = dynamicsFromGrades([...Array(10).fill(-5), ...Array(10).fill(15)], 1, 1000, 900).resampledPoints;
  const result = calculateClimbingProfile({ resampledPoints: [...first, ...second] });
  assert.equal(result.status, "available");
  assert.equal(result.measuredUphillDistanceM, 2000);
  assert.deepEqual(Object.values(result.categories).map(({ distanceM }) => distanceM), [1000, 1000, 0]);
  const downhill = calculateGradientDistribution({ resampledPoints: [...first, ...second] }, "downhill");
  assert.equal(downhill.status, "available");
  assert.equal(downhill.measuredDistanceM, 1000);
  assert.deepEqual(Object.values(downhill.categories).map(({ distanceM }) => distanceM), [1000, 0, 0]);
});

test("flat, very short uphill, missing, invalid and widely gapped profiles fail safely", () => {
  assert.deepEqual(calculateClimbingProfile({ resampledPoints: [] }), { status: "unavailable", reason: "missing-smoothed-profile" });
  assert.deepEqual(calculateClimbingProfile(dynamicsFromGrades(Array(100).fill(0))), { status: "unavailable", reason: "insufficient-uphill-distance" });
  assert.deepEqual(calculateClimbingProfile(dynamicsFromGrades([1, 1, 1, 1])), { status: "unavailable", reason: "insufficient-uphill-distance" });
  assert.deepEqual(calculateGradientDistribution(dynamicsFromGrades(Array(100).fill(0)), "downhill"), { status: "unavailable", reason: "insufficient-downhill-distance" });
  assert.deepEqual(calculateGradientDistribution(dynamicsFromGrades([-20, -20, -20, -20]), "downhill"), { status: "unavailable", reason: "insufficient-downhill-distance" });
  assert.deepEqual(calculateClimbingProfile({ resampledPoints: [{ segmentIndex: 0, distanceM: 0, elevationM: 0, smoothedElevationM: Number.NaN }] }), { status: "unavailable", reason: "missing-smoothed-profile" });
  assert.deepEqual(calculateClimbingProfile({ resampledPoints: [
    { segmentIndex: 0, distanceM: 0, elevationM: 0, smoothedElevationM: 0 },
    { segmentIndex: 0, distanceM: 200, elevationM: 10, smoothedElevationM: 10 },
  ] }), { status: "unavailable", reason: "incomplete-smoothed-profile" });
});

test("Route Analysis shows an accessible two-direction Gradient Distribution near the route overview", async () => {
  const [view, component] = await Promise.all([
    readFile(new URL("./RouteAnalysisView.tsx", import.meta.url), "utf8"),
    readFile(new URL("./ClimbingProfile.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(view, /<ClimbingProfile routeDynamics=\{analysis\.routeDynamics\}/);
  assert.match(component, /<section aria-labelledby="gradient-distribution-title"/);
  assert.match(component, /Gradient Distribution/);
  assert.match(component, /Understand how steep the climbs and descents are/);
  assert.match(component, /useState<GradientDistributionDirection>\("uphill"\)/);
  assert.match(component, /useMemo\(\(\) => \(\{[\s\S]*?uphill: calculateGradientDistribution\(routeDynamics, "uphill"\)[\s\S]*?downhill: calculateGradientDistribution\(routeDynamics, "downhill"\)/);
  assert.match(component, /aria-label="Gradient direction"/);
  assert.match(component, /aria-pressed=\{direction === value\}/);
  assert.match(component, /role="progressbar"[\s\S]*aria-valuetext/);
  assert.match(component, /formatDistanceMeters\(profile\.categories\[key\]\.distanceM, units, 1\)/);
  assert.match(component, /\{percent\}% · \{distance\}/);
  assert.match(component, /distances are cumulative across the route/);
  assert.match(component, /Gentle/);
  assert.match(component, /Moderate/);
  assert.match(component, /Steep/);
  assert.match(component, /Percentages show the share of \{directionName\} distance/);
  assert.match(component, /<details[^>]*>[\s\S]*?<summary[^>]*>[\s\S]*?How gradients are calculated[\s\S]*?<\/summary>/);
  assert.doesNotMatch(component, /<details[^>]*open/);
  assert.match(component, /positive gradients; downhill distribution uses the absolute grade of intervals with negative gradients/);
  assert.match(component, /formatMethodDistance\(500, units\)/);
});
