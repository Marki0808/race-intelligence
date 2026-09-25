import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { istria110kRaceRecord } from "./istria110kData.ts";
import {
  analyzeGpxRoute,
  GpxAnalysisError,
  parseGpxText,
} from "./gpxAnalysis.ts";

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
  const analysis = analyzeGpxRoute(parseGpxText(gpxText));
  assert.deepEqual(analysis.metrics, istria110kRaceRecord.courseAnalysis);
  assert.equal(analysis.points.length, 5778);
});
