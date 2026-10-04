import assert from "node:assert/strict";
import test from "node:test";
import {
  lookupMapillaryTerrainProof,
  matchMapillaryImages,
  parseMapillaryImages,
  validateMapillarySections,
} from "./mapillaryTerrainProof.ts";
import { POST as postMapillary } from "./api/mapillary/route.ts";
import { buildMapillaryRequests } from "./routeMapillaryRequests.ts";
import { analyzeGpxRoute } from "./gpxAnalysis.ts";

const section = {
  id: "section-a",
  startDistanceKm: 0,
  endDistanceKm: 0.2,
  points: [
    { latitude: 45, longitude: 14, distanceM: 0 },
    { latitude: 45, longitude: 14.001, distanceM: 100 },
    { latitude: 45, longitude: 14.002, distanceM: 200 },
  ],
};

test("Mapillary requests retain section path identity at equal-kilometer segment boundaries", () => {
  const analysis = analyzeGpxRoute({ segments: [
    [{ latitude: 45, longitude: 13, elevationM: 100 }, { latitude: 45, longitude: 13.01, elevationM: 120 }],
    [{ latitude: 46, longitude: 14, elevationM: 900 }, { latitude: 46, longitude: 14.01, elevationM: 880 }],
  ] });
  const sections = analysis.segments.map((segment, index) => ({
    id: `path-${index}`,
    segmentIndex: index,
    startKm: segment.startDistanceM / 1000,
    endKm: segment.endDistanceM / 1000,
  }));
  const requests = buildMapillaryRequests(sections, analysis.points);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests.map((request) => request.segmentIndex), [0, 1]);
  assert.ok(requests.every((request) => request.points.every((point) => point.segmentIndex === request.segmentIndex)));
});

test("Mapillary API retains nonzero segment identity through validation and image matching", async (context) => {
  const previousToken = process.env.MAPILLARY_ACCESS_TOKEN;
  const originalFetch = globalThis.fetch;
  process.env.MAPILLARY_ACCESS_TOKEN = "deterministic-test-token";
  const requests = [];
  globalThis.fetch = async (input) => {
    requests.push(String(input));
    return Response.json({ data: [image("segment-one-image", 14, { geometry: { type: "Point", coordinates: [14, 46] } })] });
  };
  context.after(() => {
    globalThis.fetch = originalFetch;
    if (previousToken === undefined) delete process.env.MAPILLARY_ACCESS_TOKEN;
    else process.env.MAPILLARY_ACCESS_TOKEN = previousToken;
  });

  const response = await postMapillary(new Request("http://localhost/api/mapillary", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sections: [{
      id: "segment-one-section",
      segmentIndex: 1,
      startDistanceKm: 10,
      endDistanceKm: 10.2,
      points: [
        { latitude: 46, longitude: 13.999, distanceM: 10_000, segmentIndex: 1 },
        { latitude: 46, longitude: 14.001, distanceM: 10_200, segmentIndex: 1 },
      ],
    }] }),
  }));
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(requests.length, 2);
  assert.equal(body.sections[0].availability, "available");
  assert.equal(body.sections[0].images[0].id, "segment-one-image");
  assert.equal(body.sections[0].images[0].segmentIndex, 1);
});

test("Mapillary rejects mixed-segment request points before provider work", async (context) => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return Response.json({ data: [] }); };
  context.after(() => { globalThis.fetch = originalFetch; });
  const response = await postMapillary(new Request("http://localhost/api/mapillary", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sections: [{
      id: "mixed-section",
      segmentIndex: 1,
      startDistanceKm: 10,
      endDistanceKm: 10.2,
      points: [
        { latitude: 46, longitude: 13.999, distanceM: 10_000, segmentIndex: 1 },
        { latitude: 45, longitude: 14, distanceM: 10_000, segmentIndex: 0 },
      ],
    }] }),
  }));
  assert.equal(response.status, 400);
  assert.equal(calls, 0);
});

test("legacy omitted point indexes normalize to their nonzero containing segment", () => {
  const validated = validateMapillarySections({ sections: [{
    id: "legacy-segment-one",
    segmentIndex: 1,
    startDistanceKm: 10,
    endDistanceKm: 10.2,
    points: [
      { latitude: 46, longitude: 13.999, distanceM: 10_000 },
      { latitude: 46, longitude: 14.001, distanceM: 10_200 },
    ],
  }] });
  assert.equal(validated[0].segmentIndex, 1);
  assert.deepEqual(validated[0].points.map((point) => point.segmentIndex), [1, 1]);
});

test("Mapillary rejects invalid section and point segment indexes", () => {
  assert.equal(validateMapillarySections({ sections: [{ ...section, segmentIndex: -1 }] }), null);
  assert.equal(validateMapillarySections({ sections: [{ ...section, points: section.points.map((point, index) => ({ ...point, segmentIndex: index === 0 ? 0.5 : 0 })) }] }), null);
});

function image(id, longitude, extras = {}) {
  return {
    id,
    geometry: { type: "Point", coordinates: [longitude, 45] },
    captured_at: 1_700_000_000_000,
    sequence: "sequence-1",
    thumb_1024_url: `https://images.mapillary.com/${id}/thumb.jpg`,
    ...extras,
  };
}

