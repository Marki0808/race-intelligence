import assert from "node:assert/strict";
import test from "node:test";
import {
  ROUTE_ANCHOR_EVIDENCE_SCHEMA_VERSION,
  RACE_CONTEXT_SCHEMA_VERSION,
} from "./routeAnchors.ts";
import {
  ROUTE_ANCHOR_MATCHING_ALGORITHM_VERSION,
  ROUTE_ANCHOR_MAX_EVENT_POINT_OFFSET_M,
  ROUTE_ANCHOR_MAX_PLACE_REFERENCE_OFFSET_M,
  matchRouteAnchors,
  routeAnchorGeometryFromAnalysis,
  validateRouteAnchorMatchInput,
} from "./routeAnchorMatching.ts";

const SOURCE = "official-source";
const RACE = "generic-race";
const YEAR = 2032;

function haversineM(a, b) {
  const radians = (value) => value * Math.PI / 180;
  const dLat = radians(b.latitude - a.latitude);
  const dLon = radians(b.longitude - a.longitude);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(radians(a.latitude)) * Math.cos(radians(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6_371_000 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function makeRoute(segments) {
  let cumulativeKm = 0;
  const components = segments.map((coordinates, componentIndex) => {
    const points = coordinates.map((coordinate, routePointIndex) => {
      if (routePointIndex > 0) cumulativeKm += haversineM(coordinates[routePointIndex - 1], coordinate) / 1000;
      return { ...coordinate, componentIndex, routePointIndex, distanceKm: cumulativeKm };
    });
    return { componentIndex, points };
  });
  const bounds = {
    routeId: "synthetic-route",
    distanceKm: cumulativeKm,
    components: components.map(({ componentIndex, points }) => ({
      componentIndex,
      startKm: points[0]?.distanceKm ?? cumulativeKm,
      endKm: points.at(-1)?.distanceKm ?? cumulativeKm,
      traversedDistanceKm: points.length < 2 ? 0 : points.at(-1).distanceKm - points[0].distanceKm,
    })),
  };
  return { routeId: bounds.routeId, distanceKm: cumulativeKm, bounds, components };
}

function identityEvidence(locationId, extra = {}) {
  return {
    schemaVersion: ROUTE_ANCHOR_EVIDENCE_SCHEMA_VERSION,
    evidenceId: locationId + "-identity",
    raceId: RACE,
    editionYear: YEAR,
    sourceEditionYear: null,
    sourceId: SOURCE,
    evidenceKind: "official-text-context",
    provenance: "official",
    verificationMethod: "text-review",
    ...extra,
  };
}

function makeInput({
  segments = [[{ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 0.01 }]],
  type = "NAMED_LOCATION",
  semantics,
  coordinate,
  routeKm,
  routeKmComponent,
  visitId,
  sourceEditionYear = null,
  provenance = "official",
  evidenceKind,
  verificationMethod,
  extraLocations = [],
  extraEvidence = [],
  orderingConstraints = [],
} = {}) {
  const locationId = "target";
  const positionEvidence = [];
  if (coordinate) {
    positionEvidence.push({
      schemaVersion: ROUTE_ANCHOR_EVIDENCE_SCHEMA_VERSION,
      evidenceId: "target-coordinate",
      raceId: RACE,
      editionYear: YEAR,
      sourceEditionYear,
      sourceId: SOURCE,
      evidenceKind: evidenceKind ?? "official-map-or-coordinate",
      provenance,
      verificationMethod: verificationMethod ?? "structured-source",
      coordinateFact: { ...coordinate, semantics },
      ...(visitId ? { visitId } : {}),
    });
  }
  if (routeKm !== undefined) {
    positionEvidence.push({
      schemaVersion: ROUTE_ANCHOR_EVIDENCE_SCHEMA_VERSION,
      evidenceId: "target-km",
      raceId: RACE,
      editionYear: YEAR,
      sourceEditionYear,
      sourceId: SOURCE,
      evidenceKind: "official-structured-position",
      provenance,
      verificationMethod: "structured-source",
      routeKmFact: {
        distanceKm: routeKm,
        convention: "traversed-distance-from-route-start",
        ...(routeKmComponent === undefined ? {} : { componentIndex: routeKmComponent }),
      },
      ...(visitId ? { visitId } : {}),
    });
  }
  const identity = identityEvidence(locationId);
  const locations = [{
    locationId,
    placeId: "target-place",
    name: "Test place",
    type,
    sourceEditionYear: null,
    evidenceIds: [identity.evidenceId, ...positionEvidence.map((entry) => entry.evidenceId)],
  }, ...extraLocations];
  return {
    context: {
      schemaVersion: RACE_CONTEXT_SCHEMA_VERSION,
      raceId: RACE,
      editionYear: YEAR,
      raceName: "Generic Test Race",
      sourceIds: [SOURCE],
      locations,
    },
    evidence: [identity, ...positionEvidence, ...extraEvidence],
    route: makeRoute(segments),
    orderingConstraints,
  };
}

function result(input, locationId = "target") {
  return matchRouteAnchors(input).results.find((entry) => entry.contextLocationId === locationId);
}

function edge(lon1, lon2) {
  return [{ latitude: 0, longitude: lon1 }, { latitude: 0, longitude: lon2 }];
}

test("matching algorithm and policy versions are explicit", () => {
  assert.equal(ROUTE_ANCHOR_MATCHING_ALGORITHM_VERSION, 1);
  assert.ok(ROUTE_ANCHOR_MAX_EVENT_POINT_OFFSET_M > 0);
  assert.ok(ROUTE_ANCHOR_MAX_PLACE_REFERENCE_OFFSET_M > ROUTE_ANCHOR_MAX_EVENT_POINT_OFFSET_M);
});

test("direct current-edition official route kilometer materializes an exact anchor", () => {
  const input = makeInput({ type: "AID_STATION", routeKm: 0.5 });
  const matched = result(input);
  assert.equal(matched.state, "matched-exact");
  assert.equal(matched.positionConfidence, "exact-direct");
  assert.equal(matched.position.componentIndex, 0);
  assert.ok(Math.abs(matched.position.distanceKm - 0.5) < 1e-9);
  assert.equal(matched.anchor.positionConfidence, "exact-direct");
  assert.equal(matched.positionSafe, true);
});

test("direct route kilometers outside route bounds are rejected without clamping", () => {
  const input = makeInput({ routeKm: 2 });
  const matched = result(input);
  assert.equal(matched.state, "rejected");
  assert.ok(matched.reasonCodes.includes("outside-match-tolerance"));
  assert.equal(matched.anchor.position.type, "UNPOSITIONED");
});

test("a direct kilometer at a shared disconnected-component boundary needs component identity", () => {
  const route = makeRoute([edge(0, 0.01), edge(1, 1.01)]);
  const input = makeInput({ segments: [edge(0, 0.01), edge(1, 1.01)], routeKm: route.bounds.components[0].endKm });
  const matched = result(input);
  assert.equal(matched.state, "ambiguous");
  assert.ok(matched.reasonCodes.includes("component-ambiguous"));
});

test("coordinate evidence resolves a shared-component kilometer boundary only to its uniquely supported component", () => {
  const segments = [edge(0, 0.01), edge(1, 1.01)];
  const route = makeRoute(segments);
  const matched = result(makeInput({
    segments,
    routeKm: route.bounds.components[0].endKm,
    coordinate: { latitude: 0, longitude: 0.01, componentIndex: 0 },
    semantics: "route-point",
  }));
  assert.equal(matched.state, "matched-exact");
  assert.equal(matched.position.componentIndex, 0);
  assert.ok(Math.abs(matched.position.distanceKm - route.bounds.components[0].endKm) < 1e-9);
});

test("a coordinate exactly on a route segment projects to its interpolated kilometer", () => {
  const input = makeInput({ coordinate: { latitude: 0, longitude: 0.005 }, semantics: "route-point" });
  const matched = result(input);
  assert.equal(matched.state, "matched-verified");
  assert.equal(matched.offsetMeters, 0);
  assert.ok(Math.abs(matched.position.distanceKm - input.route.distanceKm / 2) < 1e-7);
});

test("a nearby event point within its named policy tolerance is verified", () => {
  const input = makeInput({
    type: "AID_STATION",
    coordinate: { latitude: 0.0005, longitude: 0.005 },
    semantics: "event-point",
  });
  const matched = result(input);
  assert.equal(matched.state, "matched-verified");
  assert.ok(matched.offsetMeters < ROUTE_ANCHOR_MAX_EVENT_POINT_OFFSET_M);
  assert.equal(matched.positionConfidence, "verified-match");
});

test("coordinates outside their evidence-specific tolerance remain unpositioned", () => {
  const input = makeInput({
    type: "AID_STATION",
    coordinate: { latitude: 0.002, longitude: 0.005 },
    semantics: "event-point",
  });
  const matched = result(input);
  assert.equal(matched.state, "rejected");
  assert.ok(matched.reasonCodes.includes("outside-match-tolerance"));
  assert.equal(matched.anchor.position.type, "UNPOSITIONED");
  assert.ok(matched.offsetMeters > ROUTE_ANCHOR_MAX_EVENT_POINT_OFFSET_M);
  assert.ok(matched.candidateProjections.length > 0);
});

test("place-reference coordinates are approximate and never assert named-place visitation", () => {
  const input = makeInput({
    coordinate: { latitude: 0.001, longitude: 0.005 },
    semantics: "place-reference-point",
  });
  const matched = result(input);
  assert.equal(matched.state, "matched-approximate");
  assert.equal(matched.positionConfidence, "approximate");
  assert.equal(matched.positionSafe, false);
  assert.ok(matched.offsetMeters <= ROUTE_ANCHOR_MAX_PLACE_REFERENCE_OFFSET_M);
  assert.ok(matched.offsetMeters > 0);
  assert.equal(matched.anchor.positionConfidence, "approximate");
});

test("place-reference proximity cannot verify START, FINISH, or an aid station", () => {
  for (const type of ["START", "FINISH", "AID_STATION"]) {
    const matched = result(makeInput({
      type,
      coordinate: { latitude: 0.001, longitude: 0.005 },
      semantics: "place-reference-point",
    }));
    assert.notEqual(matched.state, "matched-exact");
    assert.notEqual(matched.state, "matched-verified");
    assert.equal(matched.positionSafe, false);
    assert.ok(matched.position === null || matched.position.type === "UNPOSITIONED");
  }
});

test("a place-reference coordinate cannot escalate when combined with conflicting route-point evidence", () => {
  const input = makeInput({
    coordinate: { latitude: 0.001, longitude: 0.005 },
    semantics: "place-reference-point",
  });
  input.evidence.push({
    ...identityEvidence("target"),
    evidenceId: "target-route-point",
    evidenceKind: "official-map-or-coordinate",
    verificationMethod: "structured-source",
    coordinateFact: { latitude: 0, longitude: 0.007, semantics: "route-point" },
  });
  input.context.locations[0].evidenceIds.push("target-route-point");
  const matched = result(input);
  assert.equal(matched.state, "conflicting");
  assert.equal(matched.positionSafe, false);
  assert.equal(matched.anchor, null);
});

test("START event coordinates validate only against the first traversed endpoint", () => {
  const input = makeInput({ type: "START", coordinate: { latitude: 0, longitude: 0 }, semantics: "event-point" });
  const matched = result(input);
  assert.equal(matched.state, "matched-verified");
  assert.equal(matched.position.distanceKm, input.route.bounds.components[0].startKm);
});

test("START near an interior pass conflicts instead of relocating the start", () => {
  const route = [edge(0, 0.01), edge(0.01, 0.02)];
  const input = makeInput({
    type: "START",
    segments: route,
    coordinate: { latitude: 0, longitude: 0.015 },
    semantics: "event-point",
  });
  const matched = result(input);
  assert.equal(matched.state, "conflicting");
  assert.ok(matched.reasonCodes.includes("endpoint-mismatch"));
  assert.equal(matched.anchor, null);
});

test("FINISH event coordinates validate only against the last traversed endpoint", () => {
  const input = makeInput({ type: "FINISH", coordinate: { latitude: 0, longitude: 0.01 }, semantics: "event-point" });
  const matched = result(input);
  assert.equal(matched.state, "matched-verified");
  assert.equal(matched.position.distanceKm, input.route.bounds.components.at(-1).endKm);
});

test("FINISH near an interior pass conflicts instead of relocating the finish", () => {
  const input = makeInput({
    type: "FINISH",
    segments: [edge(0, 0.01), edge(0.01, 0.02)],
    coordinate: { latitude: 0, longitude: 0.005 },
    semantics: "event-point",
  });
  const matched = result(input);
  assert.equal(matched.state, "conflicting");
  assert.ok(matched.reasonCodes.includes("endpoint-mismatch"));
});

test("place-reference proximity cannot verify either route endpoint", () => {
  for (const type of ["START", "FINISH"]) {
    const matched = result(makeInput({
      type,
      coordinate: { latitude: 0, longitude: type === "START" ? 0.0005 : 0.0095 },
      semantics: "place-reference-point",
    }));
    assert.notEqual(matched.state, "matched-exact");
    assert.notEqual(matched.state, "matched-verified");
    assert.equal(matched.positionSafe, false);
  }
});

test("aid station with a current official kilometer is exact", () => {
  const matched = result(makeInput({ type: "AID_STATION", routeKm: 0.4, visitId: "station-visit" }));
  assert.equal(matched.state, "matched-exact");
  assert.equal(matched.visitId, "station-visit");
});

test("aid-station kilometer and coordinate that agree reconcile deterministically", () => {
  const input = makeInput({
    type: "AID_STATION",
    routeKm: 0.55,
    coordinate: { latitude: 0, longitude: 0.005 },
    semantics: "event-point",
  });
  const matched = result(input);
  assert.equal(matched.state, "matched-exact");
  assert.ok(matched.evidenceIds.some((id) => id.startsWith("match:")));
});

test("direct endpoint kilometer evidence cannot relocate START to an interior position", () => {
  const matched = result(makeInput({ type: "START", routeKm: 0.5 }));
  assert.equal(matched.state, "conflicting");
  assert.ok(matched.reasonCodes.includes("endpoint-mismatch"));
  assert.equal(matched.anchor, null);
});

test("aid-station kilometer and coordinate that disagree fail closed", () => {
  const matched = result(makeInput({
    type: "AID_STATION",
    routeKm: 0.2,
    coordinate: { latitude: 0, longitude: 0.008 },
    semantics: "event-point",
  }));
  assert.equal(matched.state, "conflicting");
  assert.ok(matched.reasonCodes.includes("conflicting-evidence"));
  assert.equal(matched.anchor, null);
});

test("a coordinate near multiple route passes is ambiguous", () => {
  const input = makeInput({
    segments: [[
      { latitude: 0, longitude: 0 },
      { latitude: 0, longitude: 0.01 },
      { latitude: 0, longitude: 0 },
      { latitude: 0, longitude: 0.01 },
    ]],
    coordinate: { latitude: 0, longitude: 0.005 },
    semantics: "event-point",
    type: "AID_STATION",
  });
  const matched = result(input);
  assert.equal(matched.state, "ambiguous");
  assert.ok(matched.candidateProjections.length >= 2);
  assert.equal(matched.positionSafe, false);
});

test("an out-and-back route with a repeated coordinate remains ambiguous", () => {
  const input = makeInput({
    segments: [[
      { latitude: 0, longitude: 0 },
      { latitude: 0, longitude: 0.01 },
      { latitude: 0, longitude: 0 },
    ]],
    coordinate: { latitude: 0, longitude: 0.005 },
    semantics: "route-point",
  });
  assert.equal(result(input).state, "ambiguous");
});

test("distinct route visits remain ambiguous even when a compact loop places them close together", () => {
  const side = 0.0005625;
  const input = makeInput({
    segments: [[
      { latitude: 0, longitude: 0 },
      { latitude: 0, longitude: side },
      { latitude: side, longitude: side },
      { latitude: side, longitude: 0 },
      { latitude: 0, longitude: 0 },
      { latitude: 0, longitude: side },
    ]],
    coordinate: { latitude: 0, longitude: side / 2 },
    semantics: "event-point",
    type: "AID_STATION",
  });
  const matched = result(input);
  assert.equal(matched.state, "ambiguous");
  assert.ok(matched.candidateProjections.length >= 2);
  assert.ok(matched.candidateProjections[1].distanceKm - matched.candidateProjections[0].distanceKm < 0.3);
});

test("source-backed ordering can select one of multiple plausible visits", () => {
  const route = [[
    { latitude: 0, longitude: 0 },
    { latitude: 0, longitude: 0.01 },
    { latitude: 0, longitude: 0 },
    { latitude: 0, longitude: 0.01 },
  ]];
  const fixedId = "fixed-km";
  const targetId = "target-visit";
  const orderEvidence = {
    schemaVersion: ROUTE_ANCHOR_EVIDENCE_SCHEMA_VERSION,
    evidenceId: "order-proof",
    raceId: RACE,
    editionYear: YEAR,
    sourceEditionYear: null,
    sourceId: SOURCE,
    evidenceKind: "official-text-order",
    provenance: "official",
    verificationMethod: "text-review",
    orderingFact: { beforeVisitId: fixedId, afterVisitId: targetId },
  };
  const priorIdentity = identityEvidence("prior");
  const priorPosition = {
    schemaVersion: ROUTE_ANCHOR_EVIDENCE_SCHEMA_VERSION,
    evidenceId: fixedId + "-km",
    raceId: RACE,
    editionYear: YEAR,
    sourceEditionYear: null,
    sourceId: SOURCE,
    evidenceKind: "official-structured-position",
    provenance: "official",
    verificationMethod: "structured-source",
    visitId: fixedId,
    routeKmFact: { distanceKm: 2, componentIndex: 0, convention: "traversed-distance-from-route-start" },
  };
  const input = makeInput({
    segments: route,
    coordinate: { latitude: 0, longitude: 0.005 },
    semantics: "event-point",
    type: "AID_STATION",
    visitId: targetId,
    extraLocations: [{
      locationId: "prior",
      placeId: "prior-place",
      name: "Earlier stop",
      type: "AID_STATION",
      sourceEditionYear: null,
      evidenceIds: [priorIdentity.evidenceId, priorPosition.evidenceId],
    }],
    extraEvidence: [priorIdentity, priorPosition, orderEvidence],
    orderingConstraints: [{ beforeVisitId: fixedId, afterVisitId: targetId, evidenceIds: [orderEvidence.evidenceId] }],
  });
  const matched = result(input);
  assert.equal(matched.state, "matched-verified");
  assert.ok(matched.position.distanceKm > 2);
  assert.ok(matched.reasonCodes.includes("ordering-disambiguated"));
  assert.equal(result(input, "prior").state, "matched-exact");
});

test("ordering without spatial evidence does not create a route kilometer", () => {
  const order = {
    schemaVersion: ROUTE_ANCHOR_EVIDENCE_SCHEMA_VERSION,
    evidenceId: "order-only",
    raceId: RACE,
    editionYear: YEAR,
    sourceEditionYear: null,
    sourceId: SOURCE,
    evidenceKind: "official-text-order",
    provenance: "official",
    verificationMethod: "text-review",
    orderingFact: { beforeVisitId: "visit-a", afterVisitId: "visit-b" },
  };
  const priorIdentity = identityEvidence("prior");
  const input = makeInput({
    extraLocations: [{
      locationId: "prior", placeId: "prior-place", name: "Prior context", type: "NAMED_LOCATION",
      sourceEditionYear: null, evidenceIds: [priorIdentity.evidenceId],
    }],
    extraEvidence: [priorIdentity, order],
    orderingConstraints: [{ beforeVisitId: "visit-a", afterVisitId: "visit-b", evidenceIds: [order.evidenceId] }],
  });
  input.context.locations[0].evidenceIds.push(order.evidenceId);
  const matched = result(input);
  assert.equal(matched.state, "context-only");
  assert.equal(matched.position.type, "UNPOSITIONED");
  assert.equal(matched.positionSafe, false);
  assert.equal(result(input, "prior").position.type, "UNPOSITIONED");
});

test("same place can retain distinct explicit visit identities", () => {
  const first = makeInput({
    type: "AID_STATION",
    coordinate: { latitude: 0, longitude: 0.002 },
    semantics: "event-point",
    visitId: "visit-one",
  });
  const secondIdentity = identityEvidence("second");
  const secondCoordinate = {
    schemaVersion: ROUTE_ANCHOR_EVIDENCE_SCHEMA_VERSION,
    evidenceId: "second-coordinate",
    raceId: RACE,
    editionYear: YEAR,
    sourceEditionYear: null,
    sourceId: SOURCE,
    evidenceKind: "official-map-or-coordinate",
    provenance: "official",
    verificationMethod: "structured-source",
    coordinateFact: { latitude: 0, longitude: 0.008, semantics: "event-point" },
    visitId: "visit-two",
  };
  first.context.locations.push({
    locationId: "second", placeId: "target-place", name: "Test place", type: "AID_STATION",
    sourceEditionYear: null, evidenceIds: [secondIdentity.evidenceId, secondCoordinate.evidenceId],
  });
  first.evidence.push(secondIdentity, secondCoordinate);
  const output = matchRouteAnchors(first);
  assert.deepEqual(output.results.map((entry) => entry.visitId), ["visit-one", "visit-two"]);
  assert.equal(output.dataset.anchors[0].placeId, output.dataset.anchors[1].placeId);
});

test("repeated place evidence without visit disambiguation remains ambiguous", () => {
  const input = makeInput({
    segments: [[
      { latitude: 0, longitude: 0 },
      { latitude: 0, longitude: 0.01 },
      { latitude: 0, longitude: 0 },
    ]],
    coordinate: { latitude: 0, longitude: 0.005 },
    semantics: "event-point",
  });
  assert.equal(result(input).state, "ambiguous");
});

test("disconnected components are projected independently and no gap connector exists", () => {
  const input = makeInput({
    segments: [
      edge(0, 0.01),
      [{ latitude: 1, longitude: 1 }, { latitude: 1, longitude: 1.01 }],
    ],
    coordinate: { latitude: 0.5, longitude: 0.5 },
    semantics: "route-point",
  });
  const matched = result(input);
  assert.equal(matched.state, "rejected");
  assert.ok(matched.reasonCodes.includes("outside-match-tolerance"));
  assert.equal(matched.candidateProjections.length, 2);
  assert.deepEqual(matched.candidateProjections.map((candidate) => candidate.componentIndex).sort(), [0, 1]);
  assert.ok(matched.candidateProjections.every((candidate) => candidate.offsetMeters > 1_000));
});

test("a coordinate near both sides of a disconnected boundary remains component-ambiguous", () => {
  const matched = result(makeInput({
    segments: [
      [{ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 0.001 }],
      [{ latitude: 0.0001, longitude: 0.001 }, { latitude: 0.0001, longitude: 0.002 }],
    ],
    coordinate: { latitude: 0.00005, longitude: 0.001 },
    semantics: "route-point",
  }));
  assert.equal(matched.state, "ambiguous");
  assert.ok(matched.reasonCodes.includes("ambiguous-route-visits"));
  assert.deepEqual(matched.candidateProjections.map((candidate) => candidate.componentIndex).sort(), [0, 1]);
  assert.equal(matched.positionSafe, false);
});

test("coordinate constrained to one component cannot match another component", () => {
  const input = makeInput({
    segments: [edge(0, 0.01), edge(1, 1.01)],
    coordinate: { latitude: 1, longitude: 1.005, componentIndex: 0 },
    semantics: "route-point",
  });
  assert.equal(result(input).state, "rejected");
});

test("previous-edition coordinate alone cannot position a current edition", () => {
  const input = makeInput({
    coordinate: { latitude: 0, longitude: 0.005 },
    semantics: "event-point",
    sourceEditionYear: 2031,
    provenance: "previous-edition",
  });
  const matched = result(input);
  assert.equal(matched.state, "context-only");
  assert.ok(matched.reasonCodes.includes("previous-edition-only"));
  assert.equal(matched.anchor.position.type, "UNPOSITIONED");
});

test("current identity plus previous-edition position does not produce verified position", () => {
  const input = makeInput({
    coordinate: { latitude: 0, longitude: 0.005 },
    semantics: "route-point",
    sourceEditionYear: 2031,
    provenance: "previous-edition",
  });
  const matched = result(input);
  assert.equal(matched.positionConfidence, "context-only");
  assert.equal(matched.positionSafe, false);
});

test("estimated coordinate evidence remains context-only and reports its trust limitation", () => {
  const input = makeInput({
    coordinate: { latitude: 0, longitude: 0.005 },
    semantics: "route-point",
    provenance: "estimated",
  });
  const matched = result(input);
  assert.equal(matched.state, "context-only");
  assert.ok(matched.reasonCodes.includes("untrusted-position-evidence"));
  assert.equal(matched.positionSafe, false);
});

test("conflicting coordinate evidence never yields a position-safe anchor", () => {
  const input = makeInput({
    coordinate: { latitude: 0, longitude: 0.002 },
    semantics: "event-point",
  });
  const second = {
    ...input.evidence.find((entry) => entry.evidenceId === "target-coordinate"),
    evidenceId: "second-coordinate",
    coordinateFact: { latitude: 0, longitude: 0.008, semantics: "event-point" },
  };
  input.evidence.push(second);
  input.context.locations[0].evidenceIds.push(second.evidenceId);
  const matched = result(input);
  assert.equal(matched.state, "conflicting");
  assert.equal(matched.positionSafe, false);
  assert.equal(matched.anchor, null);
});

test("agreeing evidence and evidence input order produce stable matching output", () => {
  const input = makeInput({
    type: "AID_STATION",
    routeKm: 0.55,
    coordinate: { latitude: 0, longitude: 0.005 },
    semantics: "event-point",
  });
  const first = matchRouteAnchors(input);
  const reversed = matchRouteAnchors({ ...input, evidence: [...input.evidence].reverse() });
  assert.deepEqual(first.results, reversed.results);
  assert.deepEqual(first.dataset.anchors, reversed.dataset.anchors);
});

test("multiple agreeing coordinate records reconcile regardless of evidence array order", () => {
  const input = makeInput({
    type: "AID_STATION", coordinate: { latitude: 0, longitude: 0.005 }, semantics: "event-point",
  });
  const extra = {
    ...input.evidence.find((entry) => entry.evidenceId === "target-coordinate"),
    evidenceId: "second-coordinate",
  };
  input.evidence.push(extra);
  input.context.locations[0].evidenceIds.push(extra.evidenceId);
  const first = matchRouteAnchors(input);
  const reversed = matchRouteAnchors({ ...input, evidence: [...input.evidence].reverse() });
  assert.deepEqual(first.results, reversed.results);
  assert.deepEqual(first.dataset.anchors, reversed.dataset.anchors);
  assert.deepEqual(first.dataset.evidence, reversed.dataset.evidence);
});

test("repeated calls are deterministic", () => {
  const input = makeInput({ coordinate: { latitude: 0, longitude: 0.004 }, semantics: "route-point" });
  assert.deepEqual(matchRouteAnchors(input), matchRouteAnchors(input));
});

test("segment projection is stable when straight route sampling changes", () => {
  const sparse = makeInput({
    coordinate: { latitude: 0.0002, longitude: 0.005 },
    semantics: "event-point",
  });
  const dense = makeInput({
    segments: [[
      { latitude: 0, longitude: 0 },
      { latitude: 0, longitude: 0.0025 },
      { latitude: 0, longitude: 0.005 },
      { latitude: 0, longitude: 0.0075 },
      { latitude: 0, longitude: 0.01 },
    ]],
    coordinate: { latitude: 0.0002, longitude: 0.005 },
    semantics: "event-point",
  });
  assert.ok(Math.abs(result(sparse).position.distanceKm - result(dense).position.distanceKm) < 0.001);
});

test("spherical segment projection handles a short segment crossing the antimeridian", () => {
  const input = makeInput({
    segments: [[
      { latitude: 10, longitude: 179.99 },
      { latitude: 10, longitude: -179.99 },
    ]],
    coordinate: { latitude: 10, longitude: 180 },
    semantics: "route-point",
  });
  const matched = result(input);
  assert.equal(matched.state, "matched-verified");
  assert.ok(matched.offsetMeters < 2);
  assert.ok(Math.abs(matched.position.distanceKm - input.route.distanceKm / 2) < 1e-6);
});

test("event-point tolerance includes the exact boundary and excludes just outside", () => {
  const latitudeAtOffset = (meters) => meters / 111_195.08;
  const inside = makeInput({
    type: "AID_STATION",
    coordinate: { latitude: latitudeAtOffset(ROUTE_ANCHOR_MAX_EVENT_POINT_OFFSET_M - 0.1), longitude: 0.005 },
    semantics: "event-point",
  });
  const atBoundary = makeInput({
    type: "AID_STATION",
    coordinate: { latitude: latitudeAtOffset(ROUTE_ANCHOR_MAX_EVENT_POINT_OFFSET_M), longitude: 0.005 },
    semantics: "event-point",
  });
  const outside = makeInput({
    type: "AID_STATION",
    coordinate: { latitude: latitudeAtOffset(ROUTE_ANCHOR_MAX_EVENT_POINT_OFFSET_M + 0.1), longitude: 0.005 },
    semantics: "event-point",
  });
  assert.equal(result(inside).state, "matched-verified");
  assert.equal(result(atBoundary).state, "matched-verified");
  assert.equal(result(outside).state, "rejected");
});

test("route-point, feature-point, and place-reference thresholds have exact boundary cases", () => {
  const latitudeAt = (meters) => meters / 111_195.08;
  const routeInside = result(makeInput({ coordinate: { latitude: latitudeAt(29.9), longitude: 0.005 }, semantics: "route-point" }));
  const routeAt = result(makeInput({ coordinate: { latitude: latitudeAt(30), longitude: 0.005 }, semantics: "route-point" }));
  const routeOutside = result(makeInput({ coordinate: { latitude: latitudeAt(30.1), longitude: 0.005 }, semantics: "route-point" }));
  assert.equal(routeInside.state, "matched-verified");
  assert.equal(routeAt.state, "matched-verified");
  assert.equal(routeOutside.state, "rejected");

  const featureInside = result(makeInput({ type: "AID_STATION", coordinate: { latitude: latitudeAt(74.9), longitude: 0.005 }, semantics: "feature-point" }));
  const featureAt = result(makeInput({ type: "AID_STATION", coordinate: { latitude: latitudeAt(75), longitude: 0.005 }, semantics: "feature-point" }));
  const featureOutside = result(makeInput({ type: "AID_STATION", coordinate: { latitude: latitudeAt(75.1), longitude: 0.005 }, semantics: "feature-point" }));
  assert.equal(featureInside.state, "matched-verified");
  assert.equal(featureAt.state, "matched-verified");
  assert.equal(featureOutside.state, "rejected");

  const placeInside = result(makeInput({ coordinate: { latitude: latitudeAt(249.9), longitude: 0.005 }, semantics: "place-reference-point" }));
  const placeAt = result(makeInput({ coordinate: { latitude: latitudeAt(250), longitude: 0.005 }, semantics: "place-reference-point" }));
  const placeOutside = result(makeInput({ coordinate: { latitude: latitudeAt(250.1), longitude: 0.005 }, semantics: "place-reference-point" }));
  assert.equal(placeInside.state, "matched-approximate");
  assert.equal(placeAt.state, "matched-approximate");
  assert.equal(placeOutside.state, "rejected");
});

test("a source kilometer and coordinate reconcile only within the explicit 0.1 km policy", () => {
  const inside = result(makeInput({
    type: "AID_STATION", routeKm: 0.65,
    coordinate: { latitude: 0, longitude: 0.005 }, semantics: "event-point",
  }));
  const outside = result(makeInput({
    type: "AID_STATION", routeKm: 0.7,
    coordinate: { latitude: 0, longitude: 0.005 }, semantics: "event-point",
  }));
  assert.equal(inside.state, "matched-exact");
  assert.equal(outside.state, "conflicting");
});

test("malformed coordinate semantics fail input validation", () => {
  const input = makeInput({ coordinate: { latitude: 0, longitude: 0.005 }, semantics: "centroid" });
  assert.equal(validateRouteAnchorMatchInput(input).success, false);
});

test("matcher is generic for an arbitrary fictional race identity", () => {
  const input = makeInput({ coordinate: { latitude: 0, longitude: 0.005 }, semantics: "route-point" });
  input.context.raceId = "fictional-race-876";
  input.context.raceName = "Fictional Race";
  for (const evidence of input.evidence) evidence.raceId = input.context.raceId;
  const matched = result(input);
  assert.equal(matched.state, "matched-verified");
});

test("no position evidence yields a context-only anchor", () => {
  const matched = result(makeInput());
  assert.equal(matched.state, "context-only");
  assert.equal(matched.anchor.positionConfidence, "context-only");
  assert.equal(matched.anchor.position.type, "UNPOSITIONED");
});

test("analysis adapter preserves component identity and does not add gap distance", () => {
  const route = routeAnchorGeometryFromAnalysis("two-part", {
    segments: [
      {
        segmentIndex: 0, startDistanceM: 0, endDistanceM: 1000,
        points: [
          { latitude: 0, longitude: 0, elevationM: 0, distanceM: 0, segmentIndex: 0 },
          { latitude: 0, longitude: 0.0089932, elevationM: 1, distanceM: 1000, segmentIndex: 0 },
        ],
      },
      {
        segmentIndex: 1, startDistanceM: 1000, endDistanceM: 2000,
        points: [
          { latitude: 1, longitude: 1, elevationM: 100, distanceM: 1000, segmentIndex: 1 },
          { latitude: 1, longitude: 1.0089932, elevationM: 101, distanceM: 2000, segmentIndex: 1 },
        ],
      },
    ],
  });
  assert.equal(route.distanceKm, 2);
  assert.equal(route.bounds.components.length, 2);
  assert.equal(route.bounds.components[1].startKm, route.bounds.components[0].endKm);
  assert.equal(validateRouteAnchorMatchInput({
    ...makeInput(), route,
  }).success, true);
});
