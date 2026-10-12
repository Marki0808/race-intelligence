import assert from "node:assert/strict";
import test from "node:test";
import { createRaceGpxDownloadPost } from "./api/race-gpx-download/route.ts";
import { createOfficialGpxDownloadFlow, createOfficialGpxDownloader, OFFICIAL_GPX_DOWNLOAD_LIMITS } from "./officialGpxDownload.ts";
import { fetchPublicHttps } from "./officialGpxDiscovery.ts";

const validGpx = `<?xml version="1.0"?><gpx version="1.1" creator="test"><trk><name>Test route</name><trkseg><trkpt lat="45.8" lon="15.9"><ele>100</ele></trkpt><trkpt lat="45.8" lon="15.91"><ele>110</ele></trkpt></trkseg></trk></gpx>`;
const publicAddress = [{ address: "93.184.216.34", family: 4 }];

function gpxResponse(text = validGpx, contentType = "application/gpx+xml") {
  return {
    statusCode: 200,
    headers: { "content-type": `${contentType}; charset=utf-8` },
    body: new TextEncoder().encode(text),
  };
}

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

test("download API streams only validated GPX and sanitizes failures", async () => {
  const handler = createRaceGpxDownloadPost(async () => ({ status: "success", text: validGpx }));
  const response = await handler(new Request("https://app.example/api/race-gpx-download", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ sourcePageUrl: "https://race.example/event", gpxUrl: "https://race.example/route.gpx" }),
  }));
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /application\/gpx\+xml/);
  assert.equal(await response.text(), validGpx);

  const failureHandler = createRaceGpxDownloadPost(async () => ({ status: "provider-failure", category: "unavailable" }));
  const failure = await failureHandler(new Request("https://app.example/api/race-gpx-download", {
    method: "POST", body: JSON.stringify({ sourcePageUrl: "https://race.example/event", gpxUrl: "https://race.example/route.gpx" }),
  }));
  assert.deepEqual(await failure.json(), { status: "provider-failure", category: "unavailable" });
});
