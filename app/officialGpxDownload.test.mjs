import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import test from "node:test";
import { createRaceGpxDownloadPost } from "./api/race-gpx-download/route.ts";
import { createOfficialGpxArchiveDownloader, createOfficialGpxDownloadFlow, createOfficialGpxDownloader, OFFICIAL_GPX_DOWNLOAD_LIMITS } from "./officialGpxDownload.ts";
import { inspectGpxArchive, OFFICIAL_GPX_ARCHIVE_LIMITS } from "./officialGpxArchive.ts";
import { fetchPublicHttps } from "./officialGpxDiscovery.ts";

const validGpx = `<?xml version="1.0"?><gpx version="1.1" creator="test"><trk><name>Test route</name><trkseg><trkpt lat="45.8" lon="15.9"><ele>100</ele></trkpt><trkpt lat="45.8" lon="15.91"><ele>110</ele></trkpt></trkseg></trk></gpx>`;
const publicAddress = [{ address: "93.184.216.34", family: 4 }];

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) value = (value & 1) ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
  }
  return (value ^ 0xffffffff) >>> 0;
}

function gpxResponse(text = validGpx, contentType = "application/gpx+xml") {
  return {
    statusCode: 200,
    headers: { "content-type": `${contentType}; charset=utf-8` },
    body: new TextEncoder().encode(text),
  };
}

