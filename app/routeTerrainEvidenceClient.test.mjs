import assert from "node:assert/strict";
import test from "node:test";
import { requestRouteTerrainEvidence } from "./routeTerrainEvidenceClient.ts";

const points = [
  { latitude: 45, longitude: 13, distanceM: 0, segmentIndex: 0 },
  { latitude: 45.001, longitude: 13, distanceM: 100, segmentIndex: 0 },
  { latitude: 46, longitude: 14, distanceM: 100, segmentIndex: 1 },
  { latitude: 46.001, longitude: 14, distanceM: 200, segmentIndex: 1 },
];

test("shared terrain client posts selected analysis points to the existing bounded endpoint with components", async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl;
  let payload;
  globalThis.fetch = async (url, init) => {
    requestedUrl = url;
    payload = JSON.parse(init.body);
    return Response.json({ source: { type: "osm", name: "OpenStreetMap" }, availability: "not-found", segments: [], matchedRoutePercent: 0, attribution: "© OpenStreetMap contributors" });
  };
  try {
    const result = await requestRouteTerrainEvidence(points);
    assert.equal(result.status, "ready");
    assert.equal(requestedUrl, "/api/geo-enrichment");
    assert.deepEqual(payload.points.map(({ segmentIndex }) => segmentIndex), [0, 0, 1, 1]);
    assert.equal(payload.points[1].distanceM, 100);
    assert.equal(result.data.availability, "not-found");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("shared terrain client returns controlled unavailable evidence for API failure, malformed and provider-unavailable responses", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  for (const response of [
    new Response(null, { status: 504 }),
    new Response("not-json", { status: 200 }),
    Response.json({ source: { type: "osm", name: "OpenStreetMap" }, availability: "unknown", segments: [], matchedRoutePercent: 0, attribution: "© OpenStreetMap contributors" }),
  ]) {
    globalThis.fetch = async () => response;
    const result = await requestRouteTerrainEvidence(points);
    assert.equal(result.status, "unavailable");
    assert.equal(result.data.availability, "unknown");
    assert.equal(result.data.segments.length, 0);
  }
});
