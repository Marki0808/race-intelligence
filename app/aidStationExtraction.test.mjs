import test from "node:test";
import assert from "node:assert/strict";
import {
  alignStationEvidenceToGpx,
  extractHtmlStationEvidence,
  extractNextDataStationEvidence,
  SOURCE_KM_ALIGNMENT_TOLERANCE_KM,
  stationVisitEvidenceV1Schema,
} from "./aidStationExtraction.ts";

const sourceUrl = "https://race.example/course";
const structuredHtml = (extra = {}) => `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
  query: { race: "course-a" }, props: { pageProps: {
    event: { name: "Example Trail Event", begin: "2027-06-12" },
    track: { distance: 30000, gpxUrl: "https://race.example/course.gpx", points: [
      { uid: "start", name: "Start", distance: 0, lat: 45, lon: 14, type: "start" },
      { uid: "same-a", name: "Ridge Aid", distance: 12000, lat: 45.1, lon: 14.1, supplies: "food and water", isAssistance: false },
      { uid: "same-b", name: "Ridge Aid", distance: 21000, lat: 45.2, lon: 14.2, supplies: "water", isAssistance: true },
      { uid: "finish", name: "Finish", distance: 30000, lat: 45.3, lon: 14.3, type: "finish" },
    ] }, ...extra,
  } },
})}</script>`;
const gpx = (segments) => `<gpx><trk><name>Test</name>${segments.map((points) => `<trkseg>${points.map(([lat, lon, ele]) => `<trkpt lat="${lat}" lon="${lon}"><ele>${ele}</ele></trkpt>`).join("")}</trkseg>`).join("")}</trk></gpx>`;

test("Next data adapter preserves ordered points, repeated visits, explicit roles and unknown assistance classification", () => {
  const result = extractNextDataStationEvidence(structuredHtml(), sourceUrl);
  assert.equal(result.status, "success");
  assert.deepEqual(result.visits.map((v) => v.uid), ["start", "same-a", "same-b", "finish"]);
  assert.equal(result.visits[1].name, result.visits[2].name);
  assert.notEqual(result.visits[1].visitId, result.visits[2].visitId);
  assert.deepEqual(result.visits[0].roles, ["start"]);
  assert.deepEqual(result.visits[3].roles, ["finish"]);
  assert.deepEqual(result.visits[1].roles, [], "isAssistance/supplies must not be treated as an explicit aid-station role");
  assert.equal(result.visits[1].sourcePosition.normalizedKm, 12);
  assert.equal(result.visits[1].context.editionYear, 2027);
  assert.equal(result.visits[0].context.selectedGpxUrl, "https://race.example/course.gpx");
  assert.ok(result.visits.every((v) => stationVisitEvidenceV1Schema.safeParse(v).success));
});

test("structured course-point count and intermediate candidate count come from ordered input", () => {
  const points = Array.from({ length: 9 }, (_, index) => ({
    uid: `point-${index}`, name: index === 0 ? "Start" : index === 8 ? "Finish" : `Place ${index}`,
    distance: index * 3_000, latitude: 45 + index * 0.001, longitude: 14 + index * 0.001,
    ...(index === 0 ? { type: "start" } : index === 8 ? { type: "finish" } : { supplies: "water" }),
  }));
  const html = `<script id="__NEXT_DATA__">${JSON.stringify({ query: { race: "course-a" }, props: { pageProps: { gpxUrl: "/route.gpx", event: { name: "Example", begin: "2027-01-01" }, track: { distance: 24_000, points } } } })}</script>`;
  const result = extractNextDataStationEvidence(html, sourceUrl);
  assert.equal(result.visits.length, points.length);
  assert.equal(result.visits.filter((v) => v.sequenceRole === "intermediate-candidate").length, 7);
  assert.equal(result.visits[1].roles.includes("aid-station"), false, "supplies do not prove an aid-station role");
});

