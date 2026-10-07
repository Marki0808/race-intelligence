import assert from "node:assert/strict";
import test from "node:test";
import {
  createRouteAnchorIndex,
  ROUTE_ANCHOR_EVIDENCE_SCHEMA_VERSION,
  ROUTE_ANCHOR_INDEX_ALGORITHM_VERSION,
  ROUTE_ANCHOR_SCHEMA_VERSION,
  RACE_CONTEXT_SCHEMA_VERSION,
  routeAnchorPositionSafety,
  validateRouteAnchorDataset,
} from "./routeAnchors.ts";

const BOUNDS = {
  routeId: "route-alpha",
  distanceKm: 15,
  components: [
    { componentIndex: 0, startKm: 0, endKm: 10, traversedDistanceKm: 10 },
    { componentIndex: 1, startKm: 10, endKm: 15, traversedDistanceKm: 5 },
  ],
};

function makeRecord(specs = [], { bounds = BOUNDS, orderingConstraints = [], raceId = "race-alpha", editionYear = 2031 } = {}) {
  const evidence = [];
  const locations = [];
  const constraints = orderingConstraints.map((constraint, index) => {
    const evidenceId = `ordering-evidence-${index}`;
    evidence.push({
      schemaVersion: ROUTE_ANCHOR_EVIDENCE_SCHEMA_VERSION,
      evidenceId,
      raceId,
      editionYear,
      sourceEditionYear: null,
      sourceId: "source-alpha",
      evidenceKind: "official-text-order",
      provenance: "official",
      verificationMethod: "text-review",
      orderingFact: { beforeVisitId: constraint.beforeVisitId, afterVisitId: constraint.afterVisitId },
    });
    return { ...constraint, evidenceIds: [evidenceId] };
  });
  const anchors = specs.map((spec, index) => {
    const anchorId = spec.anchorId ?? `anchor-${index}`;
    const locationId = spec.contextLocationId ?? `location-${index}`;
    const placeId = spec.placeId ?? `place-${index}`;
    const contextEvidenceId = `context-evidence-${index}`;
    evidence.push({
      schemaVersion: ROUTE_ANCHOR_EVIDENCE_SCHEMA_VERSION,
      evidenceId: contextEvidenceId,
      raceId,
      editionYear,
      sourceEditionYear: spec.contextSourceEditionYear ?? null,
      sourceId: "source-alpha",
      evidenceKind: spec.contextEvidenceKind ?? "official-text-context",
      provenance: spec.contextProvenance ?? "official",
      verificationMethod: "text-review",
    });
    locations.push({
      locationId,
      placeId,
      name: spec.name ?? `Place ${index}`,
      type: spec.type ?? "NAMED_LOCATION",
      sourceEditionYear: spec.contextSourceEditionYear ?? null,
      evidenceIds: [contextEvidenceId],
    });

    const evidenceIds = [];
    for (const [supportIndex, support] of (spec.supports ?? defaultSupports(spec)).entries()) {
      const evidenceId = support.evidenceId ?? `evidence-${index}-${supportIndex}`;
      evidenceIds.push(evidenceId);
      evidence.push({
        schemaVersion: ROUTE_ANCHOR_EVIDENCE_SCHEMA_VERSION,
        evidenceId,
        raceId: support.raceId ?? raceId,
        editionYear: support.editionYear ?? editionYear,
        sourceEditionYear: support.sourceEditionYear ?? null,
        sourceId: support.sourceId === undefined ? "source-alpha" : support.sourceId,
        evidenceKind: support.evidenceKind,
        provenance: support.provenance,
        verificationMethod: support.verificationMethod,
        ...(support.positionFact ? { positionFact: support.positionFact } : {}),
        ...(support.measuredOffsetM !== undefined ? { measuredOffsetM: support.measuredOffsetM } : {}),
      });
    }
    return {
      schemaVersion: ROUTE_ANCHOR_SCHEMA_VERSION,
      anchorId,
      raceId: spec.raceId ?? raceId,
      editionYear: spec.editionYear ?? editionYear,
      contextLocationId: locationId,
      placeId,
      visitId: spec.visitId === undefined ? (spec.position?.type === "UNPOSITIONED" ? null : `visit-${index}`) : spec.visitId,
      type: spec.type ?? "NAMED_LOCATION",
      position: spec.position ?? { type: "UNPOSITIONED" },
      positionConfidence: spec.positionConfidence ?? "context-only",
      evidenceIds: spec.evidenceIds ?? evidenceIds,
    };
  });
  return {
    schemaVersion: ROUTE_ANCHOR_SCHEMA_VERSION,
    context: {
      schemaVersion: RACE_CONTEXT_SCHEMA_VERSION,
      raceId,
      editionYear,
      raceName: "A Fictional Race",
      sourceIds: ["source-alpha"],
      locations,
    },
    routeBounds: bounds,
    anchors,
    evidence,
    orderingConstraints: constraints,
  };
}

