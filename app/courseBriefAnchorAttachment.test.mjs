import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { analyzeGpxRoute, parseGpxText } from "./gpxAnalysis.ts";
import { buildCourseBriefInputV2 } from "./courseBriefNarrativeFacts.ts";
import {
  buildCourseBriefCandidates,
  renderCourseBriefV2,
  selectCourseBriefCandidates,
} from "./courseBriefCandidates.ts";
import {
  attachCourseBriefRouteAnchors,
  COURSE_BRIEF_ANCHOR_ATTACHMENT_VERSION,
  resolveFullPrecisionCourseBriefBoundary,
  resolveCourseBriefAnchorOwnership,
} from "./courseBriefAnchorAttachment.ts";
import { createRouteFingerprint } from "./routeFingerprint.ts";
import { createAnalysisInputFingerprint } from "./analysisInputFingerprint.ts";
import { routeAnchorGeometryFromAnalysis, matchRouteAnchors } from "./routeAnchorMatching.ts";
import { createIstria110kAnchorEvidenceFixture } from "./istria110kAnchorEvidence.ts";

const gpx = await readFile(new URL("../public/ISTRIA_110K_2027.gpx", import.meta.url), "utf8");
const analysis = analyzeGpxRoute(parseGpxText(gpx));
const courseBriefInput = buildCourseBriefInputV2(analysis);
const built = buildCourseBriefCandidates(courseBriefInput);
assert.equal(built.ok, true);
const selection = selectCourseBriefCandidates(courseBriefInput, built.candidates);
assert.equal(selection.ok, true);
const courseBriefOutput = renderCourseBriefV2(courseBriefInput, built.candidates, selection);
const routeId = "3d3-test-current-analysis";
const route = routeAnchorGeometryFromAnalysis(routeId, analysis);

async function binding(overrides = {}) {
  const geometrySegments = analysis.segments.map((segment) => segment.points.map(({ latitude, longitude }) => ({ latitude, longitude })));
  const analysisSegments = analysis.segments.map((segment) => segment.points.map(({ latitude, longitude, elevationM }) => ({ latitude, longitude, elevationM })));
  const [physical, inputFingerprint] = await Promise.all([
    createRouteFingerprint(geometrySegments),
    createAnalysisInputFingerprint(analysisSegments),
  ]);
  return {
    routeId,
    routeFingerprint: physical.routeFingerprint,
    routeFingerprintVersion: physical.routeFingerprintVersion,
    analysisInputFingerprint: inputFingerprint,
    analysisInputFingerprintVersion: 2,
    distanceKm: route.distanceKm,
    components: route.bounds.components.map(({ componentIndex, ...bounds }) => ({ segmentIndex: componentIndex, ...bounds })),
    ...overrides,
  };
}

function sourceEvidence({ id, locationId, placeId, km, type = "NAMED_LOCATION", visitId }) {
  return {
    location: {
      locationId,
      placeId,
      name: `Fixture ${locationId}`,
      type,
      sourceEditionYear: null,
      evidenceIds: [id],
    },
    evidence: {
      schemaVersion: 2,
      evidenceId: id,
      raceId: "fixture-race",
      editionYear: 2027,
      sourceEditionYear: null,
      sourceId: "fixture-official-source",
      evidenceKind: "official-structured-position",
      provenance: "official",
      verificationMethod: "structured-source",
      routeKmFact: {
        distanceKm: km,
        componentIndex: 0,
        convention: "traversed-distance-from-route-start",
      },
      ...(visitId ? { visitId } : {}),
    },
  };
}

function directMatchOutput(specs) {
  const entries = specs.map((spec) => sourceEvidence(spec));
  const context = {
    schemaVersion: 1,
    raceId: "fixture-race",
    editionYear: 2027,
    raceName: "Fixture race",
    sourceIds: ["fixture-official-source"],
    locations: entries.map(({ location }) => location),
  };
  const evidence = entries.map(({ evidence }) => evidence);
  return matchRouteAnchors({ context, evidence, route, orderingConstraints: [] });
}

function rangeMatchOutput(startKm, endKm) {
  const matching = directMatchOutput([{ id: "range-e", locationId: "range-location", placeId: "range-place", km: 4 }]);
  const position = { type: "RANGE", componentIndex: 0, startKm, endKm };
  const evidence = { ...matching.dataset.evidence.find(({ evidenceId }) => evidenceId === "range-e"), positionFact: position };
  delete evidence.routeKmFact;
  const anchor = { ...matching.dataset.anchors[0], position, evidenceIds: ["range-e"] };
  matching.dataset.context.locations[0].evidenceIds = ["range-e"];
  matching.dataset.evidence = [evidence];
  matching.dataset.anchors = [anchor];
  matching.results[0] = { ...matching.results[0], componentIndex: 0, position, evidenceIds: ["range-e"], anchor };
  return matching;
}

function request(matchingOutput, routeBindingValue) {
  return {
    courseBriefInput,
    candidatePool: built.candidates,
    selection,
    courseBriefOutput,
    routeAnalysis: analysis,
    routeBinding: routeBindingValue,
    matchingOutput,
  };
}