test("Next data adapter rejects malformed payloads and course or edition identity conflicts", () => {
  assert.equal(extractNextDataStationEvidence("<html/>", sourceUrl).status, "no-evidence");
  assert.equal(extractNextDataStationEvidence("<script id='__NEXT_DATA__'>{bad}</script>", sourceUrl).status, "rejected");
  assert.deepEqual(extractNextDataStationEvidence(structuredHtml(), sourceUrl, { expectedEditionYear: 2026 }).issues, ["course-identity-conflict"]);
  assert.deepEqual(extractNextDataStationEvidence(structuredHtml(), sourceUrl, { expectedCourseLabel: "50K" }).issues, ["course-identity-conflict"]);
  const missingPoints = structuredHtml({ track: { distance: 30_000, points: [] } });
  assert.ok(extractNextDataStationEvidence(missingPoints, sourceUrl).issues.includes("no-station-evidence"));
  const onePoint = structuredHtml({ track: { distance: 30_000, points: [{ name: "Only point", distance: 0 }] } });
  assert.ok(extractNextDataStationEvidence(onePoint, sourceUrl).issues.includes("incomplete-source"));
});

test("HTML table adapter reads course-scoped cumulative distance and separate next-visit distance", () => {
  const html = `<h1>Example Race</h1><h2>50 km course</h2><h3>Aid stations</h3><table>
    <tr><th>Number</th><th>Name</th><th>Distance from start (km)</th><th>Next (km)</th></tr>
    <tr><td>A1</td><td>Forest Gate</td><td>12</td><td>8</td></tr>
    <tr><td>A2</td><td>Forest Gate</td><td>20</td><td>30</td></tr>
  </table>`;
  const result = extractHtmlStationEvidence(html, sourceUrl);
  assert.equal(result.visits.length, 2);
  assert.equal(result.visits[0].context.courseDistanceKm, 50);
  assert.equal(result.visits[0].name, "Forest Gate");
  assert.ok(result.visits[0].roles.includes("aid-station"));
  assert.equal(result.visits[0].sourcePosition.semantics, "cumulative");
  assert.equal(result.visits[0].sourceIntervalToNext.normalizedKm, 8);
  assert.notEqual(result.visits[0].visitId, result.visits[1].visitId);
});

const transposedAidTable = (names = ["Boršt", "Puče", "Šmarje", "Malija Stadium", "Strunjan"], distances = [17, 28, 40, 51, 59]) =>
  `<h1>Coastal Ultra 64 km</h1><h2>64 km course</h2><h3>Course time limits</h3><table><tbody>
    <tr><th>AID STATION</th>${names.map((name) => `<td>${name}</td>`).join("")}</tr>
    <tr><th>Distance</th>${distances.map((distance) => `<td>${distance} km</td>`).join("")}</tr>
    <tr><th>Elevation gain</th>${names.map((_, index) => `<td>${index * 100} m</td>`).join("")}</tr>
    <tr><th>Distance to next aid station</th>${names.map((_, index) => `<td>${index + 5} km</td>`).join("")}</tr>
    <tr><th>Cut-off time</th>${names.map((_, index) => `<td>${index + 1}:00</td>`).join("")}</tr>
  </tbody></table>`;

test("transposed station tables pair each name with its same-column cumulative distance and retain column provenance", () => {
  const result = extractHtmlStationEvidence(transposedAidTable(), sourceUrl);
  assert.deepEqual(result.visits.map((visit) => [visit.name, visit.sourcePosition.normalizedKm]), [
    ["Boršt", 17], ["Puče", 28], ["Šmarje", 40], ["Malija Stadium", 51], ["Strunjan", 59],
  ]);
  assert.ok(result.visits.every((visit) => visit.roles.includes("aid-station")));
  assert.deepEqual(result.visits.map((visit) => visit.sourceOrder), [0, 1, 2, 3, 4]);
  assert.ok(result.visits.every((visit, index) => {
    const parsed = stationVisitEvidenceV1Schema.safeParse(visit);
    return parsed.success && visit.source.locator.kind === "html-table-column" && visit.source.locator.column === index + 1 && visit.sourcePosition.semantics === "cumulative";
  }));
  assert.equal(result.completeness.status, "complete");
  assert.equal(result.completeness.extractedCount, 5);
});

test("transposed station table rejects absent, ambiguous, misaligned, duplicate, and invalid distance columns", () => {
  const base = transposedAidTable();
  assert.equal(extractHtmlStationEvidence(base.replace(/<tr><th>Distance<\/th>[\s\S]*?<\/tr>/, ""), sourceUrl).visits.length, 0);
  assert.equal(extractHtmlStationEvidence(base.replace("<h3>Course time limits</h3>", "<h3>Race information</h3>"), sourceUrl).visits.length, 5, "the explicit AID STATION row is sufficient station context");
  assert.equal(extractHtmlStationEvidence(base.replace("<td>59 km</td>", ""), sourceUrl).visits.length, 0, "ragged columns must not be paired");
  assert.equal(extractHtmlStationEvidence(transposedAidTable(undefined, [17, 28, 40, 51, 51]), sourceUrl).visits.length, 0);
  assert.equal(extractHtmlStationEvidence(transposedAidTable(undefined, [17, 28, "not published", 51, 59]), sourceUrl).visits.length, 0);
});

