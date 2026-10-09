import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { analyzeGpxRoute, parseGpxText } from "./gpxAnalysis.ts";
import { buildCourseBriefInputV2 } from "./courseBriefNarrativeFacts.ts";
import { buildCourseBriefCandidates, renderCourseBriefV2, selectCourseBriefCandidates } from "./courseBriefCandidates.ts";
import {
  attachCourseBriefRouteAnchors,
  resolveFullPrecisionCourseBriefBoundary,
} from "./courseBriefAnchorAttachment.ts";
import { createAnalysisInputFingerprint } from "./analysisInputFingerprint.ts";
import { createRouteFingerprint } from "./routeFingerprint.ts";
import { createIstria110kAnchorEvidenceFixture } from "./istria110kAnchorEvidence.ts";
import { matchRouteAnchors, routeAnchorGeometryFromAnalysis } from "./routeAnchorMatching.ts";
import {
  COURSE_BRIEF_GEOGRAPHIC_RENDERER_VERSION,
  COURSE_BRIEF_GEOGRAPHIC_PRESENTATION_SCHEMA_VERSION,
  renderCourseBriefGeographicPresentation,
} from "./courseBriefGeographicRendering.ts";

const EARTH_RADIUS_M = 6_371_000;
const baseGpx = await readFile(new URL("../public/ISTRIA_110K_2027.gpx", import.meta.url), "utf8");
const profile = analyzeGpxRoute(parseGpxText(baseGpx));

// Build synthetic equatorial geometry from cumulative distances. No race-place
// coordinates or geographic labels are added by this test fixture.
function syntheticGpx(splitAt = null) {
  const points = profile.points;
  const splitIndex = splitAt === null ? points.length : points.findIndex((point) => point.distanceM >= splitAt);
  const groups = splitAt === null ? [points] : [points.slice(0, splitIndex), points.slice(splitIndex)];
  const xmlPoints = (group) => group.map((point) => {
    const longitude = point.distanceM / EARTH_RADIUS_M * 180 / Math.PI;
    return `<trkpt lat="0" lon="${longitude.toFixed(12)}"><ele>${point.elevationM}</ele></trkpt>`;
  }).join("");
  return `<gpx version="1.1" creator="synthetic-test"><trk><name>synthetic geographic renderer fixture</name>${groups
    .map((group) => `<trkseg>${xmlPoints(group)}</trkseg>`).join("")}</trk></gpx>`;
}

const analysis = analyzeGpxRoute(parseGpxText(syntheticGpx()));
const input = buildCourseBriefInputV2(analysis);
const built = buildCourseBriefCandidates(input);
assert.equal(built.ok, true);
const selection = selectCourseBriefCandidates(input, built.candidates);
assert.equal(selection.ok, true);
const routeId = "synthetic-3d4-route";

async function binding(routeAnalysis = analysis) {
  const geometry = routeAnalysis.segments.map((segment) => segment.points.map(({ latitude, longitude }) => ({ latitude, longitude })));
  const numerical = routeAnalysis.segments.map((segment) => segment.points.map(({ latitude, longitude, elevationM }) => ({ latitude, longitude, elevationM })));
  const [physical, analysisInput] = await Promise.all([createRouteFingerprint(geometry), createAnalysisInputFingerprint(numerical)]);
  const last = routeAnalysis.segments.at(-1);
  return {
    routeId,
    routeFingerprint: physical.routeFingerprint,
    routeFingerprintVersion: physical.routeFingerprintVersion,
    analysisInputFingerprint: analysisInput,
    analysisInputFingerprintVersion: 2,
    distanceKm: last.endDistanceM / 1000,
    components: routeAnalysis.segments.map((segment) => ({ segmentIndex: segment.segmentIndex,
      startKm: segment.startDistanceM / 1000, endKm: segment.endDistanceM / 1000,
      traversedDistanceKm: (segment.endDistanceM - segment.startDistanceM) / 1000 })),
  };
}