function makeZip(entries) {
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;
  for (const item of entries) {
    const name = Buffer.from(item.name, "utf8");
    const contents = Buffer.from(item.text ?? "", "utf8");
    const method = item.method ?? 8;
    const compressed = method === 8 ? deflateRawSync(contents) : contents;
    const checksum = item.crc ?? crc32(contents);
    const flags = item.flags ?? 0;
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(contents.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    localParts.push(local, compressed);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(item.hostVersion ?? 0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(contents.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(item.externalAttributes ?? ((0x81a4 << 16) >>> 0), 38);
    central.writeUInt32LE(localOffset, 42);
    name.copy(central, 46);
    centralParts.push(central);
    localOffset += local.length + compressed.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

const archiveResponse = (body) => ({
  statusCode: 200,
  headers: { "content-type": "application/zip" },
  body,
});

test("selected GPX is retrieved with bounded safe-fetch options and validated by the existing parser", async () => {
  let received;
  const download = createOfficialGpxDownloader(async (url, options) => {
    received = { url, options };
    return { ...gpxResponse(), finalUrl: new URL(url), bytesRead: validGpx.length };
  });
  assert.deepEqual(await download("https://race.example/course.gpx"), { status: "success", text: validGpx });
  assert.equal(received.options.maxBytes, 4 * 1024 * 1024);
  assert.equal(received.options.sameOriginRedirects, false);
  assert.equal(received.options.maxRedirects, 2);
  assert.equal(received.options.timeoutMs, OFFICIAL_GPX_DOWNLOAD_LIMITS.timeoutMs);
});

test("rejects malformed GPX, HTML, unsupported media, and oversized response bodies", async () => {
  const malformed = createOfficialGpxDownloader(async (url) => ({ ...gpxResponse("<html>not GPX</html>"), finalUrl: new URL(url), bytesRead: 22 }));
  assert.deepEqual(await malformed("https://race.example/route.gpx"), { status: "invalid-gpx" });

  const html = createOfficialGpxDownloader(async (url) => ({ ...gpxResponse(validGpx, "text/html"), finalUrl: new URL(url), bytesRead: validGpx.length }));
  assert.deepEqual(await html("https://race.example/route.gpx"), { status: "provider-failure", category: "invalid-response" });

  const oversized = createOfficialGpxDownloader(async (url) => ({
    ...gpxResponse("x".repeat(4 * 1024 * 1024 + 1)), finalUrl: new URL(url), bytesRead: 4 * 1024 * 1024 + 1,
  }));
  assert.deepEqual(await oversized("https://race.example/route.gpx"), { status: "provider-failure", category: "invalid-response" });
});

test("archive inspection extracts and validates one GPX entirely in memory", async () => {
  const archive = makeZip([{ name: "course.gpx", text: validGpx }]);
  const result = await inspectGpxArchive(archive);
  assert.deepEqual(result, {
    status: "success",
    archiveDigest: createHash("sha256").update(archive).digest("hex"),
    files: [{ id: "gpx-1", displayLabel: "GPX file 1", text: validGpx }],
  });
});

test("multiple distinct valid GPX files require a later explicit user selection and identical files deduplicate", async () => {
  const secondGpx = validGpx.replace("lon=\"15.91\"", "lon=\"15.92\"");
  const result = await inspectGpxArchive(makeZip([
    { name: "one.gpx", text: validGpx },
    { name: "duplicate.gpx", text: validGpx },
    { name: "two.gpx", text: secondGpx },
  ]));
  assert.equal(result.status, "success");
  assert.deepEqual(result.files.map(({ id, displayLabel }) => ({ id, displayLabel })), [
    { id: "gpx-1", displayLabel: "GPX file 1" },
    { id: "gpx-2", displayLabel: "GPX file 2" },
  ]);
});

test("empty, malformed, truncated and invalid-GPX archives fail without returning content", async () => {
  assert.deepEqual(await inspectGpxArchive(makeZip([])), { status: "no-gpx-in-archive" });
  assert.deepEqual(await inspectGpxArchive(Buffer.from("not a zip")), { status: "invalid-archive" });
  const valid = makeZip([{ name: "course.gpx", text: validGpx }]);
  assert.deepEqual(await inspectGpxArchive(valid.subarray(0, valid.length - 8)), { status: "invalid-archive" });
  assert.deepEqual(await inspectGpxArchive(makeZip([{ name: "course.gpx", text: "<gpx><trk>broken" }])), { status: "no-gpx-in-archive" });
  assert.deepEqual(await inspectGpxArchive(makeZip([{ name: "course.gpx", text: validGpx, crc: 1 }])), { status: "invalid-archive" });
});

test("encrypted, unsupported compression, path traversal, symlink, and excessive-entry archives are rejected", async () => {
  assert.deepEqual(await inspectGpxArchive(makeZip([{ name: "course.gpx", text: validGpx, flags: 1 }])), { status: "invalid-archive" });
  assert.deepEqual(await inspectGpxArchive(makeZip([{ name: "course.gpx", text: validGpx, method: 12 }])), { status: "invalid-archive" });
  assert.deepEqual(await inspectGpxArchive(makeZip([{ name: "../course.gpx", text: validGpx }])), { status: "unsafe-archive" });
  assert.deepEqual(await inspectGpxArchive(makeZip([{ name: "link.gpx", text: validGpx, externalAttributes: ((0xa1ff << 16) >>> 0) }])), { status: "unsafe-archive" });
  const manyEntries = makeZip(Array.from({ length: OFFICIAL_GPX_ARCHIVE_LIMITS.maxEntries + 1 }, (_, index) => ({ name: `f${index}.txt`, text: "x" })));
  assert.deepEqual(await inspectGpxArchive(manyEntries), { status: "archive-too-large" });
});

test("compressed, expanded, and individual GPX size limits reject ZIP bombs before returning data", async () => {
  assert.deepEqual(await inspectGpxArchive(Buffer.alloc(OFFICIAL_GPX_ARCHIVE_LIMITS.maxCompressedBytes + 1)), { status: "archive-too-large" });
  const expandedBomb = makeZip([{ name: "payload.bin", text: "0".repeat(OFFICIAL_GPX_ARCHIVE_LIMITS.maxExpandedBytes + 1) }]);
  assert.deepEqual(await inspectGpxArchive(expandedBomb), { status: "archive-too-large" });
  const largeGpx = `<?xml version="1.0"?><gpx version="1.1"><!--${"x".repeat(OFFICIAL_GPX_ARCHIVE_LIMITS.maxGpxBytes)}--></gpx>`;
  assert.deepEqual(await inspectGpxArchive(makeZip([{ name: "large.gpx", text: largeGpx }])), { status: "archive-too-large" });
  assert.deepEqual(await inspectGpxArchive(makeZip([{ name: "route-data.txt", text: largeGpx }])), { status: "archive-too-large" });
});

test("all central-directory size declarations are preflighted before any entry is decompressed", async () => {
  const aggregateBomb = makeZip([
    { name: "first.txt", text: "bad CRC is never reached", crc: 1 },
    { name: "later.txt", text: "x" },
  ]);
  const firstCentral = aggregateBomb.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  const laterCentral = aggregateBomb.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]), firstCentral + 4);
  aggregateBomb.writeUInt32LE(OFFICIAL_GPX_ARCHIVE_LIMITS.maxExpandedBytes + 1, laterCentral + 24);
  assert.deepEqual(await inspectGpxArchive(aggregateBomb), { status: "archive-too-large" });

  const individualGpxBomb = makeZip([
    { name: "first.txt", text: "bad CRC is never reached", crc: 1 },
    { name: "later.gpx", text: "x" },
  ]);
  const firstGpxCentral = individualGpxBomb.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  const laterGpxCentral = individualGpxBomb.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]), firstGpxCentral + 4);
  individualGpxBomb.writeUInt32LE(OFFICIAL_GPX_ARCHIVE_LIMITS.maxGpxBytes + 1, laterGpxCentral + 24);
  assert.deepEqual(await inspectGpxArchive(individualGpxBomb), { status: "archive-too-large" });
});

