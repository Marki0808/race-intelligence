import assert from "node:assert/strict";
import test from "node:test";
import { buildAidStationDiscoveryV1, aidStationDiscoveryV1Schema } from "./aidStationDiscovery.ts";
import { extractHtmlStationEvidence } from "./aidStationExtraction.ts";
import { createOfficialGpxDiscovery, OFFICIAL_GPX_DISCOVERY_LIMITS } from "./officialGpxDiscovery.ts";
import { createOfficialGpxDownloadFlow } from "./officialGpxDownload.ts";
import { createRaceGpxDownloadPost } from "./api/race-gpx-download/route.ts";
import { analyzeGpxRoute } from "./gpxAnalysis.ts";
import { buildAidStationSections } from "./aidStationSections.ts";

const PUBLIC = [{ address: "93.184.216.34", family: 4 }];
const rootUrl = "https://race.example/course";
const gpxUrl = "https://race.example/course.gpx";
const validGpx = `<?xml version="1.0"?><gpx version="1.1" creator="test"><trk><name>Test route</name><trkseg><trkpt lat="45.8" lon="15.9"><ele>100</ele></trkpt><trkpt lat="45.8" lon="15.910062"><ele>110</ele></trkpt></trkseg></trk></gpx>`;

function istriaStyleFixture({ count = 7, supplies = true, checkpointAt = -1, edition = 2027, course = "110K", pointCount = 7, includeNamedSupport = true, faqEdition = edition, faqEventName = "Example Ultra", startName = "Start", supportCourse = course, supportNames = "Buzet, Livade", countCourse = "110K", duplicateBuzet = false, firstPointOffsetKm = 0, offRoutePoint = -1 } = {}) {
  const courseUrl = "https://race.example/races/110K";
  const gpxIndexUrl = "https://race.example/gpx-tracks";
  const faqUrl = "https://race.example/faqs";
  const resourceUrl = "https://race.example/ISTRIA_111k_2027.gpx";
  const distances = [13_000, 25_000, 38_000, 51_000, 64_000, 78_000, 93_000];
  const points = [
    { uid: "start", name: startName, type: "start", distance: 0, lat: 45.8, lon: 15.9 },
    ...distances.slice(0, pointCount).map((distance, index) => ({
      uid: `point-${index + 1}`, name: index === 2 || duplicateBuzet && index === 0 ? "Buzet" : index === 4 ? "Livade" : `Course Point ${index + 1}`,
      distance, lat: 45.8 + (distance + (index === 0 ? firstPointOffsetKm * 1000 : 0)) / 111_195, lon: index === offRoutePoint ? 16 : 15.9,
      ...(supplies ? { supplies: index % 2 ? "hotFood" : "drink" } : {}),
      ...(index === checkpointAt ? { type: "checkpoint" } : {}),
    })),
    { uid: "finish", name: "Finish", type: "finish", distance: 111_195, lat: 46.8, lon: 15.9 },
  ];
  const payload = { query: { race: course }, props: { pageProps: { event: { id: 17, name: "Example Ultra", begin: `${edition}-04-01` }, raceId: 17, gpxUrl: resourceUrl, track: { distanceKm: 111.195, points } } } };
  const root = `<h1>${course}</h1><a href="/gpx-tracks">GPX tracks</a><a href="/faqs">FAQs</a><script id="__NEXT_DATA__">${JSON.stringify(payload)}</script>`;
  const index = `<h2>${course}</h2><a href="/ISTRIA_111k_2027.gpx">Download GPX</a>`;
  const faqPayload = { props: { pageProps: { event: { id: 17, name: faqEventName, ...(faqEdition == null ? {} : { begin: `${faqEdition}-04-01` }) } } } };
  const namedSupport = includeNamedSupport ? `<h3>On which aid stations is support allowed?</h3><ul>${duplicateBuzet ? "<li>General course information</li><li>General event information</li>" : ""}<li>${supportCourse} course: ${supportNames}</li></ul>` : "";
  const faqTitle = faqEdition == null ? "Races &amp; Runners FAQ" : `${faqEventName} ${faqEdition}`;
  const faq = `<title>${faqTitle}</title><h1>${faqTitle}</h1><script id="__NEXT_DATA__">${JSON.stringify(faqPayload)}</script><h2>Aid stations</h2>${namedSupport}<h3>How many aid stations are along the course?</h3><ul><li>168K has 10 aid stations + final one in Umag, just after finish line.</li><li>${countCourse} has ${count} aid stations + final one in Umag, just after finish line.</li><li>69K has 4 aid stations + final one in Umag, just after finish line.</li></ul>`;
  const gpx = `<?xml version="1.0"?><gpx version="1.1" creator="test"><trk><trkseg><trkpt lat="45.8" lon="15.9"><ele>0</ele></trkpt><trkpt lat="46.8" lon="15.9"><ele>0</ele></trkpt></trkseg></trk></gpx>`;
  return { courseUrl, gpxIndexUrl, faqUrl, resourceUrl, points, root, index, faq, gpx };
}

function response(html) {
  return { statusCode: 200, headers: { "content-type": "text/html; charset=utf-8" }, body: new TextEncoder().encode(`<!doctype html><html><body>${html}</body></html>`) };
}

function makeDiscovery(pages) {
  return createOfficialGpxDiscovery({
    resolve: async () => PUBLIC,
    request: async (url) => {
      const found = pages.get(url.href);
      if (found instanceof Error) throw found;
      if (!found) throw new Error("fixture page missing");
      return found;
    },
  });
}

function nextDataHtml(points = [
  { uid: "start", name: "Start", type: "start", distance: 0, lat: 45.8, lon: 15.9 },
  { uid: "ridge", name: "Ridge", distance: 390, lat: 45.8, lon: 15.905031 },
  { uid: "finish", name: "Finish", type: "finish", distance: 780, lat: 45.8, lon: 15.910062 },
]) {
  const payload = { query: { race: "0.78 km course" }, props: { pageProps: { event: { id: 7, name: "Example Ultra", begin: "2027-06-01" }, raceId: 7, gpxUrl, track: { distance: 780, points } } } };
  return `<a href="/course.gpx">GPX route</a><script id="__NEXT_DATA__">${JSON.stringify(payload)}</script>`;
}

function htmlStationTable(year = 2027) {
  return `<title>Example Ultra Edition ${year}</title><h1>Example Ultra</h1><h2>0.78 km course</h2><h3>Aid stations</h3><table>
    <tr><th>Name</th><th>Distance from start (km)</th></tr>
    <tr><td>Ridge Aid Station</td><td>0.4</td></tr><tr><td>Valley Aid Station</td><td>0.6</td></tr>
  </table>`;
}

