import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { istria110kRaceRecord } from "./istria110kData.ts";
import {
  analyzeGpxRoute,
  GpxAnalysisError,
  parseGpxText,
  groupAnalyzedPointsBySegment,
} from "./gpxAnalysis.ts";
import { createRouteFingerprint } from "./routeFingerprint.ts";
import { createAnalysisInputFingerprint } from "./analysisInputFingerprint.ts";
import { numberRouteSectionsForDisplay } from "./routeSectionPresentation.ts";
import { ROUTE_ANALYSIS_VERSION } from "./routePersistence.ts";

test("route analysis calculates distance, gain, loss, high and low points", () => {
  const result = analyzeGpxRoute({
    name: "Test trail",
    points: [
      { latitude: 45, longitude: 13, elevationM: 100 },
      { latitude: 45.001, longitude: 13, elevationM: 220 },
      { latitude: 45.002, longitude: 13, elevationM: 150 },
      { latitude: 45.003, longitude: 13, elevationM: 270 },
    ],
  });

  assert.equal(result.name, "Test trail");
  assert.ok(result.metrics.distanceKm > 0);
  assert.equal(result.metrics.elevationGainM, 240);
  assert.equal(result.metrics.elevationLossM, 70);
  assert.equal(result.metrics.highestPointM, 270);
  assert.equal(result.metrics.lowestPointM, 100);
  assert.ok(result.majorClimbs.length > 0);
  assert.ok(result.majorDescents.length > 0);
  assert.ok(result.sections.length > 0);
  assert.ok(result.keyMoments.every((moment) => moment.source === "GPX-derived"));
  assert.match(result.courseCharacter.terrain, /Unknown/);
  assert.match(result.courseCharacter.technicality, /Unknown/);
});

test("track parser retains empty, singleton, and multi-point track segments", () => {
  const parsed = parseGpxText(`<gpx><trk><trkseg><trkpt lat="45" lon="13"><ele>1</ele></trkpt><trkpt lat="45.001" lon="13"><ele>2</ele></trkpt></trkseg><trkseg/><trkseg><trkpt lat="46" lon="14"><ele>9</ele></trkpt></trkseg></trk></gpx>`);
  assert.deepEqual(parsed.segments.map((segment) => segment.length), [2, 0, 1]);
  assert.deepEqual(parsed.points.map((point) => point.segmentIndex), [0, 0, 2]);
});

test("empty and singleton-only track components are preserved but fail analysis safely", () => {
  const parsed = parseGpxText(`<gpx><trk><trkseg/><trkseg><trkpt lat="45" lon="13"><ele>100</ele></trkpt></trkseg><trkseg/></trk></gpx>`);
  assert.deepEqual(parsed.segments.map((segment) => segment.length), [0, 1, 0]);
  assert.throws(
    () => analyzeGpxRoute(parsed),
    (error) => error instanceof GpxAnalysisError && error.code === "no-track-points",
  );
});

