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

function eventStructure(overrides = {}) {
  return {
    headingElements: 0,
    meaningfulHeadingElements: 0,
    prospectsWithMeaningfulAnchorText: 0,
    prospectsWithMeaningfulAriaOrTitle: 0,
    prospectsWithMeaningfulImageAlt: 0,
    prospectsInsideSemanticCards: 0,
    prospectsWithHeadingInSharedContainer: 0,
    prospectsRejectedWithoutSharedHeading: 0,
    prospectsRejectedWithNonMeaningfulHeading: 0,
    prospectsExcludedByNavigation: 0,
    prospectsByAncestorCategory: { semanticCard: 0, section: 0, listOrTable: 0, divContainer: 0, other: 0 },
    maxProspectNestingDepth: 0,
    ...overrides,
  };
}

function eventDiagnostic(overrides = {}) {
  return {
    rootResponseStatus: null,
    rootContentType: null,
    rootHtmlBytesAccepted: 0,
    parsedAnchors: 0,
    sameOriginAnchors: 0,
    eventLinkProspects: 0,
    meaningfulHeadingCount: 0,
    organizerCourseChoicesFound: 0,
    qualifyingLabelsBySource: {
      sharedHeading: 0,
      anchorText: 0,
      ariaOrTitle: 0,
      imageAlt: 0,
      semanticCardContext: 0,
    },
    finalDeduplicatedEventChoices: 0,
    gpxCandidatePrecedenceSuppressed: false,
    explicitGpxIndexPrecedenceSuppressed: false,
    structure: eventStructure(),
    decisionReason: "root-fetch-failure",
    ...overrides,
  };
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

test("follows a GPX-download link to a same-origin index and preserves distinct course and edition evidence", async () => {
  const rootUrl = "https://race.example/";
  const indexUrl = "https://race.example/race/tracks";
  const root = page('<a href="/race/tracks">Download track GPX 2026</a>', rootUrl);
  const index = page([
    '<article><h2>SDT - 100M 2026</h2><a href="https://files.example/SDT_100_M_2026.gpx">DOWNLOAD GPX</a></article>',
    '<article><h2>CPS - 100K 2026</h2><a href="https://files.example/CPS_100_K_2026.gpx">DOWNLOAD GPX</a></article>',
    '<article><h2>ETM - 50K 2026</h2><a href="https://files.example/ETM_50_K_2026.gpx">DOWNLOAD GPX</a></article>',
    '<article><h2>CDA - 20K 2026</h2><a href="https://files.example/CDA_20_K_2026.gpx">DOWNLOAD GPX</a></article>',
  ].join(""), indexUrl);
  const { run, calls } = discovery(new Map([[rootUrl, root], [indexUrl, index]]));
  const result = await run(rootUrl);

  assert.equal(result.status, "success");
  assert.deepEqual(calls.filter((call) => call.type === "request").map((call) => call.url), [rootUrl, indexUrl]);
  assert.equal(result.candidates.length, 4);
  assert.deepEqual(result.candidates.map(({ distanceLabel }) => distanceLabel), ["100M", "100K", "50K", "20K"]);
  assert.ok(result.candidates.every(({ ambiguity }) => ambiguity === "multiple-candidates"));
  assert.ok(result.candidates.every(({ sourcePageUrl }) => sourcePageUrl === indexUrl));
  assert.ok(result.candidates.every(({ supportingEvidence }) => supportingEvidence.some((item) => item === "linked page evidence: Download track GPX 2026")));
  assert.equal(result.candidates.some(({ gpxUrl }) => gpxUrl === indexUrl), false);
  assert.equal("courseSelection" in result, false, "an event-level index must not automatically select a distance");
});

test("course identity and edition conflicts on an indexed GPX page prevent automatic preselection", async () => {
  const rootUrl = "https://race.example/races/100K";
  const indexUrl = "https://race.example/race/tracks";
  const payload = { query: { race: "100K" }, props: { pageProps: { event: { name: "Example Trail", begin: "2026-11-01" } } } };
  const root = page(`<h1>100K course</h1><script id="__NEXT_DATA__">${JSON.stringify(payload)}</script><a href="/race/tracks">Download track GPX 2026</a>`, rootUrl);
  const index = page([
    '<article><h2>2026 - 100K</h2><a href="https://files.example/route_100k_2026.gpx">Download 100K GPX</a></article>',
    '<article><h2>2025 - 100K</h2><a href="https://files.example/route_100k_2025.gpx">Download 100K GPX</a></article>',
  ].join(""), indexUrl);
  const { run } = discovery(new Map([[rootUrl, root], [indexUrl, index]]));
  const result = await run(rootUrl);
  assert.equal(result.status, "success");
  assert.equal(result.courseSelection.identity.courseLabel, "100K");
  assert.equal(result.courseSelection.identity.editionYear, 2026);
  assert.equal(result.courseSelection.preselection, null, "multiple edition candidates remain an explicit user choice");
  assert.deepEqual(result.candidates.map(({ distanceLabel }) => distanceLabel), ["100K", "100K"]);
});

test("organizer homepages return explicit same-origin course choices before any course page is fetched", async () => {
  const rootUrl = "https://organizer.example/";
  const courses = ["11 km", "17 km", "35 km", "64 km", "108 km"];
  const root = page(`<nav><ul>${courses.map((distance) => {
    const number = Number.parseInt(distance, 10);
    return `<li><a href="/razdalje/obala-${number >= 64 ? "ultra-" : ""}trail-${number}-km/">Obala ${number >= 64 ? "Ultra " : ""}Trail ${distance}</a></li>`;
  }).join("")}</ul><a href="/news/64-km-results/">64 km results</a></nav>`, rootUrl);
  const { run, calls } = discovery(new Map([[rootUrl, root]]));
  const result = await run(rootUrl);

  assert.equal(result.status, "course-selection-required");
  assert.deepEqual(result.courses.map(({ distanceLabel }) => distanceLabel), courses);
  assert.deepEqual(result.courses.map(({ displayName }) => displayName), [
    "Obala Trail 11 km", "Obala Trail 17 km", "Obala Trail 35 km", "Obala Ultra Trail 64 km", "Obala Ultra Trail 108 km",
  ]);
  assert.ok(result.courses.every(({ sourcePageUrl }) => sourcePageUrl === rootUrl));
  assert.ok(result.courses.every(({ supportingEvidence }) => supportingEvidence.some((item) => item.startsWith("matching course distance in link and same-origin destination:"))));
  assert.equal(calls.filter((call) => call.type === "request").length, 1, "course links are presented, not crawled or mixed automatically");
  assert.equal(result.courses.some(({ url }) => url.includes("results")), false);
});

test("generic labeled course cards with language-neutral CTAs produce separate choices", async () => {
  const rootUrl = "https://kajbum.example/";
  const html = `<title>Kajbumščak Trail</title><h1>Kajbumščak Trail</h1>
    <section><article><h2>Mali Krap</h2><p>DUŽINA: 9km</p><a href="/krap">SAZNAJ VIŠE</a></article>
    <article><h2>Šumski Gujdek</h2><p>DUŽINA: 18km</p><a href="/gujdek">SAZNAJ VIŠE</a></article>
    <article><h2>Dedek Kajbumščak</h2><p>DUŽINA: 29km</p><a href="/dedek">SAZNAJ VIŠE</a></article></section>
    <nav><a href="/shop/29-km-t-shirt">29 km shirt</a></nav>`;
  const { run, calls } = discovery(new Map([[rootUrl, page(html, rootUrl)]]));
  const result = await run(rootUrl);
  assert.equal(result.status, "course-selection-required");
  assert.deepEqual(result.courses.map(({ url, distanceLabel }) => [url, distanceLabel]), [
    ["https://kajbum.example/krap", "9 km"],
    ["https://kajbum.example/gujdek", "18 km"],
    ["https://kajbum.example/dedek", "29 km"],
  ]);
  assert.deepEqual(result.courses.map(({ displayName }) => displayName), ["Mali Krap", "Šumski Gujdek", "Dedek Kajbumščak"]);
  assert.equal(calls.filter(({ type }) => type === "request").length, 1, "course detail pages are not fetched until the user chooses one");
  assert.equal(result.courses.some(({ url }) => url.includes("shop")), false);
});

test("separately selected short-slug pages keep each official GPX scoped to its course distance", async () => {
  const routes = [
    ["krap", "Mali Krap", "9km", "mali-krap-9k.gpx"],
    ["gujdek", "Šumski Gujdek", "18km", "sumski-gujdek-18k.gpx"],
    ["dedek", "Dedek Kajbumščak", "29km", "dedek-kajbumsak-29k.gpx"],
  ];
  for (const [slug, name, distance, file] of routes) {
    const url = `https://kajbum.example/${slug}`;
    const resourceUrl = `https://files.example/${file}`;
    const html = `<title>Kajbumščak Trail</title><h1>${name}</h1><p>DUŽINA: ${distance}</p><a href="${resourceUrl}">PREUZMI GPX</a>`;
    const result = await (await discovery(new Map([[url, page(html, url)]]))).run(url);
    assert.equal(result.status, "success");
    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0].gpxUrl, resourceUrl);
    assert.equal(result.candidates[0].distanceLabel.replace(/\s/g, "").toLocaleLowerCase().replace(/km$/, "k"), distance.toLocaleLowerCase().replace(/km$/, "k"));
    assert.equal(result.courseSelection.identity.courseLabel.replace(/\s/g, "").toLocaleLowerCase().replace(/km$/, "k"), distance.toLocaleLowerCase().replace(/km$/, "k"));
    assert.equal(result.courseSelection.preselection.resourceUrl, resourceUrl);
  }
});