function obala64KmCourseHtml() {
  const names = ["Boršt", "Puče", "Šmarje", "Malija Stadium", "Strunjan"];
  const distances = [17, 28, 40, 51, 59];
  return `<title>Obala Ultra Trail 64 km - 2026</title>
    <h1>Obala Ultra Trail 64 km</h1><h2>64 km course</h2>
    <h3>Start</h3><p>Hrastovlje</p><h3>Finish</h3><p>Izola</p>
    <h3>Aid stations</h3><table><tbody>
      <tr><th>Aid Station</th>${names.map((name) => `<td>${name}</td>`).join("")}</tr>
      <tr><th>Distance</th>${distances.map((km) => `<td>${km} km</td>`).join("")}</tr>
    </tbody></table><p>There are five aid stations on this course.</p>`;
}

function obala64KmGpx() {
  const trackpoints = Array.from({ length: 651 }, (_, index) =>
    `<trkpt lat="45" lon="${(13 + index * 0.00125).toFixed(7)}"><ele>${Math.round(100 + 35 * Math.sin(index / 19))}</ele></trkpt>`,
  ).join("");
  return `<?xml version="1.0"?><gpx version="1.1" creator="offline-obala-fixture"><trk><name>Selected 64 km route</name><trkseg>${trackpoints}</trkseg></trk></gpx>`;
}

test("selected GPX flow captures exact Next.js station payload, validates the GPX link, and transfers verified visits", async () => {
  const discovery = makeDiscovery(new Map([[rootUrl, response(nextDataHtml())]]));
  const flow = createOfficialGpxDownloadFlow(discovery, async (url) => {
    assert.equal(url, gpxUrl);
    return { status: "success", text: validGpx };
  });
  const result = await flow(rootUrl, gpxUrl);
  assert.equal(result.status, "success");
  assert.equal(result.aidStationDiscoveryV1.schemaVersion, 1);
  assert.equal(result.aidStationDiscoveryV1.status, "available");
  assert.equal(result.aidStationDiscoveryV1.gpxProvenance.bindingStatus, "verified");
  assert.deepEqual(result.aidStationDiscoveryV1.visits.map((visit) => visit.position.confidence), ["verified", "verified", "verified"]);
  assert.equal(result.aidStationDiscoveryV1.selectedContext.editionYear, 2027);
  assert.equal(result.aidStationDiscoveryV1.gpxProvenance.selectedResourceUrl, gpxUrl);
  assert.ok(aidStationDiscoveryV1Schema.safeParse(result.aidStationDiscoveryV1).success);
});

test("same-course official station list corroborates structured course points and enables only fully covered visits", () => {
  const structured = nextDataHtml();
  const htmlStations = `<title>Example Ultra Edition 2027</title><h1>Example Ultra</h1><h2>0.78 km course</h2><h3>Aid stations</h3><table>
    <tr><th>Name</th><th>Distance from start (km)</th></tr><tr><td>Ridge Aid Station</td><td>0.39</td></tr></table>`;
  const result = buildAidStationDiscoveryV1([
    { url: rootUrl, html: `${structured}${htmlStations}`, depth: 0, linkedFromUrl: null, linkEvidence: [] },
  ], { resourceType: "gpx", sourcePageUrl: rootUrl, resourceUrl: gpxUrl, distanceLabel: "0.78 km" }, validGpx);
  assert.deepEqual(result.visits.map((visit) => visit.roles.includes("aid-station")), [false, true, false]);
  assert.equal(result.visits[1].position.confidence, "verified");
  assert.equal(result.visits[1].sourcePosition.normalizedKm, 0.39);
  assert.equal(result.visits[1].supportingEvidence?.[0].format, "html-table");
  assert.equal(result.completeness.status, "complete");
  assert.equal(result.completeness.basis, "course-points-corroborated");
  assert.equal(result.stationSegmentation.available, true);
});

test("transposed official station table corroborates only its matching structured GPX visit", () => {
  const htmlStations = `<title>Example Ultra Edition 2027</title><h1>Example Ultra</h1><h2>0.78 km course</h2><h3>Course time limits</h3><table>
    <tr><th>AID STATION</th><td>Ridge Aid Station</td></tr>
    <tr><th>Distance</th><td>0.39 km</td></tr>
  </table>`;
  const result = buildAidStationDiscoveryV1([
    { url: rootUrl, html: `${nextDataHtml()}${htmlStations}`, depth: 0, linkedFromUrl: null, linkEvidence: [] },
  ], { resourceType: "gpx", sourcePageUrl: rootUrl, resourceUrl: gpxUrl, distanceLabel: "0.78 km" }, validGpx);
  assert.equal(result.selectedContext.editionYear, 2027);
  assert.equal(result.gpxProvenance.bindingStatus, "verified");
  assert.deepEqual(result.visits.map((visit) => visit.roles.includes("aid-station")), [false, true, false]);
  assert.equal(result.visits[1].position.confidence, "verified");
  assert.equal(result.visits[1].supportingEvidence?.[0].format, "html-table");
  assert.equal(result.visits[1].supportingEvidence?.[0].locator.kind, "html-table-column");
  assert.equal(result.stationSegmentation.available, true);
});