function requestWithAnalysis(matchingOutput, routeBindingValue, routeAnalysis) {
  return { ...request(matchingOutput, routeBindingValue), routeAnalysis };
}

function observationAt(index) {
  return courseBriefOutput.observations[index];
}

function stable(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
}

test("attachment is independently versioned and leaves structural V2 output byte-for-byte unchanged", async () => {
  assert.equal(COURSE_BRIEF_ANCHOR_ATTACHMENT_VERSION, 1);
  const before = stable(courseBriefOutput);
  const result = await attachCourseBriefRouteAnchors(request(directMatchOutput([{
    id: "interior-evidence", locationId: "interior-location", placeId: "interior-place", km: 4,
  }]), await binding()));
  assert.equal(result.ok, true);
  assert.equal(stable(courseBriefOutput), before);
  assert.deepEqual(result.attachment.attachments.map(({ candidateId }) => candidateId), [observationAt(0).candidateId]);
  assert.equal(result.attachment.attachments.length, 1);
});

test("valid input with zero attachable anchors succeeds and reports context-only diagnostics", async () => {
  const fixture = createIstria110kAnchorEvidenceFixture();
  const matching = matchRouteAnchors({
    ...fixture,
    route: routeAnchorGeometryFromAnalysis(routeId, analysis),
  });
  const result = await attachCourseBriefRouteAnchors(request(matching, await binding()));
  assert.equal(result.ok, true);
  assert.deepEqual(result.attachment.attachments, []);
  assert.equal(result.attachment.diagnostics.items.filter(({ code }) => code === "context-only").length, 4);
});

test("Istria 110K 2027 remains four context-only matches with zero geographic attachments", async () => {
  const fixture = createIstria110kAnchorEvidenceFixture();
  const matching = matchRouteAnchors({ ...fixture, route: routeAnchorGeometryFromAnalysis(routeId, analysis) });
  const result = await attachCourseBriefRouteAnchors(request(matching, await binding()));
  assert.equal(matching.results.length, 4);
  assert.ok(matching.results.every(({ state }) => state === "context-only"));
  assert.equal(result.ok, true);
  assert.equal(result.attachment.attachments.length, 0);
});

test("ordering-only evidence remains unpositioned and cannot create geographic attachments", async () => {
  const evidence = {
    schemaVersion: 2, evidenceId: "order-evidence", raceId: "fixture-race", editionYear: 2027,
    sourceEditionYear: null, sourceId: "fixture-official-source", evidenceKind: "official-text-order",
    provenance: "official", verificationMethod: "text-review",
    orderingFact: { beforeVisitId: "before-visit", afterVisitId: "after-visit" },
  };
  const matching = matchRouteAnchors({
    context: { schemaVersion: 1, raceId: "fixture-race", editionYear: 2027, raceName: "Fixture race",
      sourceIds: ["fixture-official-source"], locations: [
        { locationId: "before", placeId: "before-place", name: "Before", type: "NAMED_LOCATION", sourceEditionYear: null, evidenceIds: [evidence.evidenceId] },
        { locationId: "after", placeId: "after-place", name: "After", type: "NAMED_LOCATION", sourceEditionYear: null, evidenceIds: [evidence.evidenceId] },
      ] },
    evidence: [evidence], route, orderingConstraints: [{ beforeVisitId: "before-visit", afterVisitId: "after-visit", evidenceIds: [evidence.evidenceId] }],
  });
  assert.ok(matching.results.every(({ state, method, position }) => state === "context-only" && method === "ordering-only" && position.type === "UNPOSITIONED"));
  const result = await attachCourseBriefRouteAnchors(request(matching, await binding()));
  assert.equal(result.ok, true);
  assert.deepEqual(result.attachment.attachments, []);
  assert.equal(result.attachment.diagnostics.items.length, 2);
});

test("START, TRANSITION destination, interior and FINISH attach to their component-owning observations", async () => {
  const observations = courseBriefOutput.observations;
  const matching = directMatchOutput([
    { id: "start-e", locationId: "start", placeId: "start-place", km: route.bounds.components[0].startKm, type: "START" },
    { id: "transition-e", locationId: "transition", placeId: "transition-place", km: observations[1].startKm },
    { id: "interior-e", locationId: "interior", placeId: "interior-place", km: 50 },
    { id: "finish-e", locationId: "finish", placeId: "finish-place", km: route.bounds.components[0].endKm, type: "FINISH" },
  ]);
  const result = await attachCourseBriefRouteAnchors(request(matching, await binding()));
  assert.equal(result.ok, true);
  assert.deepEqual(result.attachment.attachments.map(({ candidateId, role }) => [candidateId, role]), [
    [observations[0].candidateId, "START"],
    [observations[1].candidateId, "TRANSITION"],
    [observations[2].candidateId, "INTERNAL"],
    [observations[3].candidateId, "FINISH"],
  ]);
});