test("selected short-slug course page binds a single external GPX and keeps route filename year separate", async () => {
  const courseUrl = "https://kajbum.example/gujdek";
  const archiveUrl = "https://filesusr.example/ugd/opaque.gpx?dn=Kajbumscak+Trail+2025+-+Sumski+Gujdek+18k.gpx";
  const html = `<title>Kajbumščak Trail 2026</title><h1>Šumski Gujdek</h1>
    <p>DATUM: 21.06.2026</p><p>DUŽINA: 18km</p>
    <a href="${archiveUrl}">PREUZMI GPX</a>`;
  const { run, calls } = discovery(new Map([[courseUrl, page(html, courseUrl)]]));
  const result = await run(courseUrl);
  assert.equal(result.status, "success");
  assert.deepEqual(calls.filter(({ type }) => type === "request").map(({ url }) => url), [courseUrl]);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].gpxUrl, archiveUrl);
  assert.equal(result.candidates[0].distanceLabel, "18km");
  assert.equal(result.candidates[0].sourcePageUrl, courseUrl);
  assert.equal(result.courseSelection.identity.courseLabel, "18km");
  assert.equal(result.courseSelection.identity.editionYear, 2026);
  assert.equal(result.courseSelection.preselection.resourceUrl, archiveUrl);
  assert.equal(result.courseSelection.preselection.courseIdentity.editionYear, 2026);
  assert.equal(result.courseSelection.preselection.evidence.some((item) => item.includes("2025")), false);
  assert.ok(result.candidates[0].supportingEvidence.some((item) => item.includes("selected official course page confirms course distance")));
});

test("short-slug course pages with multiple distances or no named GPX resource remain unbound", async () => {
  const url = "https://race.example/gujdek";
  const ambiguous = page("<h1>Forest Course</h1><p>Length: 18 km; alternate length: 29 km</p><a href='https://files.example/a.gpx'>GPX</a>", url);
  const ambiguousResult = await (await discovery(new Map([[url, ambiguous]]))).run(url);
  assert.equal(ambiguousResult.status, "success");
  assert.equal("courseSelection" in ambiguousResult, false);

  const noResource = page("<h1>Forest Course</h1><p>Length: 18 km</p>", url);
  const noResourceResult = await (await discovery(new Map([[url, noResource]]))).run(url);
  assert.equal(noResourceResult.status, "no-results");
});

test("short-slug pages keep mismatched or multiple GPX resources explicitly ambiguous", async () => {
  const url = "https://race.example/gujdek";
  const mismatchPage = page('<h1>Forest Gujdek</h1><p>Distance: 18 km</p><a href="https://files.example/route-29k.gpx">29 km GPX</a>', url);
  const mismatch = await (await discovery(new Map([[url, mismatchPage]]))).run(url);
  assert.equal(mismatch.status, "success");
  assert.equal(mismatch.courseSelection.identity.courseLabel, "18 km");
  assert.equal(mismatch.candidates[0].distanceLabel, "29 km");
  assert.equal(mismatch.courseSelection.preselection, null);

  const variantsPage = page('<h1>Forest Gujdek</h1><p>Distance: 18 km</p><a href="https://files.example/route-a.gpx">Download GPX</a><a href="https://files.example/route-b.gpx">Download GPX</a>', url);
  const variants = await (await discovery(new Map([[url, variantsPage]]))).run(url);
  assert.equal(variants.status, "success");
  assert.equal(variants.candidates.length, 2);
  assert.equal(variants.courseSelection.preselection, null);
});

test("multiple explicit course choices take precedence over a competing GPX index link", async () => {
  const rootUrl = "https://organizer.example/";
  const courses = ["11 km", "17 km", "35 km", "64 km", "108 km"];
  const html = [
    '<nav><a href="/race/tracks">Download track GPX 2026</a></nav>',
    ...courses.map((distance) => {
      const number = Number.parseInt(distance, 10);
      return `<li><a href="/razdalje/obala-${number >= 64 ? "ultra-" : ""}trail-${number}-km/">Obala ${number >= 64 ? "Ultra " : ""}Trail ${distance}</a></li>`;
    }),
  ].join("");
  const indexUrl = "https://organizer.example/race/tracks";
  const { run, calls } = discovery(new Map([[rootUrl, page(html, rootUrl)], [indexUrl, page("<main>Course downloads</main>", indexUrl)]]));

  const result = await run(rootUrl);
  assert.equal(result.status, "course-selection-required");
  assert.deepEqual(result.courses.map(({ distanceLabel }) => distanceLabel), courses);
  assert.equal(calls.filter((call) => call.type === "request").length, 1, "the shared index is not fetched before the user scopes discovery to a course");
  assert.equal(result.courses.some(({ url }) => url === indexUrl), false);
});