function routePointAt(km, routeAnalysis = analysis, segmentIndex = 0) {
  return routeAnalysis.segments.find((segment) => segment.segmentIndex === segmentIndex).points
    .reduce((best, point) => Math.abs(point.distanceM / 1000 - km) < Math.abs(best.distanceM / 1000 - km) ? point : best);
}

function matchingFor(specs, routeAnalysis = analysis) {
  const evidence = [];
  const locations = specs.map((spec, index) => {
    const evidenceId = spec.evidenceId ?? `source-e-${index}`;
    const sourceId = "synthetic-official-source";
    let item = {
      schemaVersion: 2,
      evidenceId,
      raceId: "synthetic-race",
      editionYear: 2027,
      sourceEditionYear: null,
      sourceId,
      evidenceKind: "official-structured-position",
      provenance: "official",
      verificationMethod: "structured-source",
    };
    if (spec.coordinateSemantics) {
      const point = routePointAt(spec.km, routeAnalysis, spec.componentIndex ?? 0);
      item = {
        ...item,
        evidenceKind: "official-map-or-coordinate",
        verificationMethod: "geographic-match",
        coordinateFact: {
          latitude: point.latitude + (spec.offsetM ?? 0) / EARTH_RADIUS_M * 180 / Math.PI,
          longitude: point.longitude,
          semantics: spec.coordinateSemantics,
          componentIndex: spec.componentIndex ?? 0,
        },
      };
    } else {
      item.routeKmFact = {
        distanceKm: spec.km,
        componentIndex: spec.componentIndex ?? 0,
        convention: "traversed-distance-from-route-start",
      };
    }
    evidence.push(item);
    return {
      locationId: spec.locationId ?? `location-${index}`,
      placeId: spec.placeId ?? `place-${index}`,
      name: spec.name ?? `Synthetic Place ${index}`,
      type: spec.type ?? "NAMED_LOCATION",
      sourceEditionYear: null,
      evidenceIds: [evidenceId],
    };
  });
  const selectedRoute = routeAnchorGeometryFromAnalysis(routeId, routeAnalysis);
  return matchRouteAnchors({
    context: { schemaVersion: 1, raceId: "synthetic-race", editionYear: 2027,
      raceName: "Synthetic race", sourceIds: ["synthetic-official-source"], locations },
    evidence,
    route: selectedRoute,
    orderingConstraints: [],
  });
}

async function prepare(specs, routeAnalysis = analysis) {
  const currentInput = buildCourseBriefInputV2(routeAnalysis);
  const currentBuilt = buildCourseBriefCandidates(currentInput);
  assert.equal(currentBuilt.ok, true);
  const currentSelection = selectCourseBriefCandidates(currentInput, currentBuilt.candidates);
  assert.equal(currentSelection.ok, true);
  const currentOutput = renderCourseBriefV2(currentInput, currentBuilt.candidates, currentSelection);
  const matchingOutput = matchingFor(specs, routeAnalysis);
  const attachmentResult = await attachCourseBriefRouteAnchors({
    courseBriefInput: currentInput,
    candidatePool: currentBuilt.candidates,
    selection: currentSelection,
    courseBriefOutput: currentOutput,
    routeAnalysis,
    routeBinding: await binding(routeAnalysis),
    matchingOutput,
  });
  assert.equal(attachmentResult.ok, true, JSON.stringify(attachmentResult));
  return { currentInput, currentBuilt, currentSelection, currentOutput, matchingOutput,
    attachment: attachmentResult.attachment, routeAnalysis };
}

async function render(prepared, overrides = {}) {
  return renderCourseBriefGeographicPresentation({
    courseBriefInput: prepared.currentInput,
    candidatePool: prepared.currentBuilt.candidates,
    selection: prepared.currentSelection,
    structuralOutput: prepared.currentOutput,
    routeAnalysis: prepared.routeAnalysis,
    attachment: prepared.attachment,
    matchingOutput: prepared.matchingOutput,
    ...overrides,
  });
}

