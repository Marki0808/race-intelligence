import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { analyzeGpxRoute, parseGpxText } from "./gpxAnalysis.ts";
import { composeCourseBrief } from "./courseBriefComposition.ts";
import { buildCourseBriefCandidates, renderCourseBriefV2, selectCourseBriefCandidates } from "./courseBriefCandidates.ts";
import { buildCourseBriefInputV2, validateCourseBriefInputV2 } from "./courseBriefNarrativeFacts.ts";
import { istria110kRaceRecord } from "./istria110kData.ts";
import { createIstria110kAnchorEvidenceFixture } from "./istria110kAnchorEvidence.ts";

const xml = await readFile(new URL("../public/ISTRIA_110K_2027.gpx", import.meta.url), "utf8");
const analysis = analyzeGpxRoute(parseGpxText(xml));
const earthRadiusM = 6_371_000;
const syntheticXml = `<gpx version="1.1" creator="composition-test"><trk><name>Composition fixture</name><trkseg>${analysis.points.map((point) => {
  const longitude = point.distanceM / earthRadiusM * 180 / Math.PI;
  return `<trkpt lat="0" lon="${longitude.toFixed(12)}"><ele>${point.elevationM}</ele></trkpt>`;
}).join("")}</trkseg></trk></gpx>`;
const compositionAnalysis = analyzeGpxRoute(parseGpxText(syntheticXml));

function withPositionSafeEvidence() {
  const raceId = "composition-fixture-race";
  const year = 2027;
  const sourceId = "composition-fixture-source";
  const locationId = "composition-test-location";
  const evidenceId = "composition-test-position";
  return {
    raceRecord: {
      race: { id: raceId, name: "Composition fixture", editions: [{ year, gpxPath: "/composition-fixture.gpx" }] },
      edition: { year, gpxPath: "/composition-fixture.gpx" },
      sources: [{ id: sourceId, title: "Synthetic fixture source", url: "https://example.invalid/source", type: "official" }],
    },
    context: {
      schemaVersion: 1,
      raceId,
      editionYear: year,
      raceName: "Composition fixture",
      sourceIds: [sourceId],
      locations: [{
        locationId,
        placeId: "composition-test-place",
        name: "Synthetic Composition Marker",
        type: "NAMED_LOCATION",
        sourceEditionYear: null,
        evidenceIds: [evidenceId],
      }],
    },
    evidence: [{
      schemaVersion: 2,
      evidenceId,
      raceId,
      editionYear: year,
      sourceEditionYear: null,
      sourceId,
      evidenceKind: "official-structured-position",
      provenance: "official",
      verificationMethod: "structured-source",
      routeKmFact: { distanceKm: 5, componentIndex: 0, convention: "traversed-distance-from-route-start" },
    }],
  };
}

function expectedStructuralOutput(routeAnalysis) {
  const input = buildCourseBriefInputV2(routeAnalysis);
  const built = buildCourseBriefCandidates(input);
  assert.equal(built.ok, true);
  const selection = selectCourseBriefCandidates(input, built.candidates);
  assert.equal(selection.ok, true);
  return { input, candidates: built.candidates, selection, structuralOutput: renderCourseBriefV2(input, built.candidates, selection) };
}

function componentProfile(startElevationM, startLongitude) {
  return Array.from({ length: 81 }, (_, index) => ({
    latitude: 0,
    longitude: startLongitude + index * 0.0009,
    elevationM: startElevationM + (index <= 40 ? index * 8 : (80 - index) * 8),
  }));
}

test("RouteAnalysisData with cumulative boundaries that round inconsistently composes successfully", async () => {
  const multiComponentAnalysis = analyzeGpxRoute({
    segments: [componentProfile(100, 0), componentProfile(900, 20)],
    name: "Two component rounding fixture",
  });
  const [first, second] = multiComponentAnalysis.segments;
  assert.ok(second.points[0].longitude - first.points.at(-1).longitude > 19);
  assert.ok(multiComponentAnalysis.metrics.distanceKm < 20);
  const independentlyRoundedStart = Number((second.startDistanceM / 1000).toFixed(2));
  const independentlyRoundedEnd = Number((second.endDistanceM / 1000).toFixed(2));
  const independentlyRoundedDistance = Number(((second.endDistanceM - second.startDistanceM) / 1000).toFixed(2));

  assert.notEqual(independentlyRoundedEnd - independentlyRoundedStart, independentlyRoundedDistance);
  const result = await composeCourseBrief(multiComponentAnalysis);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.kind, "structural");
  assert.deepEqual(result.input.route.components.map(({ segmentIndex }) => segmentIndex), [0, 1]);
  assert.equal(result.input.route.components[0].startKm, first.startDistanceM / 1000);
  assert.equal(result.input.route.components[1].startKm, second.startDistanceM / 1000);
  assert.equal(result.input.route.components[0].endKm, result.input.route.components[1].startKm);
  assert.ok(Math.abs(result.input.route.components[1].endKm - result.input.route.components[1].startKm -
    result.input.route.components[1].traversedDistanceKm) < 1e-12);
  assert.equal(result.selection.componentCoverageComplete, true);
  assert.deepEqual([...new Set(result.structuralOutput.observations.map(({ componentIndex }) => componentIndex))], [0, 1]);

  const componentByUnitId = new Map(result.input.units.map(({ unitId, segmentIndex }) => [unitId, segmentIndex]));
  const transitions = result.input.facts.filter((fact) => fact.type === "STRUCTURAL_TRANSITION");
  assert.ok(transitions.length > 0);
  assert.deepEqual([...new Set(transitions.map(({ segmentIndex }) => segmentIndex))], [0, 1]);
  assert.ok(transitions.every((fact) => componentByUnitId.get(fact.fromUnitId) === fact.segmentIndex &&
    componentByUnitId.get(fact.toUnitId) === fact.segmentIndex));
  assert.ok(result.structuralOutput.observations.every((observation) => observation.startKm <= observation.endKm));

  const inconsistent = structuredClone(result.input);
  inconsistent.route.components[1].traversedDistanceKm += 0.01;
  assert.deepEqual(validateCourseBriefInputV2(inconsistent), { ok: false, error: "inconsistent_input" });
});

