import assert from "node:assert/strict";
import test from "node:test";
import {
  createOfficialGpxDiscovery,
  isPublicAddress,
  OFFICIAL_GPX_DISCOVERY_LIMITS,
  validateOfficialPageUrl,
} from "./officialGpxDiscovery.ts";
import { POST as postDiscovery } from "./api/race-gpx-discovery/route.ts";

const PUBLIC = [{ address: "93.184.216.34", family: 4 }];
const page = (html, url = "https://race.example/event") => ({
  statusCode: 200,
  headers: { "content-type": "text/html; charset=utf-8" },
  body: new TextEncoder().encode(`<!doctype html><html><body>${html}</body></html>`),
  url,
});

function discovery(pages, options = {}) {
  const calls = [];
  const resolve = options.resolve ?? (async (host) => {
    calls.push({ type: "resolve", host });
    return PUBLIC;
  });
  const request = options.request ?? (async (url, address, maxBytes, timeoutMs) => {
    calls.push({ type: "request", url: url.href, address, maxBytes, timeoutMs });
    const result = pages instanceof Map ? pages.get(url.href) : pages(url);
    if (result instanceof Error) throw result;
    if (!result) throw new Error("missing fixture response");
    return result;
  });
  return { run: createOfficialGpxDiscovery({ resolve, request }), calls };
}

test("accepts only credential-free HTTPS page URLs", () => {
  assert.equal(validateOfficialPageUrl("http://race.example/event"), null);
  assert.equal(validateOfficialPageUrl("https://user:pass@race.example/event"), null);
  assert.equal(validateOfficialPageUrl("https://127.0.0.1/event"), null);
  assert.equal(validateOfficialPageUrl("https://race.example:8443/event"), null);
  assert.equal(validateOfficialPageUrl("https://race.example/event#section").hash, "");
});

test("blocks private, reserved, loopback, link-local, and non-global IPv6 addresses", () => {
  for (const address of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.2.3", "100.64.0.1", "224.0.0.1", "::", "::1", "fc00::1", "fe80::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:0808:0808", "2001:2::1", "2001:db8::1", "2002::1", "3fff::1", "5f00::1", "5f00:ffff:ffff:ffff:ffff:ffff:ffff:ffff"]) {
    assert.equal(isPublicAddress(address), false, address);
  }
  assert.equal(isPublicAddress("93.184.216.34"), true);
  assert.equal(isPublicAddress("2606:4700:4700::1111"), true);
  assert.equal(isPublicAddress("2001:200::1"), true);
});

test("rejects the complete 5f00::/16 reserved IPv6 prefix at its boundaries", () => {
  for (const address of ["5f00::", "5f00::1", "5f00:0:ffff:ffff:ffff:ffff:ffff:ffff"]) {
    assert.equal(isPublicAddress(address), false, address);
  }
  // Adjacent prefixes are outside the eligible 2000::/3 global-unicast block too.
  for (const address of ["4fff::1", "5f01::1", "6000::1"]) {
    assert.equal(isPublicAddress(address), false, address);
  }
  assert.equal(isPublicAddress("3fff:f::1"), false);
});

test("discovers one direct GPX link with evidence and an explicit distance label", async () => {
  const { run, calls } = discovery(new Map([["https://race.example/event", page('<a href="/files/course.gpx">110 km GPX download</a>')]]));
  const result = await run("https://race.example/event");
  assert.equal(result.status, "success");
  assert.equal(result.candidates.length, 1);
  assert.deepEqual(result.candidates[0], {
    gpxUrl: "https://race.example/files/course.gpx", sourcePageUrl: "https://race.example/event",
    linkText: "110 km GPX download", supportingEvidence: ["link text: 110 km GPX download"],
    distanceLabel: "110 km", discoveryStatus: "link-evidence-only", ambiguity: null,
  });
  assert.equal(calls.filter((call) => call.type === "request").length, 1);
});