function defaultSupports(spec) {
  const confidence = spec.positionConfidence ?? "context-only";
  if (confidence === "context-only") return [{ evidenceKind: "official-text-context", provenance: "official", verificationMethod: "text-review" }];
  if (confidence === "exact-direct") return [{ evidenceKind: "official-structured-position", provenance: "official", verificationMethod: "structured-source", positionFact: spec.position }];
  if (confidence === "verified-match") return [{ evidenceKind: "geographic-match", provenance: "official", verificationMethod: "geographic-match", positionFact: spec.position }];
  if (confidence === "approximate") return [{ evidenceKind: "official-map-or-coordinate", provenance: "official", verificationMethod: "structured-source", positionFact: spec.position }];
  if (confidence === "conflicting") return [
    { evidenceKind: "geographic-match", provenance: "official", verificationMethod: "geographic-match", positionFact: spec.position },
    { evidenceKind: "geographic-match", provenance: "official", verificationMethod: "geographic-match", positionFact: { type: "POINT", componentIndex: 0, distanceKm: 5 } },
  ];
  return [];
}

function point(distanceKm, componentIndex = 0, extras = {}) {
  return { type: "POINT", componentIndex, distanceKm, ...extras };
}

function validPointSpec(distanceKm = 5, options = {}) {
  return {
    type: "NAMED_LOCATION",
    position: point(distanceKm, options.componentIndex ?? 0, options.positionExtras),
    positionConfidence: options.confidence ?? "verified-match",
    ...options,
  };
}

function codes(result) {
  assert.equal(result.success, false, "expected invalid dataset");
  return result.issues.map((entry) => entry.code);
}

function assertInvalidWith(specs, expectedCode, options) {
  const result = validateRouteAnchorDataset(makeRecord(specs, options));
  assert.ok(codes(result).includes(expectedCode), `expected ${expectedCode}; got ${codes(result).join(", ")}`);
}

test("schema versions and generic fixture identity are explicit", () => {
  assert.equal(RACE_CONTEXT_SCHEMA_VERSION, 1);
  assert.equal(ROUTE_ANCHOR_SCHEMA_VERSION, 1);
  assert.equal(ROUTE_ANCHOR_EVIDENCE_SCHEMA_VERSION, 1);
  assert.equal(ROUTE_ANCHOR_INDEX_ALGORITHM_VERSION, 1);
  assert.equal(validateRouteAnchorDataset(makeRecord()).success, true);
});

test("accepts current-edition exact START and FINISH at the traversed route endpoints", () => {
  const result = validateRouteAnchorDataset(makeRecord([
    { type: "START", position: point(0, 0), positionConfidence: "exact-direct" },
    { type: "FINISH", position: point(15, 1), positionConfidence: "exact-direct" },
  ]));
  assert.equal(result.success, true);
});