test("archive downloader enforces its compressed cap and validates archive bytes, not filename alone", async () => {
  let received;
  const good = makeZip([{ name: "not-called-a-gpx.txt", text: validGpx }]);
  const download = createOfficialGpxArchiveDownloader(async (url, options) => {
    received = { url, options };
    return { ...archiveResponse(good), finalUrl: new URL(url), bytesRead: good.length };
  });
  assert.deepEqual(await download("https://race.example/course.zip"), {
    status: "archive-inspection-success", archiveDigest: createHash("sha256").update(good).digest("hex"),
    files: [{ id: "gpx-1", displayLabel: "GPX file 1", text: validGpx }],
  });
  assert.equal(received.options.maxBytes, 4 * 1024 * 1024);
  assert.equal(received.options.sameOriginRedirects, false);

  const oversized = createOfficialGpxArchiveDownloader(async (url) => ({
    ...archiveResponse(new Uint8Array(OFFICIAL_GPX_ARCHIVE_LIMITS.maxCompressedBytes + 1)),
    finalUrl: new URL(url), bytesRead: OFFICIAL_GPX_ARCHIVE_LIMITS.maxCompressedBytes + 1,
  }));
  assert.deepEqual(await oversized("https://race.example/course.zip"), { status: "provider-failure", category: "invalid-response" });
});

test("safe GPX retrieval rejects private redirects and DNS rebinding before another request", async () => {
  let requests = 0;
  const privateRedirect = createOfficialGpxDownloader((url, options) => fetchPublicHttps(url, options, {
    resolve: async (host) => host === "127.0.0.1" ? [{ address: host, family: 4 }] : publicAddress,
    request: async () => {
      requests++;
      return { statusCode: 302, headers: { location: "https://127.0.0.1/private.gpx" }, body: new Uint8Array() };
    },
  }));
  assert.deepEqual(await privateRedirect("https://race.example/course.gpx"), { status: "unsafe-destination" });
  assert.equal(requests, 1);

  requests = 0;
  let resolutions = 0;
  const rebinding = createOfficialGpxDownloader((url, options) => fetchPublicHttps(url, options, {
    resolve: async () => ++resolutions === 1 ? publicAddress : [{ address: "10.0.0.2", family: 4 }],
    request: async () => {
      requests++;
      return { statusCode: 302, headers: { location: "https://cdn.example/route.gpx" }, body: new Uint8Array() };
    },
  }));
  assert.deepEqual(await rebinding("https://race.example/course.gpx"), { status: "unsafe-destination" });
  assert.equal(requests, 1);
});

