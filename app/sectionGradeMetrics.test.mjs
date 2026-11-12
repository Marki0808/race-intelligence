import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { calculateSectionGradeMetrics } from "./sectionGradeMetrics.ts";
import { analyzeGpxRoute, parseGpxText } from "./gpxAnalysis.ts";
import { buildCustomRouteSections, createCustomSectionPlan } from "./customRouteSections.ts";
import { calculateSectionGradientDistribution } from "./climbingProfileModel.ts";

function section(points, startDistanceM = points[0].distanceM, endDistanceM = points.at(-1).distanceM, segmentIndex = 0) {
  const at = (distanceM) => {
    const rightIndex = points.findIndex((point) => point.distanceM >= distanceM);
    const right = points[Math.max(1, rightIndex)];
    const left = points[Math.max(0, rightIndex - 1)];
    const ratio = (distanceM - left.distanceM) / (right.distanceM - left.distanceM);
    return { distanceM, elevationM: left.elevationM + (right.elevationM - left.elevationM) * ratio };
  };
  return {
    segmentIndex,
    startPosition: { distanceM: startDistanceM, segmentIndex },
    endPosition: { distanceM: endDistanceM, segmentIndex },
    elevationProfile: [at(startDistanceM), ...points.filter((point) => point.distanceM > startDistanceM && point.distanceM < endDistanceM), at(endDistanceM)],
  };
}

test("linear climbing and descending sections report separate distance-weighted average grades", () => {
  const climb = calculateSectionGradeMetrics(section(Array.from({ length: 11 }, (_, index) => ({ distanceM: index * 100, elevationM: index * 4 }))));
  assert.equal(climb.status, "available");
  assert.equal(climb.netGradePct, 4);
  assert.equal(climb.averageUphillGradePct, 4);
  assert.equal(climb.averageDownhillGradePct, null);
  assert.deepEqual(climb.steepestUphill100m, { gradePct: 4, startDistanceM: 0, endDistanceM: 100 });
  assert.deepEqual(climb.steepestUphill500m, { gradePct: 4, startDistanceM: 0, endDistanceM: 500 });
  assert.equal(climb.steepestDownhill100m, null);
  assert.equal(climb.steepestDownhill500m, null);

  const descentPoints = Array.from({ length: 11 }, (_, index) => ({ distanceM: index * 100, elevationM: 1000 - index * 8 }));
  const descent = calculateSectionGradeMetrics(section(descentPoints));
  assert.equal(descent.netGradePct, -8);
  assert.equal(descent.averageUphillGradePct, null);
  assert.equal(descent.averageDownhillGradePct, 8, "downhill average is reported as a magnitude and identified by its label");
  assert.equal(descent.steepestDownhill100m.gradePct, -8);
});

test("mixed sections keep net, uphill and downhill grades distinct and distance weighted", () => {
  const metrics = calculateSectionGradeMetrics(section([
    { distanceM: 0, elevationM: 0 },
    { distanceM: 100, elevationM: 10 },
    { distanceM: 200, elevationM: 20 },
    { distanceM: 300, elevationM: 10 },
    { distanceM: 400, elevationM: 0 },
  ]));
  assert.equal(metrics.status, "available");
  assert.equal(metrics.netGradePct, 0);
  assert.equal(metrics.averageUphillGradePct, 10);
  assert.equal(metrics.averageDownhillGradePct, 10);
  assert.ok(metrics.steepestUphill100m.startDistanceM >= 0);
  assert.ok(metrics.steepestUphill100m.endDistanceM <= 600);
  assert.ok(metrics.steepestDownhill100m.gradePct < 0);
});