test("endpoint semantics skip non-traversed components at either end", () => {
  const bounds = {
    routeId: "route-with-degenerate-ends",
    distanceKm: 4,
    components: [
      { componentIndex: 0, startKm: 0, endKm: 0, traversedDistanceKm: 0 },
      { componentIndex: 1, startKm: 0, endKm: 4, traversedDistanceKm: 4 },
      { componentIndex: 2, startKm: 4, endKm: 4, traversedDistanceKm: 0 },
    ],
  };
  const result = validateRouteAnchorDataset(makeRecord([
    { type: "START", position: point(0, 1), positionConfidence: "exact-direct" },
    { type: "FINISH", position: point(4, 1), positionConfidence: "exact-direct" },
  ], { bounds }));
  assert.equal(result.success, true);
});

test("accepts context-only places and verified or approximate position states", () => {
  const result = validateRouteAnchorDataset(makeRecord([
    { position: { type: "UNPOSITIONED" }, positionConfidence: "context-only", visitId: null },
    validPointSpec(4),
    { type: "NAMED_LOCATION", position: { type: "RANGE", componentIndex: 0, startKm: 4.5, endKm: 5.5 }, positionConfidence: "approximate" },
  ]));
  assert.equal(result.success, true);
  if (result.success) {
    assert.equal(routeAnchorPositionSafety(result.data.anchors[0]), "none");
    assert.equal(routeAnchorPositionSafety(result.data.anchors[1]), "exact");
    assert.equal(routeAnchorPositionSafety(result.data.anchors[2]), "qualified");
  }
});

test("accepts an official aid station at a directly evidenced kilometer", () => {
  const result = validateRouteAnchorDataset(makeRecord([{
    type: "AID_STATION",
    position: point(3.25),
    positionConfidence: "exact-direct",
  }]));
  assert.equal(result.success, true);
});

test("preserves the gpx-derived provenance category separately from confidence", () => {
  const result = validateRouteAnchorDataset(makeRecord([{
    type: "START",
    position: point(0),
    positionConfidence: "exact-direct",
    supports: [{
      evidenceKind: "gpx-waypoint",
      provenance: "gpx-derived",
      verificationMethod: "gpx-waypoint",
      positionFact: point(0),
    }],
  }]));
  assert.equal(result.success, true);
  if (result.success) assert.equal(result.data.evidence.find((entry) => entry.evidenceId === "evidence-0-0").provenance, "gpx-derived");
});

test("accepts a sourced named place with no route position", () => {
  assert.equal(validateRouteAnchorDataset(makeRecord([
    { position: { type: "UNPOSITIONED" }, positionConfidence: "context-only", visitId: null },
  ])).success, true);
});

test("the same place may have multiple distinct visit identities on loops and out-and-back routes", () => {
  const data = makeRecord([
    { ...validPointSpec(3), type: "AID_STATION", placeId: "place-revisited", name: "Shared place" },
    { ...validPointSpec(8), type: "AID_STATION", placeId: "place-revisited", name: "Shared place" },
  ], { orderingConstraints: [{ beforeVisitId: "visit-0", afterVisitId: "visit-1" }] });
  const result = validateRouteAnchorDataset(data);
  assert.equal(result.success, true);
  if (result.success) assert.equal(result.data.anchors[0].placeId, result.data.anchors[1].placeId);
  const index = createRouteAnchorIndex(data);
  assert.deepEqual(index.anchorsForComponent(0).map((anchor) => anchor.visitId), ["visit-0", "visit-1"]);
  assert.deepEqual(index.orderingBefore("visit-0"), ["visit-1"]);
});

test("rejects a duplicate visit identity instead of deduplicating by place", () => {
  assertInvalidWith([
    { ...validPointSpec(3), placeId: "same-place", visitId: "same-visit" },
    { ...validPointSpec(8), placeId: "same-place", visitId: "same-visit" },
  ], "anchor.duplicate-visit-id");
});