test("renderer versions are independently pinned and exact route-position evidence creates traced geographic spans", async () => {
  assert.equal(COURSE_BRIEF_GEOGRAPHIC_RENDERER_VERSION, 1);
  assert.equal(COURSE_BRIEF_GEOGRAPHIC_PRESENTATION_SCHEMA_VERSION, 1);
  const prepared = await prepare([{ km: 5, name: "North Marker" }]);
  const result = await render(prepared);
  assert.equal(result.ok, true);
  const geographic = result.presentation.observations.flatMap(({ spans }) => spans).find(({ kind }) => kind === "geographic");
  assert.ok(geographic);
  assert.equal(geographic.claimType, "ROUTE_POINT");
  assert.equal(geographic.positionConfidence, "exact-direct");
  assert.match(geographic.text, /North Marker/);
  assert.ok(geographic.evidenceIds.length > 0);
  assert.ok(geographic.sources.some(({ sourceId }) => sourceId === "synthetic-official-source"));
  assert.ok(geographic.sourceFactIds.length === 0);
  assert.equal(result.presentation.structuralOutput, prepared.currentOutput);
});

test("verified source-backed event point can be rendered without converting its point into an area claim", async () => {
  const prepared = await prepare([{ km: 5, type: "AID_STATION", coordinateSemantics: "event-point", name: "Aid Point" }]);
  const result = await render(prepared);
  assert.equal(result.ok, true);
  const geographic = result.presentation.observations.flatMap(({ spans }) => spans).find(({ kind }) => kind === "geographic");
  assert.ok(geographic);
  assert.equal(geographic.claimType, "EVENT_POINT");
  assert.match(geographic.text, /event point for Aid Point/);
  assert.doesNotMatch(geographic.text, /through|settlement|area/i);
});

test("projected route points are qualified with the measured offset", async () => {
  const prepared = await prepare([{ km: 5, coordinateSemantics: "route-point", name: "Projected Marker", offsetM: 18 }]);
  const result = await render(prepared);
  assert.equal(result.ok, true);
  const geographic = result.presentation.observations.flatMap(({ spans }) => spans).find(({ kind }) => kind === "geographic");
  assert.ok(geographic);
  assert.equal(geographic.positionConfidence, "verified-match");
  assert.equal(geographic.measuredOffsetM, 18);
  assert.match(geographic.text, /18 m away/);
});

test("ENTRY ownership adds a point location without rewriting the structural observation", async () => {
  const firstCandidate = selection.selectedCandidates[0];
  const factsById = new Map(input.facts.map((fact) => [fact.factId, fact]));
  const linkedFacts = [firstCandidate.primaryFactId, ...firstCandidate.supportingFactIds]
    .map((factId) => factsById.get(factId)).filter((fact) => fact !== undefined);
  const units = linkedFacts.filter((fact) => fact.type === "UNIT_CHARACTER");
  const startKm = units.length > 0 ? Math.min(...units.map((fact) => fact.startKm))
    : factsById.get(firstCandidate.primaryFactId).startKm;
  const prepared = await prepare([{ km: startKm, name: "Phase Entry Marker" }]);
  assert.equal(prepared.attachment.attachments[0].role, "ENTRY");
  const result = await render(prepared);
  assert.equal(result.ok, true);
  const observation = result.presentation.observations.find(({ candidateId }) => candidateId === firstCandidate.candidateId);
  assert.ok(observation);
  assert.equal(observation.spans[0].kind, "structural");
  assert.equal(observation.spans[0].text, prepared.currentOutput.observations[0].text);
  assert.match(observation.spans[1].text, /phase begins at the official route position for Phase Entry Marker/);
});