test("safe archive retrieval preserves SSRF and DNS rebinding rejection", async () => {
  let requests = 0;
  const privateRedirect = createOfficialGpxArchiveDownloader((url, options) => fetchPublicHttps(url, options, {
    resolve: async (host) => host === "127.0.0.1" ? [{ address: host, family: 4 }] : publicAddress,
    request: async () => {
      requests++;
      return { statusCode: 302, headers: { location: "https://127.0.0.1/private.zip" }, body: new Uint8Array() };
    },
  }));
  assert.deepEqual(await privateRedirect("https://race.example/course.zip"), { status: "unsafe-destination" });
  assert.equal(requests, 1);
});

test("safe GPX retrieval returns sanitized timeout and provider failures", async () => {
  const timeout = createOfficialGpxDownloader((url, options) => fetchPublicHttps(url, { ...options, timeoutMs: 1 }, {
    resolve: async () => publicAddress,
    request: () => new Promise(() => {}),
  }));
  assert.deepEqual(await timeout("https://race.example/route.gpx"), { status: "provider-failure", category: "timeout" });

  const unavailable = createOfficialGpxDownloader(async () => { throw new Error("internal socket detail"); });
  const result = await unavailable("https://race.example/route.gpx");
  assert.deepEqual(result, { status: "provider-failure", category: "unavailable" });
  assert.equal(JSON.stringify(result).includes("internal socket detail"), false);
});

test("download flow re-discovers and accepts only the explicitly selected current candidate", async () => {
  const candidates = ["one", "two"].map((name) => ({
    gpxUrl: `https://race.example/${name}.gpx`, sourcePageUrl: "https://race.example/event", linkText: `${name} GPX`,
    supportingEvidence: ["link text"], distanceLabel: null, discoveryStatus: "link-evidence-only", ambiguity: "multiple-candidates",
  }));
  let downloaded = "";
  const flow = createOfficialGpxDownloadFlow(async () => ({ status: "success", candidates }), async (url) => {
    downloaded = url;
    return { status: "success", text: validGpx };
  });
  assert.deepEqual(await flow("https://race.example/event", candidates[1].gpxUrl), { status: "success", text: validGpx });
  assert.equal(downloaded, candidates[1].gpxUrl);
  downloaded = "";
  assert.deepEqual(await flow("https://race.example/event", "https://race.example/stale.gpx"), { status: "candidate-not-found" });
  assert.equal(downloaded, "");
});

test("download flow does not fetch when rediscovery returns no results or fails", async () => {
  let downloadCalls = 0;
  const downloader = async () => { downloadCalls++; return { status: "success", text: validGpx }; };
  const noResults = createOfficialGpxDownloadFlow(async () => ({ status: "no-results", candidates: [] }), downloader);
  assert.deepEqual(await noResults("https://race.example/event", "https://race.example/route.gpx"), { status: "candidate-not-found" });
  const failed = createOfficialGpxDownloadFlow(async () => ({ status: "provider-failure", category: "timeout", candidates: [] }), downloader);
  assert.deepEqual(await failed("https://race.example/event", "https://race.example/route.gpx"), { status: "provider-failure", category: "timeout", candidates: [] });
  assert.equal(downloadCalls, 0);
});

