import assert from "node:assert/strict";
import test from "node:test";
import { findUniqueCourseResourcePreselection, identifyOfficialRaceCourse } from "./officialRaceCourseIdentity.ts";

const url = "https://race.example/hr/races/110K";
const html = `<!doctype html><html><head><title>110 km | Trail Event</title><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
  query: { race: "110K" },
  props: { pageProps: { event: { name: "Trail Event", begin: "2027-04-03T00:00:00Z" } } },
})}</script></head><body><h1>110K</h1></body></html>`;

function resource(resourceUrl, distanceLabel = "110K", yearEvidence = "2027") {
  return {
    url: resourceUrl,
    sourcePageUrl: url,
    distanceLabel,
    supportingEvidence: yearEvidence ? [`filename: route_${yearEvidence}`] : [],
    linkText: "GPX download",
  };
}

test("identifies a course-specific URL only when official page evidence corroborates its exact distance and edition", () => {
  const identity = identifyOfficialRaceCourse(url, html);
  assert.deepEqual(identity, {
    courseLabel: "110K",
    editionYear: 2027,
    eventName: "Trail Event",
    sourcePageUrl: url,
    evidence: ["course URL path: 110K", "structured query race confirms course label: 110K"],
  });
  assert.equal(identifyOfficialRaceCourse("https://race.example/event", html), null);
  assert.equal(identifyOfficialRaceCourse("https://race.example/races/110K", "<h1>168K</h1>"), null);
  assert.equal(identifyOfficialRaceCourse("https://race.example/event", "<h1>110K</h1>"), null, "a course heading alone on an event-level URL is not a course URL");
});

test("identifies descriptive distance-page slugs only when page title or heading confirms the exact distance", () => {
  const courseUrl = "https://race.example/en/distances/example-ultra-trail-64-km/";
  const courseHtml = "<title>Example Ultra Trail 64 km - 2026</title><h1>Example Ultra Trail 64 km</h1>";
  assert.deepEqual(identifyOfficialRaceCourse(courseUrl, courseHtml), {
    courseLabel: "64 km",
    editionYear: 2026,
    eventName: "Example Ultra Trail 64 km - 2026",
    sourcePageUrl: courseUrl,
    evidence: ["course URL path confirms distance: 64 km", "title confirms course label: 64 km"],
  });
  assert.equal(identifyOfficialRaceCourse(courseUrl, "<title>Example Ultra Trail 108 km</title><h1>Example Ultra Trail 108 km</h1>"), null);
  assert.equal(identifyOfficialRaceCourse("https://race.example/news/example-trail-64-km/", courseHtml), null);
});

test("preselects one exact course candidate and never uses an approximate distance match", () => {
  const identity = identifyOfficialRaceCourse(url, html);
  assert.ok(identity);
  const one = resource("https://files.example/route_111k_2027.gpx");
  const otherDistance = resource("https://files.example/route_168k_2027.gpx", "168K");
  const resolved = findUniqueCourseResourcePreselection(identity, url, [one, otherDistance]);
  assert.equal(resolved?.resourceUrl, one.url);
  assert.equal(resolved?.resourceType, "gpx");
  assert.equal(findUniqueCourseResourcePreselection(identity, url, [resource("https://files.example/route_111km_2027.gpx", "111 km")]), null);
});

test("keeps user selection for multiple editions or route variants of the same course", () => {
  const identity = identifyOfficialRaceCourse(url, html);
  assert.ok(identity);
  const current = resource("https://files.example/route_110k_2027.gpx", "110K", "2027");
  const older = resource("https://files.example/route_110k_2026.gpx", "110K", "2026");
  assert.equal(findUniqueCourseResourcePreselection(identity, url, [current, older]), null);
  assert.equal(findUniqueCourseResourcePreselection(identity, url, [current, resource("https://files.example/route-revision.gpx", "110K", "")]), null);
});

test("requires edition evidence for a candidate found on a different page and rejects edition mismatch", () => {
  const identity = identifyOfficialRaceCourse(url, html);
  assert.ok(identity);
  const linked = { ...resource("https://files.example/route_110k.gpx", "110K", ""), sourcePageUrl: "https://race.example/gpx-tracks" };
  assert.equal(findUniqueCourseResourcePreselection(identity, url, [linked]), null);
  assert.equal(findUniqueCourseResourcePreselection(identity, url, [resource("https://files.example/route_110k_2026.gpx", "110K", "2026")]), null);
});