test("contradictory direct position facts fail closed even when D2 reproduces an exact match", async () => {
  const prepared = await prepare([{ km: 5, name: "Contradictory Marker" }]);
  const rootEvidence = prepared.matchingOutput.dataset.evidence
    .filter((entry) => entry.derivedFromEvidenceIds === undefined)
    .map((entry) => entry.evidenceId === "source-e-0"
      ? { ...entry, positionFact: { type: "POINT", componentIndex: 0, distanceKm: 5.5 } }
      : entry);
  const conflictingMatching = matchRouteAnchors({
    context: prepared.matchingOutput.dataset.context,
    evidence: rootEvidence,
    route: routeAnchorGeometryFromAnalysis(routeId, analysis),
    orderingConstraints: prepared.matchingOutput.dataset.orderingConstraints,
  });
  assert.equal(conflictingMatching.results[0].state, "matched-exact");
  assert.equal(conflictingMatching.results[0].position.distanceKm, 5.5);

  const attachmentResult = await attachCourseBriefRouteAnchors({
    courseBriefInput: prepared.currentInput,
    candidatePool: prepared.currentBuilt.candidates,
    selection: prepared.currentSelection,
    courseBriefOutput: prepared.currentOutput,
    routeAnalysis: prepared.routeAnalysis,
    routeBinding: await binding(prepared.routeAnalysis),
    matchingOutput: conflictingMatching,
  });
  assert.equal(attachmentResult.ok, true);
  const result = await render(prepared, { matchingOutput: conflictingMatching, attachment: attachmentResult.attachment });
  assert.deepEqual(result, { ok: false, error: "unsupported_evidence" });
});

test("feature-point proximity names a point reference while place-reference approximate evidence stays out", async () => {
  const feature = await prepare([{ km: 6, type: "AID_STATION", coordinateSemantics: "feature-point", name: "Feature Marker", offsetM: 12 }]);
  const featureResult = await render(feature);
  assert.equal(featureResult.ok, true);
  const featureSpan = featureResult.presentation.observations.flatMap(({ spans }) => spans).find(({ kind }) => kind === "geographic");
  assert.ok(featureSpan);
  assert.equal(featureSpan.claimType, "FEATURE_POINT_PROXIMITY");
  assert.match(featureSpan.text, /within 12 m of the feature point reference/);
  assert.doesNotMatch(featureSpan.text, /through|around|at the settlement/i);

  const placeReference = await prepare([{ km: 6, coordinateSemantics: "place-reference-point", name: "Settlement Reference", offsetM: 20 }]);
  assert.equal(placeReference.attachment.attachments.length, 0);
  const fallback = await render(placeReference);
  assert.equal(fallback.ok, true);
  assert.ok(fallback.presentation.observations.every((observation) => observation.spans.length === 1));
  assert.deepEqual(fallback.presentation.observations.map(({ text }) => text),
    placeReference.currentOutput.observations.map(({ text }) => text));
});

test("START and terminal FINISH require actual endpoint evidence and attach only to their owning observations", async () => {
  const startKm = analysis.segments[0].startDistanceM / 1000;
  const finishKm = analysis.segments.at(-1).endDistanceM / 1000;
  const prepared = await prepare([
    { km: startKm, type: "START", name: "Start Point", visitId: "start-visit" },
    { km: finishKm, type: "FINISH", name: "Finish Point", visitId: "finish-visit" },
  ]);
  const result = await render(prepared);
  assert.equal(result.ok, true);
  const spans = result.presentation.observations.flatMap(({ spans }) => spans).filter(({ kind }) => kind === "geographic");
  assert.equal(spans.length, 2);
  assert.deepEqual(spans.map(({ claimType }) => claimType), ["START_POSITION", "FINISH_POSITION"]);
  assert.match(spans[0].text, /marks the start/);
  assert.match(spans[1].text, /marks the finish/);

  const nonEndpoint = await prepare([{ km: 10, type: "START", name: "False Start" }]);
  // The matcher/anchor validators reject this claimed START before presentation.
  assert.equal(nonEndpoint.attachment.attachments.length, 0);
});