test("Obala-shaped 64 km course table plus same-page count binds official kilometers as approximate sections", () => {
  const sourceUrl = "https://race.example/en/distances/coastal-ultra-64-km/";
  const resourceUrl = "https://race.example/wp-content/uploads/coastal-ultra-2026-64-km.gpx";
  const courseIdentity = {
    courseLabel: "64 km", editionYear: 2026, eventName: "Obala Ultra Trail",
    sourcePageUrl: sourceUrl, evidence: ["exact course URL and title", "selected official 2026 GPX resource"],
  };
  const gpx = obala64KmGpx();
  const result = buildAidStationDiscoveryV1([
    { url: sourceUrl, html: obala64KmCourseHtml(), depth: 0, linkedFromUrl: null, linkEvidence: [] },
  ], { resourceType: "gpx", sourcePageUrl: sourceUrl, resourceUrl, distanceLabel: "64 km", courseIdentity }, gpx);

  assert.equal(result.status, "available", JSON.stringify(result));
  assert.deepEqual(result.selectedContext, { eventName: "Obala Ultra Trail", editionYear: 2026, courseLabel: "64 km", courseDistanceKm: 64 });
  assert.equal(result.gpxProvenance.selectedResourceUrl, resourceUrl);
  assert.equal(result.gpxProvenance.bindingStatus, "approximate", JSON.stringify({ binding: result.gpxProvenance, reasons: result.reasonCodes, visits: result.visits.map(({ name, context, position, sequenceRole }) => ({ name, context, position, sequenceRole })) }));
  assert.deepEqual(result.visits.map((visit) => visit.name), ["Hrastovlje", "Boršt", "Puče", "Šmarje", "Malija Stadium", "Strunjan", "Izola"]);
  assert.deepEqual(result.visits.map((visit) => visit.sequenceRole), ["start", ...Array(5).fill("intermediate-candidate"), "finish"]);
  assert.deepEqual(result.visits.slice(1, -1).map((visit) => visit.sourcePosition.normalizedKm), [17, 28, 40, 51, 59]);
  assert.ok(result.visits.slice(1, -1).every((visit) => visit.roles.includes("aid-station") && visit.position.confidence === "approximate"));
  assert.ok(result.visits.slice(1, -1).every((visit) => visit.position.method === "source-distance"));
  assert.deepEqual(result.visits.filter((visit) => visit.sequenceRole !== "intermediate-candidate").map((visit) => visit.position.method), ["route-endpoint", "route-endpoint"]);
  assert.equal(result.completeness.status, "complete");
  assert.equal(result.completeness.declaredCount, 5);
  assert.equal(result.completeness.countEvidence.declaredCount, 5);
  assert.equal(result.completeness.countEvidence.source.url, sourceUrl);
  assert.equal(result.reasonCodes.includes("course-identity-conflict"), false);
  assert.equal(result.stationSegmentation.available, true, JSON.stringify(result.stationSegmentation));
  assert.equal(result.stationSegmentation.positionMode, "official-kilometer-approximate");
  assert.ok(result.reasonCodes.includes("source-distance-discrepancy") || result.reasonCodes.length === 0);
  assert.ok(result.visits.slice(1, -1).every((visit) => visit.source.url === sourceUrl));
  const analysis = analyzeGpxRoute({ segments: [[...Array.from({ length: 651 }, (_, index) => ({
    latitude: 45, longitude: 13 + index * 0.00125, elevationM: 100 + 35 * Math.sin(index / 19),
  }))]], name: "Selected 64 km route" });
  const sections = buildAidStationSections(result, analysis);
  assert.equal(sections.available, true, JSON.stringify(sections));
  assert.equal(sections.positionMode, "official-kilometer-approximate");
  assert.equal(sections.sections.length, 6);
  assert.deepEqual(sections.labels.get(`0:${sections.sections[0].id}`), { from: "Hrastovlje", to: "Boršt" });
  assert.deepEqual(sections.labels.get(`0:${sections.sections.at(-1).id}`), { from: "Strunjan", to: "Izola" });
});

test("course-scoped FAQ start schedules are not extracted as aid stations and cannot replace selected course identity", () => {
  const courseUrl = "https://race.example/en/distances/coastal-ultra-64-km/";
  const faqUrl = "https://race.example/en/more-information/";
  const faq = `<title>FAQ - Obala Ultra - Trail</title><h1>FAQ - Obala Ultra - Trail</h1>
    <h2>When and where do the races start?</h2><ul>
      <li>11 km Izola San Simon – 07.11.2026 at 12:00</li><li>17 km Korte – 07.11.2026 at 10:00</li>
      <li>35 km Izola – 07.11.2026 at 08:00</li><li>64 km Hrastovlje – 07.11.2026 at 06:00</li>
      <li>108 km Dekani – 07.11.2026 at 00:00</li></ul>`;
  const parsed = extractHtmlStationEvidence(faq, faqUrl, {
    selectedCourseLabel: "64 km", selectedCourseDistanceKm: 64, eventName: "Obala Ultra Trail", editionYear: 2026,
  });
  assert.deepEqual(parsed.visits, []);
  assert.equal(parsed.countEvidence, undefined);

  const result = buildAidStationDiscoveryV1([
    { url: courseUrl, html: obala64KmCourseHtml(), depth: 0, linkedFromUrl: null, linkEvidence: [] },
    { url: faqUrl, html: faq, depth: 1, linkedFromUrl: courseUrl, linkEvidence: ["FAQ"] },
  ], {
    resourceType: "gpx", sourcePageUrl: courseUrl, resourceUrl: "https://race.example/coastal-ultra-2026-64-km.gpx", distanceLabel: "64 km",
    courseIdentity: { courseLabel: "64 km", editionYear: 2026, eventName: "Obala Ultra Trail", sourcePageUrl: courseUrl, evidence: ["validated selected course page", "official GPX resource year"] },
  }, obala64KmGpx());
  assert.equal(result.selectedContext.eventName, "Obala Ultra Trail");
  assert.equal(result.selectedContext.editionYear, 2026);
  assert.equal(result.visits.length, 7);
  assert.equal(result.visits.some((visit) => ["Izola San Simon", "Korte", "Dekani"].includes(visit.name)), false);
  assert.equal(result.completeness.declaredCount, 5);
  assert.equal(result.stationSegmentation.available, true, JSON.stringify(result.stationSegmentation));
});

test("linked same-origin station page corroborates only the selected structured course and edition", async () => {
  const stationUrl = "https://race.example/aid-stations";
  const rootHtml = `${nextDataHtml()}<a href="/aid-stations">Aid stations</a>`;
  const stationHtml = `<title>Example Ultra Edition 2027</title><h1>Example Ultra</h1><h2>0.78 km course</h2><h3>Aid stations</h3><table>
    <tr><th>Name</th><th>Distance from start (km)</th></tr><tr><td>Ridge Aid Station</td><td>0.39</td></tr></table>`;
  const pages = new Map([[rootUrl, response(rootHtml)], [stationUrl, response(stationHtml)]]);
  const flow = createOfficialGpxDownloadFlow(makeDiscovery(pages), async () => ({ status: "success", text: validGpx }));
  const result = await flow(rootUrl, gpxUrl);
  const stationData = result.aidStationDiscoveryV1;
  assert.equal(stationData.sources.length, 2);
  assert.equal(stationData.visits[1].roles.includes("aid-station"), true);
  assert.equal(stationData.visits[1].supportingEvidence?.[0].url, stationUrl);
  assert.equal(stationData.visits[1].position.confidence, "verified");
  assert.equal(stationData.stationSegmentation.available, true);
});

test("cross-source station roles are not merged across edition or course conflicts", () => {
  const structured = nextDataHtml();
  const wrongEdition = `<title>Example Ultra Edition 2026</title><h1>Example Ultra</h1><h2>0.78 km course</h2><h3>Aid stations</h3><table>
    <tr><th>Name</th><th>Distance from start (km)</th></tr><tr><td>Ridge Aid Station</td><td>0.39</td></tr></table>`;
  const result = buildAidStationDiscoveryV1([{ url: rootUrl, html: `${structured}${wrongEdition}`, depth: 0, linkedFromUrl: null, linkEvidence: [] }], {
    resourceType: "gpx", sourcePageUrl: rootUrl, resourceUrl: gpxUrl, distanceLabel: "0.78 km",
  }, validGpx);
  assert.equal(result.visits[1].roles.includes("aid-station"), false);
  assert.notEqual(result.completeness.status, "complete");
  assert.equal(result.stationSegmentation.available, false);
});