test("disconnected components remain independently queryable", () => {
  const data = makeRecord([validPointSpec(12, { componentIndex: 1 })]);
  const index = createRouteAnchorIndex(data);
  assert.deepEqual(index.anchorsInRange(0, 10, 15), []);
  assert.deepEqual(index.anchorsInRange(1, 10, 15).map((anchor) => anchor.anchorId), ["anchor-0"]);
});

test("supports order-only relationships without manufacturing route kilometers", () => {
  const data = makeRecord([
    { position: { type: "ORDERED_ONLY", componentIndex: 0 }, positionConfidence: "context-only" },
    { position: { type: "ORDERED_ONLY", componentIndex: 0 }, positionConfidence: "context-only" },
  ], { orderingConstraints: [{ beforeVisitId: "visit-0", afterVisitId: "visit-1" }] });
  assert.equal(validateRouteAnchorDataset(data).success, true);
  const index = createRouteAnchorIndex(data);
  assert.deepEqual(index.orderingBefore("visit-0"), ["visit-1"]);
  assert.deepEqual(index.orderingAfter("visit-1"), ["visit-0"]);
  assert.deepEqual(index.anchorsInRange(0, 0, 10), []);
});

test("rejects ordering cycles and self-edges", () => {
  const cycle = makeRecord([
    { position: { type: "ORDERED_ONLY", componentIndex: 0 }, positionConfidence: "context-only" },
    { position: { type: "ORDERED_ONLY", componentIndex: 0 }, positionConfidence: "context-only" },
    { position: { type: "ORDERED_ONLY", componentIndex: 0 }, positionConfidence: "context-only" },
  ], { orderingConstraints: [
    { beforeVisitId: "visit-0", afterVisitId: "visit-1" },
    { beforeVisitId: "visit-1", afterVisitId: "visit-2" },
    { beforeVisitId: "visit-2", afterVisitId: "visit-0" },
  ] });
  assert.ok(codes(validateRouteAnchorDataset(cycle)).includes("ordering.cycle"));
  const self = makeRecord([{ position: { type: "ORDERED_ONLY" }, positionConfidence: "context-only" }], {
    orderingConstraints: [{ beforeVisitId: "visit-0", afterVisitId: "visit-0" }],
  });
  assert.ok(codes(validateRouteAnchorDataset(self)).includes("ordering.self-reference"));
});

test("rejects ordering that contradicts positioned distances", () => {
  const data = makeRecord([validPointSpec(8), validPointSpec(3)], {
    orderingConstraints: [{ beforeVisitId: "visit-0", afterVisitId: "visit-1" }],
  });
  assert.ok(codes(validateRouteAnchorDataset(data)).includes("ordering.position-contradiction"));
});

test("allows component-order-consistent ordering and rejects a reversed cross-component edge", () => {
  const forward = makeRecord([
    validPointSpec(8, { componentIndex: 0 }),
    validPointSpec(12, { componentIndex: 1 }),
  ], { orderingConstraints: [{ beforeVisitId: "visit-0", afterVisitId: "visit-1" }] });
  assert.equal(validateRouteAnchorDataset(forward).success, true);
  const reversed = makeRecord([
    validPointSpec(8, { componentIndex: 0 }),
    validPointSpec(12, { componentIndex: 1 }),
  ], { orderingConstraints: [{ beforeVisitId: "visit-1", afterVisitId: "visit-0" }] });
  assert.ok(codes(validateRouteAnchorDataset(reversed)).includes("ordering.cross-component"));
});