test("unsuccessful discovery diagnostics count accepted course choices without retaining labels", async () => {
  const rootUrl = "https://organizer.example/";
  const indexUrl = "https://organizer.example/race/tracks";
  const diagnostics = [];
  const pages = new Map([
    [rootUrl, page('<a href="/race/tracks">Download track GPX 2026</a><a href="/razdalje/forest-trail-64-km/">Forest Trail 64 km</a>', rootUrl)],
    [indexUrl, page("<main>Downloads</main>", indexUrl)],
  ]);
  const { run } = discovery(pages, { onDiagnostic: (diagnostic) => diagnostics.push(diagnostic) });

  assert.deepEqual(await run(rootUrl), { status: "no-results", candidates: [] });
  assert.equal(diagnostics[0].eventDetection.organizerCourseChoicesFound, 1);
  assert.equal(diagnostics[0].eventDetection.explicitGpxIndexPrecedenceSuppressed, true);
  assert.equal(diagnostics[0].eventDetection.decisionReason, "explicit-gpx-index-precedence");
  assert.equal(JSON.stringify(diagnostics).includes("Forest Trail"), false);
});

test("explicit course selection restarts scoped discovery with course and edition identity and no cross-course GPX mixing", async () => {
  const rootUrl = "https://organizer.example/";
  const courseUrl = "https://organizer.example/razdalje/obala-ultra-trail-64-km/";
  const root = page([
    '<a href="/razdalje/obala-ultra-trail-64-km/">Obala Ultra Trail 64 km</a>',
    '<a href="/razdalje/obala-ultra-trail-108-km/">Obala Ultra Trail 108 km</a>',
  ].join(""), rootUrl);
  const coursePage = page('<title>Obala Ultra Trail 64 km 2026</title><h1>Obala Ultra Trail 64 km</h1><a href="/downloads/obala-64-km.gpx">GPX file download</a>', courseUrl);
  const pages = new Map([[rootUrl, root], [courseUrl, coursePage]]);
  const first = await (await discovery(pages)).run(rootUrl);
  assert.equal(first.status, "course-selection-required");
  const selected = first.courses.find(({ distanceLabel }) => distanceLabel === "64 km");
  assert.ok(selected);
  assert.equal(selected.url, courseUrl);

  const { run, calls } = discovery(pages);
  const result = await run(selected.url);
  assert.equal(result.status, "success");
  assert.deepEqual(calls.filter((call) => call.type === "request").map((call) => call.url), [courseUrl]);
  assert.deepEqual(result.candidates.map(({ distanceLabel }) => distanceLabel), ["64 km"]);
  assert.equal(result.courseSelection.identity.courseLabel, "64 km");
  assert.equal(result.courseSelection.identity.editionYear, 2026);
  assert.equal(result.courseSelection.identity.eventName, "Obala Ultra Trail 64 km 2026");
  assert.equal(result.courseSelection.preselection.resourceUrl, "https://organizer.example/downloads/obala-64-km.gpx");
});

test("does not turn unrelated distance-bearing links or mismatched course destinations into course choices", async () => {
  const rootUrl = "https://organizer.example/";
  const html = [
    '<nav><a href="/news/trail-results-64-km/">Read the 64 km race results</a></nav>',
    '<section><h2>Latest news</h2><a href="/stories/forest-35-km/">Forest trail story 35 km</a></section>',
    '<section><h2>Distances</h2><a href="/courses/64-km/">Example Trail course 35 km</a></section>',
  ].join("");
  const result = await (await discovery(new Map([
    [rootUrl, page(html, rootUrl)],
    ["https://organizer.example/courses/64-km/", page("<p>Course information</p>", "https://organizer.example/courses/64-km/")],
  ]))).run(rootUrl);
  assert.equal(result.status, "no-results");
});

test("duplicate course destinations with conflicting edition evidence do not present an arbitrary year", async () => {
  const rootUrl = "https://organizer.example/";
  const html = [
    '<a href="/distances/forest-trail-64-km/">Forest Trail 64 km 2026</a>',
    '<a href="/distances/forest-trail-64-km/">Forest Trail 64 km 2027</a>',
    '<a href="/distances/forest-trail-108-km/">Forest Trail 108 km 2026</a>',
  ].join("");
  const result = await (await discovery(new Map([[rootUrl, page(html, rootUrl)]]))).run(rootUrl);
  assert.equal(result.status, "course-selection-required");
  const course = result.courses.find(({ distanceLabel }) => distanceLabel === "64 km");
  assert.ok(course);
  assert.equal(course.editionYear, null);
  assert.ok(course.supportingEvidence.some((item) => item.includes("2026")));
  assert.ok(course.supportingEvidence.some((item) => item.includes("2027")));
});

test("keeps multiple distances ambiguous and never chooses a winner", async () => {
  const { run } = discovery(new Map([["https://race.example/event", page('<a href="/a.gpx">25 km GPX</a><a href="/b.gpx">50 km GPX</a>')]]));
  const result = await run("https://race.example/event");
  assert.equal(result.status, "success");
  assert.deepEqual(result.candidates.map(({ distanceLabel, ambiguity }) => [distanceLabel, ambiguity]), [["25 km", "multiple-candidates"], ["50 km", "multiple-candidates"]]);
});

test("course-specific URL preselects one exact course resource while event-level URLs keep the course selector", async () => {
  const courseUrl = "https://race.example/hr/races/110K";
  const payload = { query: { race: "110K" }, props: { pageProps: { event: { name: "Example Trail", begin: "2027-04-03" } } } };
  const html = `<title>110 km | Example Trail</title><h1>110K course</h1><script id="__NEXT_DATA__">${JSON.stringify(payload)}</script>
    <article><h2>110K</h2><a href="https://files.example/course_110k_2027.gpx">Download 110K GPX</a></article>
    <article><h2>50K</h2><a href="https://files.example/course_50k_2027.gpx">Download 50K GPX</a></article>`;
  const pages = new Map([[courseUrl, page(html, courseUrl)]]);
  const { run } = discovery(pages);
  const result = await run(courseUrl);
  assert.equal(result.status, "success");
  assert.deepEqual(result.candidates.map((candidate) => candidate.distanceLabel), ["110K", "50K"]);
  assert.equal(result.courseSelection.identity.courseLabel, "110K");
  assert.equal(result.courseSelection.identity.editionYear, 2027);
  assert.equal(result.courseSelection.preselection.resourceUrl, "https://files.example/course_110k_2027.gpx");
  assert.equal(result.courseSelection.preselection.resourceType, "gpx");

  const eventUrl = "https://race.example/event";
  const eventResult = await (await discovery(new Map([[eventUrl, page(html, eventUrl)]]))).run(eventUrl);
  assert.equal(eventResult.status, "success");
  assert.equal("courseSelection" in eventResult, false, "event-level URLs must retain manual course selection");
});