test("transposed tables require station context and an explicit distance property, not unrelated property columns", () => {
  const unrelated = `<h1>64 km course</h1><h2>Course facts</h2><table>
    <tr><th>Property</th><td>Start</td><td>Finish</td></tr><tr><th>Distance</th><td>17 km</td><td>59 km</td></tr>
  </table>`;
  const stationWithoutDistance = `<h2>64 km course</h2><table><tr><th>Aid Station</th><td>North Gate</td></tr><tr><th>Cut-off</th><td>4:00</td></tr></table>`;
  assert.equal(extractHtmlStationEvidence(unrelated, sourceUrl).visits.length, 0);
  assert.equal(extractHtmlStationEvidence(stationWithoutDistance, sourceUrl).visits.length, 0);
});

test("transposed tables keep start, finish, and checkpoints distinct and exclude post-finish services", () => {
  const boundaries = `<h2>64 km course</h2><h3>Aid stations</h3><table>
    <tr><th>Aid Station</th><td>Start</td><td>River Gate</td><td>Finish</td></tr>
    <tr><th>Distance</th><td>0 km</td><td>17 km</td><td>64 km</td></tr></table>`;
  const visits = extractHtmlStationEvidence(boundaries, sourceUrl).visits;
  assert.deepEqual(visits.map((visit) => visit.sequenceRole), ["start", "intermediate-candidate", "finish"]);
  assert.deepEqual(visits.map((visit) => visit.roles), [["start"], ["aid-station"], ["finish"]]);
  const checkpoint = `<h2>64 km course</h2><h3>Checkpoints</h3><table>
    <tr><th>Checkpoint</th><td>East gate</td><td>West gate</td></tr><tr><th>Distance</th><td>12 km</td><td>32 km</td></tr></table>`;
  const checkpointVisits = extractHtmlStationEvidence(checkpoint, sourceUrl).visits;
  assert.ok(checkpointVisits.every((visit) => visit.roles.includes("checkpoint") && !visit.roles.includes("aid-station")));
  const postFinish = `<h2>64 km course</h2><h3>Aid stations</h3><table>
    <tr><th>Aid Station</th><td>North Gate</td><td>Umag post-finish refreshments</td></tr><tr><th>Distance</th><td>17 km</td><td>65 km</td></tr></table>`;
  assert.equal(extractHtmlStationEvidence(postFinish, sourceUrl).visits.length, 0, "an invalid post-finish column rejects the malformed mixed table as a whole");
});

test("transposed station tables preserve repeated visits, reject count conflicts, and honor edition binding", () => {
  const repeated = extractHtmlStationEvidence(transposedAidTable(["Boršt", "Puče", "Boršt"], [17, 28, 40]), sourceUrl);
  assert.deepEqual(repeated.visits.map((visit) => visit.name), ["Boršt", "Puče", "Boršt"]);
  assert.notEqual(repeated.visits[0].visitId, repeated.visits[2].visitId);
  const withWrongCount = `${transposedAidTable()}<h3>Information</h3><p>The 64 km course has 4 aid stations.</p>`;
  const conflict = extractHtmlStationEvidence(withWrongCount, sourceUrl, { selectedCourseDistanceKm: 64, selectedCourseLabel: "64K" });
  assert.equal(conflict.visits.length, 5);
  assert.equal(conflict.completeness.status, "conflicting");
  assert.equal(conflict.completeness.declaredCount, 4);
  const wrongEdition = `<title>Coastal Ultra Edition 2026</title>${transposedAidTable()}`;
  assert.deepEqual(extractHtmlStationEvidence(wrongEdition, sourceUrl, { expectedEditionYear: 2027 }).issues, ["course-identity-conflict"]);
});