test("archive download requires the confirmed current ZIP candidate and returns validated GPX files", async () => {
  const archiveUrl = "https://race.example/course.zip";
  const archive = { archiveUrl, sourcePageUrl: "https://race.example/event", displayLabel: "42 km", linkText: "Download GPX", supportingEvidence: ["heading"], distanceLabel: "42 km", resourceType: "zip-archive", discoveryStatus: "archive-link-evidence-only", ambiguity: null };
  let requestedArchive = "";
  const digest = "a".repeat(64);
  const archiveInspection = { status: "archive-inspection-success", archiveDigest: digest, files: [{ id: "gpx-1", displayLabel: "GPX file 1", text: validGpx }] };
  const flow = createOfficialGpxDownloadFlow(
    async () => ({ status: "success", candidates: [], archives: [archive] }),
    async () => { throw new Error("direct GPX downloader must not run"); },
    async (url) => { requestedArchive = url; return archiveInspection; },
  );
  assert.deepEqual(await flow("https://race.example/event", archiveUrl, "zip"), {
    status: "archive-choices", archiveDigest: digest, files: [{ id: "gpx-1", displayLabel: "GPX file 1" }],
  });
  assert.equal(requestedArchive, archiveUrl);
  assert.deepEqual(await flow("https://race.example/event", archiveUrl, "zip-entry", digest, "gpx-1"), { status: "success", text: validGpx });
  assert.deepEqual(await flow("https://race.example/event", archiveUrl, "zip-entry", "b".repeat(64), "gpx-1"), { status: "archive-changed" });
  requestedArchive = "";
  assert.deepEqual(await flow("https://race.example/event", "https://race.example/stale.zip", "zip"), { status: "candidate-not-found" });
  assert.equal(requestedArchive, "");
});

test("download API returns validated GPX with station metadata without JSON-escaping the GPX body", async () => {
  const handler = createRaceGpxDownloadPost(async () => ({ status: "success", text: validGpx }));
  const response = await handler(new Request("https://app.example/api/race-gpx-download", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ sourcePageUrl: "https://race.example/event", gpxUrl: "https://race.example/route.gpx" }),
  }));
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /multipart\/form-data/);
  const body = await response.formData();
  assert.equal(await body.get("gpxText").text(), validGpx);
  assert.equal(body.get("aidStationDiscoveryV1"), "null");

  const failureHandler = createRaceGpxDownloadPost(async () => ({ status: "provider-failure", category: "unavailable" }));
  const failure = await failureHandler(new Request("https://app.example/api/race-gpx-download", {
    method: "POST", body: JSON.stringify({ sourcePageUrl: "https://race.example/event", gpxUrl: "https://race.example/route.gpx" }),
  }));
  assert.deepEqual(await failure.json(), { status: "provider-failure", category: "unavailable" });
});

test("download API returns bounded archive-choice metadata, not every extracted GPX body", async () => {
  const files = [{ id: "gpx-1", displayLabel: "GPX file 1" }];
  const archiveDigest = "a".repeat(64);
  const handler = createRaceGpxDownloadPost(async (_source, _url, resourceType) => {
    assert.equal(resourceType, "zip");
    return { status: "archive-choices", archiveDigest, files };
  });
  const response = await handler(new Request("https://app.example/api/race-gpx-download", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ sourcePageUrl: "https://race.example/event", resourceType: "zip", archiveUrl: "https://race.example/course.zip" }),
  }));
  assert.equal(response.status, 200);
  assert.match(response.headers.get("cache-control"), /no-store/);
  assert.deepEqual(await response.json(), { status: "archive-choices", archiveDigest, files });
});

test("download API returns only the selected GPX after archive digest revalidation", async () => {
  const handler = createRaceGpxDownloadPost(async (_source, _url, resourceType, digest, entryId) => {
    assert.equal(resourceType, "zip-entry");
    assert.equal(digest, "a".repeat(64));
    assert.equal(entryId, "gpx-2");
    return { status: "success", text: validGpx };
  });
  const response = await handler(new Request("https://app.example/api/race-gpx-download", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ sourcePageUrl: "https://race.example/event", resourceType: "zip-entry", archiveUrl: "https://race.example/course.zip", archiveDigest: "a".repeat(64), entryId: "gpx-2" }),
  }));
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /multipart\/form-data/);
  const body = await response.formData();
  assert.equal(await body.get("gpxText").text(), validGpx);
  assert.equal(body.get("aidStationDiscoveryV1"), "null");
});