test("normalizes actual Mapillary image fields and constructs the official image link", () => {
  const [normalized] = parseMapillaryImages({ data: [image("img-1", 14.001)] });
  assert.equal(normalized.id, "img-1");
  assert.equal(normalized.latitude, 45);
  assert.equal(normalized.longitude, 14.001);
  assert.equal(normalized.capturedAt, 1_700_000_000_000);
  assert.equal(normalized.sequenceId, "sequence-1");
  assert.equal(normalized.thumbnailUrl, "https://images.mapillary.com/img-1/thumb.jpg");
  assert.equal(normalized.sourceUrl, "https://www.mapillary.com/app/?pKey=img-1");
});

test("matches points to their route position and rejects unrelated nearby imagery", () => {
  const parsed = parseMapillaryImages({ data: [image("near", 14.001), image("far", 14.003)] });
  const matches = matchMapillaryImages(parsed, section.points);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].id, "near");
  assert.ok(Math.abs(matches[0].distanceAlongRouteKm - 0.1) < 0.001);
});

test("Mapillary matching never interpolates across a disconnected track-segment gap", () => {
  const points = [
    { latitude: 45, longitude: 12.999, distanceM: 0, segmentIndex: 0 },
    { latitude: 45, longitude: 13, distanceM: 80, segmentIndex: 0 },
    { latitude: 45, longitude: 13.002, distanceM: 80, segmentIndex: 1 },
    { latitude: 45, longitude: 13.003, distanceM: 160, segmentIndex: 1 },
  ];
  const parsed = parseMapillaryImages({ data: [image("gap-image", 13.001)] });
  assert.deepEqual(matchMapillaryImages(parsed, points), []);
});

test("representative selection reduces near duplicates and stays deterministic", () => {
  const parsed = parseMapillaryImages({
    data: [
      image("a", 14.0001), image("b", 14.0002), image("c", 14.0008),
      image("d", 14.0015, { sequence: "sequence-2" }), image("e", 14.002),
    ],
  });
  const first = matchMapillaryImages(parsed, section.points);
  const second = matchMapillaryImages([...parsed].reverse(), section.points);
  assert.deepEqual(first.map((item) => item.id), second.map((item) => item.id));
  assert.ok(first.every((item, index) => index === 0 || (item.distanceAlongRouteKm - first[index - 1].distanceAlongRouteKm) * 1000 >= 50));
  assert.ok(first.filter((item) => item.sequenceId === "sequence-1").length <= 2);
});

test("no token returns unknown per section without attempting an API call", async () => {
  let calls = 0;
  const data = await lookupMapillaryTerrainProof([section], undefined, async () => { calls += 1; throw new Error("must not call"); });
  assert.equal(calls, 0);
  assert.equal(data.sections[0].availability, "unknown");
  assert.match(data.sections[0].note, /not configured/i);
});

test("API errors become unknown while successful empty responses become not-found", async () => {
  const failed = await lookupMapillaryTerrainProof([section], "server-token", async () => new Response("", { status: 503 }));
  assert.equal(failed.sections[0].availability, "unknown");
  const malformed = await lookupMapillaryTerrainProof([section], "server-token", async () => Response.json({ error: "invalid token" }));
  assert.equal(malformed.sections[0].availability, "unknown");
  const empty = await lookupMapillaryTerrainProof([section], "server-token", async () => Response.json({ data: [] }));
  assert.equal(empty.sections[0].availability, "not-found");
});

test("imagery and availability remain section-specific", async () => {
  const other = { ...section, id: "section-b", points: section.points.map((point) => ({ ...point, longitude: point.longitude + 0.02 })) };
  const data = await lookupMapillaryTerrainProof([section, other], "server-token", async (input) => {
    const url = new URL(String(input));
    const west = Number(url.searchParams.get("bbox").split(",")[0]);
    return Response.json({ data: west < 14.01 ? [image("section-a-image", 14.001)] : [] });
  });
  assert.equal(data.sections[0].availability, "available");
  assert.equal(data.sections[0].images[0].id, "section-a-image");
  assert.equal(data.sections[1].availability, "not-found");
});

test("rejects malformed and oversized API input", async () => {
  assert.equal(validateMapillarySections({ sections: [{ ...section, points: [{ latitude: 100, longitude: 0, distanceM: 0 }, section.points[1]] }] }), null);
  assert.equal(validateMapillarySections({ sections: Array.from({ length: 21 }, (_, index) => ({ ...section, id: `section-${index}` })) }), null);
  const response = await postMapillary(new Request("http://localhost/api/mapillary", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sections: [] }),
  }));
  assert.equal(response.status, 400);
});

test("API handler provides safe unknown results when the server token is missing", async () => {
  const previous = process.env.MAPILLARY_ACCESS_TOKEN;
  delete process.env.MAPILLARY_ACCESS_TOKEN;
  try {
    const response = await postMapillary(new Request("http://localhost/api/mapillary", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sections: [section] }),
    }));
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.sections[0].availability, "unknown");
    assert.equal(JSON.stringify(body).includes("MAPILLARY_ACCESS_TOKEN"), false);
  } finally {
    if (previous === undefined) delete process.env.MAPILLARY_ACCESS_TOKEN;
    else process.env.MAPILLARY_ACCESS_TOKEN = previous;
  }
});
