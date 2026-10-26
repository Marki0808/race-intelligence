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

test("requires explicit matching event-edition evidence for a candidate found on a different page", () => {
  const identity = identifyOfficialRaceCourse(url, html);
  assert.ok(identity);
  const linked = { ...resource("https://files.example/route_110k.gpx", "110K", ""), sourcePageUrl: "https://race.example/gpx-tracks" };
  assert.equal(findUniqueCourseResourcePreselection(identity, url, [linked]), null);
  assert.equal(findUniqueCourseResourcePreselection(identity, url, [{
    ...linked,
    linkText: "2026 race edition GPX",
  }]), null, "explicitly conflicting edition metadata on another page is rejected");
});

test("does not infer event edition from a GPX filename year", () => {
  const identity = { ...identifyOfficialRaceCourse(url, html), editionYear: null };
  const selected = resource("https://race.example/uploads/trail_110k_2026.gpx", "110K", "2026");
  const resolved = findUniqueCourseResourcePreselection(identity, url, [selected]);
  assert.equal(resolved?.courseIdentity.editionYear, null);
  assert.equal(resolved?.courseIdentity.evidence.some((item) => item.includes("edition 2026")), false);
  assert.equal(findUniqueCourseResourcePreselection(identity, url, [
    selected, resource("https://race.example/uploads/trail_110k_2025.gpx", "110K", "2025"),
  ]), null, "multiple editions still require explicit user selection");
});

test("extracts an explicitly labeled date across layout wrappers and keeps event edition separate from GPX version", () => {
  const courseUrl = "https://race.example/en/distances/coastal-ultra-64-km/";
  const courseHtml = `<title>Coastal Ultra Trail 64 km</title>
    <h1>Coastal Ultra Trail 64 km</h1>
    <section><div class="field-label"><h4><span>Date</span>:</h4></div>
      <div class="field-value"><div class="description"><p>November 7, 2026</p></div></div>
      <h4>Distance</h4><p>64 km</p></section>`;
  const identity = identifyOfficialRaceCourse(courseUrl, courseHtml);
  assert.equal(identity?.editionYear, 2026);
  assert.ok(identity?.evidence.some((item) => item.includes("labeled official course date")));

  const selected = {
    url: "https://race.example/uploads/coastal-ultra-2026-64-km.gpx",
    sourcePageUrl: courseUrl,
    distanceLabel: "64 km",
    supportingEvidence: ["official download link"],
    linkText: "GPX file download",
  };
  assert.equal(findUniqueCourseResourcePreselection(identity, courseUrl, [selected])?.courseIdentity.editionYear, 2026);
  const olderRouteVersion = findUniqueCourseResourcePreselection(identity, courseUrl, [{
    ...selected,
    url: "https://race.example/uploads/coastal-ultra-2025-64-km.gpx",
  }]);
  assert.equal(olderRouteVersion?.courseIdentity.editionYear, 2026, "the selected course page may reuse a GPX route version from an earlier year");
  assert.ok(olderRouteVersion?.evidence.includes("direct link from selected official course page"));
  assert.equal(olderRouteVersion?.evidence.some((item) => item.includes("2025")), false, "filename year is not promoted to event-edition evidence");

  assert.equal(findUniqueCourseResourcePreselection(identity, courseUrl, [{
    ...selected,
    linkText: "GPX for race edition 2025",
  }]), null, "explicitly conflicting event-edition evidence remains rejected");
  assert.equal(findUniqueCourseResourcePreselection(identity, courseUrl, [{ ...selected, distanceLabel: "65 km" }]), null, "course distance mismatch remains rejected");
  assert.equal(findUniqueCourseResourcePreselection(identity, courseUrl, [selected, { ...selected, url: "https://race.example/uploads/coastal-ultra-revision-64-km.gpx" }]), null, "multiple same-course resources remain a user choice");
});

test("conflicting explicit course-date and page-edition evidence fails closed", () => {
  const courseUrl = "https://race.example/en/distances/coastal-ultra-64-km/";
  const conflictingHtml = `<title>Coastal Ultra Trail 64 km - 2025</title>
    <h1>Coastal Ultra Trail 64 km</h1>
    <section><h4>Date</h4><p>November 7, 2026</p></section>`;
  assert.equal(identifyOfficialRaceCourse(courseUrl, conflictingHtml), null);
});