test("point at the shared observation boundary belongs to the following transition destination", async () => {
  const next = observationAt(1);
  const matching = directMatchOutput([{ id: "boundary-e", locationId: "boundary", placeId: "boundary-place", km: next.startKm }]);
  const result = await attachCourseBriefRouteAnchors(request(matching, await binding()));
  assert.equal(result.ok, true);
  assert.equal(result.attachment.attachments.length, 1);
  assert.equal(result.attachment.attachments[0].candidateId, next.candidateId);
  assert.equal(result.attachment.attachments[0].role, "TRANSITION");
});

test("point at observation start derives ENTRY", async () => {
  const matching = directMatchOutput([{ id: "entry-e", locationId: "entry", placeId: "entry-place", km: observationAt(0).startKm }]);
  const result = await attachCourseBriefRouteAnchors(request(matching, await binding()));
  assert.equal(result.ok, true);
  assert.equal(result.attachment.attachments[0].role, "ENTRY");
});

test("interior point derives INTERNAL", async () => {
  const matching = directMatchOutput([{ id: "inside-e", locationId: "inside", placeId: "inside-place", km: 5 }]);
  const result = await attachCourseBriefRouteAnchors(request(matching, await binding()));
  assert.equal(result.ok, true);
  assert.equal(result.attachment.attachments[0].role, "INTERNAL");
});

test("range ownership supports contained ranges and derives EXIT, while crossing ranges are unowned", () => {
  const windows = [{ candidateId: "obs", componentIndex: 0, startKm: 10, endKm: 20, transitionBoundaryKms: [] }];
  const ends = new Map([[0, 30]]);
  assert.deepEqual(resolveCourseBriefAnchorOwnership(windows, {
    type: "RANGE", componentIndex: 0, startKm: 15, endKm: 20, anchorType: "NAMED_LOCATION",
  }, ends), { status: "owned", candidateId: "obs", role: "EXIT" });
  assert.deepEqual(resolveCourseBriefAnchorOwnership(windows, {
    type: "RANGE", componentIndex: 0, startKm: 10, endKm: 15, anchorType: "NAMED_LOCATION",
  }, ends), { status: "owned", candidateId: "obs", role: "ENTRY" });
  assert.deepEqual(resolveCourseBriefAnchorOwnership(windows, {
    type: "RANGE", componentIndex: 0, startKm: 19, endKm: 21, anchorType: "NAMED_LOCATION",
  }, ends), { status: "unowned" });
});

test("validated RANGE anchors attach only when fully contained in one selected observation", async () => {
  const within = rangeMatchOutput(4, 5);
  const attached = await attachCourseBriefRouteAnchors(request(within, await binding()));
  assert.equal(attached.ok, true);
  assert.equal(attached.attachment.attachments.length, 1);
  assert.deepEqual(attached.attachment.attachments[0].position, { type: "RANGE", componentIndex: 0, startKm: 4, endKm: 5 });

  const boundary = observationAt(1).startKm;
  const crossing = rangeMatchOutput(boundary - 0.1, boundary + 0.1);
  const rejected = await attachCourseBriefRouteAnchors(request(crossing, await binding()));
  assert.equal(rejected.ok, true);
  assert.equal(rejected.attachment.attachments.length, 0);
  assert.ok(rejected.attachment.diagnostics.items.some(({ code }) => code === "no-observation-owner"));
});

test("half-open point ownership selects the following window without array-order dependence", () => {
  const windows = [
    { candidateId: "following", componentIndex: 0, startKm: 10, endKm: 20, transitionBoundaryKms: [] },
    { candidateId: "preceding", componentIndex: 0, startKm: 0, endKm: 10, transitionBoundaryKms: [] },
  ];
  assert.deepEqual(resolveCourseBriefAnchorOwnership(windows, {
    type: "POINT", componentIndex: 0, distanceKm: 10, anchorType: "NAMED_LOCATION",
  }, new Map()), { status: "owned", candidateId: "following", role: "ENTRY" });
});

test("equal cumulative kilometers on disconnected components never share ownership", () => {
  const windows = [
    { candidateId: "component-zero", componentIndex: 0, startKm: 0, endKm: 10, transitionBoundaryKms: [] },
    { candidateId: "component-one", componentIndex: 1, startKm: 10, endKm: 20, transitionBoundaryKms: [] },
  ];
  assert.deepEqual(resolveCourseBriefAnchorOwnership(windows, {
    type: "POINT", componentIndex: 1, distanceKm: 10, anchorType: "NAMED_LOCATION",
  }, new Map()), { status: "owned", candidateId: "component-one", role: "ENTRY" });
  assert.deepEqual(resolveCourseBriefAnchorOwnership(windows, {
    type: "POINT", componentIndex: 2, distanceKm: 10, anchorType: "NAMED_LOCATION",
  }, new Map()), { status: "unowned" });
});

