import { z } from "zod";
import type { RouteAnalysisData } from "./gpxAnalysis.ts";
import { ROUTE_ANCHOR_MATCHING_ALGORITHM_VERSION } from "./routeAnchorMatchingVersion.ts";
export { ROUTE_ANCHOR_MATCHING_ALGORITHM_VERSION } from "./routeAnchorMatchingVersion.ts";
import {
  ROUTE_ANCHOR_EVIDENCE_SCHEMA_VERSION,
  ROUTE_ANCHOR_SCHEMA_VERSION,
  raceContextV1Schema,
  routeAnchorDatasetV1Schema,
  routeAnchorEvidenceV2Schema,
  routeAnchorOrderingConstraintSchema,
  routeAnchorRouteBoundsSchema,
  validateRouteAnchorDataset,
  type RouteAnchorCoordinateSemantics,
  type RouteAnchorDatasetV1,
  type RouteAnchorEvidenceV2,
  type RouteAnchorOrderingConstraint,
  type RouteAnchorPosition,
  type RouteAnchorType,
} from "./routeAnchors.ts";

export const ROUTE_ANCHOR_MATCH_POLICY_VERSION = 1 as const;
export const ROUTE_ANCHOR_PROJECTION_METHOD = "spherical-great-circle-segment-projection" as const;
export const ROUTE_ANCHOR_EARTH_RADIUS_M = 6_371_000;
export const ROUTE_ANCHOR_MAX_ROUTE_POINT_OFFSET_M = 30;
export const ROUTE_ANCHOR_MAX_EVENT_POINT_OFFSET_M = 100;
export const ROUTE_ANCHOR_MAX_FEATURE_POINT_OFFSET_M = 75;
export const ROUTE_ANCHOR_MAX_PLACE_REFERENCE_OFFSET_M = 250;
export const ROUTE_ANCHOR_POSITION_AGREEMENT_TOLERANCE_KM = 0.1;
const MAX_DIAGNOSTIC_PROJECTIONS = 8;

// Policy rationale: event coordinates represent a specific event point; route
// coordinates should lie close to mapped geometry; settlement references are
// deliberately approximate and use a wider cap without asserting visitation.
// These limits are generic evidence-policy values, not race-specific tuning.

export const ROUTE_ANCHOR_MATCH_STATES = [
  "matched-exact", "matched-verified", "matched-approximate", "context-only",
  "ambiguous", "conflicting", "rejected",
] as const;
export const ROUTE_ANCHOR_MATCH_METHODS = [
  "direct-route-km", "direct-route-coordinate", "curated-geographic-coordinate", "ordering-only", "none",
] as const;
export const ROUTE_ANCHOR_MATCH_REASON_CODES = [
  "matched-direct-km", "matched-endpoint-coordinate", "matched-route-projection",
  "insufficient-position-evidence", "untrusted-position-evidence", "previous-edition-only", "outside-match-tolerance",
  "ambiguous-route-visits", "component-ambiguous", "ordering-disambiguated",
  "conflicting-evidence", "endpoint-mismatch", "unsupported-coordinate-semantics",
] as const;

const componentIndexSchema = z.number().int().min(0).max(100_000);
const geometryPointSchema = z.object({
  latitude: z.number().finite().min(-90).max(90),
  longitude: z.number().finite().min(-180).max(180),
  componentIndex: componentIndexSchema,
  routePointIndex: z.number().int().min(0).max(10_000_000),
  distanceKm: z.number().finite().min(0).max(100_000),
}).strict();
const routeGeometrySchema = z.object({
  routeId: z.string().min(1).max(160),
  distanceKm: z.number().finite().min(0).max(100_000),
  bounds: routeAnchorRouteBoundsSchema,
  components: z.array(z.object({
    componentIndex: componentIndexSchema,
    points: z.array(geometryPointSchema).max(10_000_000),
  }).strict()).max(128),
}).strict();

export const routeAnchorMatchInputV1Schema = z.object({
  context: raceContextV1Schema,
  evidence: z.array(routeAnchorEvidenceV2Schema).max(20_000),
  route: routeGeometrySchema,
  orderingConstraints: z.array(routeAnchorOrderingConstraintSchema).max(20_000).default([]),
}).strict();

export type RouteAnchorMatchInputV1 = z.input<typeof routeAnchorMatchInputV1Schema>;
export type RouteAnchorMatchResultState = typeof ROUTE_ANCHOR_MATCH_STATES[number];
export type RouteAnchorMatchMethod = typeof ROUTE_ANCHOR_MATCH_METHODS[number];
export type RouteAnchorMatchReasonCode = typeof ROUTE_ANCHOR_MATCH_REASON_CODES[number];
export type RouteAnchorGeometryPoint = z.infer<typeof geometryPointSchema>;
export type RouteAnchorRouteGeometry = z.infer<typeof routeGeometrySchema>;

/** Adapts the exact cumulative positions emitted by GPX analysis; no gap edges are constructed. */
export function routeAnchorGeometryFromAnalysis(routeId: string, analysis: Pick<RouteAnalysisData, "segments">): RouteAnchorRouteGeometry {
  const components = analysis.segments.map((segment) => ({
    componentIndex: segment.segmentIndex,
    points: segment.points.map((point, routePointIndex) => ({
      latitude: point.latitude,
      longitude: point.longitude,
      componentIndex: point.segmentIndex,
      routePointIndex,
      distanceKm: point.distanceM / 1000,
    })),
  }));
  const bounds = {
    routeId,
    distanceKm: analysis.segments.at(-1)?.endDistanceM ? analysis.segments.at(-1)!.endDistanceM / 1000 : 0,
    components: analysis.segments.map((segment) => ({
      componentIndex: segment.segmentIndex,
      startKm: segment.startDistanceM / 1000,
      endKm: segment.endDistanceM / 1000,
      traversedDistanceKm: (segment.endDistanceM - segment.startDistanceM) / 1000,
    })),
  };
  return { routeId, distanceKm: bounds.distanceKm, bounds, components };
}