test("cross-component ordering remains relational metadata and never leaks into spatial queries", () => {
  const data = makeRecord([
    validPointSpec(9, { componentIndex: 0 }),
    validPointSpec(12, { componentIndex: 1 }),
  ], { orderingConstraints: [{ beforeVisitId: "visit-0", afterVisitId: "visit-1" }] });
  const index = createRouteAnchorIndex(data);

  assert.deepEqual(index.orderingBefore("visit-0"), ["visit-1"]);
  assert.equal(index.anchorById("anchor-0")?.position.componentIndex, 0);
  assert.equal(index.anchorById("anchor-0")?.position.distanceKm, 9);
  assert.equal(index.anchorById("anchor-1")?.position.componentIndex, 1);
  assert.equal(index.anchorById("anchor-1")?.position.distanceKm, 12);
  assert.deepEqual(index.anchorsInRange(0, 0, 15).map((anchor) => anchor.anchorId), ["anchor-0"]);
  assert.deepEqual(index.anchorsNearDistance(0, 12, 10).map((anchor) => anchor.anchorId), ["anchor-0"]);
  assert.deepEqual(index.anchorsInRange(1, 10, 15).map((anchor) => anchor.anchorId), ["anchor-1"]);
  assert.deepEqual(index.anchorsNearDistance(1, 9, 10).map((anchor) => anchor.anchorId), ["anchor-1"]);
});

test("rejects out-of-bounds points, ranges, and reversed ranges", () => {
  assertInvalidWith([validPointSpec(11)], "anchor.point-outside-component");
  assertInvalidWith([{
    type: "NAMED_LOCATION",
    position: { type: "RANGE", componentIndex: 0, startKm: 9, endKm: 11 },
    positionConfidence: "approximate",
  }], "anchor.invalid-range");
  assertInvalidWith([{
    type: "NAMED_LOCATION",
    position: { type: "RANGE", componentIndex: 0, startKm: 6, endKm: 5 },
    positionConfidence: "approximate",
  }], "anchor.invalid-range");
});

test("rejects invalid coordinates and non-finite values", () => {
  const invalidCoordinate = makeRecord([validPointSpec(5, { positionExtras: { coordinate: { latitude: 91, longitude: 0 } } })]);
  assert.equal(validateRouteAnchorDataset(invalidCoordinate).success, false);
  const infiniteDistance = makeRecord([validPointSpec(Number.POSITIVE_INFINITY)]);
  assert.equal(validateRouteAnchorDataset(infiniteDistance).success, false);
});

test("requires visit identity for positioned points and ranges", () => {
  const data = makeRecord([validPointSpec(5, { visitId: null })]);
  assert.ok(codes(validateRouteAnchorDataset(data)).includes("anchor.position-missing-visit"));
  const unpositioned = makeRecord([{ position: { type: "UNPOSITIONED" }, positionConfidence: "context-only", visitId: "visit-without-position" }]);
  assert.ok(codes(validateRouteAnchorDataset(unpositioned)).includes("anchor.unpositioned-has-visit"));
});

test("approximate point confidence requires a measured error bound", () => {
  const unbounded = makeRecord([{
    position: point(5),
    positionConfidence: "approximate",
  }]);
  assert.ok(codes(validateRouteAnchorDataset(unbounded)).includes("anchor.approximate-point-unbounded"));
  const bounded = makeRecord([{
    position: point(5),
    positionConfidence: "approximate",
    supports: [{
      evidenceKind: "geographic-match",
      provenance: "estimated",
      verificationMethod: "geographic-match",
      positionFact: point(5),
      measuredOffsetM: 35,
    }],
  }]);
  assert.equal(validateRouteAnchorDataset(bounded).success, true);
});

test("rejects context-only precise points and exact-direct unpositioned anchors", () => {
  assertInvalidWith([validPointSpec(5, { confidence: "context-only" })], "anchor.context-only-positioned");
  assertInvalidWith([{ position: { type: "UNPOSITIONED" }, positionConfidence: "exact-direct", visitId: null }], "anchor.exact-without-position");
});