test("keeps multiple distances ambiguous and never chooses a winner", async () => {
  const { run } = discovery(new Map([["https://race.example/event", page('<a href="/a.gpx">25 km GPX</a><a href="/b.gpx">50 km GPX</a>')]]));
  const result = await run("https://race.example/event");
  assert.equal(result.status, "success");
  assert.deepEqual(result.candidates.map(({ distanceLabel, ambiguity }) => [distanceLabel, ambiguity]), [["25 km", "multiple-candidates"], ["50 km", "multiple-candidates"]]);
});

test("follows relative same-origin course subpages and records the actual source page", async () => {
  const pages = new Map([
    ["https://race.example/event", page('<a href="course/">Course details</a><a href="https://other.example/course">Course map</a>')],
    ["https://race.example/course/", page('<a href="../files/route.gpx">Download GPX</a>')],
  ]);
  const { run, calls } = discovery(pages);
  const result = await run("https://race.example/event");
  assert.equal(result.status, "success");
  assert.equal(result.candidates[0].gpxUrl, "https://race.example/files/route.gpx");
  assert.equal(result.candidates[0].sourcePageUrl, "https://race.example/course/");
  assert.equal(calls.filter((call) => call.type === "request").length, 2);
});

test("deduplicates repeated links and does not inspect script text", async () => {
  const html = '<a href="/course.gpx" title="Course > route">Course GPX</a><a href="/course.gpx">Course GPX duplicate</a><script data-note=">"><a href="/fake.gpx">Fake GPX</a></script>';
  const { run } = discovery(new Map([["https://race.example/event", page(html)]]));
  const result = await run("https://race.example/event");
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].gpxUrl, "https://race.example/course.gpx");
});

test("does not return sensitive query values in source URLs or signed candidate URLs", async () => {
  const html = '<a href="/course.gpx?signature=private-value">Course GPX</a><a href="/ordinary.gpx">GPX</a>';
  const { run } = discovery(new Map([["https://race.example/event?token=private-source-token", page(html)]]));
  const result = await run("https://race.example/event?token=private-source-token");
  assert.equal(result.status, "success");
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].sourcePageUrl, "https://race.example/event");
  assert.equal(JSON.stringify(result).includes("private"), false);
});

test("returns no-results when no evidence-backed GPX link exists", async () => {
  const { run } = discovery(new Map([["https://race.example/event", page('<a href="/about">About</a>')]]));
  assert.deepEqual(await run("https://race.example/event"), { status: "no-results", candidates: [] });
});

test("reports malformed and non-HTML responses without exposing response contents", async () => {
  const { run } = discovery(new Map([["https://race.example/event", { statusCode: 200, headers: { "content-type": "application/json" }, body: new TextEncoder().encode('{"internal":"secret"}') }]]));
  assert.deepEqual(await run("https://race.example/event"), { status: "provider-failure", category: "invalid-response", candidates: [] });
  const malformed = discovery(new Map([["https://race.example/event", { statusCode: 200, headers: { "content-type": "text/html" }, body: new TextEncoder().encode("not html") }]]));
  assert.deepEqual(await malformed.run("https://race.example/event"), { status: "provider-failure", category: "invalid-response", candidates: [] });
  const oversized = discovery(new Map([["https://race.example/event", { statusCode: 200, headers: { "content-type": "text/html" }, body: new Uint8Array(1_000_001) }]]));
  assert.deepEqual(await oversized.run("https://race.example/event"), { status: "provider-failure", category: "invalid-response", candidates: [] });
});

test("returns safe timeout and provider failure categories", async () => {
  const timed = createOfficialGpxDiscovery({ resolve: async () => PUBLIC, request: () => new Promise(() => {}) }, {
    ...OFFICIAL_GPX_DISCOVERY_LIMITS, timeoutMs: 5,
  });
  assert.deepEqual(await timed("https://race.example/event"), { status: "provider-failure", category: "timeout", candidates: [] });
  const unavailable = discovery(new Map([["https://race.example/event", new Error("private network detail")]]));
  const result = await unavailable.run("https://race.example/event");
  assert.deepEqual(result, { status: "provider-failure", category: "unavailable", candidates: [] });
  assert.equal(JSON.stringify(result).includes("private network detail"), false);
});