test("course-specific discovery refuses multiple editions, variants, and approximate-distance candidates", async () => {
  const courseUrl = "https://race.example/courses/50K";
  const payload = { query: { course: "50K" }, props: { pageProps: { event: { name: "Example Trail", begin: "2027-04-03" } } } };
  const structured = `<h1>50K course</h1><script id="__NEXT_DATA__">${JSON.stringify(payload)}</script>`;
  const variants = page(`${structured}<a href="https://files.example/route_50k_2027.gpx">50K GPX 2027</a><a href="https://files.example/route_50k_2026.gpx">50K GPX 2026</a>`, courseUrl);
  const multiple = await (await discovery(new Map([[courseUrl, variants]]))).run(courseUrl);
  assert.equal(multiple.courseSelection.preselection, null);

  const approximate = page(`${structured}<a href="https://files.example/route_51k_2027.gpx">51 km GPX 2027</a>`, courseUrl);
  const mismatch = await (await discovery(new Map([[courseUrl, approximate]]))).run(courseUrl);
  assert.equal(mismatch.courseSelection.preselection, null);
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

test("returns evidence-backed organizer event choices instead of crawling and mixing event routes", async () => {
  const rootUrl = "https://organizer.example/";
  const html = [
    '<nav><a href="/about">About</a><a href="/races/100M">SDT - Serra de Tramuntana</a></nav>',
    '<main>',
    '<article><h2>External Ultra Trail</h2><a href="https://external.example/event">Details</a></article>',
    '<article><h2>Ultra Trail Učka</h2><a href="/ultra-trail-ucka">Saznaj više</a></article>',
    '<article><h2>Rika Vertikal</h2><a href="/rika-vertikal">Saznaj više</a></article>',
    '<article><h2>Drenova Trail</h2><a href="/drenova-trail">Saznaj više</a></article>',
    '<article><h2>Malinska Trail</h2><a href="/malinska-trail">Saznaj više</a></article>',
    '</main>',
  ].join("");
  const { run, calls } = discovery(new Map([[rootUrl, page(html, rootUrl)]]));
  const result = await run(rootUrl);
  assert.equal(result.status, "event-selection-required");
  assert.deepEqual(result.events.map(({ displayName, url }) => [displayName, url]), [
    ["Ultra Trail Učka", "https://organizer.example/ultra-trail-ucka"],
    ["Rika Vertikal", "https://organizer.example/rika-vertikal"],
    ["Drenova Trail", "https://organizer.example/drenova-trail"],
    ["Malinska Trail", "https://organizer.example/malinska-trail"],
  ]);
  assert.ok(result.events.every((event) => event.sourcePageUrl === rootUrl && event.supportingEvidence.includes(`associated heading: ${event.displayName}`)));
  assert.equal(calls.filter((call) => call.type === "request").length, 1, "event pages are not fetched before user selection");
});

test("associates organizer event-card sibling headings with generic learn-more links", async () => {
  const rootUrl = "https://organizer.example/";
  const html = [
    '<main><article class="event-card"><h2>Forest Ultra</h2><div class="actions"><a href="/forest-ultra">Learn more</a></div></article>',
    '<article class="event-card"><h2>Ridge Trail</h2><div class="actions"><a href="/ridge-trail">Saznaj više</a></div></article></main>',
  ].join("");
  const { run, calls } = discovery(new Map([[rootUrl, page(html, rootUrl)]]));
  const result = await run(rootUrl);

  assert.equal(result.status, "event-selection-required");
  assert.deepEqual(result.events.map(({ displayName, url }) => [displayName, url]), [
    ["Forest Ultra", "https://organizer.example/forest-ultra"],
    ["Ridge Trail", "https://organizer.example/ridge-trail"],
  ]);
  assert.ok(result.events.every((event) => event.supportingEvidence.includes(`associated heading: ${event.displayName}`)));
  assert.equal(calls.filter((call) => call.type === "request").length, 1);
});

test("discovers distinct event choices from descriptive same-origin card links without headings", async () => {
  const rootUrl = "https://organizer.example/";
  const html = [
    '<main><article><a href="/coastal-ultra">Coastal Ultra Trail</a></article>',
    '<article><a href="/forest-vertical">Forest Vertical Race</a></article>',
    '<article><a href="/coastal-ultra">Coastal Ultra Trail</a></article></main>',
    '<nav><a href="/about">About the Organizer</a></nav>',
  ].join("");
  const { run, calls } = discovery(new Map([[rootUrl, page(html, rootUrl)]]));
  const result = await run(rootUrl);

  assert.equal(result.status, "event-selection-required");
  assert.deepEqual(result.events.map(({ displayName, url }) => [displayName, url]), [
    ["Coastal Ultra Trail", "https://organizer.example/coastal-ultra"],
    ["Forest Vertical Race", "https://organizer.example/forest-vertical"],
  ]);
  assert.ok(result.events.every((event) => event.supportingEvidence.some((item) => item.startsWith("link text:"))));
  assert.equal(calls.filter((call) => call.type === "request").length, 1);
});

test("uses a bounded semantic-card label for generic event actions and supports image and accessible labels", async () => {
  const rootUrl = "https://organizer.example/";
  const html = [
    '<main><article class="event-card"><div>Mountain Ultra Challenge</div><a href="/mountain-ultra">Saznaj više</a></article>',
    '<article class="event-card"><a href="/ridge-trail" aria-label="Ridge Trail Race"><img alt="Ridge Trail Race event"></a></article>',
    '<article class="event-card"><div class="event-title">Valley Trail Festival</div><a href="/valley-trail" title="Valley Trail Festival">Details</a></article></main>',
  ].join("");
  const { run } = discovery(new Map([[rootUrl, page(html, rootUrl)]]));
  const result = await run(rootUrl);

  assert.equal(result.status, "event-selection-required");
  assert.deepEqual(result.events.map((event) => event.displayName), [
    "Mountain Ultra Challenge", "Ridge Trail Race", "Valley Trail Festival",
  ]);
  assert.ok(result.events[0].supportingEvidence.includes("associated card label: Mountain Ultra Challenge"));
  assert.ok(result.events[1].supportingEvidence.includes("aria-label: Ridge Trail Race"));
  assert.ok(result.events[2].supportingEvidence.includes("title: Valley Trail Festival"));
});

test("RIKA-style named event cards without headings use their local labels instead of generic CTAs", async () => {
  const rootUrl = "https://organizer.example/";
  const html = [
    '<main><article class="event-card"><div>Ultra Trail Učka</div><a href="/event-a">Saznaj više</a></article>',
    '<article class="event-card"><div>Rika Vertikal</div><a href="/event-b">Saznaj više</a></article>',
    '<article class="event-card"><div>Drenova Trail</div><a href="/event-c">Saznaj više</a></article></main>',
  ].join("");
  const { run, calls } = discovery(new Map([[rootUrl, page(html, rootUrl)]]));
  const result = await run(rootUrl);

  assert.equal(result.status, "event-selection-required");
  assert.deepEqual(result.events.map((event) => event.displayName), ["Ultra Trail Učka", "Rika Vertikal", "Drenova Trail"]);
  assert.ok(result.events.every((event) => event.linkText === "Saznaj više"));
  assert.equal(calls.filter((call) => call.type === "request").length, 1);
});

test("explicit event-card evidence permits meaningful local event names without English race keywords", async () => {
  const rootUrl = "https://organizer.example/";
  const html = [
    '<main><article class="event-card"><a href="/event-a">Učka Gathering</a></article>',
    '<article class="race-card"><div>Drenova Celebration</div><a href="/event-b">Learn more</a></article></main>',
  ].join("");
  const { run } = discovery(new Map([[rootUrl, page(html, rootUrl)]]));
  const result = await run(rootUrl);

  assert.equal(result.status, "event-selection-required");
  assert.deepEqual(result.events.map((event) => event.displayName), ["Učka Gathering", "Drenova Celebration"]);
  assert.ok(result.events[0].supportingEvidence.includes("link text: Učka Gathering"));
  assert.ok(result.events[1].supportingEvidence.includes("associated card label: Drenova Celebration"));
});

test("event-name keywords remain required outside explicit event cards and generic cards need event evidence", async () => {
  const rootUrl = "https://organizer.example/";
  const html = [
    '<main><article class="card"><a href="/news-one">Community Update</a></article>',
    '<article class="card"><a href="/news-two">Volunteer Gathering</a></article>',
    '<article><a href="/ordinary-one">Local Celebration</a></article>',
    '<article><a href="/ordinary-two">Village Weekend</a></article>',
    '<article class="event-card"><a href="/empty-one">Learn more</a></article>',
    '<article class="event-card"><a href="/empty-two">Details</a></article></main>',
  ].join("");
  const { run } = discovery(new Map([[rootUrl, page(html, rootUrl)]]));

  assert.deepEqual(await run(rootUrl), { status: "no-results", candidates: [] });
});

test("does not promote generic links, non-card labels, or distance-specific pages to event choices", async () => {
  const rootUrl = "https://organizer.example/";
  const html = [
    '<main><a href="/join" title="Join Our Community">Learn more</a>',
    '<article><a href="/races/100M">100M Ultra Trail</a></article>',
    '<div><span>Unrelated Mountain Race</span><a href="/unlabeled">Saznaj vise</a></div>',
    '<article><a href="/real-ultra">Real Ultra Trail Event</a></article></main>',
    '<footer><article><a href="/footer-race">Footer Mountain Race</a></article></footer>',
  ].join("");
  const diagnostics = [];
  const { run } = discovery(new Map([
    [rootUrl, page(html, rootUrl)],
    ["https://organizer.example/races/100M", page("<main><p>No route resources here.</p></main>", "https://organizer.example/races/100M")],
    ["https://organizer.example/real-ultra", page("<main><p>No route resources here.</p></main>", "https://organizer.example/real-ultra")],
  ]), { onDiagnostic: (item) => diagnostics.push(item) });
  const result = await run(rootUrl);

  assert.equal(result.status, "no-results", JSON.stringify({ result, diagnostics }));
});

test("deduplicates no-heading event links and retains the strongest available label", async () => {
  const rootUrl = "https://organizer.example/";
  const html = '<main><article><a href="/one">Coastal Trail Race</a><a href="/one" title="Coastal Trail">Details</a><a href="/two">Forest Ultra Event</a></article></main>';
  const { run } = discovery(new Map([[rootUrl, page(html, rootUrl)]]));
  const result = await run(rootUrl);

  assert.equal(result.status, "event-selection-required");
  assert.equal(result.events.filter((event) => event.url === "https://organizer.example/one").length, 1);
  assert.equal(result.events[0].displayName, "Coastal Trail Race");
  assert.ok(result.events[0].supportingEvidence.includes("title: Coastal Trail"));
});

test("unusable short HTTP 202 HTML returns no-results without attempting to bypass the response", async () => {
  const rootUrl = "https://organizer.example/";
  const body = new TextEncoder().encode("<!doctype html><html><body>Page temporarily unavailable</body></html>");
  const response = { statusCode: 202, headers: { "content-type": "text/html; charset=utf-8" }, body, url: rootUrl };
  const { run, calls } = discovery(new Map([[rootUrl, response]]));

  assert.deepEqual(await run(rootUrl), { status: "no-results", candidates: [] });
  assert.equal(calls.filter((call) => call.type === "request").length, 1);
});

test("associates a preceding heading through nested wrappers within the same semantic card", async () => {
  const rootUrl = "https://organizer.example/";
  const html = [
    '<div class="race-card"><div class="card-content"><h3>Coastal Mountain Race</h3></div><div class="card-actions"><div><a href="/coastal-mountain">Details</a></div></div></div>',
    '<div class="race-card"><div><h3>Valley Trail Event</h3></div><div><a href="/valley-trail">Find out more</a></div></div>',
  ].join("");
  const { run } = discovery(new Map([[rootUrl, page(html, rootUrl)]]));
  const result = await run(rootUrl);

  assert.equal(result.status, "event-selection-required");
  assert.deepEqual(result.events.map((event) => event.displayName), ["Coastal Mountain Race", "Valley Trail Event"]);
});

test("does not borrow a heading from a neighboring card without its own heading", async () => {
  const rootUrl = "https://organizer.example/";
  const html = [
    '<article><h2>Named Mountain Event</h2><a href="/named">Details</a></article>',
    '<article><a href="/unlabeled">Learn more</a></article>',
  ].join("");
  const diagnostics = [];
  const { run } = discovery(new Map([[rootUrl, page(html, rootUrl)]]), { onDiagnostic: (item) => diagnostics.push(item) });
  const result = await run(rootUrl);

  assert.deepEqual(result, { status: "no-results", candidates: [] });
  assert.equal(diagnostics[0].eventDetection.meaningfulHeadingCount, 1);
  assert.equal(diagnostics[0].eventDetection.finalDeduplicatedEventChoices, 1);
});

test("navigation and footer links are excluded from organizer event choices", async () => {
  const rootUrl = "https://organizer.example/";
  const html = [
    '<header><div class="event-card"><h2>Header Navigation Race</h2><a href="/header-info">Details</a></div></header>',
    '<main><p>No event cards here.</p></main>',
    '<footer><article><h2>Footer Race</h2><a href="/footer-info">Learn more</a></article></footer>',
  ].join("");
  const diagnostics = [];
  const { run } = discovery(new Map([[rootUrl, page(html, rootUrl)]]), { onDiagnostic: (item) => diagnostics.push(item) });
  const result = await run(rootUrl);

  assert.deepEqual(result, { status: "no-results", candidates: [] });
  assert.equal(diagnostics[0].eventDetection.eventLinkProspects, 0);
  assert.equal(diagnostics[0].eventDetection.finalDeduplicatedEventChoices, 0);
});

test("no-results diagnostics identify missing meaningful headings without recording page data", async () => {
  const rootUrl = "https://organizer.example/?tracking=private-query-value";
  const html = '<main><a href="/ultra-one">Saznaj više</a><a href="/vertical-two">Saznaj više</a><a href="https://external.example/event">External event</a></main>';
  const diagnostics = [];
  const { run } = discovery(new Map([[rootUrl, page(html, rootUrl)]]), {
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  });

  const result = await run(rootUrl);
  assert.deepEqual(result, { status: "no-results", candidates: [] });
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].reason, "no-results");
  assert.deepEqual(diagnostics[0].eventDetection, {
    rootResponseStatus: 200,
    rootContentType: "text/html",
    rootHtmlBytesAccepted: Buffer.byteLength(`<!doctype html><html><body>${html}</body></html>`),
    parsedAnchors: 3,
    sameOriginAnchors: 2,
    eventLinkProspects: 2,
    meaningfulHeadingCount: 0,
    organizerCourseChoicesFound: 0,
    qualifyingLabelsBySource: {
      sharedHeading: 0,
      anchorText: 0,
      ariaOrTitle: 0,
      imageAlt: 0,
      semanticCardContext: 0,
    },
    finalDeduplicatedEventChoices: 0,
    gpxCandidatePrecedenceSuppressed: false,
    explicitGpxIndexPrecedenceSuppressed: false,
    structure: eventStructure({
      headingElements: 0,
      meaningfulHeadingElements: 0,
      prospectsRejectedWithoutSharedHeading: 2,
      prospectsByAncestorCategory: { semanticCard: 0, section: 0, listOrTable: 0, divContainer: 0, other: 2 },
      maxProspectNestingDepth: 3,
    }),
    decisionReason: "no-meaningful-headings",
  });
  const serialized = JSON.stringify(diagnostics);
  for (const privateValue of ["private-query-value", "private-label-one", "private-label-two", "/ultra-one", "organizer.example"]) {
    assert.equal(serialized.includes(privateValue), false, privateValue);
  }
});