test("same-name repeated visits are corroborated by compatible source position one-to-one", () => {
  const repeatedPoints = [
    { uid: "start", name: "Start", type: "start", distance: 0, lat: 45.8, lon: 15.9 },
    { uid: "visit-1", name: "Ridge", distance: 260, lat: 45.8, lon: 15.90334 },
    { uid: "visit-2", name: "Ridge", distance: 520, lat: 45.8, lon: 15.9067 },
    { uid: "finish", name: "Finish", type: "finish", distance: 780, lat: 45.8, lon: 15.910062 },
  ];
  const structured = nextDataHtml(repeatedPoints);
  const html = `<title>Example Ultra Edition 2027</title><h1>Example Ultra</h1><h2>0.78 km course</h2><h3>Aid stations</h3><table>
    <tr><th>Name</th><th>Distance from start (km)</th></tr><tr><td>Ridge Aid Station</td><td>0.26</td></tr><tr><td>Ridge Aid Station</td><td>0.52</td></tr></table>`;
  const result = buildAidStationDiscoveryV1([{ url: rootUrl, html: `${structured}${html}`, depth: 0, linkedFromUrl: null, linkEvidence: [] }], {
    resourceType: "gpx", sourcePageUrl: rootUrl, resourceUrl: gpxUrl, distanceLabel: "0.78 km",
  }, validGpx);
  assert.equal(result.visits.length, 4);
  assert.deepEqual(result.visits.slice(1, 3).map((visit) => visit.roles.includes("aid-station")), [true, true]);
  assert.equal(result.visits[1].supportingEvidence?.length, 1);
  assert.equal(result.visits[2].supportingEvidence?.length, 1);
});

test("course-specific page identity is server-resolved and carried into selected-GPX station binding", async () => {
  const courseUrl = "https://race.example/races/0.78km";
  const payload = {
    query: { race: "0.78 km course" },
    props: { pageProps: { event: { id: 7, name: "Example Ultra", begin: "2027-06-01" }, raceId: 7, gpxUrl,
      track: { distance: 780, points: [
        { uid: "start", name: "Start", type: "start", distance: 0, lat: 45.8, lon: 15.9 },
        { uid: "ridge", name: "Ridge", distance: 390, lat: 45.8, lon: 15.905031 },
        { uid: "finish", name: "Finish", type: "finish", distance: 780, lat: 45.8, lon: 15.910062 },
      ] } } },
  };
  const pageHtml = `<h1>0.78 km course</h1><a href="${gpxUrl}">Download GPX 0.78 km</a><script id="__NEXT_DATA__">${JSON.stringify(payload)}</script>`;
  const flow = createOfficialGpxDownloadFlow(makeDiscovery(new Map([[courseUrl, response(pageHtml)]])), async () => ({ status: "success", text: validGpx }));
  const result = await flow(courseUrl, gpxUrl);
  assert.equal(result.status, "success");
  assert.equal(result.aidStationDiscoveryV1.selectedContext.eventName, "Example Ultra");
  assert.equal(result.aidStationDiscoveryV1.selectedContext.editionYear, 2027);
  assert.equal(result.aidStationDiscoveryV1.gpxProvenance.bindingStatus, "verified");
  assert.ok(result.aidStationDiscoveryV1.gpxProvenance.bindingEvidenceIds.includes("embedded-gpx-url-match"));
});

test("server-resolved course identity mismatch keeps station positions unresolved", () => {
  const result = buildAidStationDiscoveryV1([{ url: rootUrl, html: htmlStationTable(), depth: 0, linkedFromUrl: null, linkEvidence: [] }], {
    resourceType: "gpx", sourcePageUrl: rootUrl, resourceUrl: gpxUrl, distanceLabel: "0.78 km",
    courseIdentity: {
      courseLabel: "50K", editionYear: 2027, eventName: "Example Ultra", sourcePageUrl: rootUrl,
      evidence: ["course URL path and page heading corroborate 50K"],
    },
  }, validGpx);
  assert.equal(result.gpxProvenance.bindingStatus, "unverified");
  assert.ok(result.reasonCodes.includes("course-identity-conflict"));
  assert.ok(result.visits.every((visit) => visit.position.confidence === "unresolved"));
});

test("bounded discovery follows an explicit same-origin aid-station page and keeps source kilometers approximate", async () => {
  const stationUrl = "https://race.example/aid-stations";
  const pages = new Map([
    [rootUrl, response(`<h1>Example Ultra Edition 2027</h1><a href="/aid-stations">Aid stations</a><a href="/course.gpx">0.78 km GPX download</a>`) ],
    [stationUrl, response(htmlStationTable())],
  ]);
  const discovery = makeDiscovery(pages);
  const flow = createOfficialGpxDownloadFlow(discovery, async () => ({ status: "success", text: validGpx }));
  const result = await flow(rootUrl, gpxUrl);
  assert.equal(result.status, "success");
  const stationData = result.aidStationDiscoveryV1;
  assert.equal(stationData.status, "available");
  assert.deepEqual(stationData.sources.map((source) => [source.url, source.depth, source.linkedFromUrl]), [
    [rootUrl, 0, null], [stationUrl, 1, rootUrl],
  ]);
  assert.deepEqual(stationData.visits.map((visit) => visit.name), ["Ridge", "Valley"]);
  assert.ok(stationData.visits.every((visit) => visit.position.confidence === "approximate"), JSON.stringify({ confidence: stationData.visits.map((visit) => visit.position), reasons: stationData.reasonCodes, context: stationData.selectedContext }));
  assert.ok(stationData.visits.every((visit) => visit.context.editionYear === 2027));
});

test("selected course distance scopes multi-distance HTML without mixing station lists", () => {
  const html = `<title>Example Ultra Edition 2027</title>
    <h2>100 km course</h2><h3>Aid stations</h3><table><tr><th>Name</th><th>Distance from start (km)</th></tr><tr><td>Long Route Camp</td><td>60</td></tr></table>
    <h2>50 km course</h2><h3>Aid stations</h3><table><tr><th>Name</th><th>Distance from start (km)</th></tr><tr><td>Short Route Gate</td><td>25</td></tr></table>`;
  const result = buildAidStationDiscoveryV1([{ url: rootUrl, html, depth: 0, linkedFromUrl: null, linkEvidence: [] }], {
    resourceType: "gpx", sourcePageUrl: rootUrl, resourceUrl: gpxUrl, distanceLabel: "50 km",
  }, validGpx);
  assert.deepEqual(result.visits.map((visit) => visit.name), ["Short Route Gate"]);
  assert.equal(result.selectedContext.courseDistanceKm, 50);
});

test("unknown edition preserves station evidence but never promotes its position", () => {
  const html = htmlStationTable(2027).replace("Edition 2027", "");
  const result = buildAidStationDiscoveryV1([{ url: rootUrl, html, depth: 0, linkedFromUrl: null, linkEvidence: [] }], {
    resourceType: "gpx", sourcePageUrl: rootUrl, resourceUrl: gpxUrl, distanceLabel: "0.78 km",
  }, validGpx);
  assert.equal(result.status, "available");
  assert.equal(result.selectedContext.editionYear, null);
  assert.ok(result.visits.every((visit) => visit.position.confidence === "unresolved"));
  assert.ok(result.reasonCodes.includes("course-binding-unverified"));
});