test("overlapping selected ranges are ambiguous unless one has the exact structural transition relation", () => {
  const windows = [
    { candidateId: "later-in-input", componentIndex: 0, startKm: 10, endKm: 20, transitionBoundaryKms: [] },
    { candidateId: "earlier-in-input", componentIndex: 0, startKm: 5, endKm: 15, transitionBoundaryKms: [] },
  ];
  const position = { type: "POINT", componentIndex: 0, distanceKm: 12, anchorType: "NAMED_LOCATION" };
  assert.deepEqual(resolveCourseBriefAnchorOwnership(windows, position, new Map()), {
    status: "ambiguous", candidateIds: ["earlier-in-input", "later-in-input"],
  });
  const transitionWindows = windows.map((window) => window.candidateId === "later-in-input"
    ? { ...window, transitionBoundaryKms: [12] }
    : window);
  assert.deepEqual(resolveCourseBriefAnchorOwnership(transitionWindows, position, new Map()), {
    status: "owned", candidateId: "later-in-input", role: "TRANSITION",
  });
});

test("terminal FINISH is admitted at the true final endpoint only", () => {
  const windows = [{ candidateId: "last", componentIndex: 0, startKm: 90, endKm: 100, transitionBoundaryKms: [] }];
  assert.deepEqual(resolveCourseBriefAnchorOwnership(windows, {
    type: "POINT", componentIndex: 0, distanceKm: 100, anchorType: "FINISH",
  }, new Map([[0, 100]])), { status: "owned", candidateId: "last", role: "FINISH" });
  assert.deepEqual(resolveCourseBriefAnchorOwnership(windows, {
    type: "POINT", componentIndex: 0, distanceKm: 100, anchorType: "NAMED_LOCATION",
  }, new Map([[0, 100]])), { status: "unowned" });
});

function boundaryAnalysis(actualBoundaryKm, displayBoundaryKm = Number(actualBoundaryKm.toFixed(2))) {
  const nextEndKm = Math.max(100, actualBoundaryKm + 10);
  return {
    routeAnalysis: { routeSections: [
      { segmentIndex: 0, startKm: 0, endKm: displayBoundaryKm,
        startPosition: { segmentIndex: 0, distanceM: 0 }, endPosition: { segmentIndex: 0, distanceM: actualBoundaryKm * 1000 } },
      { segmentIndex: 0, startKm: displayBoundaryKm, endKm: Number(nextEndKm.toFixed(2)),
        startPosition: { segmentIndex: 0, distanceM: actualBoundaryKm * 1000 }, endPosition: { segmentIndex: 0, distanceM: nextEndKm * 1000 } },
    ] },
    componentBounds: [{ segmentIndex: 0, startKm: 0, endKm: nextEndKm, traversedDistanceKm: nextEndKm }],
    nextEndKm,
  };
}

function preciseWindows(boundaryKm, endKm) {
  return [
    { candidateId: "before", componentIndex: 0, startKm: 0, endKm: boundaryKm, transitionBoundaryKms: [] },
    { candidateId: "after", componentIndex: 0, startKm: boundaryKm, endKm, transitionBoundaryKms: [boundaryKm] },
  ];
}

test("full-precision ownership is independent of a boundary rounded downward", () => {
  const fixture = boundaryAnalysis(42.754, 42.75);
  const boundary = resolveFullPrecisionCourseBriefBoundary(fixture.routeAnalysis, 0, 42.75, "end", fixture.componentBounds);
  assert.deepEqual(boundary, { status: "resolved", distanceKm: 42.754 });
  const windows = preciseWindows(boundary.distanceKm, fixture.nextEndKm);
  assert.deepEqual(resolveCourseBriefAnchorOwnership(windows, {
    type: "POINT", componentIndex: 0, distanceKm: 42.752, anchorType: "NAMED_LOCATION",
  }, new Map([[0, fixture.nextEndKm]])), { status: "owned", candidateId: "before", role: "INTERNAL" });
  assert.deepEqual(resolveCourseBriefAnchorOwnership(windows, {
    type: "POINT", componentIndex: 0, distanceKm: 42.756, anchorType: "NAMED_LOCATION",
  }, new Map([[0, fixture.nextEndKm]])), { status: "owned", candidateId: "after", role: "INTERNAL" });
});

test("a boundary rounded upward still assigns a point before its actual position to the preceding observation", () => {
  const fixture = boundaryAnalysis(42.756, 42.76);
  const boundary = resolveFullPrecisionCourseBriefBoundary(fixture.routeAnalysis, 0, 42.76, "start", fixture.componentBounds);
  assert.deepEqual(boundary, { status: "resolved", distanceKm: 42.756 });
  const windows = preciseWindows(boundary.distanceKm, fixture.nextEndKm);
  assert.deepEqual(resolveCourseBriefAnchorOwnership(windows, {
    type: "POINT", componentIndex: 0, distanceKm: 42.754, anchorType: "NAMED_LOCATION",
  }, new Map([[0, fixture.nextEndKm]])), { status: "owned", candidateId: "before", role: "INTERNAL" });
  assert.deepEqual(resolveCourseBriefAnchorOwnership(windows, {
    type: "POINT", componentIndex: 0, distanceKm: 42.758, anchorType: "NAMED_LOCATION",
  }, new Map([[0, fixture.nextEndKm]])), { status: "owned", candidateId: "after", role: "INTERNAL" });
});

