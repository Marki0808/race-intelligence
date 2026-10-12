import assert from "node:assert/strict";
import test from "node:test";
import {
  createOfficialGpxDiscovery,
  createPinnedDnsLookup,
  isPublicAddress,
  OFFICIAL_GPX_DISCOVERY_LIMITS,
  validateOfficialPageUrl,
} from "./officialGpxDiscovery.ts";
import { POST as postDiscovery } from "./api/race-gpx-discovery/route.ts";

const PUBLIC = [{ address: "93.184.216.34", family: 4 }];

test("pinned DNS lookup supports Node's all-address callback contract", () => {
  const lookup = createPinnedDnsLookup(PUBLIC[0]);
  let allResult;
  lookup("race.example", { all: true }, (error, addresses) => { allResult = { error, addresses }; });
  assert.deepEqual(allResult, { error: null, addresses: [PUBLIC[0]] });

  let singleResult;
  lookup("race.example", (error, address, family) => { singleResult = { error, address, family }; });
  assert.deepEqual(singleResult, { error: null, address: PUBLIC[0].address, family: PUBLIC[0].family });
});

const page = (html, url = "https://race.example/event") => ({
  statusCode: 200,
  headers: { "content-type": "text/html; charset=utf-8" },
  body: new TextEncoder().encode(`<!doctype html><html><body>${html}</body></html>`),
  url,
});

function sizedPage(html, targetBytes, url = "https://race.example/event") {
  const shell = `<!doctype html><html><body>${html}</body></html>`;
  const paddingLength = targetBytes - Buffer.byteLength(shell);
  assert.ok(paddingLength >= 0, "target size must fit the HTML fixture");
  return {
    statusCode: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
    body: new TextEncoder().encode(`<!doctype html><html><body>${"x".repeat(paddingLength)}${html}</body></html>`),
    url,
  };
}

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
  return { run: createOfficialGpxDiscovery({ resolve, request }, undefined, options.onDiagnostic), calls };
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
    linkText: "110 km GPX download", displayLabel: "110 km",
    supportingEvidence: ["link text: 110 km GPX download", "filename: course"],
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

test("extracts five course distances from associated headings and excludes the GPX index navigation link", async () => {
  const html = [
    '<nav><a href="/courses/gpx-tracks">GPX tracks</a></nav>',
    '<article><h3>Istria100 - 168K</h3><a href="https://files.example/ISTRIA_168k_2027_a.gpx">GPX track</a></article>',
    '<article><h3>Istria100 - 110K</h3><a href="https://files.example/ISTRIA_111k_2027_b.gpx">GPX track</a></article>',
    '<article><h3>Istria100 - 69K</h3><a href="https://files.example/ISTRIA_69k_2027_c.gpx">GPX track</a></article>',
    '<article><h3>Istria100 - 42K</h3><a href="https://files.example/ISTRIA_42k_2027_d.gpx">GPX track</a></article>',
    '<article><h3>Istria100 - 21K</h3><a href="https://files.example/ISTRIA_21k_2027_e.gpx">GPX track</a></article>',
  ].join("");
  const pages = new Map([
    ["https://race.example/event", page(html)],
    ["https://race.example/courses/gpx-tracks", page('<p>Course files are listed on the main event page.</p>')],
  ]);
  const { run } = discovery(pages);
  const result = await run("https://race.example/event");
  assert.equal(result.status, "success");
  assert.deepEqual(result.candidates.map(({ distanceLabel }) => distanceLabel), ["168K", "110K", "69K", "42K", "21K"]);
  assert.deepEqual(result.candidates.map(({ displayLabel }) => displayLabel), [
    "Istria100 - 168K", "Istria100 - 110K", "Istria100 - 69K", "Istria100 - 42K", "Istria100 - 21K",
  ]);
  assert.ok(result.candidates.every(({ gpxUrl }) => gpxUrl.endsWith(".gpx")));
  assert.ok(result.candidates.every(({ supportingEvidence }) => supportingEvidence.some((item) => item.startsWith("associated heading: Istria100"))));
  assert.equal(result.candidates.some(({ gpxUrl }) => gpxUrl.endsWith("/courses/gpx-tracks")), false);
});