test("linked station data from a conflicting edition remains visible as unresolved evidence", async () => {
  const stationUrl = "https://race.example/aid-stations";
  const pages = new Map([
    [rootUrl, response(`<h1>Example Ultra Edition 2027</h1><a href="/aid-stations">Aid stations</a><a href="/course.gpx">0.78 km GPX download</a>`) ],
    [stationUrl, response(htmlStationTable(2026))],
  ]);
  const result = await createOfficialGpxDownloadFlow(makeDiscovery(pages), async () => ({ status: "success", text: validGpx }))(rootUrl, gpxUrl);
  const stationData = result.aidStationDiscoveryV1;
  assert.equal(stationData.selectedContext.editionYear, 2026);
  assert.ok(stationData.visits.every((visit) => visit.position.confidence === "unresolved"));
  assert.ok(stationData.reasonCodes.includes("course-identity-conflict"));
  assert.ok(stationData.stationSegmentation.reasonCodes.includes("visits-not-positioned"));
});

test("embedded structured data for a different GPX cannot bind to the selected candidate", () => {
  const mismatch = nextDataHtml().replace(gpxUrl, "https://race.example/other.gpx");
  const result = buildAidStationDiscoveryV1([{ url: rootUrl, html: mismatch, depth: 0, linkedFromUrl: null, linkEvidence: [] }], {
    resourceType: "gpx", sourcePageUrl: rootUrl, resourceUrl: gpxUrl, distanceLabel: null,
  }, validGpx);
  assert.equal(result.status, "unavailable");
  assert.ok(result.reasonCodes.includes("selected-gpx-mismatch"));
  assert.equal(result.visits.length, 0);
});

test("a ZIP entry binds through its rediscovered course, digest and edition; missing or malformed station sources fail open", () => {
  const html = htmlStationTable();
  const page = { url: rootUrl, html, depth: 0, linkedFromUrl: null, linkEvidence: [] };
  const archive = buildAidStationDiscoveryV1([page], {
    resourceType: "zip-entry", sourcePageUrl: rootUrl, resourceUrl: "https://race.example/course.zip", distanceLabel: "0.78 km", entryId: "gpx-1", archiveDigest: "a".repeat(64),
  }, validGpx);
  assert.equal(archive.gpxProvenance.bindingStatus, "approximate");
  assert.ok(archive.gpxProvenance.bindingEvidenceIds.includes("archive-digest-entry-match"));
  assert.ok(archive.visits.every((visit) => visit.position.confidence === "approximate"));
  const noEvidence = buildAidStationDiscoveryV1([{ ...page, html: "<html><body>Route page without station data</body></html>" }], {
    resourceType: "gpx", sourcePageUrl: rootUrl, resourceUrl: gpxUrl, distanceLabel: null,
  }, validGpx);
  assert.equal(noEvidence.status, "unavailable");
  assert.ok(noEvidence.reasonCodes.includes("no-station-evidence"));
  const malformed = buildAidStationDiscoveryV1([{ ...page, html: "<script id='__NEXT_DATA__'>{broken}</script>" }], {
    resourceType: "gpx", sourcePageUrl: rootUrl, resourceUrl: gpxUrl, distanceLabel: null,
  }, validGpx);
  assert.equal(malformed.status, "unavailable");
});

test("station-link traversal and captured source pages obey existing depth and page budgets", async () => {
  const root = response(`<a href="/race-guide">Race guide</a><a href="/course.gpx">50 km GPX</a>`);
  const pages = new Map([[rootUrl, root]]);
  pages.set("https://race.example/race-guide", response(`<h2>Aid stations</h2><p>Checkpoint at km 1: Gate 1</p>`));
  // Only pages linked by actual anchors can be traversed; the route still succeeds with absent station evidence.
  const discovery = makeDiscovery(pages);
  const seen = [];
  const result = await discovery(rootUrl, (page) => seen.push(page));
  assert.equal(result.status, "success");
  assert.ok(seen.length <= OFFICIAL_GPX_DISCOVERY_LIMITS.maxPages);
  assert.ok(seen.every((page) => page.depth <= OFFICIAL_GPX_DISCOVERY_LIMITS.maxSubpageDepth));
});

test("a failed optional station page does not block an otherwise valid GPX-only flow", async () => {
  const pages = new Map([
    [rootUrl, response(`<a href="/aid-stations">Aid stations</a><a href="/course.gpx">GPX route</a>`) ],
    ["https://race.example/aid-stations", new Error("fixture provider failure")],
  ]);
  const flow = createOfficialGpxDownloadFlow(makeDiscovery(pages), async () => ({ status: "success", text: validGpx }));
  const result = await flow(rootUrl, gpxUrl);
  assert.equal(result.status, "success");
  assert.equal(result.text, validGpx);
  assert.equal(result.aidStationDiscoveryV1.status, "unavailable");
  assert.ok(result.aidStationDiscoveryV1.reasonCodes.includes("optional-source-unavailable"));
});

test("a non-HTML station subpage is treated as optional and does not break GPX download", async () => {
  const nonHtml = { statusCode: 200, headers: { "content-type": "application/pdf" }, body: new TextEncoder().encode("unsupported station document") };
  const pages = new Map([
    [rootUrl, response(`<a href="/regulations">Regulations</a><a href="/course.gpx">GPX route</a>`) ],
    ["https://race.example/regulations", nonHtml],
  ]);
  const result = await createOfficialGpxDownloadFlow(makeDiscovery(pages), async () => ({ status: "success", text: validGpx }))(rootUrl, gpxUrl);
  assert.equal(result.status, "success");
  assert.equal(result.text, validGpx);
  assert.ok(result.aidStationDiscoveryV1.reasonCodes.includes("optional-source-unavailable"));
});

test("download API transfers the versioned station result beside the unchanged GPX text", async () => {
  const stationEvidence = buildAidStationDiscoveryV1([{ url: rootUrl, html: htmlStationTable(), depth: 0, linkedFromUrl: null, linkEvidence: [] }], {
    resourceType: "gpx", sourcePageUrl: rootUrl, resourceUrl: gpxUrl, distanceLabel: "0.78 km",
  }, validGpx);
  const post = createRaceGpxDownloadPost(async () => ({ status: "success", text: validGpx, aidStationDiscoveryV1: stationEvidence }));
  const response = await post(new Request("https://app.example/api/race-gpx-download", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ sourcePageUrl: rootUrl, gpxUrl }),
  }));
  assert.equal(response.status, 200);
  const form = await response.formData();
  assert.equal(await form.get("gpxText").text(), validGpx);
  assert.deepEqual(JSON.parse(form.get("aidStationDiscoveryV1")), stationEvidence);
});