test("an anchor exactly on the recovered full-precision boundary belongs to the following observation", () => {
  const fixture = boundaryAnalysis(42.754, 42.75);
  const boundary = resolveFullPrecisionCourseBriefBoundary(fixture.routeAnalysis, 0, 42.75, "start", fixture.componentBounds);
  assert.deepEqual(resolveCourseBriefAnchorOwnership(preciseWindows(boundary.distanceKm, fixture.nextEndKm), {
    type: "POINT", componentIndex: 0, distanceKm: boundary.distanceKm, anchorType: "NAMED_LOCATION",
  }, new Map([[0, fixture.nextEndKm]])), { status: "owned", candidateId: "after", role: "TRANSITION" });
});

test("a range crossing the true boundary is unowned even when it lies beyond the rounded display boundary", () => {
  const fixture = boundaryAnalysis(42.754, 42.75);
  const boundary = resolveFullPrecisionCourseBriefBoundary(fixture.routeAnalysis, 0, 42.75, "end", fixture.componentBounds);
  assert.ok(42.753 > 42.75);
  assert.deepEqual(resolveCourseBriefAnchorOwnership(preciseWindows(boundary.distanceKm, fixture.nextEndKm), {
    type: "RANGE", componentIndex: 0, startKm: 42.753, endKm: 42.755, anchorType: "NAMED_LOCATION",
  }, new Map([[0, fixture.nextEndKm]])), { status: "unowned" });
});

test("a transition affinity cannot override actual component interval ownership", () => {
  const windows = [
    { candidateId: "before", componentIndex: 0, startKm: 0, endKm: 42.754, transitionBoundaryKms: [] },
    { candidateId: "after-starts-later", componentIndex: 0, startKm: 42.756, endKm: 100, transitionBoundaryKms: [42.754] },
  ];
  assert.deepEqual(resolveCourseBriefAnchorOwnership(windows, {
    type: "POINT", componentIndex: 0, distanceKm: 42.754, anchorType: "NAMED_LOCATION",
  }, new Map([[0, 100]])), { status: "unowned" });
});

test("ambiguous rounded boundary recovery fails closed instead of choosing one precise position", () => {
  const fixture = boundaryAnalysis(42.754, 42.75);
  fixture.routeAnalysis.routeSections.push({ segmentIndex: 0, startKm: 42.75, endKm: 42.75,
    startPosition: { segmentIndex: 0, distanceM: 42751 }, endPosition: { segmentIndex: 0, distanceM: 42752 } });
  assert.deepEqual(resolveFullPrecisionCourseBriefBoundary(fixture.routeAnalysis, 0, 42.75, "start", fixture.componentBounds), {
    status: "unresolved",
  });
});

test("an anchor near an unresolved canonical boundary fails closed with a bounded diagnostic", async () => {
  const observation = observationAt(1);
  const matching = directMatchOutput([{ id: "uncertain-boundary-e", locationId: "uncertain-boundary", placeId: "uncertain-place", km: observation.startKm }]);
  const uncertainAnalysis = structuredClone(analysis);
  const section = uncertainAnalysis.routeSections.find((item) => item.segmentIndex === observation.componentIndex && item.startKm === observation.startKm);
  assert.ok(section);
  section.startPosition.distanceM += 1;
  const result = await attachCourseBriefRouteAnchors(requestWithAnalysis(matching, await binding(), uncertainAnalysis));
  assert.equal(result.ok, true);
  assert.deepEqual(result.attachment.attachments, []);
  assert.ok(result.attachment.diagnostics.items.some(({ code, anchorId }) =>
    code === "uncertain-observation-boundary" && anchorId === matching.results[0].anchor.anchorId), JSON.stringify(result.attachment.diagnostics.items));
  assert.ok(result.attachment.diagnostics.items.length <= 256);
});

test("equal-priority distinct visits remain unattached with diagnostics; visit identity is preserved", async () => {
  const matching = directMatchOutput([
    { id: "visit-a-e", locationId: "visit-a", placeId: "same-place", km: 2, visitId: "visit-a-id" },
    { id: "visit-b-e", locationId: "visit-b", placeId: "same-place", km: 8, visitId: "visit-b-id" },
  ]);
  const result = await attachCourseBriefRouteAnchors(request(matching, await binding()));
  assert.equal(result.ok, true);
  assert.equal(result.attachment.attachments.length, 0);
  assert.equal(result.attachment.diagnostics.items.filter(({ code }) => code === "equal-priority-anchors").length, 2);
  assert.deepEqual(matching.results.map(({ visitId }) => visitId).sort(), ["visit-a-id", "visit-b-id"]);
});