test("Croatian GPX zapisi navigation is prioritized over generic race links and reaches five labeled routes", async () => {
  const rootUrl = "https://race.example/hr";
  const indexUrl = "https://race.example/races-runners/runners/gpx-tracks";
  const routeHtml = ["168K", "110K", "69K", "42K", "21K"].map((distance) =>
    `<article><h3>Istria100 - ${distance}</h3><a href="https://files.example/${distance}.gpx">GPX track</a></article>`,
  ).join("");
  const pages = new Map([
    [rootUrl, page('<nav><a href="/hr/races">Utrke</a><a href="/hr/race/168k">Istra 168K</a><a href="/hr/login">Prijava</a><a href="/races-runners/runners/gpx-tracks">GPX zapisi</a></nav>')],
    [indexUrl, page(routeHtml)],
  ]);
  const { run, calls } = discovery(pages);
  const result = await run(rootUrl);
  assert.equal(result.status, "success");
  assert.deepEqual(calls.filter((call) => call.type === "request").map((call) => call.url), [rootUrl, indexUrl]);
  assert.deepEqual(result.candidates.map(({ distanceLabel }) => distanceLabel), ["168K", "110K", "69K", "42K", "21K"]);
});

test("English GPX tracks navigation is followed before unrelated same-origin event links", async () => {
  const rootUrl = "https://race.example/en";
  const indexUrl = "https://race.example/en/course/gpx-tracks";
  const pages = new Map([
    [rootUrl, page('<nav><a href="/events">Events</a><a href="/en/account">Account</a><a href="/en/course/gpx-tracks">GPX tracks</a></nav>')],
    [indexUrl, page('<article><h3>Mountain route 42K</h3><a href="https://files.example/42k.gpx">GPX track</a></article>')],
  ]);
  const { run, calls } = discovery(pages);
  const result = await run(rootUrl);
  assert.equal(result.status, "success");
  assert.deepEqual(calls.filter((call) => call.type === "request").map((call) => call.url), [rootUrl, indexUrl]);
  assert.equal(result.candidates[0].distanceLabel, "42K");
});

test("recognizes explicit route navigation labels across supported languages", async () => {
  const labels = [
    ["Staze", "/hr/staze"], ["Trase", "/hr/trase"], ["Utrke", "/hr/utrke/istria"],
    ["Routes", "/en/routes"], ["Courses", "/en/courses"], ["Parcours", "/fr/parcours"],
    ["Recorridos", "/es/recorridos"], ["Tracks", "/en/tracks"], ["Downloads", "/en/downloads"],
  ];
  for (const [label, path] of labels) {
    const rootUrl = "https://race.example/home";
    const targetUrl = new URL(path, rootUrl).href;
    const pages = new Map([
      [rootUrl, page(`<nav><a href="${path}">${label}</a></nav>`, rootUrl)],
      [targetUrl, page('<p>No route download on this page.</p>', targetUrl)],
    ]);
    const { run, calls } = discovery(pages);
    assert.deepEqual(await run(rootUrl), { status: "no-results", candidates: [] }, label);
    assert.deepEqual(calls.filter((call) => call.type === "request").map((call) => call.url), [rootUrl, targetUrl], label);
  }
});

test("reaches a GPX page at subpage depth two within the page budget", async () => {
  const rootUrl = "https://race.example/home";
  const raceUrl = "https://race.example/utrke/spring-trail";
  const indexUrl = "https://race.example/en/courses";
  const pages = new Map([
    [rootUrl, page('<a href="/races">Utrke</a><a href="/utrke/spring-trail">Spring trail event</a>')],
    [raceUrl, page('<a href="/en/courses">Course routes</a><a href="/en/account">Account</a>')],
    [indexUrl, page('<article><h3>Spring trail 33K</h3><a href="https://files.example/spring-33k.gpx">GPX track</a></article>')],
  ]);
  const { run, calls } = discovery(pages);
  const result = await run(rootUrl);
  assert.equal(result.status, "success");
  assert.deepEqual(calls.filter((call) => call.type === "request").map((call) => call.url), [rootUrl, raceUrl, indexUrl]);
  assert.equal(result.candidates[0].distanceLabel, "33K");
});

test("irrelevant navigation links do not consume the bounded page traversal budget", async () => {
  const rootUrl = "https://race.example/home";
  const indexUrl = "https://race.example/gpx/staze";
  const irrelevant = Array.from({ length: 30 }, (_, index) =>
    `<a href="/account/page-${index}">Account ${index}</a><a href="/news/item-${index}">News ${index}</a><a href="https://ad.example/${index}">Partner</a>`,
  ).join("");
  const pages = new Map([
    [rootUrl, page(`${irrelevant}<a href="/races">Races</a><a href="/gpx/staze">Staze</a>`, rootUrl)],
    [indexUrl, page('<article><h3>Forest route 18K</h3><a href="https://files.example/18k.gpx">GPX track</a></article>', indexUrl)],
  ]);
  const { run, calls } = discovery(pages);
  const result = await run(rootUrl);
  assert.equal(result.status, "success");
  assert.deepEqual(calls.filter((call) => call.type === "request").map((call) => call.url), [rootUrl, indexUrl]);
  assert.equal(result.candidates[0].distanceLabel, "18K");
});