test("course points plus a matching FAQ count infer only the unconfirmed aid-station roles and retain evidence", () => {
  const fixture = istriaStyleFixture();
  const result = buildAidStationDiscoveryV1([
    { url: fixture.courseUrl, html: fixture.root, depth: 0, linkedFromUrl: null, linkEvidence: [] },
    { url: fixture.gpxIndexUrl, html: fixture.index, depth: 1, linkedFromUrl: fixture.courseUrl, linkEvidence: ["GPX tracks"] },
    { url: fixture.faqUrl, html: fixture.faq, depth: 1, linkedFromUrl: fixture.courseUrl, linkEvidence: ["FAQs"] },
  ], { resourceType: "gpx", sourcePageUrl: fixture.gpxIndexUrl, resourceUrl: fixture.resourceUrl, distanceLabel: "110K", courseIdentity: { courseLabel: "110K", editionYear: 2027, eventName: "Example Ultra", sourcePageUrl: fixture.courseUrl, evidence: ["selected course URL and page"] } }, fixture.gpx);
  const intermediate = result.visits.slice(1, -1);
  assert.equal(intermediate.length, 7, JSON.stringify(result));
  assert.deepEqual(intermediate.map((visit) => visit.roles.includes("aid-station")), Array(7).fill(true));
  assert.deepEqual(intermediate.map((visit) => visit.classification), ["inferred-role", "inferred-role", "explicit-role", "inferred-role", "explicit-role", "inferred-role", "inferred-role"]);
  assert.equal(result.visits[0].roles.includes("aid-station"), false);
  assert.equal(result.visits.at(-1).roles.includes("aid-station"), false);
  assert.equal(result.completeness.status, "complete");
  assert.equal(result.completeness.declaredCount, 7);
  assert.equal(result.completeness.basis, "course-points-corroborated");
  assert.equal(result.completeness.countEvidence.source.url, fixture.faqUrl);
  assert.equal(result.reasonCodes.includes("cross-source-identity-conflict"), false);
  assert.ok(intermediate.every((visit) => visit.position.confidence === "verified"));
  assert.equal(result.stationSegmentation.available, true);
  assert.ok(result.visits[1].source.excerpt.includes("supplies"));
  assert.ok(result.visits[1].supportingEvidence.some((evidence) => evidence.url === fixture.faqUrl));
});

test("realistic FAQ prose about support timing does not block count-corroborated segmentation", () => {
  const fixture = istriaStyleFixture();
  const faq = `${fixture.faq}<p>To be able to enter the aid station and to assist to runner, support member needs to have a support bracelet. Support member is allowed to enter the aid station 5 minutes before the arrival of their runner.</p>`;
  const extractedFaq = extractHtmlStationEvidence(faq, fixture.faqUrl, {
    selectedCourseLabel: "110K", selectedCourseDistanceKm: 110,
    eventName: "Example Ultra", editionYear: 2027, expectedEditionYear: 2027,
  });
  assert.equal(extractedFaq.countEvidence?.declaredCount, 7);
  assert.deepEqual(extractedFaq.visits.map((visit) => visit.name), ["Buzet", "Livade"]);

  const result = buildAidStationDiscoveryV1([
    { url: fixture.courseUrl, html: fixture.root, depth: 0, linkedFromUrl: null, linkEvidence: [] },
    { url: fixture.faqUrl, html: faq, depth: 1, linkedFromUrl: fixture.courseUrl, linkEvidence: ["FAQs"] },
  ], { resourceType: "gpx", sourcePageUrl: fixture.courseUrl, resourceUrl: fixture.resourceUrl, distanceLabel: "110K", courseIdentity: { courseLabel: "110K", editionYear: 2027, eventName: "Example Ultra", sourcePageUrl: fixture.courseUrl, evidence: ["selected course URL and page"] } }, fixture.gpx);
  assert.equal(result.completeness.status, "complete", JSON.stringify(result));
  assert.equal(result.completeness.declaredCount, 7);
  assert.equal(result.stationSegmentation.available, true);
  assert.equal(result.reasonCodes.includes("cross-source-station-match-ambiguous"), false);
});

test("event-level multi-course FAQ inherits edition from its directly linked course and matches Buzet only to the intermediate visit", () => {
  const fixture = istriaStyleFixture({ faqEdition: null, startName: "Buzet" });
  const extractedFaq = extractHtmlStationEvidence(fixture.faq, fixture.faqUrl, { selectedCourseLabel: "110K", selectedCourseDistanceKm: 110, eventName: "Example Ultra", editionYear: 2027, expectedEditionYear: 2027 });
  assert.equal(extractedFaq.countEvidence?.declaredCount, 7, JSON.stringify(extractedFaq));
  assert.deepEqual(extractedFaq.visits.map((visit) => visit.name), ["Buzet", "Livade"]);
  const result = buildAidStationDiscoveryV1([
    { url: fixture.courseUrl, html: fixture.root, depth: 0, linkedFromUrl: null, linkEvidence: [] },
    { url: fixture.faqUrl, html: fixture.faq, depth: 1, linkedFromUrl: fixture.courseUrl, linkEvidence: ["FAQs"] },
  ], { resourceType: "gpx", sourcePageUrl: fixture.courseUrl, resourceUrl: fixture.resourceUrl, distanceLabel: "110K", courseIdentity: { courseLabel: "110K", editionYear: 2027, eventName: "Example Ultra", sourcePageUrl: fixture.courseUrl, evidence: ["selected course URL and page"] } }, fixture.gpx);
  assert.equal(result.completeness.status, "complete", JSON.stringify(result));
  assert.equal(result.completeness.declaredCount, 7);
  assert.equal(result.completeness.countEvidence.context.editionYear, 2027);
  assert.equal(result.completeness.countEvidence.source.url, fixture.faqUrl);
  assert.equal(result.stationSegmentation.available, true);
  assert.equal(result.visits[0].name, "Buzet");
  assert.equal(result.visits[0].roles.includes("aid-station"), false, "same-name start must not receive station evidence");
  const intermediateBuzet = result.visits.slice(1, -1).find((visit) => visit.name === "Buzet");
  assert.ok(intermediateBuzet?.roles.includes("aid-station"));
  assert.equal(intermediateBuzet.classification, "explicit-role");
  assert.ok(intermediateBuzet.supportingEvidence.some((evidence) => evidence.url === fixture.faqUrl));
  assert.equal(result.visits.filter((visit) => visit.name === "Livade" && visit.roles.includes("aid-station")).length, 1);
  assert.ok(result.visits.slice(1, -1).every((visit) => visit.roles.includes("aid-station")));
});

