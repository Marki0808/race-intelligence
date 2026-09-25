import assert from "node:assert/strict";
import test from "node:test";
import {
  lookupMapillaryTerrainProof,
  matchMapillaryImages,
  parseMapillaryImages,
  validateMapillarySections,
} from "./mapillaryTerrainProof.ts";
import { POST as postMapillary } from "./api/mapillary/route.ts";

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