test("course navigation with no GPX remains a bounded no-results state", async () => {
  const pages = new Map([
    ["https://race.example/home", page('<nav><a href="/courses">Courses</a></nav>')],
    ["https://race.example/courses", page('<h2>Courses</h2><a href="/registration">Registration</a>')],
  ]);
  const { run, calls } = discovery(pages);
  assert.deepEqual(await run("https://race.example/home"), { status: "no-results", candidates: [] });
  assert.equal(calls.filter((call) => call.type === "request").length, 2);
});

test("a secondary page failure reports safe server diagnostics and preserves the all-or-nothing public failure", async () => {
  const rootUrl = "https://race.example/hr";
  const indexUrl = "https://race.example/gpx-tracks";
  const unrelatedUrl = "https://race.example/courses/other-catalog";
  const diagnostics = [];
  const routeHtml = ["168K", "110K", "69K", "42K", "21K"].map((distance) =>
    `<article><h3>Course ${distance}</h3><a href="https://files.example/${distance}.gpx">GPX track</a></article>`,
  ).join("");
  const pages = new Map([
    [rootUrl, page('<a href="/gpx-tracks">GPX tracks</a>')],
    [indexUrl, page(`${routeHtml}<a href="/courses/other-catalog">Courses</a>`, indexUrl)],
    [unrelatedUrl, new Error("private response body and hostname")],
  ]);
  const { run, calls } = discovery(pages, { onDiagnostic: (diagnostic) => diagnostics.push(diagnostic) });
  const result = await run(rootUrl);

  assert.deepEqual(calls.filter((call) => call.type === "request").map((call) => call.url), [rootUrl, indexUrl, unrelatedUrl]);
  assert.deepEqual(result, { status: "provider-failure", category: "unavailable", candidates: [] });
  assert.deepEqual(diagnostics, [{
    stage: "https-request", reason: "unavailable", pagesAttempted: 3, subpageDepth: 2, candidatesFound: 5,
    aggregateBytesAccepted: pages.get(rootUrl).body.byteLength + pages.get(indexUrl).body.byteLength,
  }]);
  assert.equal(JSON.stringify({ result, diagnostics }).includes("private response body and hostname"), false);
  assert.equal(JSON.stringify({ result, diagnostics }).includes("files.example"), false);
  assert.equal(JSON.stringify(result).includes("diagnostic"), false);
});

test("uses distinguishable filename labels when distance evidence is absent", async () => {
  const html = '<article><h3>Course files</h3><a href="/files/east_loop.gpx">GPX track</a><a href="/files/west_loop.gpx">GPX track</a></article>';
  const { run } = discovery(new Map([[
    "https://race.example/event", page(html),
  ]]));
  const result = await run("https://race.example/event");
  assert.equal(result.status, "success");
  assert.deepEqual(result.candidates.map(({ distanceLabel, displayLabel }) => [distanceLabel, displayLabel]), [
    [null, "east loop"], [null, "west loop"],
  ]);
});

test("does not guess a distance when one associated heading names multiple distances", async () => {
  const html = '<article><h3>110K or 21K options</h3><a href="/files/course.gpx">GPX track</a></article>';
  const { run } = discovery(new Map([["https://race.example/event", page(html)]]));
  const result = await run("https://race.example/event");
  assert.equal(result.status, "success");
  assert.deepEqual(result.candidates.map(({ distanceLabel, displayLabel }) => [distanceLabel, displayLabel]), [[null, "course"]]);
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
  const html = '<a href="https://RACE.example:443/course.gpx#top" title="Course > route">Course GPX</a><a href="https://race.example/course.gpx#download">Course GPX duplicate</a><script data-note="><"><a href="/fake.gpx">Fake GPX</a></script>';
  const { run } = discovery(new Map([["https://race.example/event", page(html)]]));
  const result = await run("https://race.example/event");
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].gpxUrl, "https://race.example/course.gpx");
  assert.deepEqual(result.candidates[0].supportingEvidence, [
    "link text: Course GPX", "title: Course > route", "filename: course", "link text: Course GPX duplicate",
  ]);
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
  const invalidDiagnostics = [];
  const htmlInvalid = discovery(new Map([["https://race.example/event", { statusCode: 200, headers: { "content-type": "application/json" }, body: new TextEncoder().encode("{}") }]]), {
    onDiagnostic: (diagnostic) => invalidDiagnostics.push(diagnostic),
  });
  assert.deepEqual(await htmlInvalid.run("https://race.example/event"), { status: "provider-failure", category: "invalid-response", candidates: [] });
  assert.equal(invalidDiagnostics[0].stage, "html-validation");
  assert.equal(invalidDiagnostics[0].reason, "invalid-response");
  const oversizedDiagnostics = [];
  const oversized = discovery(new Map([["https://race.example/event", { statusCode: 200, headers: { "content-type": "text/html" }, body: new Uint8Array(1_000_001) }]]), {
    onDiagnostic: (diagnostic) => oversizedDiagnostics.push(diagnostic),
  });
  assert.deepEqual(await oversized.run("https://race.example/event"), { status: "provider-failure", category: "invalid-response", candidates: [] });
  assert.equal(oversizedDiagnostics[0].reason, "response-size-limit");
  assert.equal(oversizedDiagnostics[0].aggregateBytesAccepted, 0);
});