test("100 m and 500 m windows interpolate boundaries exactly and remain inside the section", () => {
  const points = Array.from({ length: 9 }, (_, index) => ({ distanceM: index * 100, elevationM: index * 10 }));
  const metrics = calculateSectionGradeMetrics(section(points, 50, 650));
  assert.equal(metrics.status, "available");
  assert.deepEqual(metrics.steepestUphill100m, { gradePct: 10, startDistanceM: 50, endDistanceM: 150 });
  assert.deepEqual(metrics.steepestUphill500m, { gradePct: 10, startDistanceM: 50, endDistanceM: 550 });
  for (const key of ["steepestUphill100m", "steepestUphill500m", "steepestDownhill100m", "steepestDownhill500m"]) {
    const value = metrics[key];
    if (value) assert.ok(value.startDistanceM >= 50 && value.endDistanceM <= 650);
  }
  const short = calculateSectionGradeMetrics(section(points, 10, 90));
  assert.equal(short.steepestUphill100m, null);
  assert.equal(short.steepestUphill500m, null);
  assert.equal(short.steepestDownhill100m, null);
  assert.equal(short.steepestDownhill500m, null);
});

test("small smoothed changes below the meaningful threshold and flat sections do not get grade claims", () => {
  const noisy = Array.from({ length: 11 }, (_, index) => ({ distanceM: index * 100, elevationM: index % 2 ? 0.1 : 0 }));
  const metrics = calculateSectionGradeMetrics(section(noisy));
  assert.equal(metrics.averageUphillGradePct, null);
  assert.equal(metrics.averageDownhillGradePct, null);
  assert.equal(metrics.steepestUphill100m, null);
  assert.equal(metrics.steepestDownhill100m, null);
  const flat = calculateSectionGradeMetrics(section(Array.from({ length: 7 }, (_, index) => ({ distanceM: index * 100, elevationM: 300 }))));
  assert.equal(flat.netGradePct, 0);
  assert.equal(flat.averageUphillGradePct, null);
  assert.equal(flat.averageDownhillGradePct, null);
});

test("repeated identical-distance samples are collapsed while conflicting duplicates and component gaps fail closed", () => {
  const repeated = section([{ distanceM: 0, elevationM: 0 }, { distanceM: 100, elevationM: 5 }, { distanceM: 100, elevationM: 5 }, { distanceM: 200, elevationM: 10 }]);
  assert.equal(calculateSectionGradeMetrics(repeated).status, "available");
  const conflicting = section([{ distanceM: 0, elevationM: 0 }, { distanceM: 100, elevationM: 5 }, { distanceM: 100, elevationM: 8 }, { distanceM: 200, elevationM: 10 }]);
  assert.deepEqual(calculateSectionGradeMetrics(conflicting), { status: "unavailable", reason: "invalid-or-incomplete-profile" });
  const gap = section([{ distanceM: 0, elevationM: 0 }, { distanceM: 100, elevationM: 5 }, { distanceM: 1000, elevationM: 50 }]);
  assert.deepEqual(calculateSectionGradeMetrics(gap), { status: "unavailable", reason: "invalid-or-incomplete-profile" });
  const crossComponent = section([{ distanceM: 0, elevationM: 0 }, { distanceM: 100, elevationM: 5 }, { distanceM: 200, elevationM: 10 }]);
  crossComponent.endPosition.segmentIndex = 1;
  assert.deepEqual(calculateSectionGradeMetrics(crossComponent), { status: "unavailable", reason: "invalid-or-incomplete-profile" });
});