test("short GPX routes across flat, gentle-climb, and gentle-descent profiles analyze safely end to end", async (t) => {
  const distancesM = [50, 100, 300, 500, 1000];
  const profiles = ["flat", "gentle climb", "gentle descent"];

  for (const distanceM of distancesM) {
    for (const profile of profiles) {
      await t.test(`${distanceM} m ${profile}`, () => {
        const parsed = parseGpxText(makeShortRouteGpx(distanceM, profile, 11));
        const analysis = analyzeGpxRoute(parsed);
        const expectedDeltaM = profile === "flat" ? 0 : (distanceM / 1000) * 5 * (profile === "gentle climb" ? 1 : -1);
        const allowedRhythms = profile === "flat" ? ["flat"] : profile === "gentle climb" ? ["flat", "climb"] : ["flat", "descent"];

        assert.equal(parsed.segments.length, 1);
        assert.equal(parsed.segments[0].length, 11);
        assert.ok(Math.abs(analysis.metrics.distanceKm - distanceM / 1000) <= 0.005);
        assert.equal(analysis.metrics.elevationGainM, Math.round(Math.max(0, expectedDeltaM)));
        assert.equal(analysis.metrics.elevationLossM, Math.round(Math.max(0, -expectedDeltaM)));
        assert.equal(analysis.metrics.highestPointM, Math.max(100, 100 + expectedDeltaM));
        assert.equal(analysis.metrics.lowestPointM, Math.min(100, 100 + expectedDeltaM));
        assert.ok(Number.isFinite(analysis.routeDynamics.totalDistanceKm));
        assert.ok(analysis.routeDynamics.samples.every((sample) => Number.isFinite(sample.distanceM) && Number.isFinite(sample.medium.verticalIntensityMPerKm)));
        assert.ok(analysis.routeDynamics.events.every((event) =>
          event.segmentIndex === 0 && event.startKm >= 0 && event.endKm >= event.startKm && event.endKm <= analysis.metrics.distanceKm + 0.01 &&
          allowedRhythms.includes(event.rhythm),
        ));
        assert.ok(analysis.routeSections.every((section) =>
          section.segmentIndex === 0 && section.startPosition.segmentIndex === 0 && section.endPosition.segmentIndex === 0 &&
          Number.isFinite(section.elevationMinM) && Number.isFinite(section.elevationMaxM) &&
          section.startKm >= 0 && section.endKm >= section.startKm && section.endKm <= analysis.metrics.distanceKm + 0.01 &&
          allowedRhythms.includes(section.dominantRhythm),
        ));
        assert.ok(analysis.keyMoments.every((moment) =>
          moment.segmentIndex === 0 && moment.focusStartKm >= 0 && moment.focusEndKm >= moment.focusStartKm && moment.focusEndKm <= analysis.metrics.distanceKm + 0.01,
        ));
        assert.ok(analysis.keyMoments.every((moment) => moment.source === "GPX-derived"));
      });
    }
  }
});

test("sparse endpoint-only short GPX routes analyze without fabricated transitions", async (t) => {
  for (const distanceM of [300, 1000]) {
    for (const profile of ["flat", "gentle climb", "gentle descent"]) {
      await t.test(`${distanceM} m sparse ${profile}`, () => {
        const analysis = analyzeGpxRoute(parseGpxText(makeShortRouteGpx(distanceM, profile, 2)));
        assert.equal(analysis.points.length, 2);
        assert.ok(Math.abs(analysis.metrics.distanceKm - distanceM / 1000) <= 0.005);
        assert.ok(analysis.routeDynamics.events.every((event) => event.segmentIndex === 0 && event.startPosition.segmentIndex === 0 && event.endPosition.segmentIndex === 0));
        assert.ok(analysis.routeSections.every((section) => section.segmentIndex === 0 && section.startPosition.segmentIndex === 0 && section.endPosition.segmentIndex === 0));
        assert.ok(analysis.keyMoments.every((moment) => moment.segmentIndex === 0));
      });
    }
  }
});

test("two short disconnected GPX segments do not create gap distance, elevation changes, dynamics, or crossing sections", () => {
  const parsed = parseGpxText(`<gpx><trk><trkseg>
    <trkpt lat="45" lon="13"><ele>100</ele></trkpt>
    <trkpt lat="45" lon="13.000635"><ele>110</ele></trkpt>
    <trkpt lat="45" lon="13.00127"><ele>120</ele></trkpt>
  </trkseg><trkseg>
    <trkpt lat="46" lon="14"><ele>900</ele></trkpt>
    <trkpt lat="46" lon="14.000635"><ele>890</ele></trkpt>
    <trkpt lat="46" lon="14.00127"><ele>880</ele></trkpt>
  </trkseg></trk></gpx>`);
  const analysis = analyzeGpxRoute(parsed);

  assert.deepEqual(parsed.segments.map((segment) => segment.length), [3, 3]);
  assert.equal(analysis.segments.length, 2);
  assert.ok(Math.abs(analysis.metrics.distanceKm - 0.2) < 0.01);
  assert.equal(analysis.metrics.elevationGainM, 20);
  assert.equal(analysis.metrics.elevationLossM, 20);
  assert.equal(analysis.points[2].distanceM, analysis.points[3].distanceM);
  assert.ok(analysis.routeDynamics.events.every((event) => event.startPosition.segmentIndex === event.segmentIndex && event.endPosition.segmentIndex === event.segmentIndex));
  assert.ok(analysis.routeSections.every((section) => section.startPosition.segmentIndex === section.segmentIndex && section.endPosition.segmentIndex === section.segmentIndex));
  assert.ok(analysis.keyMoments.every((moment) => moment.focusStartPosition.segmentIndex === moment.segmentIndex && moment.focusEndPosition.segmentIndex === moment.segmentIndex));
});