test("truncated response-read failures remain distinct from size-limit diagnostics", async () => {
  const diagnostics = [];
  const { run } = discovery(new Map(), {
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    request: async (_url, _address, _maxBytes, _timeout, _accept, onStage) => {
      onStage?.("response-read");
      throw new Error("synthetic truncated stream detail");
    },
  });
  assert.deepEqual(await run("https://race.example/event"), { status: "provider-failure", category: "unavailable", candidates: [] });
  assert.deepEqual(diagnostics, [{
    stage: "response-read", reason: "unavailable", pagesAttempted: 1, subpageDepth: 0, candidatesFound: 0,
    aggregateBytesAccepted: 0,
  }]);
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
  const redirectDiagnostics = [];
  const redirectRun = discovery(new Map(), {
    onDiagnostic: (diagnostic) => redirectDiagnostics.push(diagnostic),
    request: async () => {
      redirects++;
      return { statusCode: 302, headers: { location: `/hop-${redirects}` }, body: new Uint8Array() };
    },
  });
  assert.deepEqual(await redirectRun.run("https://race.example/event"), { status: "provider-failure", category: "unavailable", candidates: [] });
  assert.equal(redirects, 3);
  assert.deepEqual(redirectDiagnostics, [{
    stage: "redirect-validation", reason: "unavailable", pagesAttempted: 1, subpageDepth: 0, candidatesFound: 0, aggregateBytesAccepted: 0,
  }]);
});

test("homepage and GPX index pages may together exceed the per-page limit while staying within the aggregate budget", async () => {
  const rootUrl = "https://race.example/hr";
  const indexUrl = "https://race.example/gpx-tracks";
  const htmlByPage = new Map([
    [rootUrl, sizedPage('<a href="/gpx-tracks">GPX tracks</a>', 650_000, rootUrl)],
    [indexUrl, sizedPage('<article><h2>42K</h2><a href="https://files.example/42k.gpx">GPX download</a></article>', 650_000, indexUrl)],
  ]);
  const { run, calls } = discovery(htmlByPage);
  const result = await run(rootUrl);
  assert.equal(result.status, "success");
  assert.equal(result.candidates[0].distanceLabel, "42K");
  assert.deepEqual(calls.filter((call) => call.type === "request").map((call) => call.maxBytes), [1_000_000, 1_000_000]);
  assert.equal(htmlByPage.get(rootUrl).body.byteLength + htmlByPage.get(indexUrl).body.byteLength, 1_300_000);
});

test("aggregate HTML byte limit rejects a crawl above two megabytes and reports safe byte counts", async () => {
  const rootUrl = "https://race.example/hr";
  const indexUrl = "https://race.example/course";
  const detailUrl = "https://race.example/course/details";
  const pages = new Map([
    [rootUrl, sizedPage('<a href="/course">Course</a>', 700_000, rootUrl)],
    [indexUrl, sizedPage('<a href="/course/details">Route details</a>', 700_000, indexUrl)],
    [detailUrl, sizedPage('<a href="https://files.example/route.gpx">Download GPX</a>', 700_000, detailUrl)],
  ]);
  const diagnostics = [];
  const { run, calls } = discovery(pages, { onDiagnostic: (diagnostic) => diagnostics.push(diagnostic) });
  assert.deepEqual(await run(rootUrl), { status: "provider-failure", category: "invalid-response", candidates: [] });
  assert.deepEqual(calls.filter((call) => call.type === "request").map((call) => call.maxBytes), [1_000_000, 1_000_000, 600_000]);
  assert.deepEqual(diagnostics, [{
    stage: "http-response", reason: "response-size-limit", pagesAttempted: 3, subpageDepth: 2, candidatesFound: 0,
    aggregateBytesAccepted: 1_400_000,
  }]);
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
    timeoutMs: 8_000, maxPages: 3, maxSubpageDepth: 2, maxRedirects: 2, maxResponseBytes: 1_000_000, maxTotalResponseBytes: 2_000_000,
    maxCandidates: 20, maxConcurrentPerProcess: 2,
  });
});