test("transposed extraction does not promote positions when route-course or edition binding is unverified", () => {
  const extracted = extractHtmlStationEvidence(transposedAidTable(), sourceUrl, { selectedCourseLabel: "64K", selectedCourseDistanceKm: 64 });
  assert.equal(extracted.visits.length, 5);
  const route = gpx([[[45, 14, 0], [45.1, 14.1, 100], [45.2, 14.2, 0]]]);
  const unbound = alignStationEvidenceToGpx(extracted.visits, route, {
    validatedCourse: true, editionValidated: false, bindingEvidenceIds: ["course-page"], eventName: null, editionYear: null,
    courseLabel: "64K", courseId: null, selectedGpxUrl: "https://race.example/route.gpx", selectedCourseDistanceKm: 64,
  });
  assert.ok(unbound.visits.every((visit) => visit.position.confidence === "unresolved"));
  assert.ok(unbound.visits.every((visit) => visit.position.reason === "course-binding-unverified"));
});

test("multi-course HTML requires explicit course selection and does not mix lists", () => {
  const html = `<h1>Example Ultra</h1><h2>100 km course</h2><h3>Aid stations</h3><ul><li>Aid Station 1: North Gate, 30 km</li></ul>
    <h2>50 km course</h2><h3>Aid stations</h3><ul><li>Aid Station 1: South Gate, 20 km</li></ul>`;
  const ambiguous = extractHtmlStationEvidence(html, sourceUrl);
  assert.equal(ambiguous.status, "course-selection-required");
  assert.equal(ambiguous.visits.length, 0);
  assert.equal(ambiguous.courseChoices.length, 2);
  const selected = extractHtmlStationEvidence(html, sourceUrl, { selectedCourseDistanceKm: 50 });
  assert.deepEqual(selected.visits.map((v) => v.name), ["South Gate"]);
});

test("heading-scoped lists and explicit prose preserve roles, units, qualifiers and unknown edition", () => {
  const html = `<h1>Coastal Trail</h1><h2>25 mile course</h2><h3>Water-only points</h3>
    <ul><li>Water-only point 1: Blue Bridge, approximately 4 miles</li><li>Water-only point 2: Blue Bridge, 10+ miles</li></ul>
    <p>Checkpoint at km 18: Old Mill.</p>`;
  const result = extractHtmlStationEvidence(html, sourceUrl);
  assert.equal(result.visits.length, 3);
  assert.equal(result.visits[0].sourcePosition.unit, "mi");
  assert.equal(result.visits[0].sourcePosition.normalizedKm, 4 * 1.609344);
  assert.equal(result.visits[0].sourcePosition.qualifier, "approximate");
  assert.ok(result.visits[0].roles.includes("water-only"));
  assert.equal(result.visits[1].sourcePosition.qualifier, "at-least");
  assert.equal(result.visits[2].name, "Old Mill");
  assert.ok(result.visits[2].roles.includes("checkpoint"));
  assert.equal(result.visits[0].context.editionYear, null);
});

test("station FAQ counts and post-finish mentions are not promoted to visits; minutes are not miles", () => {
  const html = `<h1>Example Trail Event Edition 2027</h1><h2>110K course</h2>
    <h3>Aid stations</h3><ul><li>110K has 7 aid stations + final one in Umag, just after finish line.</li></ul>
    <h3>On which aid stations is support allowed?</h3><ul><li>110K course: Buzet, Livade</li></ul>
    <p>Support member is allowed to enter the aid station 5 minutes before the arrival of their runner.</p>`;
  const result = extractHtmlStationEvidence(html, sourceUrl, {
    selectedCourseLabel: "110K", selectedCourseDistanceKm: 110,
    eventName: "Example Trail Event", editionYear: 2027, expectedEditionYear: 2027,
  });
  assert.equal(result.countEvidence?.declaredCount, 7);
  assert.deepEqual(result.visits.map((visit) => visit.name), ["Buzet", "Livade"]);
  assert.ok(result.visits.every((visit) => visit.sourcePosition === null));
});

test("explicitly overlapping station roles are retained without collapsing the visit", () => {
  const html = `<h2>20 km course</h2><p>Checkpoint at km 8: Pine Gate (water station and aid station).</p>`;
  const result = extractHtmlStationEvidence(html, sourceUrl);
  assert.equal(result.visits.length, 1);
  assert.deepEqual(result.visits[0].roles.sort(), ["aid-station", "checkpoint", "water-only"]);
});