function makeShortRouteGpx(distanceM, profile, pointCount) {
  const latitude = 45;
  const earthRadiusM = 6_371_000;
  const legDistanceM = distanceM / (pointCount - 1);
  const deltaLongitudeRadians = 2 * Math.asin(Math.sin(legDistanceM / (2 * earthRadiusM)) / Math.cos(latitude * Math.PI / 180));
  const deltaLongitudeDegrees = deltaLongitudeRadians * 180 / Math.PI;
  const totalElevationChangeM = profile === "flat" ? 0 : (distanceM / 1000) * 5 * (profile === "gentle climb" ? 1 : -1);
  const points = Array.from({ length: pointCount }, (_, index) => {
    const longitude = 13 + deltaLongitudeDegrees * index;
    const elevation = 100 + totalElevationChangeM * index / (pointCount - 1);
    return `<trkpt lat="${latitude}" lon="${longitude}"><ele>${elevation}</ele></trkpt>`;
  }).join("");
  return `<gpx version="1.1"><trk><trkseg>${points}</trkseg></trk></gpx>`;
}

test("disconnected track segments add no connector distance or elevation change", () => {
  const parsed = parseGpxText(`<gpx><trk><trkseg><trkpt lat="45" lon="13"><ele>100</ele></trkpt><trkpt lat="45.009" lon="13"><ele>150</ele></trkpt></trkseg><trkseg><trkpt lat="46" lon="14"><ele>9000</ele></trkpt><trkpt lat="46.009" lon="14"><ele>8940</ele></trkpt></trkseg></trk></gpx>`);
  const analysis = analyzeGpxRoute(parsed);
  assert.equal(analysis.segments.length, 2);
  assert.equal(analysis.metrics.distanceKm, 2);
  assert.equal(analysis.metrics.elevationGainM, 50);
  assert.equal(analysis.metrics.elevationLossM, 60);
  assert.equal(analysis.points[1].distanceM, analysis.points[2].distanceM);
  assert.equal(analysis.points[1].segmentIndex, 0);
  assert.equal(analysis.points[2].segmentIndex, 1);
  assert.equal(analysis.metrics.highestPointM, 9000);
  assert.ok(analysis.routeDynamics.resampledPoints.every((point) => Number.isInteger(point.segmentIndex)));
  assert.ok(analysis.routeDynamics.events.every((event) => event.startKm >= analysis.segments[event.segmentIndex].startDistanceM / 1000 && event.endKm <= analysis.segments[event.segmentIndex].endDistanceM / 1000));
  assert.ok(analysis.routeSections.every((section) => section.startPosition.segmentIndex === section.endPosition.segmentIndex));
  assert.deepEqual(groupAnalyzedPointsBySegment(analysis.points).map((segment) => segment.length), [2, 2]);
  assert.ok(analysis.keyMoments.some((moment) => moment.title === "Highest point" && moment.segmentIndex === 1));
});