test("composes structural V2 from the supplied analysis and returns unchanged output without evidence", async () => {
  const result = await composeCourseBrief(analysis);
  assert.equal(result.ok, true);
  assert.equal(result.kind, "structural");
  assert.equal(result.geographicPresentation, null);
  assert.equal(result.geographicDiagnostic, "geographic_evidence_not_supplied");
  assert.equal(result.input.schemaVersion, 2);
  assert.equal(result.structuralOutput.schemaVersion, 2);
  assert.ok(result.structuralOutput.observations.length > 0);
  assert.deepEqual({ input: result.input, candidates: result.candidates, selection: result.selection, structuralOutput: result.structuralOutput }, expectedStructuralOutput(analysis));
});

test("internally consistent edition evidence without independent analysis provenance stays structural-only", async () => {
  const editionEvidence = withPositionSafeEvidence();
  const first = await composeCourseBrief(compositionAnalysis, editionEvidence);
  const second = await composeCourseBrief(compositionAnalysis, editionEvidence);
  assert.equal(first.ok, true);
  assert.equal(first.kind, "structural");
  assert.equal(first.geographicPresentation, null);
  assert.equal(first.geographicDiagnostic, "edition_route_provenance_unavailable");
  assert.deepEqual(second, first);
  assert.deepEqual({ input: first.input, candidates: first.candidates, selection: first.selection, structuralOutput: first.structuralOutput }, expectedStructuralOutput(compositionAnalysis));
});

test("route names, IDs, fingerprints, distance and bounds do not establish edition provenance", async () => {
  const editionEvidence = {
    ...withPositionSafeEvidence(),
    routeAnalysisProvenance: {
      routeName: "Composition fixture",
      routeId: "composition-fixture-route",
      routeFingerprint: "caller-asserted-fingerprint",
      analysisInputFingerprint: "caller-asserted-input-fingerprint",
      distanceKm: compositionAnalysis.metrics.distanceKm,
      componentBounds: compositionAnalysis.segments.map(({ segmentIndex, startDistanceM, endDistanceM }) => ({
        segmentIndex, startKm: startDistanceM / 1000, endKm: endDistanceM / 1000,
      })),
    },
  };
  const result = await composeCourseBrief(compositionAnalysis, editionEvidence);
  assert.equal(result.ok, true);
  assert.equal(result.kind, "structural");
  assert.equal(result.geographicPresentation, null);
  assert.equal(result.geographicDiagnostic, "edition_route_provenance_unavailable");
});

test("Istria anchor evidence remains structural-only until edition GPX provenance is available", async () => {
  const result = await composeCourseBrief(analysis, {
    raceRecord: istria110kRaceRecord,
    ...createIstria110kAnchorEvidenceFixture(),
  });
  assert.equal(result.ok, true);
  assert.equal(result.kind, "structural");
  assert.equal(result.geographicPresentation, null);
  assert.equal(result.geographicDiagnostic, "edition_route_provenance_unavailable");
  assert.deepEqual(result.structuralOutput, expectedStructuralOutput(analysis).structuralOutput);
});

test("wrong or stale edition context and source bindings cannot produce geographic claims", async () => {
  const editionEvidence = withPositionSafeEvidence();
  const wrongEdition = { ...editionEvidence, context: { ...editionEvidence.context, editionYear: 2026 } };
  const wrongSource = { ...editionEvidence, evidence: editionEvidence.evidence.map((item) => item.evidenceId === "composition-test-position"
    ? { ...item, sourceId: "unregistered-source" } : item) };
  for (const invalid of [wrongEdition, wrongSource]) {
    const result = await composeCourseBrief(analysis, invalid);
    assert.equal(result.ok, true);
    assert.equal(result.kind, "structural");
    assert.equal(result.geographicPresentation, null);
    assert.equal(result.geographicDiagnostic, "edition_binding_invalid");
    assert.deepEqual(result.structuralOutput, expectedStructuralOutput(analysis).structuralOutput);
  }
});

test("untrusted matching constraints cannot enable geographic composition", async () => {
  const editionEvidence = { ...withPositionSafeEvidence(), orderingConstraints: [{ beforeVisitId: "missing", afterVisitId: "also-missing", evidenceIds: ["none"] }] };
  const result = await composeCourseBrief(analysis, editionEvidence);
  assert.equal(result.ok, true);
  assert.equal(result.kind, "structural");
  assert.equal(result.geographicPresentation, null);
  assert.equal(result.geographicDiagnostic, "edition_route_provenance_unavailable");
  assert.ok(result.structuralOutput.observations.length > 0);
});

test("structural engine failure is typed and does not fabricate output", async () => {
  const result = await composeCourseBrief({ segments: [], points: [], metrics: {} });
  assert.equal(result.ok, false);
  assert.ok(["invalid_route_analysis", "structural_render_failed"].includes(result.error));
  assert.equal("structuralOutput" in result, false);
});

test("composition has no Course Brief V1 API/provider dependency", async () => {
  const source = await readFile(new URL("./courseBriefComposition.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /courseBriefApi|courseBriefGeneration|openAiCourseBriefProvider|fetch\s*\(/);
  assert.doesNotMatch(source, /matchRouteAnchors|attachCourseBriefRouteAnchors|renderCourseBriefGeographicPresentation/);
});