test("ordering defects and duplicate source kilometers are preserved as ambiguity and block completeness", () => {
  const html = `<h2>30 km course</h2><h3>Aid stations</h3><table><tr><th>Name</th><th>Distance from start (km)</th></tr>
    <tr><td>One</td><td>10</td></tr><tr><td>Two</td><td>10</td></tr><tr><td>Three</td><td>8</td></tr></table>`;
  const result = extractHtmlStationEvidence(html, sourceUrl);
  assert.deepEqual(result.visits.map((v) => v.sourceOrder), [0, 1, 2]);
  assert.ok(result.issues.includes("duplicate-source-position"));
  assert.ok(result.issues.includes("out-of-order-visits"));
  assert.ok(result.visits[0].ambiguities.includes("duplicate-source-position"));
  assert.equal(result.completeness.status, "partial");
});

test("a course-scoped ordered aid-station list can be complete without a declared total", () => {
  const html = `<h2>40 km course</h2><h3>Aid stations</h3><table><tr><th>Name</th><th>Distance from start (km)</th></tr>
    <tr><td>North Gate Aid Station</td><td>12</td></tr><tr><td>River Aid Station</td><td>25</td></tr></table>`;
  const result = extractHtmlStationEvidence(html, sourceUrl);
  assert.deepEqual(result.completeness, { status: "complete", declaredCount: null, extractedCount: 2, basis: "dedicated-course-list" });
  const partial = extractHtmlStationEvidence(html.replace("Aid stations", "Partial aid stations"), sourceUrl);
  assert.notEqual(partial.completeness.status, "complete");
});

test("explicit totals are accepted only when the course-scoped extracted count agrees", () => {
  const html = `<h2>40 km course</h2><h3>Aid stations (2)</h3><table><tr><th>Name</th><th>Distance from start (km)</th></tr>
    <tr><td>North Gate Aid Station</td><td>12</td></tr><tr><td>River Aid Station</td><td>25</td></tr></table>`;
  const matching = extractHtmlStationEvidence(html, sourceUrl);
  assert.equal(matching.completeness.status, "complete");
  assert.equal(matching.completeness.declaredCount, 2);
  assert.equal(matching.completeness.basis, "explicit-count");
  const mismatch = extractHtmlStationEvidence(html.replace("Aid stations (2)", "Aid stations (3)"), sourceUrl);
  assert.equal(mismatch.completeness.status, "partial");
  assert.equal(mismatch.completeness.declaredCount, 3);
});

test("ambiguous prose, irrelevant content, malformed HTML and invalid source URL produce no invented visits", () => {
  assert.equal(extractHtmlStationEvidence("<h1>Race</h1><p>We have great aid stations.</p>", sourceUrl).status, "no-evidence");
  assert.equal(extractHtmlStationEvidence("<h1>Race</h1><p>Cutoff at 20 km.</p>", sourceUrl).visits.length, 0);
  assert.equal(extractHtmlStationEvidence("<p>Aid station at 12 km</p>", "http://race.example/").status, "rejected");
  assert.equal(extractHtmlStationEvidence("<table><tr><td>aid station at 10 km</td>", sourceUrl).status, "rejected");
});

test("source-kilometer alignment is approximate, requires binding and never rescales", () => {
  const html = `<h2>10 km course</h2><h3>Aid stations</h3><table><tr><th>Name</th><th>Distance from start (km)</th></tr><tr><td>Middle</td><td>5</td></tr></table>`;
  const visits = extractHtmlStationEvidence(html, sourceUrl).visits;
  const route = gpx([[[45, 14, 10], [45.045, 14, 100], [45.09, 14, 10]]]);
  const binding = { validatedCourse: true, editionValidated: true, bindingEvidenceIds: ["course-page", "edition-page"], eventName: null, editionYear: null, courseLabel: null, courseId: null, selectedGpxUrl: "https://race.example/selected.gpx", selectedCourseDistanceKm: 10 };
  const unbound = alignStationEvidenceToGpx(visits, route, { ...binding, editionValidated: false });
  assert.equal(unbound.visits[0].position.confidence, "unresolved");
  const aligned = alignStationEvidenceToGpx(visits, route, binding);
  assert.equal(aligned.visits[0].position.confidence, "approximate");
  assert.equal(aligned.visits[0].position.distanceKm, 5);
  assert.equal(Math.abs(aligned.routeDistanceKm - 10) > 0, true);
  const mismatched = alignStationEvidenceToGpx(visits, route, { ...binding, selectedCourseDistanceKm: 30 });
  assert.equal(mismatched.visits[0].position.reason, "route-distance-mismatch");
  const moderateDifference = alignStationEvidenceToGpx(visits, route, { ...binding, selectedCourseDistanceKm: aligned.routeDistanceKm + 0.75 });
  assert.equal(moderateDifference.visits[0].position.confidence, "approximate");
  assert.equal(moderateDifference.visits[0].position.distanceKm, 5);
  const outOfRangeVisit = { ...visits[0], sourcePosition: { ...visits[0].sourcePosition, value: 11, normalizedKm: 11 } };
  assert.equal(alignStationEvidenceToGpx([outOfRangeVisit], route, binding).visits[0].position.reason, "source-position-out-of-range");
  assert.equal(SOURCE_KM_ALIGNMENT_TOLERANCE_KM, 0.5, "legacy coordinate discrepancy threshold remains diagnostic only");
});