test("structural event diagnostics distinguish heading and explicit link evidence without retaining labels", async () => {
  const rootUrl = "https://organizer.example/";
  const html = [
    '<nav><h2>Upcoming Races</h2><a href="/nav-link">Learn more</a></nav>',
    '<article><h2>Mountain Ultra</h2><div><a href="/one">Learn more</a></div></article>',
    '<article><h3>More</h3><a href="/two">Learn more</a></article>',
    '<div><a href="/three" aria-label="Coastal Trail Race" title="Coastal Trail details"><img alt="Coastal Trail event"></a></div>',
    '<div><a href="/four">Forest Gathering Details</a></div>',
  ].join("");
  const diagnostics = [];
  const { run } = discovery(new Map([[rootUrl, page(html, rootUrl)]]), { onDiagnostic: (item) => diagnostics.push(item) });

  assert.deepEqual(await run(rootUrl), { status: "no-results", candidates: [] });
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].eventDetection.eventLinkProspects, 4);
  assert.equal(diagnostics[0].eventDetection.meaningfulHeadingCount, 1);
  assert.deepEqual(diagnostics[0].eventDetection.qualifyingLabelsBySource, {
    sharedHeading: 1,
    anchorText: 0,
    ariaOrTitle: 0,
    imageAlt: 0,
    semanticCardContext: 0,
  });
  assert.equal(diagnostics[0].eventDetection.structure.headingElements, 3);
  assert.equal(diagnostics[0].eventDetection.structure.meaningfulHeadingElements, 2);
  assert.equal(diagnostics[0].eventDetection.structure.prospectsWithMeaningfulAnchorText, 1);
  assert.equal(diagnostics[0].eventDetection.structure.prospectsWithMeaningfulAriaOrTitle, 1);
  assert.equal(diagnostics[0].eventDetection.structure.prospectsWithMeaningfulImageAlt, 1);
  assert.equal(diagnostics[0].eventDetection.structure.prospectsInsideSemanticCards, 2);
  assert.equal(diagnostics[0].eventDetection.structure.prospectsWithHeadingInSharedContainer, 2);
  assert.equal(diagnostics[0].eventDetection.structure.prospectsRejectedWithoutSharedHeading, 2);
  assert.equal(diagnostics[0].eventDetection.structure.prospectsRejectedWithNonMeaningfulHeading, 1);
  assert.equal(diagnostics[0].eventDetection.structure.prospectsExcludedByNavigation, 1);
  assert.deepEqual(diagnostics[0].eventDetection.structure.prospectsByAncestorCategory, {
    semanticCard: 2, section: 0, listOrTable: 0, divContainer: 2, other: 0,
  });
  assert.equal(diagnostics[0].eventDetection.structure.maxProspectNestingDepth, 4);
  const serialized = JSON.stringify(diagnostics);
  for (const privateValue of ["Mountain Ultra", "Coastal Trail Race", "Forest Gathering Details", "/three", "organizer.example"]) {
    assert.equal(serialized.includes(privateValue), false, privateValue);
  }
  assert.ok(serialized.length < 1800, "fixed counter payload remains small");
});