test("projected START and FINISH claims stay qualified and require route endpoints", async () => {
  const startKm = analysis.segments[0].startDistanceM / 1000;
  const finishKm = analysis.segments.at(-1).endDistanceM / 1000;
  const prepared = await prepare([
    { km: startKm, type: "START", coordinateSemantics: "route-point", name: "Projected Start", offsetM: 0 },
    { km: finishKm, type: "FINISH", coordinateSemantics: "route-point", name: "Projected Finish", offsetM: 7 },
  ]);
  const result = await render(prepared);
  assert.equal(result.ok, true);
  const spans = result.presentation.observations.flatMap(({ spans }) => spans).filter(({ kind }) => kind === "geographic");
  assert.deepEqual(spans.map(({ claimType }) => claimType), ["START_POSITION", "FINISH_POSITION"]);
  assert.ok(spans.every(({ positionConfidence }) => positionConfidence === "verified-match"));
  assert.match(spans[0].text, /start is matched to the route point/i);
  assert.match(spans[0].text, /0 m from its source coordinate/);
  assert.match(spans[1].text, /finish is matched to the route point/i);
  assert.match(spans[1].text, /7 m from its source coordinate/);
  assert.ok(spans.every(({ text }) => !/exact|official route position/i.test(text)));
});

test("transition geography is rendered only with its exact structural transition fact", async () => {
  const transition = input.facts.find((fact) => fact.type === "STRUCTURAL_TRANSITION");
  assert.ok(transition);
  const exact = resolveFullPrecisionCourseBriefBoundary(analysis, transition.segmentIndex, transition.boundaryKm, "start",
    analysis.segments.map((segment) => ({ segmentIndex: segment.segmentIndex, startKm: segment.startDistanceM / 1000,
      endKm: segment.endDistanceM / 1000, traversedDistanceKm: (segment.endDistanceM - segment.startDistanceM) / 1000 })));
  assert.equal(exact.status, "resolved");
  const prepared = await prepare([{ km: exact.distanceKm, name: "Transition Marker" }]);
  const result = await render(prepared);
  assert.equal(result.ok, true);
  const span = result.presentation.observations.flatMap(({ spans }) => spans).find(({ kind, claimType }) =>
    kind === "geographic" && claimType === "STRUCTURAL_TRANSITION_POSITION");
  assert.ok(span);
  assert.ok(span.sourceFactIds.includes(transition.factId));
  assert.match(span.text, new RegExp(`from ${transition.fromCharacter} to ${transition.toCharacter}`));

  const internal = await prepare([{ km: 5, name: "Interior Marker" }]);
  const forged = structuredClone(internal.attachment);
  forged.attachments[0].role = "TRANSITION";
  forged.renderTokens[0].role = "TRANSITION";
  assert.deepEqual(await render(internal, { attachment: forged }), { ok: false, error: "ownership_mismatch" });
});

test("repeated visits retain distinct visit identity and remain chronological", async () => {
  const prepared = await prepare([
    { km: 5, name: "Same Place, first visit", placeId: "same-place", visitId: "visit-one" },
    { km: 50, name: "Same Place, second visit", placeId: "same-place", visitId: "visit-two" },
  ]);
  const result = await render(prepared);
  assert.equal(result.ok, true);
  const spans = result.presentation.observations.flatMap(({ spans }) => spans).filter(({ kind }) => kind === "geographic");
  assert.equal(spans.length, 2);
  assert.equal(new Set(spans.map(({ visitId }) => visitId)).size, 2);
  assert.ok(spans.every(({ visitId }) => visitId.startsWith("visit:")));
  assert.ok(spans[0].position.distanceKm < spans[1].position.distanceKm);
});