test("previous-edition evidence cannot be the sole support for a current exact or verified position", () => {
  const exact = makeRecord([{
    ...validPointSpec(5),
    positionConfidence: "exact-direct",
    contextSourceEditionYear: 2030,
    supports: [{
      evidenceKind: "official-structured-position",
      provenance: "previous-edition",
      sourceEditionYear: 2030,
      verificationMethod: "historical-reference",
      positionFact: point(5),
    }],
  }]);
  assert.ok(codes(validateRouteAnchorDataset(exact)).includes("anchor.exact-without-direct-evidence"));
  const verified = makeRecord([{
    ...validPointSpec(5),
    positionConfidence: "verified-match",
    contextSourceEditionYear: 2030,
    supports: [{
      evidenceKind: "geographic-match",
      provenance: "previous-edition",
      sourceEditionYear: 2030,
      verificationMethod: "geographic-match",
      positionFact: point(5),
    }],
  }]);
  assert.ok(codes(validateRouteAnchorDataset(verified)).includes("anchor.verified-without-match-evidence"));
  const approximate = makeRecord([{
    ...validPointSpec(5),
    positionConfidence: "approximate",
    supports: [{
      evidenceKind: "official-map-or-coordinate",
      provenance: "previous-edition",
      sourceEditionYear: 2030,
      verificationMethod: "historical-reference",
      positionFact: point(5),
      measuredOffsetM: 200,
    }],
  }]);
  assert.ok(codes(validateRouteAnchorDataset(approximate)).includes("anchor.historical-position-only"));
  const historicalContext = makeRecord([{
    position: { type: "UNPOSITIONED" },
    positionConfidence: "context-only",
    visitId: null,
    contextSourceEditionYear: 2030,
    contextProvenance: "previous-edition",
  }]);
  assert.equal(validateRouteAnchorDataset(historicalContext).success, true);
  const contextOnly = makeRecord([{
    position: { type: "UNPOSITIONED" },
    positionConfidence: "context-only",
    visitId: null,
    contextProvenance: "previous-edition",
  }]);
  assert.ok(codes(validateRouteAnchorDataset(contextOnly)).includes("context.historical-source-unmarked"));
});

test("conflicting anchors remain addressable but are excluded from safe positional queries", () => {
  const data = makeRecord([{
    ...validPointSpec(5),
    positionConfidence: "conflicting",
    supports: [
      { evidenceKind: "geographic-match", provenance: "official", verificationMethod: "geographic-match", positionFact: point(5) },
      { evidenceKind: "geographic-match", provenance: "official", verificationMethod: "geographic-match", positionFact: point(7) },
    ],
  }]);
  const index = createRouteAnchorIndex(data);
  assert.equal(index.anchorById("anchor-0")?.positionConfidence, "conflicting");
  assert.deepEqual(index.anchorsInRange(0, 0, 10), []);
  assert.deepEqual(index.anchorsInRange(0, 0, 10, { includeConflicting: true }).map((anchor) => anchor.anchorId), ["anchor-0"]);
});

test("rejects missing evidence, duplicate evidence/anchor IDs, and duplicate visit IDs", () => {
  const missing = makeRecord([validPointSpec(5)]);
  missing.anchors[0].evidenceIds = ["missing-evidence"];
  assert.ok(codes(validateRouteAnchorDataset(missing)).includes("anchor.missing-evidence"));

  const duplicateEvidence = makeRecord([validPointSpec(5), validPointSpec(6)]);
  duplicateEvidence.evidence[1].evidenceId = duplicateEvidence.evidence[0].evidenceId;
  assert.ok(codes(validateRouteAnchorDataset(duplicateEvidence)).includes("evidence.duplicate-id"));

  const duplicateAnchor = makeRecord([validPointSpec(5), validPointSpec(6)]);
  duplicateAnchor.anchors[1].anchorId = duplicateAnchor.anchors[0].anchorId;
  assert.ok(codes(validateRouteAnchorDataset(duplicateAnchor)).includes("anchor.duplicate-id"));
});