test("unsuccessful discovery counts qualifying label source without retaining labels", async () => {
  const rootUrl = "https://organizer.example/";
  const html = [
    '<article><h2>Alpine Trail Event</h2><a href="/same">Learn more</a></article>',
    '<a href="/same">Ultra Trail One</a>',
    '<article><a href="/same" aria-label="Ultra Trail Two">Learn more</a></article>',
    '<article><a href="/same"><img alt="Mountain Trail Race"></a></article>',
    '<article>Forest Trail Event Four<a href="/same">Learn more</a></article>',
  ].join("");
  const diagnostics = [];
  const { run } = discovery(new Map([[rootUrl, page(html, rootUrl)]]), { onDiagnostic: (item) => diagnostics.push(item) });

  assert.deepEqual(await run(rootUrl), { status: "no-results", candidates: [] });
  assert.equal(diagnostics.length, 1);
  assert.deepEqual(diagnostics[0].eventDetection.qualifyingLabelsBySource, {
    sharedHeading: 1,
    anchorText: 1,
    ariaOrTitle: 1,
    imageAlt: 1,
    semanticCardContext: 1,
  });
  assert.equal(diagnostics[0].eventDetection.finalDeduplicatedEventChoices, 1);
  const serialized = JSON.stringify(diagnostics);
  for (const privateValue of ["Alpine Trail Event", "Ultra Trail One", "Ultra Trail Two", "Mountain Trail Race", "Forest Trail Event Four", "/same", "organizer.example"]) {
    assert.equal(serialized.includes(privateValue), false, privateValue);
  }
  assert.ok(serialized.length < 2_000, "source counters keep the diagnostic payload bounded");
});