test("ambiguous partial names do not block a complete count-corroborated ordered course-point sequence", () => {
  const fixture = istriaStyleFixture({ duplicateBuzet: true });
  const result = buildAidStationDiscoveryV1([
    { url: fixture.courseUrl, html: fixture.root, depth: 0, linkedFromUrl: null, linkEvidence: [] },
    { url: fixture.faqUrl, html: fixture.faq, depth: 1, linkedFromUrl: fixture.courseUrl, linkEvidence: ["FAQs"] },
  ], { resourceType: "gpx", sourcePageUrl: fixture.courseUrl, resourceUrl: fixture.resourceUrl, distanceLabel: "110K", courseIdentity: { courseLabel: "110K", editionYear: 2027, eventName: "Example Ultra", sourcePageUrl: fixture.courseUrl, evidence: ["selected course URL and page"] } }, fixture.gpx);

  assert.ok(result.reasonCodes.includes("cross-source-station-match-ambiguous"), "keep the unresolved name association diagnostic");
  assert.equal(result.completeness.status, "complete");
  assert.equal(result.completeness.declaredCount, 7);
  assert.equal(result.completeness.countEvidence.declaredCount, 7);
  assert.equal(result.stationSegmentation.available, true);
  assert.equal(result.visits.slice(1, -1).length, 7);
  assert.ok(result.visits.slice(1, -1).every((visit) => visit.roles.includes("aid-station")));
  assert.ok(result.visits.filter((visit) => visit.name === "Buzet").every((visit) =>
    !visit.supportingEvidence.some((evidence) => evidence.url === fixture.faqUrl && evidence.excerpt.includes("On which aid stations")),
  ), "do not attach the ambiguous named-list evidence to either repeated visit");
});

test("a named station absent from the selected course-point identities remains an unresolved blocker", () => {
  const fixture = istriaStyleFixture({ supportNames: "Unmatched Place, Livade" });
  const result = buildAidStationDiscoveryV1([
    { url: fixture.courseUrl, html: fixture.root, depth: 0, linkedFromUrl: null, linkEvidence: [] },
    { url: fixture.faqUrl, html: fixture.faq, depth: 1, linkedFromUrl: fixture.courseUrl, linkEvidence: ["FAQs"] },
  ], { resourceType: "gpx", sourcePageUrl: fixture.courseUrl, resourceUrl: fixture.resourceUrl, distanceLabel: "110K", courseIdentity: { courseLabel: "110K", editionYear: 2027, eventName: "Example Ultra", sourcePageUrl: fixture.courseUrl, evidence: ["selected course URL and page"] } }, fixture.gpx);

  assert.ok(result.reasonCodes.includes("cross-source-station-match-ambiguous"));
  assert.notEqual(result.completeness.status, "complete");
  assert.equal(result.stationSegmentation.available, false);
});

test("an off-route visit prevents final completeness and segmentation despite matching source counts", () => {
  const fixture = istriaStyleFixture({ includeNamedSupport: false, offRoutePoint: 0 });
  const result = buildAidStationDiscoveryV1([
    { url: fixture.courseUrl, html: fixture.root, depth: 0, linkedFromUrl: null, linkEvidence: [] },
    { url: fixture.faqUrl, html: fixture.faq, depth: 1, linkedFromUrl: fixture.courseUrl, linkEvidence: ["FAQs"] },
  ], { resourceType: "gpx", sourcePageUrl: fixture.courseUrl, resourceUrl: fixture.resourceUrl, distanceLabel: "110K", courseIdentity: { courseLabel: "110K", editionYear: 2027, eventName: "Example Ultra", sourcePageUrl: fixture.courseUrl, evidence: ["selected course URL and page"] } }, fixture.gpx);

  assert.equal(result.completeness.status, "partial");
  assert.equal(result.completeness.declaredCount, 7);
  assert.ok(result.reasonCodes.includes("coordinate-off-route"));
  assert.ok(result.stationSegmentation.reasonCodes.includes("visits-not-positioned"));
  assert.equal(result.stationSegmentation.available, false);
});

test("a moderate source-to-GPX station distance discrepancy remains diagnostic but does not block the corroborated sequence", () => {
  const fixture = istriaStyleFixture({ includeNamedSupport: false, firstPointOffsetKm: 0.6 });
  const result = buildAidStationDiscoveryV1([
    { url: fixture.courseUrl, html: fixture.root, depth: 0, linkedFromUrl: null, linkEvidence: [] },
    { url: fixture.faqUrl, html: fixture.faq, depth: 1, linkedFromUrl: fixture.courseUrl, linkEvidence: ["FAQs"] },
  ], { resourceType: "gpx", sourcePageUrl: fixture.courseUrl, resourceUrl: fixture.resourceUrl, distanceLabel: "110K", courseIdentity: { courseLabel: "110K", editionYear: 2027, eventName: "Example Ultra", sourcePageUrl: fixture.courseUrl, evidence: ["selected course URL and page"] } }, fixture.gpx);

  assert.ok(result.reasonCodes.includes("source-distance-discrepancy"));
  assert.equal(result.completeness.status, "complete");
  assert.equal(result.completeness.declaredCount, 7);
  assert.equal(result.stationSegmentation.available, true);
  assert.ok(result.visits.every((visit) => visit.position.confidence === "verified"));
});

test("a directly linked FAQ with an explicit conflicting edition cannot inherit the selected edition", () => {
  const fixture = istriaStyleFixture({ faqEdition: 2026 });
  const result = buildAidStationDiscoveryV1([
    { url: fixture.courseUrl, html: fixture.root, depth: 0, linkedFromUrl: null, linkEvidence: [] },
    { url: fixture.faqUrl, html: fixture.faq, depth: 1, linkedFromUrl: fixture.courseUrl, linkEvidence: ["FAQs"] },
  ], { resourceType: "gpx", sourcePageUrl: fixture.courseUrl, resourceUrl: fixture.resourceUrl, distanceLabel: "110K", courseIdentity: { courseLabel: "110K", editionYear: 2027, eventName: "Example Ultra", sourcePageUrl: fixture.courseUrl, evidence: ["selected course URL and page"] } }, fixture.gpx);
  assert.equal(result.stationSegmentation.available, false);
  assert.notEqual(result.completeness.status, "complete");
  assert.ok(result.reasonCodes.includes("cross-source-identity-conflict"));
  assert.equal(result.visits.slice(1, -1).some((visit) => visit.supportingEvidence.some((evidence) => evidence.url === fixture.faqUrl)), false);
});

