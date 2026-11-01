import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { analyzeGpxRoute, GpxAnalysisError, parseGpxText } from "./gpxAnalysis.ts";
import {
  GpxUploadError,
  MAX_GPX_UPLOAD_BYTES,
  MAX_GPX_UPLOAD_TRACK_POINTS,
  parseRouteModeGpxText,
  readGpxUpload,
} from "./gpxUpload.ts";
import { RouteUploadRequestGate } from "./routeUploadRequestGate.ts";

const validGpx = `<?xml version="1.0"?><gpx><trk><name>Test loop</name><trkseg>
  <trkpt lat="45" lon="13"><ele>100</ele></trkpt>
  <trkpt lat="45.001" lon="13"><ele>120</ele></trkpt>
</trkseg></trk></gpx>`;

function file(name, text, overrides = {}) {
  return { name, size: Buffer.byteLength(text), text: async () => text, ...overrides };
}

test("normal GPX upload reads, validates and analyzes a supported route", async () => {
  const upload = await readGpxUpload(file("Ridge.GPX", validGpx));
  const analysis = analyzeGpxRoute(upload.parsed, upload.fallbackName);
  assert.equal(upload.fallbackName, "Ridge");
  assert.equal(analysis.name, "Test loop");
  assert.ok(analysis.metrics.distanceKm > 0);
  assert.ok(analysis.routeSections.length > 0);
});

test("a valid GPX XML document is accepted as either .gpx or .xml regardless of MIME type", async () => {
  const gpxFile = await readGpxUpload(file("route.gpx", validGpx, { type: "text/plain" }));
  const xmlFile = await readGpxUpload(file("route.xml", validGpx, { type: "application/xml" }));
  assert.equal(gpxFile.parsed.points.length, 2);
  assert.equal(xmlFile.parsed.points.length, 2);
  assert.equal(parseRouteModeGpxText(validGpx).points.length, 2);
});

test("invalid names and non-GPX XML are rejected without weakening content validation", async () => {
  await assert.rejects(readGpxUpload(file("route.txt", validGpx)), (error) => error instanceof GpxUploadError && error.code === "unsupported-file-name");
  await assert.rejects(readGpxUpload(file("route.xml", "<html>not a route</html>")), (error) => error instanceof GpxAnalysisError && error.code === "invalid-gpx");
  assert.throws(() => parseRouteModeGpxText("not XML"), (error) => error instanceof GpxAnalysisError && error.code === "invalid-gpx");
});

test("file-size limit is checked before reading and is documented by the upload contract", async () => {
  let read = false;
  await assert.rejects(readGpxUpload(file("large.gpx", "", { size: MAX_GPX_UPLOAD_BYTES + 1, text: async () => { read = true; return ""; } })), (error) => error instanceof GpxUploadError && error.code === "file-too-large");
  assert.equal(read, false);
  assert.equal(MAX_GPX_UPLOAD_BYTES, 20 * 1024 * 1024);
  assert.equal(MAX_GPX_UPLOAD_TRACK_POINTS, 100_000);
});

test("point-count limit rejects before materializing parsed route-point arrays", () => {
  const threePoints = `<gpx><trk><trkseg>${"<trkpt lat=\"45\" lon=\"13\"><ele>1</ele></trkpt>".repeat(3)}</trkseg></trk></gpx>`;
  assert.throws(() => parseGpxText(threePoints, { maxTrackPoints: 2 }), (error) => error instanceof GpxAnalysisError && error.code === "too-many-points");
  assert.throws(() => parseGpxText(validGpx, { maxTrackPoints: 0 }), RangeError);
});

test("request gate prevents overlap and ignores stale asynchronous completions", async () => {
  const gate = new RouteUploadRequestGate();
  const first = gate.begin();
  assert.equal(first, 1);
  assert.equal(gate.begin(), null);
  assert.equal(gate.finish(first), true);
  const second = gate.begin();
  assert.equal(second, 2);

  let resolveFirst;
  const firstWork = new Promise((resolve) => { resolveFirst = resolve; });
  let published = "";
  const staleCompletion = firstWork.then((value) => { if (gate.isCurrent(first)) published = value; });
  resolveFirst("old route");
  await staleCompletion;
  assert.equal(published, "");
  assert.equal(gate.isCurrent(second), true);
  gate.invalidate();
  assert.equal(gate.isCurrent(second), false);
  assert.equal(gate.finish(second), false);
});

test("Route Mode starts its gate before reading the selected file and checks identity before publishing", async () => {
  const source = await readFile(new URL("./RouteMode.tsx", import.meta.url), "utf8");
  const handler = source.slice(source.indexOf("async function handleFileChange"), source.indexOf("return (", source.indexOf("async function handleFileChange")));
  assert.ok(handler.indexOf("beginRouteRequest()") < handler.indexOf("readGpxUpload(file)"));
  assert.match(source, /disabled=\{isProcessing\}/);
  assert.match(source, /if \(requestGate\.current\.isCurrent\(requestId\)\)/);
  assert.match(source, /if \(requestGate\.current\.finish\(requestId\)\) setIsProcessing\(false\)/);
});