export type RouteAnchorProjectionCandidate = {
  componentIndex: number;
  distanceKm: number;
  offsetMeters: number;
  projectedCoordinate: { latitude: number; longitude: number };
  segmentStartPointIndex: number;
  segmentEndPointIndex: number;
};

export type RouteAnchorMatchResult = {
  contextLocationId: string;
  placeId: string;
  visitId: string | null;
  state: RouteAnchorMatchResultState;
  method: RouteAnchorMatchMethod;
  evidenceIds: string[];
  componentIndex: number | null;
  position: RouteAnchorPosition | null;
  offsetMeters: number | null;
  candidateProjections: RouteAnchorProjectionCandidate[];
  reasonCodes: RouteAnchorMatchReasonCode[];
  safeToMaterialize: boolean;
  positionSafe: boolean;
  positionConfidence: "exact-direct" | "verified-match" | "approximate" | "context-only" | "conflicting" | null;
  anchor: RouteAnchorDatasetV1["anchors"][number] | null;
};

export type RouteAnchorMatchingOutput = {
  algorithmVersion: typeof ROUTE_ANCHOR_MATCHING_ALGORITHM_VERSION;
  matchPolicyVersion: typeof ROUTE_ANCHOR_MATCH_POLICY_VERSION;
  dataset: RouteAnchorDatasetV1;
  results: RouteAnchorMatchResult[];
};

export type RouteAnchorMatchingValidationResult =
  | { success: true; data: z.output<typeof routeAnchorMatchInputV1Schema> }
  | { success: false; issues: Array<{ code: string; path: string }> };

type LinearPoint = RouteAnchorGeometryPoint;
type Candidate = RouteAnchorProjectionCandidate & { visitId: string; sourceEvidenceId: string; semantics: RouteAnchorCoordinateSemantics };
type Location = z.output<typeof raceContextV1Schema>["locations"][number];
type MatchDraft = {
  location: Location;
  state: RouteAnchorMatchResultState;
  method: RouteAnchorMatchMethod;
  evidenceIds: string[];
  componentIndex: number | null;
  position: RouteAnchorPosition | null;
  offsetMeters: number | null;
  candidates: Candidate[];
  reasonCodes: RouteAnchorMatchReasonCode[];
  confidence: RouteAnchorMatchResult["positionConfidence"];
  visitId: string | null;
  sourcePositionEvidence: Array<{ evidence: RouteAnchorEvidenceV2; position: RouteAnchorPosition; method: "route-km" | "coordinate"; offsetMeters: number | null }>;
};

function stableId(prefix: string, material: string): string {
  let first = 2_166_136_261;
  let second = 2_246_822_519;
  for (let index = 0; index < material.length; index += 1) {
    const code = material.charCodeAt(index);
    first = Math.imul(first ^ code, 16_777_619);
    second = Math.imul(second ^ code, 32_668_991);
  }
  return prefix + ":" + (first >>> 0).toString(16).padStart(8, "0") + (second >>> 0).toString(16).padStart(8, "0");
}