test("rejects race and edition mismatches between context, anchors, and evidence", () => {
  const anchorRace = makeRecord([validPointSpec(5)]);
  anchorRace.anchors[0].raceId = "other-race";
  assert.ok(codes(validateRouteAnchorDataset(anchorRace)).includes("anchor.race-mismatch"));

  const anchorEdition = makeRecord([validPointSpec(5)]);
  anchorEdition.anchors[0].editionYear = 2030;
  assert.ok(codes(validateRouteAnchorDataset(anchorEdition)).includes("anchor.edition-mismatch"));

  const evidenceRace = makeRecord([validPointSpec(5)]);
  evidenceRace.evidence.find((entry) => entry.evidenceId === "evidence-0-0").raceId = "other-race";
  assert.ok(codes(validateRouteAnchorDataset(evidenceRace)).includes("evidence.race-mismatch"));

  const evidenceEdition = makeRecord([validPointSpec(5)]);
  evidenceEdition.evidence.find((entry) => entry.evidenceId === "evidence-0-0").editionYear = 2030;
  assert.ok(codes(validateRouteAnchorDataset(evidenceEdition)).includes("evidence.edition-mismatch"));
});

test("requires START and FINISH to match first/last traversed components", () => {
  assertInvalidWith([{ type: "START", position: point(1), positionConfidence: "exact-direct" }], "anchor.start-not-route-start");
  assertInvalidWith([{ type: "FINISH", position: point(14, 1), positionConfidence: "exact-direct" }], "anchor.finish-not-route-finish");
});

test("range lookup uses half-open point ownership and overlap semantics for ranges", () => {
  const index = createRouteAnchorIndex(makeRecord([
    validPointSpec(2),
    validPointSpec(4),
    { type: "NAMED_LOCATION", position: { type: "RANGE", componentIndex: 0, startKm: 3, endKm: 5 }, positionConfidence: "approximate" },
  ]));
  assert.deepEqual(index.anchorsInRange(0, 2, 4).map((anchor) => anchor.anchorId), ["anchor-0", "anchor-2"]);
  assert.deepEqual(index.anchorsInRange(0, 4, 6).map((anchor) => anchor.anchorId), ["anchor-2", "anchor-1"]);
});

test("an approximate range ending at a query boundary is not double-owned by the next range", () => {
  const index = createRouteAnchorIndex(makeRecord([{
    type: "NAMED_LOCATION",
    position: { type: "RANGE", componentIndex: 0, startKm: 3, endKm: 5 },
    positionConfidence: "approximate",
  }]));
  assert.deepEqual(index.anchorsInRange(0, 0, 5).map((anchor) => anchor.anchorId), ["anchor-0"]);
  assert.deepEqual(index.anchorsInRange(0, 5, 8), []);
});

test("includes an exact terminal FINISH at the end of the final route range", () => {
  const index = createRouteAnchorIndex(makeRecord([
    { type: "FINISH", position: point(15, 1), positionConfidence: "exact-direct" },
  ]));
  assert.deepEqual(index.anchorsInRange(1, 14, 15).map((anchor) => anchor.type), ["FINISH"]);
});

test("near-distance queries include the tolerance boundary and approximate ranges", () => {
  const index = createRouteAnchorIndex(makeRecord([
    validPointSpec(5),
    { type: "NAMED_LOCATION", position: { type: "RANGE", componentIndex: 0, startKm: 6, endKm: 7 }, positionConfidence: "approximate" },
  ]));
  assert.deepEqual(index.anchorsNearDistance(0, 6, 1).map((anchor) => anchor.anchorId), ["anchor-0", "anchor-1"]);
});