test("automatic and custom section objects use the same smoothed profile metric calculation", async () => {
  const trackPoints = Array.from({ length: 21 }, (_, index) => {
    const distanceM = index * 100;
    const elevationM = distanceM <= 1000 ? 100 + distanceM * 0.08 : 180 - (distanceM - 1000) * 0.03;
    return `<trkpt lat="${45 + distanceM / 111000}" lon="13"><ele>${elevationM}</ele></trkpt>`;
  }).join("");
  const analysis = analyzeGpxRoute(parseGpxText(`<gpx><trk><trkseg>${trackPoints}</trkseg></trk></gpx>`));
  assert.ok(analysis);
  const customPlan = { ...createCustomSectionPlan(), boundaries: [{ id: "custom-point-1", distanceKm: "1.000", name: "Boundary" }] };
  const custom = buildCustomRouteSections(analysis, customPlan);
  assert.equal(custom.available, true);
  for (const generatedSection of [...analysis.routeSections, ...custom.sections]) {
    const metrics = calculateSectionGradeMetrics(generatedSection);
    assert.equal(metrics.status, "available");
    assert.ok(Number.isFinite(metrics.netGradePct));
    for (const window of [metrics.steepestUphill100m, metrics.steepestUphill500m, metrics.steepestDownhill100m, metrics.steepestDownhill500m].filter(Boolean)) {
      assert.ok(window.startDistanceM >= generatedSection.startPosition.distanceM);
      assert.ok(window.endDistanceM <= generatedSection.endPosition.distanceM);
    }
  }
  assert.ok([...analysis.routeSections, ...custom.sections].some((generatedSection) =>
    calculateSectionGradientDistribution(generatedSection, "uphill").status === "available"));
  assert.ok([...analysis.routeSections, ...custom.sections].some((generatedSection) =>
    calculateSectionGradientDistribution(generatedSection, "downhill").status === "available"));
  const source = await readFile(new URL("./RouteSectionBrowser.tsx", import.meta.url), "utf8");
  assert.match(source, /calculateSectionGradeMetrics\(section\)/, "one presenter computes metrics for all section kinds");
  assert.match(source, /Average uphill grade/);
  assert.match(source, /Average downhill grade/);
  assert.doesNotMatch(source, />Net grade</);
  assert.doesNotMatch(source, /<details[^>]*>/, "sustained grade values are visible without a collapsed disclosure");
  assert.match(source, /\{!isAidStationSection && <SectionGradientDistribution section=\{section\} \/>\}/);
  const distribution = await readFile(new URL("./SectionGradientDistribution.tsx", import.meta.url), "utf8");
  assert.match(distribution, /calculateSectionGradientDistribution\(section, direction\)/);
  assert.match(distribution, /defaultSectionGradientDirection\(section\.dominantRhythm\)/);
  assert.match(distribution, /sectionIdentity/);
  assert.match(distribution, /aria-pressed=\{direction === value\}/);
});

test("automatic sections interpolate exact non-grid boundaries without weakening incomplete-profile checks", () => {
  const trackPoints = Array.from({ length: 201 }, (_, index) => {
    const distanceM = index * 100;
    const distanceKm = distanceM / 1000;
    const elevationM = distanceKm <= 10 ? 100 + distanceKm * 30 : 400 - (distanceKm - 10) * 30;
    return { latitude: 45 + distanceM / 111_000, longitude: 14, elevationM, segmentIndex: 0 };
  });
  const analysis = analyzeGpxRoute({ points: trackPoints });
  assert.ok(analysis.routeSections.length > 0);

  for (const generatedSection of analysis.routeSections) {
    const profile = generatedSection.elevationProfile;
    assert.equal(profile[0].distanceM, generatedSection.startPosition.distanceM);
    assert.equal(profile.at(-1).distanceM, generatedSection.endPosition.distanceM);
    assert.ok(profile.every((point) => point.segmentIndex === undefined || point.segmentIndex === generatedSection.segmentIndex));
    assert.equal(calculateSectionGradeMetrics(generatedSection).status, "available");
  }
  assert.ok(analysis.routeSections.some((generatedSection) =>
    calculateSectionGradientDistribution(generatedSection, "downhill").status === "available"));

  const incomplete = {
    segmentIndex: 0,
    startPosition: { distanceM: 0, segmentIndex: 0 },
    endPosition: { distanceM: 1_000, segmentIndex: 0 },
    elevationProfile: [{ distanceM: 0, elevationM: 0 }, { distanceM: 1_000, elevationM: 100 }],
  };
  incomplete.elevationProfile[1].distanceM = 800;
  assert.deepEqual(calculateSectionGradeMetrics(incomplete), { status: "unavailable", reason: "invalid-or-incomplete-profile" });
});