test("identical and nearby segment endpoints are still distinct path components", () => {
  const analysis = analyzeGpxRoute({ segments: [
    [{ latitude: 45, longitude: 13, elevationM: 10 }, { latitude: 45.001, longitude: 13, elevationM: 20 }],
    [{ latitude: 45.001, longitude: 13, elevationM: 900 }, { latitude: 45.002, longitude: 13, elevationM: 890 }],
  ] });
  assert.equal(analysis.points[1].distanceM, analysis.points[2].distanceM);
  assert.equal(analysis.points[1].segmentIndex, 0);
  assert.equal(analysis.points[2].segmentIndex, 1);
  assert.equal(analysis.metrics.elevationGainM, 10);
  assert.equal(analysis.metrics.elevationLossM, 10);
});

test("Route Dynamics and Route Sections analyze each sustained track segment independently", () => {
  const makeSegment = (baseElevationM, elevationDeltaM) => Array.from({ length: 81 }, (_, index) => ({
    latitude: 0,
    longitude: index * 100 / 111_320,
    elevationM: baseElevationM + elevationDeltaM * index / 80,
  }));
  const analysis = analyzeGpxRoute({ segments: [makeSegment(100, 500), makeSegment(900, -450)] });

  assert.ok(analysis.routeDynamics.samples.some((sample) => sample.segmentIndex === 0));
  assert.ok(analysis.routeDynamics.samples.some((sample) => sample.segmentIndex === 1));
  assert.ok(analysis.routeSections.some((section) => section.segmentIndex === 0));
  assert.ok(analysis.routeSections.some((section) => section.segmentIndex === 1));
  assert.ok(analysis.routeSections.every((section) => section.startPosition.segmentIndex === section.endPosition.segmentIndex));
  assert.ok(analysis.metrics.distanceKm > 15.9 && analysis.metrics.distanceKm < 16.1);
  assert.equal(analysis.metrics.elevationGainM, 500);
  assert.equal(analysis.metrics.elevationLossM, 450);
});

test("multi-segment Route Sections keep segment identity and use globally sequential display ordinals", () => {
  const segment = (latitude, startElevationM) => Array.from({ length: 5 }, (_, index) => ({
    latitude,
    longitude: 15.9 + index * 0.0065,
    elevationM: startElevationM + index * 5,
  }));
  const analysis = analyzeGpxRoute({ segments: [segment(45.8, 120), segment(46, 820)] });

  assert.equal(analysis.routeSections.length, 2);
  assert.deepEqual(analysis.routeSections.map((section) => section.segmentIndex), [0, 1]);
  assert.ok(analysis.routeSections.every((section) => section.startPosition.segmentIndex === section.endPosition.segmentIndex));
  assert.deepEqual(numberRouteSectionsForDisplay(analysis.routeSections).map(({ ordinal }) => ordinal), [1, 2]);
  assert.deepEqual(numberRouteSectionsForDisplay(analysis.routeSections).map(({ section }) => section.segmentIndex), [0, 1]);
});

test("route name falls back neutrally when the GPX has no name", () => {
  const result = analyzeGpxRoute({
    points: [
      { latitude: 45, longitude: 13, elevationM: 1 },
      { latitude: 45.001, longitude: 13, elevationM: 2 },
    ],
  });
  assert.equal(result.name, "Uploaded route");
});

test("GPX parsing reports invalid XML and an empty track without throwing an opaque error", () => {
  assert.throws(
    () => parseGpxText("not a GPX file"),
    (error) => error instanceof GpxAnalysisError && error.code === "invalid-gpx",
  );
  assert.throws(
    () => parseGpxText('<gpx version="1.1"></gpx>'),
    (error) => error instanceof GpxAnalysisError && error.code === "no-track-points",
  );
});