function haversineMeters(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }): number {
  const radians = (value: number) => value * Math.PI / 180;
  const dLat = radians(b.latitude - a.latitude);
  const rawDLon = b.longitude - a.longitude;
  const dLon = radians(((rawDLon + 540) % 360) - 180);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(radians(a.latitude)) * Math.cos(radians(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * ROUTE_ANCHOR_EARTH_RADIUS_M * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function normalizeLongitude(longitude: number): number {
  return ((longitude + 540) % 360) - 180;
}

type Vector3 = { x: number; y: number; z: number };

function toUnitVector(coordinate: { latitude: number; longitude: number }): Vector3 {
  const radians = (value: number) => value * Math.PI / 180;
  const latitude = radians(coordinate.latitude);
  const longitude = radians(coordinate.longitude);
  return { x: Math.cos(latitude) * Math.cos(longitude), y: Math.cos(latitude) * Math.sin(longitude), z: Math.sin(latitude) };
}

function dot(a: Vector3, b: Vector3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function cross(a: Vector3, b: Vector3): Vector3 {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}

function scale(vector: Vector3, amount: number): Vector3 {
  return { x: vector.x * amount, y: vector.y * amount, z: vector.z * amount };
}

function subtract(a: Vector3, b: Vector3): Vector3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function length(vector: Vector3): number {
  return Math.hypot(vector.x, vector.y, vector.z);
}

function normalized(vector: Vector3): Vector3 {
  const magnitude = length(vector);
  return magnitude === 0 ? vector : scale(vector, 1 / magnitude);
}

function angularDistance(a: Vector3, b: Vector3): number {
  return Math.atan2(length(cross(a, b)), Math.max(-1, Math.min(1, dot(a, b))));
}

function toCoordinate(vector: Vector3): { latitude: number; longitude: number } {
  return {
    latitude: Math.atan2(vector.z, Math.hypot(vector.x, vector.y)) * 180 / Math.PI,
    longitude: normalizeLongitude(Math.atan2(vector.y, vector.x) * 180 / Math.PI),
  };
}

function projectToSegment(
  coordinate: { latitude: number; longitude: number },
  start: LinearPoint,
  end: LinearPoint,
): RouteAnchorProjectionCandidate {
  const a = toUnitVector(start);
  const b = toUnitVector(end);
  const q = toUnitVector(coordinate);
  const arc = angularDistance(a, b);
  const normal = normalized(cross(a, b));
  const projected = normalized(subtract(q, scale(normal, dot(q, normal))));
  const alternatives = [projected, scale(projected, -1)];
  const onArc = alternatives.find((point) => Math.abs(angularDistance(a, point) + angularDistance(point, b) - arc) < 1e-7);
  let projectedVector: Vector3;
  let t: number;
  if (arc < 1e-12 || length(normal) < 1e-12 || !onArc) {
    const startOffset = angularDistance(q, a);
    const endOffset = angularDistance(q, b);
    t = startOffset <= endOffset ? 0 : 1;
    projectedVector = t === 0 ? a : b;
  } else {
    projectedVector = onArc;
    t = Math.max(0, Math.min(1, angularDistance(a, onArc) / arc));
  }
  const projectedCoordinate = toCoordinate(projectedVector);
  return {
    componentIndex: start.componentIndex,
    distanceKm: start.distanceKm + (end.distanceKm - start.distanceKm) * t,
    offsetMeters: haversineMeters(coordinate, projectedCoordinate),
    projectedCoordinate,
    segmentStartPointIndex: start.routePointIndex,
    segmentEndPointIndex: end.routePointIndex,
  };
}

function projectionCandidates(
  coordinate: { latitude: number; longitude: number },
  components: readonly { componentIndex: number; points: readonly LinearPoint[] }[],
  componentFilter?: number,
): RouteAnchorProjectionCandidate[] {
  const projections: RouteAnchorProjectionCandidate[] = [];
  for (const component of components) {
    if (componentFilter !== undefined && component.componentIndex !== componentFilter) continue;
    for (let index = 0; index + 1 < component.points.length; index += 1) {
      const start = component.points[index];
      const end = component.points[index + 1];
      if (haversineMeters(start, end) === 0) continue;
      projections.push(projectToSegment(coordinate, start, end));
    }
  }
  projections.sort((a, b) => a.componentIndex - b.componentIndex
    || a.segmentStartPointIndex - b.segmentStartPointIndex
    || a.offsetMeters - b.offsetMeters);
  const localMinima = projections.filter((candidate, index) => {
    const previous = projections[index - 1];
    const next = projections[index + 1];
    const previousOffset = previous?.componentIndex === candidate.componentIndex
      && previous.segmentEndPointIndex >= candidate.segmentStartPointIndex - 1
      ? previous.offsetMeters : Number.POSITIVE_INFINITY;
    const nextOffset = next?.componentIndex === candidate.componentIndex
      && next.segmentStartPointIndex <= candidate.segmentEndPointIndex + 1
      ? next.offsetMeters : Number.POSITIVE_INFINITY;
    return candidate.offsetMeters <= previousOffset + 1e-6 && candidate.offsetMeters <= nextOffset + 1e-6;
  });
  const distinctVisits: RouteAnchorProjectionCandidate[] = [];
  for (const candidate of localMinima) {
    const samePosition = distinctVisits.find((existing) => existing.componentIndex === candidate.componentIndex
      && Math.abs(existing.distanceKm - candidate.distanceKm) <= 1e-9);
    if (!samePosition) distinctVisits.push(candidate);
    else if (candidate.offsetMeters < samePosition.offsetMeters) {
      distinctVisits[distinctVisits.indexOf(samePosition)] = candidate;
    }
  }
  return distinctVisits.sort((a, b) => a.offsetMeters - b.offsetMeters
    || a.componentIndex - b.componentIndex || a.distanceKm - b.distanceKm);
}

function publicProjection(candidate: Candidate): RouteAnchorProjectionCandidate {
  return {
    componentIndex: candidate.componentIndex,
    distanceKm: candidate.distanceKm,
    offsetMeters: candidate.offsetMeters,
    projectedCoordinate: candidate.projectedCoordinate,
    segmentStartPointIndex: candidate.segmentStartPointIndex,
    segmentEndPointIndex: candidate.segmentEndPointIndex,
  };
}

function diagnosticProjections(candidates: readonly Candidate[]): RouteAnchorProjectionCandidate[] {
  return [...candidates]
    .sort((a, b) => a.offsetMeters - b.offsetMeters || a.componentIndex - b.componentIndex || a.distanceKm - b.distanceKm)
    .slice(0, MAX_DIAGNOSTIC_PROJECTIONS)
    .map(publicProjection);
}

function geometryIssues(route: RouteAnchorRouteGeometry): string[] {
  const issues: string[] = [];
  if (route.bounds.routeId !== route.routeId || Math.abs(route.bounds.distanceKm - route.distanceKm) > 1e-6) issues.push("route.identity-mismatch");
  if (route.components.length !== route.bounds.components.length) issues.push("route.component-count-mismatch");
  if (route.components.some((component, index) => component.componentIndex !== index)) issues.push("route.component-index-order");
  if (route.bounds.components.some((component, index) => component.componentIndex !== index)) issues.push("route.bounds-component-index-order");
  for (let index = 0; index < route.components.length; index += 1) {
    const geometry = route.components[index];
    const bounds = route.bounds.components[index];
    if (!bounds || geometry.componentIndex !== bounds.componentIndex) {
      issues.push("route.component-bounds-mismatch");
      continue;
    }
    const points = geometry.points;
    if (points.some((point, pointIndex) => point.componentIndex !== geometry.componentIndex || point.routePointIndex !== pointIndex)) {
      issues.push("route.point-identity-mismatch");
      continue;
    }
    if (points.some((point, pointIndex) => pointIndex > 0 && point.distanceKm < points[pointIndex - 1].distanceKm)) {
      issues.push("route.point-distance-order");
      continue;
    }
    if (points.length === 0) {
      if (bounds.traversedDistanceKm !== 0) issues.push("route.empty-component-distance");
      continue;
    }
    if (Math.abs(points[0].distanceKm - bounds.startKm) > 1e-6
      || Math.abs(points.at(-1)!.distanceKm - bounds.endKm) > 1e-6) issues.push("route.point-bounds-mismatch");
    for (let pointIndex = 1; pointIndex < points.length; pointIndex += 1) {
      const previous = points[pointIndex - 1];
      const point = points[pointIndex];
      const edgeKm = haversineMeters(previous, point) / 1000;
      if (Math.abs((point.distanceKm - previous.distanceKm) - edgeKm) > 0.002) issues.push("route.linear-reference-mismatch");
    }
  }
  for (let index = 1; index < route.bounds.components.length; index += 1) {
    if (Math.abs(route.bounds.components[index].startKm - route.bounds.components[index - 1].endKm) > 1e-6) {
      issues.push("route.component-distance-gap");
    }
  }
  for (const component of route.components) {
    for (let pointIndex = 1; pointIndex < component.points.length; pointIndex += 1) {
      if (Math.abs(Math.PI * ROUTE_ANCHOR_EARTH_RADIUS_M
        - haversineMeters(component.points[pointIndex - 1], component.points[pointIndex])) < 0.01) {
        issues.push("route.edge-antipodal-ambiguous");
      }
    }
  }
  if (route.bounds.components.length > 0 && Math.abs(route.bounds.components[0].startKm) > 1e-6) {
    issues.push("route.distance-must-start-at-zero");
  }
  if (Math.abs((route.bounds.components.at(-1)?.endKm ?? 0) - route.distanceKm) > 1e-6) issues.push("route.total-distance-mismatch");
  return [...new Set(issues)];
}

export function validateRouteAnchorMatchInput(value: unknown): RouteAnchorMatchingValidationResult {
  const parsed = routeAnchorMatchInputV1Schema.safeParse(value);
  if (!parsed.success) return {
    success: false,
    issues: parsed.error.issues.map((entry) => ({ code: "schema." + entry.code, path: entry.path.map(String).join(".") })),
  };
  const input = parsed.data;
  const issues = geometryIssues(input.route).map((code) => ({ code, path: "route" }));
  const base = validateRouteAnchorDataset({
    schemaVersion: ROUTE_ANCHOR_SCHEMA_VERSION,
    context: input.context,
    routeBounds: input.route.bounds,
    anchors: [],
    evidence: input.evidence,
    orderingConstraints: [],
  });
  if (!base.success) issues.push(...base.issues.map((entry) => ({ code: entry.code, path: entry.path })));
  const evidenceById = new Map(input.evidence.map((evidence) => [evidence.evidenceId, evidence]));
  const pairs = new Set<string>();
  for (const constraint of input.orderingConstraints) {
    const pair = constraint.beforeVisitId + "\u0000" + constraint.afterVisitId;
    if (pairs.has(pair)) issues.push({ code: "ordering.duplicate-edge", path: "orderingConstraints" });
    pairs.add(pair);
    if (constraint.beforeVisitId === constraint.afterVisitId) issues.push({ code: "ordering.self-reference", path: "orderingConstraints" });
    const supports = constraint.evidenceIds.map((id) => evidenceById.get(id));
    if (supports.some((evidence) => !evidence || evidence.evidenceKind !== "official-text-order"
      || evidence.orderingFact?.beforeVisitId !== constraint.beforeVisitId
      || evidence.orderingFact?.afterVisitId !== constraint.afterVisitId
      || evidence.provenance === "previous-edition")) {
      issues.push({ code: "ordering.unsupported-edge", path: "orderingConstraints" });
    }
  }
  return issues.length > 0 ? { success: false, issues } : { success: true, data: input };
}

function maximumOffset(semantics: RouteAnchorCoordinateSemantics): number {
  switch (semantics) {
    case "route-point": return ROUTE_ANCHOR_MAX_ROUTE_POINT_OFFSET_M;
    case "event-point": return ROUTE_ANCHOR_MAX_EVENT_POINT_OFFSET_M;
    case "feature-point": return ROUTE_ANCHOR_MAX_FEATURE_POINT_OFFSET_M;
    case "place-reference-point": return ROUTE_ANCHOR_MAX_PLACE_REFERENCE_OFFSET_M;
  }
}

function coordinateMethod(evidence: RouteAnchorEvidenceV2): RouteAnchorMatchMethod {
  return evidence.verificationMethod === "manual-curation" || evidence.evidenceKind === "curated-verification"
    ? "curated-geographic-coordinate"
    : evidence.evidenceKind === "official-map-or-coordinate" && evidence.provenance === "official"
      ? "direct-route-coordinate"
      : "curated-geographic-coordinate";
}

function directKmPosition(
  evidence: RouteAnchorEvidenceV2,
  route: RouteAnchorRouteGeometry,
): { position: RouteAnchorPosition | null; reason: RouteAnchorMatchReasonCode | null } {
  const fact = evidence.routeKmFact;
  if (evidence.provenance !== "official" || evidence.sourceId === null || evidence.sourceEditionYear !== null) {
    return { position: null, reason: null };
  }
  const directPosition = evidence.positionFact;
  if (directPosition?.type === "POINT") {
    const component = route.bounds.components.find((candidate) => candidate.componentIndex === directPosition.componentIndex);
    if (!component || directPosition.distanceKm < component.startKm - 1e-9
      || directPosition.distanceKm > component.endKm + 1e-9) {
      return { position: null, reason: "outside-match-tolerance" };
    }
    return {
      position: { type: "POINT", componentIndex: component.componentIndex, distanceKm: directPosition.distanceKm },
      reason: "matched-direct-km",
    };
  }
  if (!fact) return { position: null, reason: null };
  if (fact.distanceKm > route.distanceKm + 1e-9) return { position: null, reason: "outside-match-tolerance" };
  const possible = route.bounds.components.filter((component) => component.traversedDistanceKm > 0
    && fact.distanceKm >= component.startKm - 1e-9 && fact.distanceKm <= component.endKm + 1e-9
    && (fact.componentIndex === undefined || fact.componentIndex === component.componentIndex));
  if (possible.length !== 1) return { position: null, reason: possible.length > 1 ? "component-ambiguous" : "outside-match-tolerance" };
  return { position: { type: "POINT", componentIndex: possible[0].componentIndex, distanceKm: fact.distanceKm }, reason: "matched-direct-km" };
}

function orderCoordinateCandidates(
  candidates: Candidate[],
  visitId: string,
  constraints: readonly RouteAnchorOrderingConstraint[],
  fixed: ReadonlyMap<string, RouteAnchorPosition>,
): { candidates: Candidate[]; disambiguated: boolean } {
  const hasComparableFixedVisit = constraints.some((edge) => (edge.afterVisitId === visitId && fixed.has(edge.beforeVisitId))
    || (edge.beforeVisitId === visitId && fixed.has(edge.afterVisitId)));
  if (!hasComparableFixedVisit) return { candidates, disambiguated: false };
  const ordered = candidates.filter((candidate) => constraints.every((edge) => {
    const otherVisitId = edge.afterVisitId === visitId ? edge.beforeVisitId
      : edge.beforeVisitId === visitId ? edge.afterVisitId : null;
    if (!otherVisitId) return true;
    const other = fixed.get(otherVisitId);
    if (!other || other.type !== "POINT") return true;
    const candidateBefore = candidate.componentIndex < other.componentIndex
      || (candidate.componentIndex === other.componentIndex && candidate.distanceKm < other.distanceKm - 1e-9);
    const otherBefore = other.componentIndex < candidate.componentIndex
      || (other.componentIndex === candidate.componentIndex && other.distanceKm < candidate.distanceKm - 1e-9);
    return edge.afterVisitId === visitId ? otherBefore : candidateBefore;
  }));
  return { candidates: ordered, disambiguated: ordered.length === 1 && candidates.length > 1 };
}

function isPositionTrusted(evidence: RouteAnchorEvidenceV2): boolean {
  return (evidence.provenance === "official" || evidence.provenance === "gpx-derived")
    && evidence.sourceEditionYear === null
    && evidence.sourceId !== null;
}

function uniqueReasonCodes(codes: RouteAnchorMatchReasonCode[]): RouteAnchorMatchReasonCode[] {
  return [...new Set(codes)];
}

function projectForLocation(
  evidence: RouteAnchorEvidenceV2,
  location: Location,
  input: z.output<typeof routeAnchorMatchInputV1Schema>,
): Candidate[] {
  const fact = evidence.coordinateFact;
  if (!fact || !isPositionTrusted(evidence)) return [];
  if (fact.semantics === "place-reference-point" && location.type !== "NAMED_LOCATION") return [];
  return allCoordinateProjections(evidence, location, input)
    .filter((candidate) => candidate.offsetMeters <= maximumOffset(fact.semantics) + 1e-6)
    .filter((candidate) => {
      if (location.type === "START" || location.type === "FINISH") {
        const traversed = input.route.bounds.components.filter((component) => component.traversedDistanceKm > 0);
        const endpoint = location.type === "START" ? traversed[0] : traversed.at(-1);
        if (!endpoint || candidate.componentIndex !== endpoint.componentIndex) return false;
        return location.type === "START"
          ? Math.abs(candidate.distanceKm - endpoint.startKm) <= 1e-6
          : Math.abs(candidate.distanceKm - endpoint.endKm) <= 1e-6;
      }
      return true;
    });
}

function allCoordinateProjections(
  evidence: RouteAnchorEvidenceV2,
  location: Location,
  input: z.output<typeof routeAnchorMatchInputV1Schema>,
): Candidate[] {
  const fact = evidence.coordinateFact;
  if (!fact || !isPositionTrusted(evidence)) return [];
  return projectionCandidates(fact, input.route.components, fact.componentIndex).map((candidate) => ({
    ...candidate,
    visitId: evidence.visitId ?? stableId("visit", input.route.routeId + ":" + location.locationId),
    sourceEvidenceId: evidence.evidenceId,
    semantics: fact.semantics,
  }));
}

function addDerivedEvidence(
  source: RouteAnchorEvidenceV2,
  position: RouteAnchorPosition,
  method: "route-km" | "coordinate",
  offsetMeters: number | null,
  locationId: string,
): RouteAnchorEvidenceV2 {
  return {
    schemaVersion: ROUTE_ANCHOR_EVIDENCE_SCHEMA_VERSION,
    evidenceId: stableId("match", source.evidenceId + ":" + locationId + ":" + method),
    raceId: source.raceId,
    editionYear: source.editionYear,
    sourceEditionYear: source.sourceEditionYear,
    sourceId: source.sourceId,
    evidenceKind: method === "route-km" ? "official-structured-position" : "geographic-match",
    provenance: source.provenance,
    verificationMethod: method === "route-km" ? "structured-source" : "geographic-match",
    positionFact: position,
    ...(offsetMeters === null ? {} : { measuredOffsetM: offsetMeters }),
    matchingPolicyVersion: ROUTE_ANCHOR_MATCH_POLICY_VERSION,
    derivedFromEvidenceIds: [source.evidenceId],
    ...(source.coordinateFact === undefined ? {} : { coordinateFact: source.coordinateFact }),
    ...(source.routeKmFact === undefined ? {} : { routeKmFact: source.routeKmFact }),
  };
}

function confidenceForCoordinate(locationType: RouteAnchorType, semantics: RouteAnchorCoordinateSemantics): "verified-match" | "approximate" {
  if (semantics === "route-point") return "verified-match";
  if (semantics === "event-point" && locationType !== "NAMED_LOCATION") return "verified-match";
  if (semantics === "feature-point" && locationType === "AID_STATION") return "verified-match";
  return "approximate";
}

function fallbackDraft(
  location: Location,
  method: RouteAnchorMatchMethod,
  evidenceIds: string[],
  state: RouteAnchorMatchResultState,
  reasonCodes: RouteAnchorMatchReasonCode[],
  candidates: Candidate[] = [],
): MatchDraft {
  const nearest = [...candidates].sort((a, b) => a.offsetMeters - b.offsetMeters
    || a.componentIndex - b.componentIndex || a.distanceKm - b.distanceKm)[0];
  return {
    location, state, method, evidenceIds, componentIndex: nearest?.componentIndex ?? null, position: null, offsetMeters: nearest?.offsetMeters ?? null,
    candidates, reasonCodes: uniqueReasonCodes(reasonCodes), confidence: "context-only", visitId: null, sourcePositionEvidence: [],
  };
}

function comparePosition(a: RouteAnchorPosition, b: RouteAnchorPosition): boolean {
  return a.type === "POINT" && b.type === "POINT" && a.componentIndex === b.componentIndex
    && Math.abs(a.distanceKm - b.distanceKm) <= ROUTE_ANCHOR_POSITION_AGREEMENT_TOLERANCE_KM;
}

function matchOneLocation(
  location: Location,
  input: z.output<typeof routeAnchorMatchInputV1Schema>,
  fixedPositions: ReadonlyMap<string, RouteAnchorPosition>,
): MatchDraft {
  const evidenceById = new Map(input.evidence.map((evidence) => [evidence.evidenceId, evidence]));
  const linked = location.evidenceIds.map((id) => evidenceById.get(id))
    .filter((entry): entry is RouteAnchorEvidenceV2 => entry !== undefined)
    .sort((a, b) => a.evidenceId.localeCompare(b.evidenceId));
  const eligible = linked.filter(isPositionTrusted);
  const historicalPosition = linked.some((evidence) => evidence.provenance === "previous-edition"
    && (evidence.routeKmFact !== undefined || evidence.coordinateFact !== undefined || evidence.positionFact !== undefined));
  const directEvidence = eligible.filter((evidence) => (evidence.routeKmFact !== undefined || evidence.positionFact?.type === "POINT")
    && evidence.evidenceKind === "official-structured-position");
  const directPositions = directEvidence.map((evidence) => ({ evidence, ...directKmPosition(evidence, input.route) }));
  const coordinateEvidence = eligible.filter((evidence) => evidence.coordinateFact !== undefined);
  const rawCandidates = coordinateEvidence.flatMap((evidence) => projectForLocation(evidence, location, input));
  const allCoordinateCandidates = coordinateEvidence.flatMap((evidence) => allCoordinateProjections(evidence, location, input));
  const allowedEvidence = coordinateEvidence.filter((evidence) => projectForLocation(evidence, location, input).length > 0);
  const outsideCoordinate = coordinateEvidence.length > 0 && rawCandidates.length === 0;
  let directInvalid = directPositions.find((item) => item.position === null && item.reason !== null);
  const directValid = directPositions.filter((item): item is typeof item & { position: RouteAnchorPosition } => item.position !== null);
  if (directInvalid?.reason === "component-ambiguous" && directInvalid.evidence.routeKmFact) {
    const kilometer = directInvalid.evidence.routeKmFact.distanceKm;
    const supportedComponents = new Set(rawCandidates.flatMap((candidate) => {
      const source = coordinateEvidence.find((entry) => entry.evidenceId === candidate.sourceEvidenceId);
      if (!source?.coordinateFact || !["route-point", "event-point"].includes(source.coordinateFact.semantics)) return [];
      return Math.abs(candidate.distanceKm - kilometer) <= ROUTE_ANCHOR_POSITION_AGREEMENT_TOLERANCE_KM
        ? [candidate.componentIndex]
        : [];
    }));
    if (supportedComponents.size === 1) {
      const componentIndex = [...supportedComponents][0];
      directValid.push({
        evidence: directInvalid.evidence,
        position: { type: "POINT", componentIndex, distanceKm: kilometer },
        reason: "matched-direct-km",
      });
      directInvalid = undefined;
    }
  }
  const uniqueDirect = directValid.filter((entry, index, all) => all.findIndex((candidate) => comparePosition(candidate.position, entry.position)) === index);

  if (directInvalid) {
    const state = directInvalid.reason === "component-ambiguous" ? "ambiguous" : "rejected";
    const reasons: RouteAnchorMatchReasonCode[] = directInvalid.reason
      ? [directInvalid.reason]
      : ["insufficient-position-evidence"];
    return fallbackDraft(location, "direct-route-km", linked.map((entry) => entry.evidenceId), state, reasons, allCoordinateCandidates);
  }
  if (uniqueDirect.length > 1) {
    return fallbackDraft(location, "direct-route-km", linked.map((entry) => entry.evidenceId), "conflicting", ["conflicting-evidence"], allCoordinateCandidates);
  }
  const direct = uniqueDirect[0];
  if (direct && (location.type === "START" || location.type === "FINISH")) {
    const traversed = input.route.bounds.components.filter((component) => component.traversedDistanceKm > 0);
    const endpoint = location.type === "START" ? traversed[0] : traversed.at(-1);
    const isEndpoint = !!endpoint && direct.position.type === "POINT"
      && direct.position.componentIndex === endpoint.componentIndex
      && Math.abs(direct.position.distanceKm - (location.type === "START" ? endpoint.startKm : endpoint.endKm)) <= 1e-6;
    if (!isEndpoint) {
      return fallbackDraft(location, "direct-route-km", linked.map((entry) => entry.evidenceId), "conflicting", ["endpoint-mismatch"]);
    }
  }

  if ((location.type === "START" || location.type === "FINISH") && coordinateEvidence.length > 0) {
    const endpointCandidates = rawCandidates;
    const maxOffsetByEvidence = new Map(coordinateEvidence.map((evidence) => [
      evidence.evidenceId,
      evidence.coordinateFact ? maximumOffset(evidence.coordinateFact.semantics) : 0,
    ]));
    const allRouteCandidates = allCoordinateCandidates.filter((candidate) =>
      candidate.offsetMeters <= (maxOffsetByEvidence.get(candidate.sourceEvidenceId) ?? 0) + 1e-6);
    if (endpointCandidates.length === 0 && allRouteCandidates.length > 0) {
      return fallbackDraft(location, coordinateMethod(coordinateEvidence[0]), linked.map((entry) => entry.evidenceId), "conflicting",
        ["endpoint-mismatch"], rawCandidates);
    }
  }
  if (direct && rawCandidates.some((candidate) => !comparePosition(direct.position, {
    type: "POINT", componentIndex: candidate.componentIndex, distanceKm: candidate.distanceKm,
  }))) {
    return fallbackDraft(location, "direct-route-km", linked.map((entry) => entry.evidenceId), "conflicting", ["conflicting-evidence"], rawCandidates);
  }
  if (outsideCoordinate && direct) {
    return fallbackDraft(location, "direct-route-km", linked.map((entry) => entry.evidenceId), "conflicting",
      ["conflicting-evidence"], allCoordinateCandidates);
  }
  if (direct) {
    const supportingCoordinateEvidence = rawCandidates.flatMap((candidate) => {
      const evidence = coordinateEvidence.find((entry) => entry.evidenceId === candidate.sourceEvidenceId);
      if (!evidence || !comparePosition(direct.position, {
        type: "POINT", componentIndex: candidate.componentIndex, distanceKm: candidate.distanceKm,
      })) return [];
      return [{ evidence, position: direct.position, method: "coordinate" as const, offsetMeters: candidate.offsetMeters }];
    });
    return {
      location, state: "matched-exact", method: "direct-route-km", evidenceIds: linked.map((entry) => entry.evidenceId),
      componentIndex: direct.position.type === "POINT" ? direct.position.componentIndex : null,
      position: direct.position, offsetMeters: supportingCoordinateEvidence[0]?.offsetMeters ?? null,
      candidates: rawCandidates, reasonCodes: ["matched-direct-km"],
      confidence: "exact-direct", visitId: direct.evidence.visitId ?? stableId("visit", input.route.routeId + ":" + location.locationId),
      sourcePositionEvidence: [
        { evidence: direct.evidence, position: direct.position, method: "route-km" as const, offsetMeters: null },
        ...supportingCoordinateEvidence,
      ],
    };
  }
  if (coordinateEvidence.length === 0) {
    const ordering = linked.some((evidence) => evidence.evidenceKind === "official-text-order");
    const untrustedPosition = linked.some((evidence) => !isPositionTrusted(evidence)
      && (evidence.coordinateFact !== undefined || evidence.routeKmFact !== undefined || evidence.positionFact !== undefined));
    return fallbackDraft(location, ordering ? "ordering-only" : "none", linked.map((entry) => entry.evidenceId), "context-only",
      historicalPosition ? ["previous-edition-only"] : untrustedPosition ? ["untrusted-position-evidence"] : ["insufficient-position-evidence"]);
  }
  if (rawCandidates.length === 0) {
    const unsupported = eligible.some((evidence) => evidence.coordinateFact?.semantics === "place-reference-point" && location.type !== "NAMED_LOCATION");
    return fallbackDraft(location, coordinateMethod(coordinateEvidence[0]), linked.map((entry) => entry.evidenceId), "rejected",
      historicalPosition ? ["previous-edition-only"] : unsupported ? ["unsupported-coordinate-semantics"] : ["outside-match-tolerance"],
      allCoordinateCandidates);
  }
  const uniqueEvidencePositions = coordinateEvidence
    .map((evidence) => projectForLocation(evidence, location, input))
    .filter((candidates) => candidates.length === 1)
    .map((candidates) => candidates[0]);
  if (uniqueEvidencePositions.some((candidate, index) => uniqueEvidencePositions
    .slice(index + 1)
    .some((other) => !comparePosition(
      { type: "POINT", componentIndex: candidate.componentIndex, distanceKm: candidate.distanceKm },
      { type: "POINT", componentIndex: other.componentIndex, distanceKm: other.distanceKm },
    )))) {
    return fallbackDraft(location, coordinateMethod(coordinateEvidence[0]), linked.map((entry) => entry.evidenceId), "conflicting",
      ["conflicting-evidence"], rawCandidates);
  }
  const visitIds = new Set(rawCandidates.map((candidate) => candidate.visitId));
  if (visitIds.size > 1) {
    return fallbackDraft(location, coordinateMethod(coordinateEvidence[0]), linked.map((entry) => entry.evidenceId), "ambiguous",
      ["ambiguous-route-visits"], rawCandidates);
  }
  const visitId = rawCandidates[0].visitId;
  const ordered = orderCoordinateCandidates(rawCandidates, visitId, input.orderingConstraints, fixedPositions);
  if (ordered.candidates.length === 0) {
    return fallbackDraft(location, coordinateMethod(coordinateEvidence[0]), linked.map((entry) => entry.evidenceId), "conflicting",
      ["conflicting-evidence"], rawCandidates);
  }
  if (ordered.candidates.length > 1) {
    return fallbackDraft(location, coordinateMethod(coordinateEvidence[0]), linked.map((entry) => entry.evidenceId), "ambiguous",
      ["ambiguous-route-visits"], ordered.candidates);
  }
  const selected = ordered.candidates[0];
  const otherBest = rawCandidates.filter((candidate) => candidate.sourceEvidenceId !== selected.sourceEvidenceId);
  if (otherBest.some((candidate) => !comparePosition({
    type: "POINT", componentIndex: selected.componentIndex, distanceKm: selected.distanceKm,
  }, {
    type: "POINT", componentIndex: candidate.componentIndex, distanceKm: candidate.distanceKm,
  }))) {
    return fallbackDraft(location, coordinateMethod(coordinateEvidence[0]), linked.map((entry) => entry.evidenceId), "conflicting",
      ["conflicting-evidence"], rawCandidates);
  }
  const position: RouteAnchorPosition = { type: "POINT", componentIndex: selected.componentIndex, distanceKm: selected.distanceKm };
  const confidence = confidenceForCoordinate(location.type, selected.semantics);
  return {
    location,
    state: confidence === "verified-match" ? "matched-verified" : "matched-approximate",
    method: coordinateMethod(coordinateEvidence.find((evidence) => evidence.evidenceId === selected.sourceEvidenceId)!),
    evidenceIds: linked.map((entry) => entry.evidenceId), componentIndex: selected.componentIndex, position,
    offsetMeters: selected.offsetMeters, candidates: rawCandidates,
    reasonCodes: uniqueReasonCodes([
      location.type === "START" || location.type === "FINISH" ? "matched-endpoint-coordinate" : "matched-route-projection",
      ...(ordered.disambiguated ? ["ordering-disambiguated" as const] : []),
    ]),
    confidence, visitId,
    sourcePositionEvidence: allowedEvidence.flatMap((evidence) => {
      const supportsSelected = projectForLocation(evidence, location, input).some((candidate) => candidate.visitId === selected.visitId
        && comparePosition(position, { type: "POINT", componentIndex: candidate.componentIndex, distanceKm: candidate.distanceKm }));
      return supportsSelected ? [{ evidence, position, method: "coordinate" as const, offsetMeters: selected.offsetMeters }] : [];
    }),
  };
}

export function matchRouteAnchors(value: unknown): RouteAnchorMatchingOutput {
  const validation = validateRouteAnchorMatchInput(value);
  if (!validation.success) throw new TypeError("Invalid Route Anchor match input: " + validation.issues.map((entry) => entry.code).join(", "));
  const input = validation.data;
  const independentlyMatched = input.context.locations.map((location) => matchOneLocation(location, input, new Map()))
    .filter((draft) => (draft.state === "matched-exact" || draft.state === "matched-verified" || draft.state === "matched-approximate")
      && draft.visitId !== null && draft.position !== null);
  const fixedPositions = new Map(independentlyMatched.map((draft) => [draft.visitId!, draft.position!]));
  const drafts = input.context.locations.map((location) => matchOneLocation(location, input, fixedPositions));
  const evidence = [...input.evidence].sort((a, b) => a.evidenceId.localeCompare(b.evidenceId));
  const anchors: RouteAnchorDatasetV1["anchors"] = [];
  const results: RouteAnchorMatchResult[] = [];

  for (const draft of drafts) {
    if (draft.state === "conflicting") {
      results.push({
        contextLocationId: draft.location.locationId, placeId: draft.location.placeId, visitId: null,
        state: draft.state, method: draft.method, evidenceIds: draft.evidenceIds, componentIndex: draft.componentIndex,
        position: null, offsetMeters: draft.offsetMeters,
        candidateProjections: diagnosticProjections(draft.candidates),
        reasonCodes: draft.reasonCodes, safeToMaterialize: false, positionSafe: false, positionConfidence: "conflicting", anchor: null,
      });
      continue;
    }
    let position = draft.position;
    let confidence = draft.confidence ?? "context-only";
    let visitId = draft.visitId;
    const derivedEvidenceIds: string[] = [];
    if (position && confidence !== "context-only") {
      for (const source of draft.sourcePositionEvidence) {
        const derived = addDerivedEvidence(source.evidence, source.position, source.method, source.offsetMeters, draft.location.locationId);
        evidence.push(derived);
        derivedEvidenceIds.push(derived.evidenceId);
      }
    } else {
      position = { type: "UNPOSITIONED" };
      confidence = "context-only";
      visitId = null;
    }
    const anchor: RouteAnchorDatasetV1["anchors"][number] = {
      schemaVersion: ROUTE_ANCHOR_SCHEMA_VERSION,
      anchorId: stableId("anchor", input.route.routeId + ":" + input.context.raceId + ":" + input.context.editionYear + ":" + draft.location.locationId),
      raceId: input.context.raceId,
      editionYear: input.context.editionYear,
      contextLocationId: draft.location.locationId,
      placeId: draft.location.placeId,
      visitId,
      type: draft.location.type,
      position,
      positionConfidence: confidence,
      evidenceIds: [...new Set([...draft.location.evidenceIds, ...derivedEvidenceIds])],
    };
    anchors.push(anchor);
    results.push({
      contextLocationId: draft.location.locationId,
      placeId: draft.location.placeId,
      visitId,
      state: draft.state,
      method: draft.method,
      evidenceIds: anchor.evidenceIds,
      componentIndex: position.type === "POINT" || position.type === "RANGE" ? position.componentIndex : null,
      position,
      offsetMeters: draft.offsetMeters,
      candidateProjections: diagnosticProjections(draft.candidates),
      reasonCodes: draft.reasonCodes,
      safeToMaterialize: true,
      positionSafe: confidence === "exact-direct" || confidence === "verified-match",
      positionConfidence: confidence,
      anchor,
    });
  }

  const positionedVisits = new Set(anchors.flatMap((anchor) => anchor.visitId === null ? [] : [anchor.visitId]));
  const orderingConstraints = input.orderingConstraints.filter((constraint) => positionedVisits.has(constraint.beforeVisitId)
    && positionedVisits.has(constraint.afterVisitId));
  const dataset = {
    schemaVersion: ROUTE_ANCHOR_SCHEMA_VERSION,
    context: input.context,
    routeBounds: input.route.bounds,
    anchors,
    evidence,
    orderingConstraints,
  } satisfies RouteAnchorDatasetV1;
  const finalValidation = validateRouteAnchorDataset(dataset);
  if (!finalValidation.success) {
    throw new TypeError("Invalid materialized Route Anchor dataset: " + finalValidation.issues.map((entry) => entry.code).join(", "));
  }
  const finalSchema = routeAnchorDatasetV1Schema.safeParse(finalValidation.data);
  if (!finalSchema.success) throw new TypeError("Materialized Route Anchor dataset failed output validation.");
  return {
    algorithmVersion: ROUTE_ANCHOR_MATCHING_ALGORITHM_VERSION,
    matchPolicyVersion: ROUTE_ANCHOR_MATCH_POLICY_VERSION,
    dataset: finalSchema.data,
    results,
  };
}