test("exact-direct outranks verified-match without ranking names, IDs, evidence counts, or input order", async () => {
  const point = analysis.points.find((entry) => entry.distanceM / 1000 > 3 && entry.distanceM / 1000 < 8);
  assert.ok(point);
  const direct = sourceEvidence({ id: "exact-e", locationId: "exact-location", placeId: "Z-place", km: 4 });
  const verified = {
    location: { locationId: "verified-location", placeId: "A-place", name: "Verified", type: "NAMED_LOCATION", sourceEditionYear: null, evidenceIds: ["verified-e"] },
    evidence: {
      schemaVersion: 2, evidenceId: "verified-e", raceId: "fixture-race", editionYear: 2027, sourceEditionYear: null,
      sourceId: "fixture-official-source", evidenceKind: "official-map-or-coordinate", provenance: "official",
      verificationMethod: "geographic-match", coordinateFact: { latitude: point.latitude, longitude: point.longitude, semantics: "route-point", componentIndex: point.segmentIndex },
    },
  };
  const matching = matchRouteAnchors({
    context: { schemaVersion: 1, raceId: "fixture-race", editionYear: 2027, raceName: "Fixture race", sourceIds: ["fixture-official-source"], locations: [direct.location, verified.location] },
    evidence: [direct.evidence, verified.evidence], route, orderingConstraints: [],
  });
  assert.ok(matching.results.some(({ contextLocationId, state }) => contextLocationId === "verified-location" && state === "matched-verified"));
  const result = await attachCourseBriefRouteAnchors(request(matching, await binding()));
  assert.equal(result.ok, true);
  const attached = result.attachment.attachments.find(({ candidateId }) => candidateId === observationAt(0).candidateId);
  assert.equal(attached?.anchorId, matching.results.find(({ contextLocationId }) => contextLocationId === "exact-location")?.anchor.anchorId);
  assert.ok(result.attachment.diagnostics.items.some(({ code, anchorId }) => code === "lower-priority-anchor"
    && anchorId === matching.results.find(({ contextLocationId }) => contextLocationId === "verified-location")?.anchor.anchorId));
});

test("explicit structural transition association outranks a generic anchor for that observation", async () => {
  const transitionObservation = observationAt(1);
  const midpoint = (transitionObservation.startKm + transitionObservation.endKm) / 2;
  const matching = directMatchOutput([
    { id: "generic-e", locationId: "generic", placeId: "generic-place", km: midpoint },
    { id: "transition-e", locationId: "transition-boundary", placeId: "transition-place", km: transitionObservation.startKm },
  ]);
  const result = await attachCourseBriefRouteAnchors(request(matching, await binding()));
  assert.equal(result.ok, true);
  const attached = result.attachment.attachments.find(({ candidateId }) => candidateId === transitionObservation.candidateId);
  assert.equal(attached?.contextLocationId, "transition-boundary");
  assert.equal(attached?.role, "TRANSITION");
  assert.ok(result.attachment.diagnostics.items.some(({ code, contextLocationId }) =>
    code === "lower-priority-anchor" && contextLocationId === "generic"));
});

test("approximate place-reference matches are diagnostic-only", async () => {
  const point = analysis.points.find((entry) => entry.distanceM / 1000 > 3 && entry.distanceM / 1000 < 8);
  assert.ok(point);
  const matching = matchRouteAnchors({
    context: { schemaVersion: 1, raceId: "fixture-race", editionYear: 2027, raceName: "Fixture race", sourceIds: ["fixture-source"], locations: [
      { locationId: "approx", placeId: "approx-place", name: "Approx", type: "NAMED_LOCATION", sourceEditionYear: null, evidenceIds: ["approx-e"] },
    ] },
    evidence: [{ schemaVersion: 2, evidenceId: "approx-e", raceId: "fixture-race", editionYear: 2027, sourceEditionYear: null,
      sourceId: "fixture-source", evidenceKind: "official-map-or-coordinate", provenance: "official", verificationMethod: "geographic-match",
      coordinateFact: { latitude: point.latitude, longitude: point.longitude, semantics: "place-reference-point", componentIndex: point.segmentIndex } }],
    route, orderingConstraints: [],
  });
  assert.equal(matching.results[0].state, "matched-approximate");
  const result = await attachCourseBriefRouteAnchors(request(matching, await binding()));
  assert.equal(result.ok, true);
  assert.equal(result.attachment.attachments.length, 0);
  assert.equal(result.attachment.diagnostics.items[0].code, "approximate-excluded");
  assert.equal(result.attachment.diagnostics.items[0].matchState, "matched-approximate");
  assert.ok(result.attachment.diagnostics.items[0].evidenceIds.includes("approx-e"));
  assert.deepEqual(result.attachment.diagnostics.items[0].reasonCodes, ["matched-route-projection"]);
});

test("conflicting and context-only matching results never attach", async () => {
  const evidence = [2, 8].map((km, index) => ({
    schemaVersion: 2,
    evidenceId: `conflict-${index}`,
    raceId: "fixture-race",
    editionYear: 2027,
    sourceEditionYear: null,
    sourceId: "fixture-official-source",
    evidenceKind: "official-structured-position",
    provenance: "official",
    verificationMethod: "structured-source",
    routeKmFact: { distanceKm: km, componentIndex: 0, convention: "traversed-distance-from-route-start" },
  }));
  const conflict = matchRouteAnchors({
    context: { schemaVersion: 1, raceId: "fixture-race", editionYear: 2027, raceName: "Fixture race",
      sourceIds: ["fixture-official-source"], locations: [{ locationId: "conflict", placeId: "conflict-place", name: "Conflict",
        type: "NAMED_LOCATION", sourceEditionYear: null, evidenceIds: evidence.map(({ evidenceId }) => evidenceId) }] },
    evidence, route, orderingConstraints: [],
  });
  assert.equal(conflict.results[0].state, "conflicting");
  const checked = await attachCourseBriefRouteAnchors(request(conflict, await binding()));
  assert.equal(checked.ok, true);
  assert.equal(checked.attachment.attachments.length, 0);
  assert.equal(checked.attachment.diagnostics.items[0].code, "conflicting-excluded");
});