test("disconnected components preserve component ownership at a shared cumulative-km boundary", async () => {
  const midpoint = profile.points[Math.floor(profile.points.length / 2)].distanceM;
  const separatedAnalysis = analyzeGpxRoute(parseGpxText(syntheticGpx(midpoint)));
  assert.equal(separatedAnalysis.segments.length, 2);
  const sharedKm = separatedAnalysis.segments[1].startDistanceM / 1000;
  const prepared = await prepare([
    { km: sharedKm, componentIndex: 0, name: "Earlier Component Edge", visitId: "edge-before" },
    { km: sharedKm, componentIndex: 1, name: "Later Component Entry", visitId: "edge-after" },
  ], separatedAnalysis);
  const result = await render(prepared);
  assert.equal(result.ok, true);
  const spans = result.presentation.observations.flatMap(({ spans }) => spans).filter(({ kind }) => kind === "geographic");
  assert.equal(spans.length, 1);
  assert.equal(spans[0].componentIndex, 1);
  assert.equal(spans[0].visitId.startsWith("visit:"), true);
  const ownerObservation = result.presentation.observations.find(({ spans: itemSpans }) => itemSpans.includes(spans[0]));
  assert.equal(ownerObservation.componentIndex, 1);
});

test("full-precision ownership and role are revalidated rather than trusting rounded display bounds", async () => {
  const transition = input.facts.find((fact) => fact.type === "STRUCTURAL_TRANSITION");
  const boundary = resolveFullPrecisionCourseBriefBoundary(analysis, transition.segmentIndex, transition.boundaryKm, "start",
    analysis.segments.map((segment) => ({ segmentIndex: segment.segmentIndex, startKm: segment.startDistanceM / 1000,
      endKm: segment.endDistanceM / 1000, traversedDistanceKm: (segment.endDistanceM - segment.startDistanceM) / 1000 })));
  const prepared = await prepare([{ km: boundary.distanceKm, name: "Boundary Marker" }]);
  assert.equal(prepared.attachment.attachments[0].role, "TRANSITION");
  const altered = structuredClone(prepared.attachment);
  altered.attachments[0].position.distanceKm += 0.001;
  assert.deepEqual(await render(prepared, { attachment: altered }), { ok: false, error: "attachment_reference_mismatch" });
});

test("unsupported geographic language is never emitted from an interior route point", async () => {
  const prepared = await prepare([{ km: 6, coordinateSemantics: "route-point", name: "Interior Point", offsetM: 5 }]);
  const result = await render(prepared);
  assert.equal(result.ok, true);
  const text = result.presentation.observations.flatMap(({ spans }) => spans).filter(({ kind }) => kind === "geographic")
    .map(({ text: value }) => value).join(" ").toLowerCase();
  for (const phrase of ["through", "toward", "approaching", "before", "after", "changes character", "settlement"]) {
    assert.equal(text.includes(phrase), false, `unexpected geographic inference: ${phrase}`);
  }
});

test("Istria with zero position-safe anchors returns the exact original V2 structural text", async () => {
  const fixture = createIstria110kAnchorEvidenceFixture();
  const istriaAnalysis = analyzeGpxRoute(parseGpxText(baseGpx));
  const matchingOutput = matchRouteAnchors({ ...fixture, route: routeAnchorGeometryFromAnalysis(routeId, istriaAnalysis) });
  assert.ok(matchingOutput.results.every(({ state }) => state === "context-only"));
  const currentInput = buildCourseBriefInputV2(istriaAnalysis);
  const currentBuilt = buildCourseBriefCandidates(currentInput);
  const currentSelection = selectCourseBriefCandidates(currentInput, currentBuilt.candidates);
  const currentOutput = renderCourseBriefV2(currentInput, currentBuilt.candidates, currentSelection);
  const attached = await attachCourseBriefRouteAnchors({ courseBriefInput: currentInput, candidatePool: currentBuilt.candidates,
    selection: currentSelection, courseBriefOutput: currentOutput, routeAnalysis: istriaAnalysis,
    routeBinding: await binding(istriaAnalysis), matchingOutput });
  assert.equal(attached.ok, true);
  assert.deepEqual(attached.attachment.attachments, []);
  const presentation = await render({ currentInput, currentBuilt, currentSelection, currentOutput, routeAnalysis: istriaAnalysis,
    attachment: attached.attachment, matchingOutput });
  assert.equal(presentation.ok, true);
  assert.deepEqual(presentation.presentation.structuralOutput, currentOutput);
  assert.deepEqual(presentation.presentation.observations.map(({ text }) => text), currentOutput.observations.map(({ text }) => text));
  assert.ok(presentation.presentation.observations.every(({ spans }) => spans.length === 1 && spans[0].kind === "structural"));
});