test("rejects unsafe redirects before a second connection", async () => {
  let requestCount = 0;
  const { run } = discovery(new Map(), {
    request: async () => {
      requestCount++;
      return { statusCode: 302, headers: { location: "https://127.0.0.1/admin" }, body: new Uint8Array() };
    },
  });
  assert.deepEqual(await run("https://race.example/event"), { status: "unsafe-destination", candidates: [] });
  assert.equal(requestCount, 1);
});

test("re-resolves each followed page and rejects a DNS change to a private address", async () => {
  let lookups = 0;
  const { run, calls } = discovery(new Map([
    ["https://race.example/event", page('<a href="/course">Course details</a>')],
    ["https://race.example/course", page('<a href="/route.gpx">GPX</a>')],
  ]), {
    resolve: async () => ++lookups === 1 ? PUBLIC : [{ address: "10.0.0.2", family: 4 }],
  });
  assert.deepEqual(await run("https://race.example/event"), { status: "unsafe-destination", candidates: [] });
  assert.equal(calls.filter((call) => call.type === "request").length, 1);
});

test("re-resolves redirect destinations before opening the redirected connection", async () => {
  let lookups = 0;
  let requests = 0;
  const { run } = discovery(new Map(), {
    resolve: async () => ++lookups === 1 ? PUBLIC : [{ address: "192.168.1.3", family: 4 }],
    request: async () => {
      requests++;
      return { statusCode: 302, headers: { location: "/redirected" }, body: new Uint8Array() };
    },
  });
  assert.deepEqual(await run("https://race.example/event"), { status: "unsafe-destination", candidates: [] });
  assert.equal(requests, 1);
});

test("caps followed pages and redirect hops", async () => {
  const pages = new Map([
    ["https://race.example/one", page('<a href="/two">Course details</a>')],
    ["https://race.example/two", page('<a href="/three">Route details</a>')],
    ["https://race.example/three", page('<a href="/four">Track details</a>')],
    ["https://race.example/four", page('<a href="/four.gpx">GPX</a>')],
  ]);
  const { run, calls } = discovery(pages);
  assert.equal((await run("https://race.example/one")).status, "no-results");
  assert.equal(calls.filter((call) => call.type === "request").length, 3);

  let redirects = 0;
  const redirectRun = discovery(new Map(), { request: async () => {
    redirects++;
    return { statusCode: 302, headers: { location: `/hop-${redirects}` }, body: new Uint8Array() };
  } });
  assert.deepEqual(await redirectRun.run("https://race.example/event"), { status: "provider-failure", category: "unavailable", candidates: [] });
  assert.equal(redirects, 3);
});

test("enforces the per-process concurrent discovery cap", async () => {
  const pending = [];
  const run = createOfficialGpxDiscovery({
    resolve: async () => PUBLIC,
    request: () => new Promise((resolve) => pending.push(resolve)),
  });
  const first = run("https://race.example/one");
  const second = run("https://race.example/two");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(pending.length, 2);
  assert.deepEqual(await run("https://race.example/three"), { status: "provider-failure", category: "busy", candidates: [] });
  for (const resolve of pending) resolve(page(""));
  assert.equal((await first).status, "no-results");
  assert.equal((await second).status, "no-results");
});

test("the API rejects invalid and oversized requests without fetching", async () => {
  const invalid = await postDiscovery(new Request("https://app.example/api/race-gpx-discovery", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: "http://localhost/admin" }),
  }));
  assert.equal(invalid.status, 400);
  assert.deepEqual(await invalid.json(), { status: "invalid-url", candidates: [] });
  const oversized = await postDiscovery(new Request("https://app.example/api/race-gpx-discovery", {
    method: "POST", headers: { "content-type": "application/json" }, body: "x".repeat(9_000),
  }));
  assert.equal(oversized.status, 413);
});

test("bounds pages, redirects, bytes, candidates, timeout, and per-process concurrency", () => {
  assert.deepEqual(OFFICIAL_GPX_DISCOVERY_LIMITS, {
    timeoutMs: 8_000, maxPages: 3, maxRedirects: 2, maxResponseBytes: 1_000_000,
    maxCandidates: 20, maxConcurrentPerProcess: 2,
  });
});