test("structural event counters and nesting depth are capped for dense pages", async () => {
  const rootUrl = "https://organizer.example/";
  const deepAction = `${"<div>".repeat(40)}<a href="/details">Learn more</a>${"</div>".repeat(40)}`;
  const denseMarkup = Array.from({ length: 1100 }, () => `<article><h2>Mountain Event</h2>${deepAction}</article>`).join("");
  const diagnostics = [];
  const { run } = discovery(new Map([[rootUrl, page(denseMarkup, rootUrl)]]), { onDiagnostic: (item) => diagnostics.push(item) });

  assert.deepEqual(await run(rootUrl), { status: "no-results", candidates: [] });
  const diagnostic = diagnostics[0].eventDetection;
  assert.equal(diagnostic.parsedAnchors, 1000);
  assert.equal(diagnostic.sameOriginAnchors, 1000);
  assert.equal(diagnostic.eventLinkProspects, 1000);
  assert.equal(diagnostic.structure.headingElements, 1000);
  assert.equal(diagnostic.structure.meaningfulHeadingElements, 1000);
  assert.equal(diagnostic.structure.maxProspectNestingDepth, 32);
  assert.ok(JSON.stringify(diagnostic).length < 1800);
});

test("no-results diagnostics show when an explicit GPX index takes precedence over event choices", async () => {
  const rootUrl = "https://organizer.example/";
  const indexUrl = "https://organizer.example/gpx-tracks";
  const html = '<nav><a href="/gpx-tracks">GPX tracks</a></nav><article><h2>Mountain Event One</h2><a href="/mountain-one">Details</a></article><article><h2>Mountain Event Two</h2><a href="/mountain-two">Details</a></article>';
  const diagnostics = [];
  const { run, calls } = discovery(new Map([
    [rootUrl, page(html, rootUrl)],
    [indexUrl, page("<main><h1>Course downloads</h1></main>", indexUrl)],
  ]), { onDiagnostic: (diagnostic) => diagnostics.push(diagnostic) });

  assert.deepEqual(await run(rootUrl), { status: "no-results", candidates: [] });
  assert.deepEqual(calls.filter((call) => call.type === "request").map((call) => call.url), [rootUrl, indexUrl]);
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].eventDetection.decisionReason, "explicit-gpx-index-precedence");
  assert.equal(diagnostics[0].eventDetection.explicitGpxIndexPrecedenceSuppressed, true);
  assert.equal(diagnostics[0].eventDetection.gpxCandidatePrecedenceSuppressed, false);
  assert.equal(diagnostics[0].eventDetection.eventLinkProspects, 2);
  assert.equal(diagnostics[0].eventDetection.meaningfulHeadingCount, 2);
  assert.equal(diagnostics[0].eventDetection.finalDeduplicatedEventChoices, 2);
});

test("root response diagnostics use bounded safe reason codes for unsuitable HTML", async () => {
  const cases = [
    ["http status", { statusCode: 403, headers: { "content-type": "text/html" }, body: new TextEncoder().encode("blocked") }, "root-http-status", "text/html"],
    ["content type", { statusCode: 200, headers: { "content-type": "application/json; private=secret" }, body: new TextEncoder().encode("{}") }, "root-non-html-content-type", "other"],
    ["missing content type", { statusCode: 200, headers: {}, body: new TextEncoder().encode("<!doctype html><html></html>") }, "root-non-html-content-type", "missing"],
    ["empty body", { statusCode: 200, headers: { "content-type": "text/html" }, body: new Uint8Array() }, "root-empty-body", "text/html"],
    ["unsupported encoding", { statusCode: 200, headers: { "content-type": "text/html", "content-encoding": "gzip" }, body: new TextEncoder().encode("<!doctype html><html></html>") }, "root-unsupported-content-encoding", "text/html"],
    ["malformed document", { statusCode: 200, headers: { "content-type": "text/html" }, body: new TextEncoder().encode("not html") }, "root-invalid-html-document", "text/html"],
  ];

  for (const [label, response, reason, contentType] of cases) {
    const diagnostics = [];
    const { run } = discovery(new Map([["https://race.example/event", response]]), {
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    assert.deepEqual(await run("https://race.example/event"), { status: "provider-failure", category: "invalid-response", candidates: [] }, label);
    assert.equal(diagnostics.length, 1, label);
    assert.equal(diagnostics[0].eventDetection.rootContentType, contentType, label);
    assert.equal(diagnostics[0].eventDetection.decisionReason, reason, label);
    assert.equal(diagnostics[0].eventDetection.rootHtmlBytesAccepted, 0, label);
    assert.equal(JSON.stringify(diagnostics).includes("secret"), false, label);
  }
});

test("selected organizer event gets scoped discovery and exposes explicitly GPX-labeled ZIP as an archive choice", async () => {
  const rootUrl = "https://organizer.example/";
  const eventUrl = "https://organizer.example/ultra-trail-ucka";
  const pages = new Map([
    [rootUrl, page('<main><article><h2>Ultra Trail Učka</h2><a href="/ultra-trail-ucka">Saznaj više</a></article><article><h2>Rika Vertikal</h2><a href="/rika-vertikal">Saznaj više</a></article><article><h2>Drenova Trail</h2><a href="/drenova-trail">Saznaj više</a></article></main>', rootUrl)],
    [eventUrl, page('<section><h2>UTU 85km / 4600m+</h2><a href="/uploads/utu-course.zip">DOWNLOAD GPX</a></section>', eventUrl)],
  ]);
  const { run, calls } = discovery(pages);
  const choices = await run(rootUrl);
  assert.equal(choices.status, "event-selection-required");
  const scoped = await run(choices.events[0].url);
  assert.deepEqual(scoped, {
    status: "success",
    candidates: [],
    archives: [{
      archiveUrl: "https://organizer.example/uploads/utu-course.zip",
      sourcePageUrl: eventUrl,
      displayLabel: "UTU 85km / 4600m+",
      linkText: "DOWNLOAD GPX",
      supportingEvidence: ["link text: DOWNLOAD GPX", "associated heading: UTU 85km / 4600m+", "resource format: ZIP archive; contained GPX not yet verified"],
      distanceLabel: "85 km",
      resourceType: "zip-archive",
      discoveryStatus: "archive-link-evidence-only",
      ambiguity: null,
    }],
  });
  assert.deepEqual(calls.filter((call) => call.type === "request").map((call) => call.url), [rootUrl, eventUrl]);
});

test("multiple distance archives on one event page become distinct archive-backed course choices", async () => {
  const eventUrl = "https://organizer.example/ultra-trail-ucka";
  const html = [
    '<section><h2>UTU 85km / 4600m+</h2><a href="/uploads/utu.zip">GPX</a></section>',
    '<section><h2>ULC 42km / 2200m+</h2><a href="/uploads/ulc.zip">GPX</a></section>',
    '<section><h2>ULA 22km / 1200m+</h2><a href="/uploads/ula.zip">GPX</a></section>',
  ].join("");
  const { run } = discovery(new Map([[eventUrl, page(html, eventUrl)]]));
  const result = await run(eventUrl);
  assert.equal(result.status, "success");
  assert.deepEqual(result.archives.map((resource) => resource.displayLabel), [
    "UTU 85km / 4600m+", "ULC 42km / 2200m+", "ULA 22km / 1200m+",
  ]);
  assert.deepEqual(result.archives.map((resource) => resource.distanceLabel), ["85 km", "42 km", "22 km"]);
  assert.equal(result.archives.every((resource) => resource.discoveryStatus === "archive-link-evidence-only"), true);
  assert.equal(result.archives.every((resource) => resource.ambiguity === "multiple-candidates"), true);
});

test("two distinct event cards are sufficient to request explicit event selection", async () => {
  const rootUrl = "https://organizer.example/";
  const html = '<main><article><h2>Ultra Trail A</h2><a href="/ultra-trail-a">Details</a></article><article><h2>City Marathon B</h2><a href="/city-marathon-b">Details</a></article></main>';
  const { run } = discovery(new Map([[rootUrl, page(html, rootUrl)]]));
  const result = await run(rootUrl);
  assert.equal(result.status, "event-selection-required");
  assert.equal(result.events.length, 2);
});

test("single-event homepage with an explicit GPX index keeps the existing crawl flow", async () => {
  const rootUrl = "https://istria.example/hr";
  const indexUrl = "https://istria.example/runners/gpx-tracks";
  const pages = new Map([
    [rootUrl, page('<main><article><h2>Istria 100</h2><a href="/races/110k">Istria 110K</a></article><nav><a href="/runners/gpx-tracks">GPX zapisi</a></nav></main>', rootUrl)],
    [indexUrl, page('<article><h3>Istria 110K</h3><a href="https://files.example/istria-110k.gpx">GPX</a></article>', indexUrl)],
  ]);
  const { run, calls } = discovery(pages);
  const result = await run(rootUrl);
  assert.equal(result.status, "success");
  assert.equal(result.candidates[0].distanceLabel, "110K");
  assert.deepEqual(calls.filter((call) => call.type === "request").map((call) => call.url), [rootUrl, indexUrl]);
});

test("a course page follows its explicitly described same-origin map details page and finds linked GPX", async () => {
  const courseUrl = "https://race.example/routes/coastal-ultra/";
  const mapUrl = "https://race.example/map/coastal-ultra/";
  const fileUrl = "https://race.example/files/coastal-ultra.gpx";
  const pages = new Map([
    [courseUrl, page('<h1>Coastal Ultra</h1><p>Distance: 80 km</p><a href="/map/coastal-ultra/">Details</a><p>To download the GPX track of the route, click on Details in the top right corner of the map.</p>', courseUrl)],
    [mapUrl, page('<main><h2>Coastal Ultra route map</h2><a href="/files/coastal-ultra.gpx">Download GPX</a></main>', mapUrl)],
  ]);
  const { run, calls } = discovery(pages);
  const result = await run(courseUrl);
  assert.equal(result.status, "success");
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].gpxUrl, fileUrl);
  assert.deepEqual(calls.filter((call) => call.type === "request").map((call) => call.url), [courseUrl, mapUrl]);
});