test("explicit cumulative kilometer 25 maps directly on a bound longer route without a waypoint or scaling", () => {
  const html = `<h2>40 km course</h2><h3>Aid stations</h3><table><tr><th>Name</th><th>Distance from start (km)</th></tr><tr><td>High Pass Aid Station</td><td>25</td></tr></table>`;
  const visit = extractHtmlStationEvidence(html, sourceUrl).visits[0];
  const points = Array.from({ length: 52 }, (_, i) => [45, 14 + (i * 0.01), 100]);
  const route = gpx([points]);
  const result = alignStationEvidenceToGpx([visit], route, {
    validatedCourse: true, editionValidated: true, bindingEvidenceIds: ["official-course", "edition", "selected-gpx"],
    eventName: null, editionYear: null, courseLabel: null, courseId: null,
    selectedGpxUrl: "https://race.example/selected.gpx", selectedCourseDistanceKm: 40,
  });
  assert.equal(result.visits[0].position.confidence, "approximate");
  assert.equal(result.visits[0].position.method, "source-distance");
  assert.equal(result.visits[0].position.distanceKm, 25);
  assert.equal(result.visits[0].coordinates, null);
});

test("heading-scoped station names pair with immediately associated distance paragraphs in source order", () => {
  const html = `<h1>Coastal Ultra 100K</h1><h2>Aid stations</h2>
    <h3>Malo Grablje</h3><p>10.3 km</p>
    <h3>Vidikovac</h3><p>15. 5 km</p>
    <h3>Stari Grad</h3><p>25. km</p>
    <h3>Vrisnik</h3><p>46.6 kilometers</p>
    <h3>Zavala</h3><p>62 km</p>
    <h3>Vrisnik</h3><p>70.3 km</p>
    <h3>Sv. Nedjelja</h3><p>85 km</p>
    <h3>Milna</h3><p>95.3 km</p>`;
  const result = extractHtmlStationEvidence(html, sourceUrl);
  assert.deepEqual(result.visits.map((visit) => [visit.name, visit.sourcePosition?.normalizedKm]), [
    ["Malo Grablje", 10.3], ["Vidikovac", 15.5], ["Stari Grad", 25], ["Vrisnik", 46.6],
    ["Zavala", 62], ["Vrisnik", 70.3], ["Sv. Nedjelja", 85], ["Milna", 95.3],
  ]);
  assert.notEqual(result.visits[3].visitId, result.visits[5].visitId);
  assert.deepEqual(result.visits.map((visit) => visit.roles), Array.from({ length: 8 }, () => ["aid-station"]));
  assert.equal(result.visits[0].source.locator.path, "paragraph[0]");
  assert.match(result.visits[0].source.excerpt, /Malo Grablje \| 10\.3 km/);
});

test("heading distance extraction rejects distant, ambiguous, malformed and timing-only associations", () => {
  const distant = extractHtmlStationEvidence(`<h2>Aid stations</h2><h3>North Aid Station</h3><p>Refreshments are available.</p><h3>General information</h3><p>Course distance is 20 km.</p>`, sourceUrl);
  assert.equal(distant.visits.length, 0);
  const timing = extractHtmlStationEvidence(`<h2>Aid stations</h2><h3>North Gate</h3><p>Cutoff is 4 hours at 10 km.</p>`, sourceUrl);
  assert.equal(timing.visits.length, 0);
  const ambiguous = extractHtmlStationEvidence(`<h2>Aid stations</h2><h3>North Gate</h3><p>10 km then 12 km after the checkpoint.</p>`, sourceUrl);
  assert.equal(ambiguous.visits.length, 0);
  const malformed = extractHtmlStationEvidence(`<h2>Aid stations</h2><h3>North Gate</h3><p>10,,5 km</p>`, sourceUrl);
  assert.equal(malformed.visits.length, 0);
  const afterFinish = extractHtmlStationEvidence(`<h2>Aid stations</h2><h3>Post-finish refreshments in Umag</h3><p>101 km</p>`, sourceUrl);
  assert.equal(afterFinish.visits.length, 0);
});