test("ambiguous and rejected materialized context results remain excluded", async () => {
  for (const state of ["ambiguous", "rejected"]) {
    const matching = directMatchOutput([{ id: `${state}-e`, locationId: state, placeId: `${state}-place`, km: 3 }]);
    const anchor = matching.dataset.anchors[0];
    const diagnosticAnchor = { ...anchor, position: { type: "UNPOSITIONED" }, positionConfidence: "context-only", visitId: null };
    matching.dataset.anchors[0] = diagnosticAnchor;
    matching.results[0] = { ...matching.results[0], state, visitId: null, position: { type: "UNPOSITIONED" }, componentIndex: null,
      positionConfidence: "context-only", positionSafe: false, anchor: diagnosticAnchor };
    const result = await attachCourseBriefRouteAnchors(request(matching, await binding()));
    assert.equal(result.ok, true);
    assert.equal(result.attachment.attachments.length, 0);
    assert.equal(result.attachment.diagnostics.items[0].code, state === "ambiguous" ? "ambiguous-match-excluded" : "rejected-match-excluded");
  }
});

test("unselected candidate windows cannot own an anchor", () => {
  const selectedWindows = [{ candidateId: "selected-observation", componentIndex: 0, startKm: 0, endKm: 10, transitionBoundaryKms: [] }];
  const omittedCandidateWindow = { candidateId: "omitted-candidate", componentIndex: 0, startKm: 10, endKm: 20, transitionBoundaryKms: [] };
  assert.ok(!selectedWindows.some(({ candidateId }) => candidateId === omittedCandidateWindow.candidateId));
  assert.deepEqual(resolveCourseBriefAnchorOwnership(selectedWindows, {
    type: "POINT", componentIndex: 0, distanceKm: 15, anchorType: "NAMED_LOCATION",
  }, new Map()), { status: "unowned" });
});

test("attachment output is keyed only by selected rendered observations", async () => {
  const matching = directMatchOutput([{ id: "outside-e", locationId: "outside", placeId: "outside-place", km: 70 }]);
  const result = await attachCourseBriefRouteAnchors(request(matching, await binding()));
  assert.equal(result.ok, true);
  assert.equal(result.attachment.attachments.length, 1);
  assert.ok(result.attachment.attachments.every(({ candidateId }) => selection.selectedCandidates.some((candidate) => candidate.candidateId === candidateId)));
  assert.ok(!result.attachment.attachments.some(({ candidateId }) => selection.omittedCandidateIds.includes(candidateId)));
});

test("START and FINISH do not get forced into observations that do not own their endpoints", () => {
  const windows = [{ candidateId: "middle", componentIndex: 0, startKm: 10, endKm: 20, transitionBoundaryKms: [] }];
  const ends = new Map([[0, 30]]);
  assert.deepEqual(resolveCourseBriefAnchorOwnership(windows, {
    type: "POINT", componentIndex: 0, distanceKm: 0, anchorType: "START",
  }, ends), { status: "unowned" });
  assert.deepEqual(resolveCourseBriefAnchorOwnership(windows, {
    type: "POINT", componentIndex: 0, distanceKm: 30, anchorType: "FINISH",
  }, ends), { status: "unowned" });
});

test("attachment rejects stale candidates and a selection/output mismatch without partial results", async () => {
  const matching = directMatchOutput([{ id: "stale-e", locationId: "stale", placeId: "stale-place", km: 4 }]);
  const stalePool = [...built.candidates, { ...built.candidates[0], candidateId: "stale-candidate" }];
  const stale = await attachCourseBriefRouteAnchors({ ...request(matching, await binding()), candidatePool: stalePool });
  assert.deepEqual(stale, { ok: false, error: "invalid_candidate_pool" });
  const wrongOutput = { ...courseBriefOutput, observations: [...courseBriefOutput.observations].reverse() };
  const mismatch = await attachCourseBriefRouteAnchors({ ...request(matching, await binding()), courseBriefOutput: wrongOutput });
  assert.deepEqual(mismatch, { ok: false, error: "output_mismatch" });
});

test("route fingerprints and exact component-aware bounds are checked against the same analysis", async () => {
  const matching = directMatchOutput([{ id: "route-e", locationId: "route", placeId: "route-place", km: 4 }]);
  const goodBinding = await binding();
  const badIdentity = await binding({ routeFingerprint: "different-physical-route" });
  assert.deepEqual(await attachCourseBriefRouteAnchors(request(matching, badIdentity)), { ok: false, error: "route_identity_mismatch" });
  const badBounds = await binding({ distanceKm: 1 });
  assert.deepEqual(await attachCourseBriefRouteAnchors(request(matching, badBounds)), { ok: false, error: "route_bounds_mismatch" });
  const badRouteId = await binding({ routeId: "another-id" });
  assert.deepEqual(await attachCourseBriefRouteAnchors(request(matching, badRouteId)), { ok: false, error: "route_bounds_mismatch" });
  assert.equal((await attachCourseBriefRouteAnchors(request(matching, goodBinding))).ok, true);
});