test("stale versions, missing source evidence, duplicate attachment ownership and mismatched route identity fail closed", async () => {
  const prepared = await prepare([{ km: 5, coordinateSemantics: "route-point", name: "Checked Marker" }]);
  const stale = structuredClone(prepared.attachment);
  stale.schemaVersion = 99;
  assert.deepEqual(await render(prepared, { attachment: stale }), { ok: false, error: "invalid_attachment" });

  const staleMatchingVersion = structuredClone(prepared.attachment);
  staleMatchingVersion.matchingAlgorithmVersion = 999;
  assert.deepEqual(await render(prepared, { attachment: staleMatchingVersion }), { ok: false, error: "invalid_attachment" });

  const missingEvidence = structuredClone(prepared.matchingOutput);
  missingEvidence.dataset.evidence = missingEvidence.dataset.evidence.filter((entry) =>
    !prepared.attachment.attachments[0].evidenceIds.includes(entry.evidenceId));
  assert.deepEqual(await render(prepared, { matchingOutput: missingEvidence }), { ok: false, error: "invalid_matching_output" });

  const mismatchedPlace = structuredClone(prepared.attachment);
  mismatchedPlace.attachments[0].placeId = "another-place";
  assert.deepEqual(await render(prepared, { attachment: mismatchedPlace }), { ok: false, error: "attachment_reference_mismatch" });

  const mismatchedVisit = structuredClone(prepared.attachment);
  mismatchedVisit.attachments[0].visitId = "another-visit";
  assert.deepEqual(await render(prepared, { attachment: mismatchedVisit }), { ok: false, error: "attachment_reference_mismatch" });

  const mismatchedSource = structuredClone(prepared.attachment);
  mismatchedSource.attachments[0].sources[0].sourceId = "another-source";
  assert.deepEqual(await render(prepared, { attachment: mismatchedSource }), { ok: false, error: "attachment_reference_mismatch" });

  const forgedConflict = structuredClone(prepared.matchingOutput);
  forgedConflict.results[0].state = "conflicting";
  forgedConflict.results[0].position = null;
  assert.deepEqual(await render(prepared, { matchingOutput: forgedConflict }), { ok: false, error: "invalid_matching_output" });

  const duplicate = structuredClone(prepared.attachment);
  duplicate.attachments.push(structuredClone(duplicate.attachments[0]));
  duplicate.renderTokens.push(structuredClone(duplicate.renderTokens[0]));
  assert.deepEqual(await render(prepared, { attachment: duplicate }), { ok: false, error: "invalid_attachment" });

  const wrongAnalysis = structuredClone(prepared.routeAnalysis);
  wrongAnalysis.points[0].elevationM += 1;
  assert.deepEqual(await render(prepared, { routeAnalysis: wrongAnalysis }), { ok: false, error: "route_identity_mismatch" });
});

test("rendering is deterministic under matching dataset/result order changes and retains structural fact traces", async () => {
  const prepared = await prepare([{ km: 5, coordinateSemantics: "route-point", name: "Deterministic Marker", offsetM: 3 }]);
  const normal = await render(prepared);
  const reordered = structuredClone(prepared.matchingOutput);
  reordered.results.reverse();
  reordered.dataset.context.locations.reverse();
  reordered.dataset.anchors.reverse();
  reordered.dataset.evidence.reverse();
  const second = await render(prepared, { matchingOutput: reordered });
  assert.equal(normal.ok, true);
  assert.deepEqual(second, normal);
  for (const observation of normal.presentation.observations) {
    const structural = observation.spans.find(({ kind }) => kind === "structural");
    assert.ok(structural.sourceFactIds.every((id) => input.facts.some((fact) => fact.factId === id)));
    assert.ok(observation.text.startsWith(structural.text));
  }
});