test("map page with no explicit GPX resource returns no candidates and static GPX metadata is narrowly recognized", async () => {
  const courseUrl = "https://race.example/routes/coastal-ultra/";
  const mapUrl = "https://race.example/map/coastal-ultra/";
  const noExport = new Map([
    [courseUrl, page('<h1>Coastal Ultra</h1><p>80 km. To download the GPX track, click on Details in the map.</p><a href="/map/coastal-ultra/">Details</a>', courseUrl)],
    [mapUrl, page('<main><h2>Route map</h2><p>No downloadable route file is listed.</p></main>', mapUrl)],
  ]);
  const first = discovery(noExport);
  assert.deepEqual(await first.run(courseUrl), { status: "no-results", candidates: [] });
  assert.deepEqual(first.calls.filter((call) => call.type === "request").map((call) => call.url), [courseUrl, mapUrl]);

  const metadata = new Map([
    [courseUrl, page('<h1>Coastal Ultra</h1><p>80 km. To download the GPX track, click on Details in the map.</p><a href="/map/coastal-ultra/">Details</a>', courseUrl)],
    [mapUrl, page('<meta name="gpx-url" content="/files/course.gpx"><meta name="description" content="https://race.example/not-a-course.gpx">', mapUrl)],
  ]);
  const second = discovery(metadata);
  const metadataResult = await second.run(courseUrl);
  assert.equal(metadataResult.status, "success");
  assert.deepEqual(metadataResult.candidates.map((candidate) => candidate.gpxUrl), ["https://race.example/files/course.gpx"]);
});

test("course map download instructions do not authorize unrelated or external map destinations", async () => {
  const courseUrl = "https://race.example/routes/coastal-ultra/";
  const unrelatedMap = "https://race.example/map/club-locations/";
  const pages = new Map([
    [courseUrl, page('<h1>Coastal Ultra</h1><p>80 km course. To download the GPX track, click on Details in the map.</p><a href="/map/club-locations/">Map</a><a href="https://maps.example/map/coastal-ultra/">Course map</a><a href="http://127.0.0.1/map/coastal-ultra/">Details</a>', courseUrl)],
  ]);
  const { run, calls } = discovery(pages);
  assert.deepEqual(await run(courseUrl), { status: "no-results", candidates: [] });
  assert.deepEqual(calls.filter((call) => call.type === "request").map((call) => call.url), [courseUrl]);
  assert.equal(pages.has(unrelatedMap), false);
});

test("distance-specific race pages and generic navigation do not become organizer event choices", async () => {
  const rootUrl = "https://series.example/";
  const html = '<nav><a href="/about">About</a><a href="/contact">Contact</a></nav><main><article><h2>SDT - 100M</h2><a href="/races/100M">SDT - 100M</a></article><article><h2>CPS - 100K</h2><a href="/races/100K">CPS - 100K</a></article><article><h2>ETM - 50K</h2><a href="/races/50K">ETM - 50K</a></article></main>';
  const pages = new Map([
    [rootUrl, page(html, rootUrl)],
    ["https://series.example/races/100M", page("<main><p>Race detail</p></main>", "https://series.example/races/100M")],
    ["https://series.example/races/100K", page("<main><p>Race detail</p></main>", "https://series.example/races/100K")],
  ]);
  const { run } = discovery(pages);
  const result = await run(rootUrl);
  assert.equal(result.status, "no-results");
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
    eventDetection: eventDiagnostic({
      rootResponseStatus: 200, rootContentType: "text/html", rootHtmlBytesAccepted: pages.get(rootUrl).body.byteLength,
      parsedAnchors: 1, sameOriginAnchors: 1, explicitGpxIndexPrecedenceSuppressed: true,
      decisionReason: "provider-failure-during-crawl",
    }),
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
    eventDetection: eventDiagnostic(),
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
    eventDetection: eventDiagnostic(),
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
    eventDetection: eventDiagnostic({
      rootResponseStatus: 200, rootContentType: "text/html", rootHtmlBytesAccepted: 700_000,
      parsedAnchors: 1, sameOriginAnchors: 1, explicitGpxIndexPrecedenceSuppressed: false,
      decisionReason: "provider-failure-during-crawl",
    }),
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