test("stale evidence references, duplicated visits, and invalid components fail closed", async () => {
  const matching = directMatchOutput([
    { id: "one-e", locationId: "one", placeId: "one-place", km: 3 },
    { id: "two-e", locationId: "two", placeId: "two-place", km: 40 },
  ]);
  const badEvidence = structuredClone(matching);
  badEvidence.results[0].evidenceIds.push("missing-evidence");
  assert.deepEqual(await attachCourseBriefRouteAnchors(request(badEvidence, await binding())), { ok: false, error: "invalid_matching_output" });

  const duplicateVisits = structuredClone(matching);
  const firstVisit = duplicateVisits.dataset.anchors[0].visitId;
  duplicateVisits.dataset.anchors[1].visitId = firstVisit;
  duplicateVisits.results[1].visitId = firstVisit;
  duplicateVisits.results[1].anchor.visitId = firstVisit;
  assert.deepEqual(await attachCourseBriefRouteAnchors(request(duplicateVisits, await binding())), { ok: false, error: "invalid_matching_output" });

  const badComponent = structuredClone(matching);
  badComponent.dataset.anchors[0].position.componentIndex = 1;
  badComponent.results[0].position.componentIndex = 1;
  badComponent.results[0].anchor.position.componentIndex = 1;
  badComponent.results[0].componentIndex = 1;
  assert.deepEqual(await attachCourseBriefRouteAnchors(request(badComponent, await binding())), { ok: false, error: "invalid_matching_output" });
});

test("duplicate, missing, and inconsistent selected observation identities fail closed", async () => {
  const matching = directMatchOutput([{ id: "identity-e", locationId: "identity", placeId: "identity-place", km: 4 }]);
  const duplicateOutput = structuredClone(courseBriefOutput);
  duplicateOutput.observations[1].candidateId = duplicateOutput.observations[0].candidateId;
  assert.deepEqual(await attachCourseBriefRouteAnchors({ ...request(matching, await binding()), courseBriefOutput: duplicateOutput }), {
    ok: false, error: "output_mismatch",
  });
  const wrongSelection = { ...selection, omittedCandidateIds: ["stale"] };
  assert.deepEqual(await attachCourseBriefRouteAnchors({ ...request(matching, await binding()), selection: wrongSelection }), {
    ok: false, error: "selection_mismatch",
  });
});

test("attachment is deterministic under matching result, anchor and evidence input reordering", async () => {
  const matching = directMatchOutput([
    { id: "second-e", locationId: "second", placeId: "second-place", km: 50 },
    { id: "first-e", locationId: "first", placeId: "first-place", km: 4 },
  ]);
  const first = await attachCourseBriefRouteAnchors(request(matching, await binding()));
  assert.equal(first.ok, true);
  const reordered = structuredClone(matching);
  reordered.results.reverse();
  reordered.dataset.anchors.reverse();
  reordered.dataset.evidence.reverse();
  const second = await attachCourseBriefRouteAnchors(request(reordered, await binding()));
  assert.equal(second.ok, true);
  assert.deepEqual(second.attachment, first.attachment);
});

test("attachment output retains evidence IDs, source provenance, offsets, role and structured render token", async () => {
  const point = analysis.points.find((entry) => entry.distanceM / 1000 > 3 && entry.distanceM / 1000 < 8);
  assert.ok(point);
  const matching = matchRouteAnchors({
    context: { schemaVersion: 1, raceId: "fixture-race", editionYear: 2027, raceName: "Fixture race", sourceIds: ["fixture-source"], locations: [
      { locationId: "verified-token", placeId: "token-place", name: "Token", type: "NAMED_LOCATION", sourceEditionYear: null, evidenceIds: ["token-e"] },
    ] },
    evidence: [{ schemaVersion: 2, evidenceId: "token-e", raceId: "fixture-race", editionYear: 2027, sourceEditionYear: null,
      sourceId: "fixture-source", evidenceKind: "official-map-or-coordinate", provenance: "official", verificationMethod: "geographic-match",
      coordinateFact: { latitude: point.latitude, longitude: point.longitude, semantics: "route-point", componentIndex: point.segmentIndex } }],
    route, orderingConstraints: [],
  });
  const result = await attachCourseBriefRouteAnchors(request(matching, await binding()));
  assert.equal(result.ok, true);
  const attached = result.attachment.attachments[0];
  assert.equal(attached.placeId, "token-place");
  assert.equal(attached.positionConfidence, "verified-match");
  assert.ok(attached.evidenceIds.includes("token-e"));
  assert.ok(attached.sources.some(({ sourceId, provenance }) => sourceId === "fixture-source" && provenance === "official"));
  assert.equal(typeof attached.measuredOffsetM, "number");
  assert.equal(result.attachment.renderTokens[0].kind, "route-anchor");
  assert.equal("text" in result.attachment.renderTokens[0], false);
});