test("heading evidence keeps aid, checkpoint, water-only, start and finish roles distinct", () => {
  const html = `<h2>Course 20 km</h2>
    <h3>Start</h3><p>0 km</p>
    <h2>Checkpoints</h2><h3>Timing Gate</h3><p>5 km</p>
    <h2>Water-only points</h2><h3>Spring</h3><p>10 km</p>
    <h2>Aid stations</h2><h3>Village Station</h3><p>15 km</p>
    <h2>Finish</h2><p>20 km</p>`;
  const result = extractHtmlStationEvidence(html, sourceUrl, { selectedCourseLabel: "20 km", selectedCourseDistanceKm: 20 });
  assert.deepEqual(result.visits.map((visit) => [visit.name, visit.sequenceRole, visit.roles]), [
    ["Start", "start", ["start"]], ["Timing Gate", "intermediate-candidate", ["checkpoint"]],
    ["Spring", "intermediate-candidate", ["water-only"]], ["Village Station", "intermediate-candidate", ["aid-station"]],
    ["Finish", "finish", ["finish"]],
  ]);
});

test("coordinate projection verifies unambiguous matches and leaves self-crossing visits unresolved", () => {
  const payload = JSON.parse(/>([\s\S]*)<\/script>/.exec(structuredHtml())[1]);
  const parsed = extractNextDataStationEvidence(structuredHtml(), sourceUrl);
  const simpleRoute = gpx([[[45, 14, 0], [45.1, 14.1, 100], [45.2, 14.2, 0], [45.3, 14.3, 0]]]);
  const binding = { validatedCourse: true, editionValidated: true, bindingEvidenceIds: ["course-page", "edition-page"], eventName: "Example Trail Event", editionYear: 2027, courseLabel: "course-a", courseId: "course-a", selectedGpxUrl: "https://race.example/course.gpx", selectedCourseDistanceKm: 30 };
  const matched = alignStationEvidenceToGpx([parsed.visits[1]], simpleRoute, binding);
  assert.equal(matched.visits[0].position.confidence, "verified");
  assert.equal(matched.visits[0].position.method, "coordinate-projection");
  const crossingGpx = gpx([[[45, 14, 0], [45.01, 14.01, 1], [45, 14, 0], [45.01, 14.01, 1]]]);
  const crossing = alignStationEvidenceToGpx([{ ...parsed.visits[0], coordinates: { latitude: 45, longitude: 14 } }], crossingGpx, binding);
  assert.equal(crossing.visits[0].position.confidence, "unresolved");
  assert.equal(crossing.visits[0].position.reason, "coordinate-match-ambiguous");
  assert.ok(payload);
});

test("coordinate projection retains disconnected component identity and rejects binding mismatch", () => {
  const result = extractNextDataStationEvidence(structuredHtml(), sourceUrl);
  const route = gpx([
    [[44, 13, 0], [44.001, 13.001, 1]],
    [[45.099, 14.099, 0], [45.101, 14.101, 1], [45.2, 14.2, 0]],
  ]);
  const binding = { validatedCourse: true, editionValidated: true, bindingEvidenceIds: ["course-page", "edition-page"], eventName: "Example Trail Event", editionYear: 2027, courseLabel: "course-a", courseId: "course-a", selectedGpxUrl: "https://race.example/course.gpx", selectedCourseDistanceKm: 30 };
  const aligned = alignStationEvidenceToGpx([result.visits[1]], route, binding);
  assert.equal(aligned.visits[0].position.confidence, "verified");
  assert.equal(aligned.visits[0].position.componentIndex, 1);
  const mismatch = alignStationEvidenceToGpx([result.visits[1]], route, { ...binding, editionYear: 2026 });
  assert.equal(mismatch.visits[0].position.confidence, "unresolved");
  assert.equal(mismatch.visits[0].position.reason, "course-identity-mismatch");
});