test("GPX parsing rejects missing elevation and multiple tracks", () => {
  const missingElevation = `<?xml version="1.0"?><gpx><trk><trkseg>
    <trkpt lat="45" lon="13"><ele>10</ele></trkpt>
    <trkpt lat="45.001" lon="13"></trkpt>
  </trkseg></trk></gpx>`;
  assert.throws(
    () => parseGpxText(missingElevation),
    (error) => error instanceof GpxAnalysisError && error.code === "insufficient-elevation",
  );

  const multipleTracks = `<?xml version="1.0"?><gpx>
    <trk><trkseg><trkpt lat="45" lon="13"><ele>1</ele></trkpt></trkseg></trk>
    <trk><trkseg><trkpt lat="45.001" lon="13"><ele>2</ele></trkpt></trkseg></trk>
  </gpx>`;
  assert.throws(
    () => parseGpxText(multipleTracks),
    (error) => error instanceof GpxAnalysisError && error.code === "multiple-tracks",
  );
});

test("GPX route points and metadata names are supported", () => {
  const routeXml = `<?xml version="1.0"?><gpx xmlns="http://www.topografix.com/GPX/1/1">
    <metadata><name>Ridge &amp; valley</name></metadata>
    <rte><name>Alternative route title</name>
      <rtept lat="45" lon="13"><ele>100</ele></rtept>
      <rtept lat="45.001" lon="13"><ele>120</ele></rtept>
    </rte>
  </gpx>`;
  const parsed = parseGpxText(routeXml);
  assert.equal(parsed.name, "Ridge & valley");
  assert.equal(parsed.points.length, 2);
  assert.equal(analyzeGpxRoute(parsed).name, "Ridge & valley");
});

test("multiple GPX routes without a track remain rejected", () => {
  const multipleRoutes = `<gpx>
    <rte><rtept lat="45" lon="13"><ele>100</ele></rtept><rtept lat="45.001" lon="13"><ele>120</ele></rtept></rte>
    <rte><rtept lat="46" lon="14"><ele>300</ele></rtept><rtept lat="46.001" lon="14"><ele>320</ele></rtept></rte>
  </gpx>`;
  assert.throws(
    () => parseGpxText(multipleRoutes),
    (error) => error instanceof GpxAnalysisError && error.code === "multiple-tracks",
  );
});

test("invalid points and routes are rejected instead of receiving invented fallback values", () => {
  assert.throws(
    () => analyzeGpxRoute({ points: [] }),
    (error) => error instanceof GpxAnalysisError && error.code === "no-track-points",
  );
  assert.throws(
    () =>
      analyzeGpxRoute({
        points: [
          { latitude: 95, longitude: 13, elevationM: 1 },
          { latitude: 95, longitude: 13, elevationM: 2 },
        ],
      }),
    (error) => error instanceof GpxAnalysisError && error.code === "invalid-coordinate",
  );
  assert.throws(
    () =>
      analyzeGpxRoute({
        points: [
          { latitude: 45, longitude: 13, elevationM: 1 },
          { latitude: 45, longitude: 13, elevationM: 2 },
        ],
      }),
    (error) => error instanceof GpxAnalysisError && error.code === "invalid-route",
  );
});

test("the shared engine reproduces the Istria race GPX metrics as a regression check", async () => {
  const gpxText = await readFile(
    new URL("../public/ISTRIA_110K_2027.gpx", import.meta.url),
    "utf8",
  );
  const parsed = parseGpxText(gpxText);
  const analysis = analyzeGpxRoute(parsed);
  assert.deepEqual(analysis.metrics, istria110kRaceRecord.courseAnalysis);
  assert.equal(analysis.points.length, 5778);
  assert.equal(analysis.segments.length, 1);
  assert.equal(analysis.segments[0].points.length, 5778);
  const fingerprint = await createRouteFingerprint(parsed.segments.map((segment) => segment.map(({ latitude, longitude }) => ({ latitude, longitude }))));
  const analysisInput = await createAnalysisInputFingerprint(parsed.segments);
  assert.equal(fingerprint.routeFingerprintVersion, 2);
  assert.match(fingerprint.routeFingerprint, /^route-v2-sha256-[a-f0-9]{64}$/);
  assert.match(analysisInput, /^analysis-input-v2-sha256-[a-f0-9]{64}$/);
  assert.equal(ROUTE_ANALYSIS_VERSION, 2);
});