test("a directly linked FAQ with conflicting event identity cannot inherit course identity", () => {
  const fixture = istriaStyleFixture({ faqEventName: "Different Ultra" });
  const result = buildAidStationDiscoveryV1([
    { url: fixture.courseUrl, html: fixture.root, depth: 0, linkedFromUrl: null, linkEvidence: [] },
    { url: fixture.faqUrl, html: fixture.faq, depth: 1, linkedFromUrl: fixture.courseUrl, linkEvidence: ["FAQs"] },
  ], { resourceType: "gpx", sourcePageUrl: fixture.courseUrl, resourceUrl: fixture.resourceUrl, distanceLabel: "110K", courseIdentity: { courseLabel: "110K", editionYear: 2027, eventName: "Example Ultra", sourcePageUrl: fixture.courseUrl, evidence: ["selected course URL and page"] } }, fixture.gpx);
  assert.equal(result.stationSegmentation.available, false);
  assert.ok(result.reasonCodes.includes("cross-source-identity-conflict"));
  assert.notEqual(result.completeness.status, "complete");
});

test("station names and count stated only for another course do not corroborate the selected course", () => {
  const fixture = istriaStyleFixture({ faqEdition: null, supportCourse: "69K", countCourse: "69K", count: 4 });
  const result = buildAidStationDiscoveryV1([
    { url: fixture.courseUrl, html: fixture.root, depth: 0, linkedFromUrl: null, linkEvidence: [] },
    { url: fixture.faqUrl, html: fixture.faq, depth: 1, linkedFromUrl: fixture.courseUrl, linkEvidence: ["FAQs"] },
  ], { resourceType: "gpx", sourcePageUrl: fixture.courseUrl, resourceUrl: fixture.resourceUrl, distanceLabel: "110K", courseIdentity: { courseLabel: "110K", editionYear: 2027, eventName: "Example Ultra", sourcePageUrl: fixture.courseUrl, evidence: ["selected course URL and page"] } }, fixture.gpx);
  assert.notEqual(result.completeness.status, "complete");
  assert.equal(result.completeness.countEvidence, undefined);
  assert.equal(result.visits.slice(1, -1).every((visit) => !visit.supportingEvidence.some((evidence) => evidence.url === fixture.faqUrl)), true);
  assert.equal(result.visits.slice(1, -1).some((visit) => visit.classification === "inferred-role"), false);
});

test("count mismatch, edition mismatch, missing refreshment evidence, and mixed checkpoint points block inference", () => {
  const cases = [
    [istriaStyleFixture({ count: 6 }), "count-mismatch"],
    [istriaStyleFixture({ pointCount: 6 }), "partial-course-points"],
    [istriaStyleFixture({ edition: 2026 }), "wrong-edition"],
    [istriaStyleFixture({ course: "69K" }), "wrong-course"],
    [istriaStyleFixture({ supplies: false }), "missing-supplies"],
    [istriaStyleFixture({ checkpointAt: 3 }), "mixed-checkpoint"],
  ];
  for (const [fixture, caseName] of cases) {
    const result = buildAidStationDiscoveryV1([
      { url: fixture.courseUrl, html: fixture.root, depth: 0, linkedFromUrl: null, linkEvidence: [] },
      { url: fixture.faqUrl, html: fixture.faq, depth: 1, linkedFromUrl: fixture.courseUrl, linkEvidence: ["FAQs"] },
    ], { resourceType: "gpx", sourcePageUrl: fixture.courseUrl, resourceUrl: fixture.resourceUrl, distanceLabel: "110K", courseIdentity: { courseLabel: "110K", editionYear: 2027, eventName: "Example Ultra", sourcePageUrl: fixture.courseUrl, evidence: ["selected course URL and page"] } }, fixture.gpx);
    assert.equal(result.stationSegmentation.available, false);
    assert.notEqual(result.completeness.status, "complete", caseName);
    if (caseName === "count-mismatch") assert.ok(result.reasonCodes.includes("station-count-conflict"));
    assert.ok(result.visits.slice(1, -1).some((visit) => !visit.roles.includes("aid-station")));
  }
});

test("an independent course-scoped FAQ count can corroborate a complete refreshment-bearing sequence without named station records", () => {
  const fixture = istriaStyleFixture({ includeNamedSupport: false });
  const result = buildAidStationDiscoveryV1([
    { url: fixture.courseUrl, html: fixture.root, depth: 0, linkedFromUrl: null, linkEvidence: [] },
    { url: fixture.faqUrl, html: fixture.faq, depth: 1, linkedFromUrl: fixture.courseUrl, linkEvidence: ["FAQs"] },
  ], { resourceType: "gpx", sourcePageUrl: fixture.courseUrl, resourceUrl: fixture.resourceUrl, distanceLabel: "110K", courseIdentity: { courseLabel: "110K", editionYear: 2027, eventName: "Example Ultra", sourcePageUrl: fixture.courseUrl, evidence: ["selected course URL and page"] } }, fixture.gpx);
  assert.equal(result.stationSegmentation.available, true);
  assert.deepEqual(result.visits.slice(1, -1).map((visit) => visit.classification), Array(7).fill("inferred-role"));
  assert.equal(result.completeness.countEvidence.source.url, fixture.faqUrl);
});

test("FAQ count without refreshment-bearing course points cannot create station roles", () => {
  const fixture = istriaStyleFixture({ supplies: false });
  const result = buildAidStationDiscoveryV1([
    { url: fixture.courseUrl, html: fixture.root, depth: 0, linkedFromUrl: null, linkEvidence: [] },
    { url: fixture.faqUrl, html: fixture.faq, depth: 1, linkedFromUrl: fixture.courseUrl, linkEvidence: ["FAQs"] },
  ], { resourceType: "gpx", sourcePageUrl: fixture.courseUrl, resourceUrl: fixture.resourceUrl, distanceLabel: "110K", courseIdentity: { courseLabel: "110K", editionYear: 2027, eventName: "Example Ultra", sourcePageUrl: fixture.courseUrl, evidence: ["selected course URL and page"] } }, fixture.gpx);
  assert.equal(result.visits.slice(1, -1).some((visit) => visit.classification === "inferred-role"), false);
  assert.equal(result.stationSegmentation.available, false);
});

test("selected course discovery spends its bounded page budget on linked GPX and FAQ pages without following generic FAQ links from organizer homepages", async () => {
  const fixture = istriaStyleFixture();
  const pages = new Map([
    [fixture.courseUrl, response(fixture.root)],
    [fixture.gpxIndexUrl, response(fixture.index)],
    [fixture.faqUrl, response(fixture.faq)],
  ]);
  const seen = [];
  const discovery = makeDiscovery(pages);
  const result = await discovery(fixture.courseUrl, (page) => seen.push(page));
  assert.equal(result.status, "success");
  assert.equal(result.candidates.length, 1);
  assert.ok(seen.some((page) => page.url === fixture.faqUrl));
  assert.equal(seen.length, 3);
  const homepageUrl = "https://race.example/";
  const homepageDiscovery = makeDiscovery(new Map([[homepageUrl, response(`<a href="/faq">FAQs</a><a href="/course.gpx">GPX route</a>`)]]));
  const homepageSeen = [];
  await homepageDiscovery(homepageUrl, (page) => homepageSeen.push(page));
  assert.deepEqual(homepageSeen.map((page) => page.url), [homepageUrl]);
});