test("index ordering is deterministic by component, position, then stable anchor ID", () => {
  const data = makeRecord([
    validPointSpec(12, { componentIndex: 1, anchorId: "z-anchor" }),
    validPointSpec(3, { componentIndex: 0, anchorId: "b-anchor" }),
    validPointSpec(3, { componentIndex: 0, anchorId: "a-anchor" }),
  ]);
  const first = createRouteAnchorIndex(data).anchorsForComponent(0).map((anchor) => anchor.anchorId);
  const second = createRouteAnchorIndex(data).anchorsForComponent(0).map((anchor) => anchor.anchorId);
  assert.deepEqual(first, ["a-anchor", "b-anchor"]);
  assert.deepEqual(second, first);
  assert.deepEqual(createRouteAnchorIndex(data).anchorsForComponent(1).map((anchor) => anchor.anchorId), ["z-anchor"]);
});

test("repeated index calls are identical and ID/visit lookup is explicit", () => {
  const index = createRouteAnchorIndex(makeRecord([validPointSpec(3)]));
  assert.deepEqual(index.anchorsForComponent(0), index.anchorsForComponent(0));
  assert.equal(index.anchorById("anchor-0")?.anchorId, "anchor-0");
  assert.equal(index.visitById("visit-0")?.anchorId, "anchor-0");
  assert.equal(index.anchorById("missing"), null);
  assert.equal(index.visitById("missing"), null);
});

test("returns clean empty queries for a route with no anchors", () => {
  const index = createRouteAnchorIndex(makeRecord([], {
    bounds: { routeId: "empty-route", distanceKm: 0, components: [] },
  }));
  assert.deepEqual(index.anchorsForComponent(0), []);
  assert.deepEqual(index.anchorsInRange(0, 0, 10), []);
  assert.deepEqual(index.anchorsNearDistance(0, 2, 1), []);
  assert.deepEqual(index.startAnchors(), []);
  assert.deepEqual(index.finishAnchors(), []);
});

test("start and finish helpers return display-safe endpoint anchors", () => {
  const index = createRouteAnchorIndex(makeRecord([
    { type: "START", position: point(0), positionConfidence: "exact-direct" },
    { type: "FINISH", position: point(15, 1), positionConfidence: "exact-direct" },
  ]));
  assert.deepEqual(index.startAnchors().map((anchor) => anchor.type), ["START"]);
  assert.deepEqual(index.finishAnchors().map((anchor) => anchor.type), ["FINISH"]);
});

test("rejects malformed versions, unknown enums, and unknown object properties", () => {
  const version = makeRecord();
  version.schemaVersion = 2;
  assert.equal(validateRouteAnchorDataset(version).success, false);
  const type = makeRecord([{ type: "SUMMIT", position: { type: "UNPOSITIONED" }, positionConfidence: "context-only", visitId: null }]);
  assert.equal(validateRouteAnchorDataset(type).success, false);
  const extra = makeRecord();
  extra.extra = true;
  assert.equal(validateRouteAnchorDataset(extra).success, false);
});

test("rejects historical source edition misuse and missing source references", () => {
  const badHistorical = makeRecord([{
    position: { type: "UNPOSITIONED" },
    positionConfidence: "context-only",
    visitId: null,
    contextSourceEditionYear: 2031,
    supports: [{ evidenceKind: "previous-edition-reference", provenance: "previous-edition", sourceEditionYear: 2031, verificationMethod: "historical-reference" }],
  }]);
  assert.ok(codes(validateRouteAnchorDataset(badHistorical)).some((code) => code.includes("historical") || code.includes("source-edition")));
  const missingSource = makeRecord([validPointSpec(5)]);
  missingSource.evidence.find((entry) => entry.evidenceId === "evidence-0-0").sourceId = "unknown-source";
  assert.ok(codes(validateRouteAnchorDataset(missingSource)).includes("evidence.unknown-source"));
});

test("does not encode any race-specific assumptions", () => {
  const result = validateRouteAnchorDataset(makeRecord([validPointSpec(5)], { raceId: "arbitrary-race-42", editionYear: 2042 }));
  assert.equal(result.success, true);
});

test("index rejects invalid input instead of indexing unvalidated records", () => {
  assert.throws(() => createRouteAnchorIndex({ schemaVersion: 999 }), /Invalid Route Anchor dataset/);
});
