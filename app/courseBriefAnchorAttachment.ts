import { z } from "zod";
import {
  COURSE_BRIEF_CANDIDATE_ALGORITHM_VERSION,
  COURSE_BRIEF_OUTPUT_V2_SCHEMA_VERSION,
  renderCourseBriefV2,
  selectCourseBriefCandidates,
  validateCourseBriefCandidatePool,
  type CourseBriefCandidate,
  type CourseBriefOutputV2,
} from "./courseBriefCandidates.ts";
import {
  buildCourseBriefInputV2,
  validateCourseBriefInputV2,
  type CourseBriefInputV2,
  type CourseBriefNarrativeSource,
} from "./courseBriefNarrativeFacts.ts";
import { createAnalysisInputFingerprint, ANALYSIS_INPUT_FINGERPRINT_VERSION } from "./analysisInputFingerprint.ts";
import { ROUTE_FINGERPRINT_VERSION, createRouteFingerprint } from "./routeFingerprint.ts";
import type { RouteAnalysisData } from "./gpxAnalysis.ts";
import {
  ROUTE_ANCHOR_POSITION_CONFIDENCE,
  routeAnchorDatasetV1Schema,
  validateRouteAnchorDataset,
  type RouteAnchorPosition,
  type RouteAnchorEvidenceV2,
  type RouteAnchorV1,
} from "./routeAnchors.ts";
import {
  ROUTE_ANCHOR_MATCHING_ALGORITHM_VERSION,
  ROUTE_ANCHOR_MATCH_POLICY_VERSION,
  ROUTE_ANCHOR_MATCH_STATES,
  routeAnchorGeometryFromAnalysis,
  ROUTE_ANCHOR_MATCH_REASON_CODES,
  type RouteAnchorMatchReasonCode,
  type RouteAnchorMatchingOutput,
} from "./routeAnchorMatching.ts";

export const COURSE_BRIEF_ANCHOR_ATTACHMENT_VERSION = 1 as const;
export const COURSE_BRIEF_ANCHOR_ATTACHMENT_SCHEMA_VERSION = 1 as const;
export const COURSE_BRIEF_ANCHOR_ATTACHMENT_MAX_DIAGNOSTICS = 256 as const;

export const COURSE_BRIEF_ANCHOR_ROLES = ["START", "FINISH", "ENTRY", "EXIT", "TRANSITION", "INTERNAL"] as const;
export type CourseBriefAnchorRole = typeof COURSE_BRIEF_ANCHOR_ROLES[number];
export type CourseBriefAnchorDiagnosticCode =
  | "approximate-excluded"
  | "context-only"
  | "conflicting-excluded"
  | "ambiguous-match-excluded"
  | "rejected-match-excluded"
  | "no-observation-owner"
  | "uncertain-observation-boundary"
  | "ambiguous-observation-owner"
  | "equal-priority-anchors"
  | "lower-priority-anchor";

const idSchema = z.string().min(1).max(600);
const kmSchema = z.number().finite().min(0).max(100_000);
const componentSchema = z.object({
  segmentIndex: z.number().int().min(0).max(127),
  startKm: kmSchema,
  endKm: kmSchema,
  traversedDistanceKm: kmSchema,
}).strict();

/** Derived from the same RouteAnalysisData used to build CourseBriefInputV2 and matching geometry. */
export type CourseBriefAnchorRouteBindingV1 = {
  routeId: string;
  routeFingerprint: string;
  routeFingerprintVersion: typeof ROUTE_FINGERPRINT_VERSION;
  analysisInputFingerprint: string;
  analysisInputFingerprintVersion: typeof ANALYSIS_INPUT_FINGERPRINT_VERSION;
  distanceKm: number;
  components: Array<z.infer<typeof componentSchema>>;
};

export type CourseBriefAnchorAttachmentSource = {
  evidenceId: string;
  sourceId: string | null;
  provenance: RouteAnchorEvidenceV2["provenance"];
  sourceEditionYear: number | null;
  evidenceKind: RouteAnchorEvidenceV2["evidenceKind"];
  verificationMethod: RouteAnchorEvidenceV2["verificationMethod"];
};

export type CourseBriefAnchorAttachment = {
  attachmentId: string;
  candidateId: string;
  observationId: string;
  anchorId: string;
  contextLocationId: string;
  placeId: string;
  visitId: string;
  anchorType: RouteAnchorV1["type"];
  componentIndex: number;
  position: Extract<RouteAnchorPosition, { type: "POINT" | "RANGE" }>;
  positionConfidence: "exact-direct" | "verified-match";
  evidenceIds: string[];
  sources: CourseBriefAnchorAttachmentSource[];
  measuredOffsetM: number | null;
  role: CourseBriefAnchorRole;
};

export type CourseBriefAnchorRenderTokenV1 = {
  kind: "route-anchor";
  attachmentId: string;
  candidateId: string;
  observationId: string;
  contextLocationId: string;
  role: CourseBriefAnchorRole;
};

export type CourseBriefAnchorAttachmentDiagnostic = {
  code: CourseBriefAnchorDiagnosticCode;
  contextLocationId: string;
  anchorId: string | null;
  visitId: string | null;
  matchState: RouteAnchorMatchingOutput["results"][number]["state"];
  reasonCodes: RouteAnchorMatchReasonCode[];
  evidenceIds: string[];
  candidateIds: string[];
  role: "CONTEXT_ONLY" | null;
};

export type CourseBriefAnchorAttachmentV1 = {
  schemaVersion: typeof COURSE_BRIEF_ANCHOR_ATTACHMENT_SCHEMA_VERSION;
  algorithmVersion: typeof COURSE_BRIEF_ANCHOR_ATTACHMENT_VERSION;
  candidateAlgorithmVersion: typeof COURSE_BRIEF_CANDIDATE_ALGORITHM_VERSION;
  courseBriefOutputSchemaVersion: typeof COURSE_BRIEF_OUTPUT_V2_SCHEMA_VERSION;
  matchingAlgorithmVersion: typeof ROUTE_ANCHOR_MATCHING_ALGORITHM_VERSION;
  matchPolicyVersion: typeof ROUTE_ANCHOR_MATCH_POLICY_VERSION;
  routeBinding: CourseBriefAnchorRouteBindingV1;
  attachments: CourseBriefAnchorAttachment[];
  renderTokens: CourseBriefAnchorRenderTokenV1[];
  diagnostics: { items: CourseBriefAnchorAttachmentDiagnostic[]; omittedCount: number };
};

export type CourseBriefAnchorAttachmentInput = {
  courseBriefInput: unknown;
  candidatePool: unknown;
  selection: unknown;
  courseBriefOutput: unknown;
  routeAnalysis: RouteAnalysisData;
  routeBinding: unknown;
  matchingOutput: unknown;
};

export type CourseBriefAnchorAttachmentResult =
  | { ok: true; attachment: CourseBriefAnchorAttachmentV1 }
  | {
      ok: false;
      error:
        | "invalid_course_brief_input"
        | "invalid_candidate_pool"
        | "selection_mismatch"
        | "output_mismatch"
        | "route_identity_mismatch"
        | "route_bounds_mismatch"
        | "invalid_matching_output";
    };

const routeBindingSchema = z.object({
  routeId: idSchema,
  routeFingerprint: z.string().min(1).max(160),
  routeFingerprintVersion: z.literal(ROUTE_FINGERPRINT_VERSION),
  analysisInputFingerprint: z.string().min(1).max(160),
  analysisInputFingerprintVersion: z.literal(ANALYSIS_INPUT_FINGERPRINT_VERSION),
  distanceKm: kmSchema,
  components: z.array(componentSchema).min(1).max(128),
}).strict();

const matchProjectionSchema = z.object({
  componentIndex: z.number().int().min(0).max(127),
  distanceKm: kmSchema,
  offsetMeters: z.number().finite().min(0).max(1_000_000),
  projectedCoordinate: z.object({
    latitude: z.number().finite().min(-90).max(90),
    longitude: z.number().finite().min(-180).max(180),
  }).strict(),
  segmentStartPointIndex: z.number().int().min(0),
  segmentEndPointIndex: z.number().int().min(0),
}).strict();

const matchResultSchema = z.object({
  contextLocationId: idSchema,
  placeId: idSchema,
  visitId: idSchema.nullable(),
  state: z.enum(ROUTE_ANCHOR_MATCH_STATES),
  method: z.enum(["direct-route-km", "direct-route-coordinate", "curated-geographic-coordinate", "ordering-only", "none"]),
  evidenceIds: z.array(idSchema).max(64),
  componentIndex: z.number().int().min(0).max(127).nullable(),
  position: z.unknown().nullable(),
  offsetMeters: z.number().finite().min(0).max(1_000_000).nullable(),
  candidateProjections: z.array(matchProjectionSchema).max(8),
  reasonCodes: z.array(z.enum(ROUTE_ANCHOR_MATCH_REASON_CODES)).max(64),
  safeToMaterialize: z.boolean(),
  positionSafe: z.boolean(),
  positionConfidence: z.enum(ROUTE_ANCHOR_POSITION_CONFIDENCE).nullable(),
  anchor: z.unknown().nullable(),
}).strict();

const matchingOutputSchema = z.object({
  algorithmVersion: z.literal(ROUTE_ANCHOR_MATCHING_ALGORITHM_VERSION),
  matchPolicyVersion: z.literal(ROUTE_ANCHOR_MATCH_POLICY_VERSION),
  dataset: z.unknown(),
  results: z.array(matchResultSchema).max(10_000),
}).strict();

export type CourseBriefAnchorObservationWindow = {
  candidateId: string;
  componentIndex: number;
  startKm: number;
  endKm: number;
  transitionBoundaryKms: readonly number[];
};

export type CourseBriefAnchorOwnershipPosition =
  | { type: "POINT"; componentIndex: number; distanceKm: number; anchorType: RouteAnchorV1["type"] }
  | { type: "RANGE"; componentIndex: number; startKm: number; endKm: number; anchorType: RouteAnchorV1["type"] };

type BoundaryResolution = { status: "resolved"; distanceKm: number } | { status: "unresolved" };

function roundKm(value: number): number {
  return Number(value.toFixed(2));
}

/** Recover rounded V2 boundary values only from exact GPX positions retained by RouteAnalysisData. */
export function resolveFullPrecisionCourseBriefBoundary(
  routeAnalysis: RouteAnalysisData,
  componentIndex: number,
  roundedKm: number,
  side: "start" | "end",
  componentBounds: readonly CourseBriefAnchorRouteBindingV1["components"][number][],
): BoundaryResolution {
  const component = componentBounds.find((bound) => bound.segmentIndex === componentIndex);
  if (!component) return { status: "unresolved" };
  const exactPositions = new Set<number>();
  let requestedSideFound = false;
  for (const section of routeAnalysis.routeSections) {
    if (section.segmentIndex !== componentIndex) continue;
    const endpoints = [
      { side: "start" as const, rounded: section.startKm, position: section.startPosition },
      { side: "end" as const, rounded: section.endKm, position: section.endPosition },
    ];
    for (const endpoint of endpoints) {
      if (endpoint.position.segmentIndex !== componentIndex || endpoint.rounded !== roundedKm
        || !Number.isFinite(endpoint.position.distanceM) || endpoint.position.distanceM < 0) continue;
      if (endpoint.side === side) requestedSideFound = true;
      const distanceKm = endpoint.position.distanceM / 1000;
      if (roundKm(distanceKm) !== roundedKm || distanceKm < component.startKm - 1e-9 || distanceKm > component.endKm + 1e-9) continue;
      exactPositions.add(distanceKm);
    }
  }
  return requestedSideFound && exactPositions.size === 1
    ? { status: "resolved", distanceKm: [...exactPositions][0] }
    : { status: "unresolved" };
}

type AttachableRouteAnchor = Omit<RouteAnchorV1, "visitId" | "position" | "positionConfidence"> & {
  visitId: string;
  position: Extract<RouteAnchorPosition, { type: "POINT" | "RANGE" }>;
  positionConfidence: "exact-direct" | "verified-match";
};

export type CourseBriefAnchorOwnershipResult =
  | { status: "owned"; candidateId: string; role: CourseBriefAnchorRole }
  | { status: "unowned" }
  | { status: "ambiguous"; candidateIds: string[] };

/** Pure ownership rule exposed so boundary/overlap policy can be tested independently of the canonical V2 builder. */
export function resolveCourseBriefAnchorOwnership(
  windows: readonly CourseBriefAnchorObservationWindow[],
  position: CourseBriefAnchorOwnershipPosition,
  finalComponentEnds: ReadonlyMap<number, number>,
): CourseBriefAnchorOwnershipResult {
  const candidates = windows.filter((window) => {
    if (window.componentIndex !== position.componentIndex) return false;
    if (position.type === "RANGE") {
      return position.startKm >= window.startKm && position.endKm <= window.endKm && position.endKm > position.startKm;
    }
    if (position.anchorType === "START" && position.distanceKm !== window.startKm) return false;
    if (position.distanceKm >= window.startKm && position.distanceKm < window.endKm) return true;
    const finalEnd = finalComponentEnds.get(window.componentIndex);
    return position.anchorType === "FINISH" && finalEnd !== undefined
      && position.distanceKm === finalEnd && window.endKm === finalEnd;
  });
  if (candidates.length === 0) return { status: "unowned" };

  if (position.type === "POINT") {
    const transitionOwners = candidates.filter((window) => window.transitionBoundaryKms.includes(position.distanceKm));
    if (transitionOwners.length === 1) {
      return { status: "owned", candidateId: transitionOwners[0].candidateId, role: "TRANSITION" };
    }
    if (transitionOwners.length > 1) return { status: "ambiguous", candidateIds: transitionOwners.map(({ candidateId }) => candidateId).sort() };
  }
  if (candidates.length > 1) return { status: "ambiguous", candidateIds: candidates.map(({ candidateId }) => candidateId).sort() };

  const owner = candidates[0];
  if (position.anchorType === "START") return { status: "owned", candidateId: owner.candidateId, role: "START" };
  if (position.anchorType === "FINISH") return { status: "owned", candidateId: owner.candidateId, role: "FINISH" };
  if (position.type === "POINT") {
    return {
      status: "owned",
      candidateId: owner.candidateId,
      role: position.distanceKm === owner.startKm ? "ENTRY" : "INTERNAL",
    };
  }
  if (position.startKm === owner.startKm && position.endKm < owner.endKm) {
    return { status: "owned", candidateId: owner.candidateId, role: "ENTRY" };
  }
  if (position.endKm === owner.endKm && position.startKm > owner.startKm) {
    return { status: "owned", candidateId: owner.candidateId, role: "EXIT" };
  }
  return { status: "owned", candidateId: owner.candidateId, role: "INTERNAL" };
}

function stableValue(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return `[${value.map(stableValue).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableValue(record[key])}`).join(",")}}`;
}

function sameValue(left: unknown, right: unknown): boolean {
  return stableValue(left) === stableValue(right);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPointOrRange(position: unknown): position is Extract<RouteAnchorPosition, { type: "POINT" | "RANGE" }> {
  if (!isRecord(position)) return false;
  if (position.type === "POINT") {
    return Number.isSafeInteger(position.componentIndex) && typeof position.distanceKm === "number" && Number.isFinite(position.distanceKm);
  }
  if (position.type === "RANGE") {
    return Number.isSafeInteger(position.componentIndex) && typeof position.startKm === "number" && Number.isFinite(position.startKm)
      && typeof position.endKm === "number" && Number.isFinite(position.endKm) && position.endKm > position.startKm;
  }
  return false;
}

function isAttachableRouteAnchor(anchor: RouteAnchorV1): anchor is AttachableRouteAnchor {
  return anchor.visitId !== null
    && (anchor.positionConfidence === "exact-direct" || anchor.positionConfidence === "verified-match")
    && isPointOrRange(anchor.position);
}

function isUnpositioned(position: unknown): boolean {
  return isRecord(position) && position.type === "UNPOSITIONED";
}

function buildRouteAnalysisBinding(routeId: string, analysis: RouteAnalysisData) {
  const segments = analysis.segments.map((segment) => segment.points);
  const geometry = segments.map((points) => points.map(({ latitude, longitude }) => ({ latitude, longitude })));
  const analysisPoints = segments.map((points) => points.map(({ latitude, longitude, elevationM }) => ({ latitude, longitude, elevationM })));
  return Promise.all([
    createRouteFingerprint(geometry),
    createAnalysisInputFingerprint(analysisPoints),
  ]).then(([physical, analysisInput]) => ({
    routeId,
    routeFingerprint: physical.routeFingerprint,
    routeFingerprintVersion: physical.routeFingerprintVersion,
    analysisInputFingerprint: analysisInput,
    analysisInputFingerprintVersion: ANALYSIS_INPUT_FINGERPRINT_VERSION,
    distanceKm: analysis.segments.at(-1)?.endDistanceM ? analysis.segments.at(-1)!.endDistanceM / 1000 : 0,
    components: analysis.segments.map((segment) => ({
      segmentIndex: segment.segmentIndex,
      startKm: segment.startDistanceM / 1000,
      endKm: segment.endDistanceM / 1000,
      traversedDistanceKm: (segment.endDistanceM - segment.startDistanceM) / 1000,
    })),
  }));
}

function addDiagnostic(
  diagnostics: CourseBriefAnchorAttachmentDiagnostic[],
  diagnostic: CourseBriefAnchorAttachmentDiagnostic,
): void {
  diagnostics.push({
    ...diagnostic,
    candidateIds: [...new Set(diagnostic.candidateIds)].sort(),
    reasonCodes: [...new Set(diagnostic.reasonCodes)].sort(),
    evidenceIds: [...new Set(diagnostic.evidenceIds)].sort(),
  });
}

function diagnosticCodeForState(state: string): CourseBriefAnchorDiagnosticCode | null {
  switch (state) {
    case "matched-approximate": return "approximate-excluded";
    case "context-only": return "context-only";
    case "conflicting": return "conflicting-excluded";
    case "ambiguous": return "ambiguous-match-excluded";
    case "rejected": return "rejected-match-excluded";
    default: return null;
  }
}

function validateMatchingOutput(value: unknown): RouteAnchorMatchingOutput | null {
  const parsed = matchingOutputSchema.safeParse(value);
  if (!parsed.success) return null;
  const datasetResult = validateRouteAnchorDataset(parsed.data.dataset);
  if (!datasetResult.success || !routeAnchorDatasetV1Schema.safeParse(datasetResult.data).success) return null;
  const dataset = datasetResult.data;
  const locationById = new Map(dataset.context.locations.map((location) => [location.locationId, location]));
  const evidenceIds = new Set(dataset.evidence.map((evidence) => evidence.evidenceId));
  const anchorById = new Map(dataset.anchors.map((anchor) => [anchor.anchorId, anchor]));
  const resultIds = new Set<string>();
  const referencedAnchorIds = new Set<string>();

  for (const result of parsed.data.results) {
    const location = locationById.get(result.contextLocationId);
    if (!location || resultIds.has(result.contextLocationId) || result.placeId !== location.placeId
      || result.evidenceIds.some((id) => !evidenceIds.has(id))
      || location.evidenceIds.some((id) => !result.evidenceIds.includes(id))
      || result.evidenceIds.some((id) => !location.evidenceIds.includes(id)
        && !dataset.evidence.find((evidence) => evidence.evidenceId === id)?.derivedFromEvidenceIds?.some((sourceId) => location.evidenceIds.includes(sourceId)))) return null;
    resultIds.add(result.contextLocationId);
    let materializedAnchor: RouteAnchorV1 | undefined;
    if (result.anchor !== null) {
      if (!isRecord(result.anchor) || typeof result.anchor.anchorId !== "string") return null;
      const anchor = anchorById.get(result.anchor.anchorId);
      if (!anchor || referencedAnchorIds.has(anchor.anchorId) || !sameValue(result.anchor, anchor)
        || anchor.contextLocationId !== result.contextLocationId || result.visitId !== anchor.visitId
        || !sameValue(result.position, anchor.position)) return null;
      materializedAnchor = anchor;
      referencedAnchorIds.add(anchor.anchorId);
      if (anchor.position.type === "POINT" || anchor.position.type === "RANGE") {
        if (result.componentIndex !== anchor.position.componentIndex) return null;
      } else if (result.componentIndex !== null) return null;
    } else if (result.state !== "conflicting" || result.position !== null || result.visitId !== null) {
      return null;
    }

    switch (result.state) {
      case "matched-exact":
        if (!result.anchor || result.positionConfidence !== "exact-direct" || !result.positionSafe || !result.safeToMaterialize
          || !isPointOrRange(result.position) || materializedAnchor?.positionConfidence !== "exact-direct") return null;
        break;
      case "matched-verified":
        if (!result.anchor || result.positionConfidence !== "verified-match" || !result.positionSafe || !result.safeToMaterialize
          || !isPointOrRange(result.position) || materializedAnchor?.positionConfidence !== "verified-match") return null;
        break;
      case "matched-approximate":
        if (!result.anchor || result.positionConfidence !== "approximate" || result.positionSafe || !result.safeToMaterialize
          || !isPointOrRange(result.position) || materializedAnchor?.positionConfidence !== "approximate") return null;
        break;
      case "context-only":
        if (!result.anchor || result.positionConfidence !== "context-only" || result.positionSafe || !result.safeToMaterialize || !isUnpositioned(result.position)
          || materializedAnchor?.positionConfidence !== "context-only" || materializedAnchor.visitId !== null) return null;
        break;
      case "conflicting":
        if (result.anchor !== null || result.position !== null || result.positionSafe || result.safeToMaterialize
          || result.positionConfidence !== "conflicting") return null;
        break;
      case "ambiguous":
      case "rejected":
        if (!result.anchor || result.positionConfidence !== "context-only" || result.positionSafe || !result.safeToMaterialize
          || !isUnpositioned(result.position) || materializedAnchor?.positionConfidence !== "context-only"
          || !isUnpositioned(materializedAnchor.position) || materializedAnchor.visitId !== null || result.visitId !== null) return null;
        break;
    }
    if (result.state === "matched-exact" && !result.reasonCodes.includes("matched-direct-km")) return null;
    if (result.state === "matched-verified" && !result.reasonCodes.some((code) =>
      code === "matched-route-projection" || code === "matched-endpoint-coordinate")) return null;
    if (result.state === "matched-approximate" && !result.reasonCodes.some((code) =>
      code === "matched-route-projection" || code === "matched-endpoint-coordinate")) return null;
  }
  if (resultIds.size !== locationById.size || referencedAnchorIds.size !== anchorById.size) return null;
  return {
    algorithmVersion: parsed.data.algorithmVersion,
    matchPolicyVersion: parsed.data.matchPolicyVersion,
    dataset,
    results: parsed.data.results as RouteAnchorMatchingOutput["results"],
  };
}

function candidateRange(candidate: CourseBriefCandidate, input: CourseBriefInputV2): { startKm: number; endKm: number } | null {
  const facts = new Map(input.facts.map((fact) => [fact.factId, fact]));
  const linked = [candidate.primaryFactId, ...candidate.supportingFactIds]
    .map((id) => facts.get(id)).filter((fact) => fact !== undefined);
  const units = linked.filter((fact) => fact.type === "UNIT_CHARACTER");
  const primary = facts.get(candidate.primaryFactId);
  if (units.length > 0) {
    return {
      startKm: Math.min(...units.map((fact) => fact.startKm)),
      endKm: Math.max(...units.map((fact) => fact.endKm)),
    };
  }
  return primary ? { startKm: primary.startKm, endKm: primary.endKm } : null;
}

function roleAndTransitionBoundaries(
  candidate: CourseBriefCandidate,
  input: CourseBriefInputV2,
  routeAnalysis: RouteAnalysisData,
  componentBounds: CourseBriefAnchorRouteBindingV1["components"],
): number[] {
  const ids = [candidate.primaryFactId, ...candidate.supportingFactIds];
  const facts = new Map(input.facts.map((fact) => [fact.factId, fact]));
  const linked = ids.flatMap((id) => {
    const fact = facts.get(id);
    return fact === undefined ? [] : [fact];
  });
  return linked.flatMap((fact) => {
    if (fact.type !== "STRUCTURAL_TRANSITION" || fact.segmentIndex !== candidate.componentIndex) return [];
    const explicitlyDestinationAssociated = candidate.primaryFactId === fact.factId
      || linked.some((candidateFact) => candidateFact.type === "UNIT_CHARACTER" && candidateFact.unitId === fact.toUnitId);
    if (!explicitlyDestinationAssociated) return [];
    const exact = resolveFullPrecisionCourseBriefBoundary(routeAnalysis, fact.segmentIndex, fact.boundaryKm, "start", componentBounds);
    return exact.status === "resolved" ? [exact.distanceKm] : [];
  });
}

function attachmentId(candidateId: string, anchorId: string): string {
  return `course-brief-anchor:${encodeURIComponent(candidateId)}:${encodeURIComponent(anchorId)}`;
}

/**
 * Attaches current-edition exact/verified positions to canonical selected observations.
 * It validates every layer before producing any attachment and never modifies CourseBriefOutputV2.
 */
export async function attachCourseBriefRouteAnchors(
  value: CourseBriefAnchorAttachmentInput,
): Promise<CourseBriefAnchorAttachmentResult> {
  const briefValidation = validateCourseBriefInputV2(value.courseBriefInput);
  if (!briefValidation.ok) return { ok: false, error: "invalid_course_brief_input" };
  const courseBriefInput = briefValidation.input;
  const pool = validateCourseBriefCandidatePool(courseBriefInput, value.candidatePool);
  if (!pool.ok) return { ok: false, error: "invalid_candidate_pool" };

  const expectedSelection = selectCourseBriefCandidates(courseBriefInput, pool.candidates);
  if (!expectedSelection.ok || !sameValue(value.selection, expectedSelection)) {
    return { ok: false, error: "selection_mismatch" };
  }
  let canonicalOutput: CourseBriefOutputV2;
  try {
    canonicalOutput = renderCourseBriefV2(courseBriefInput, pool.candidates, expectedSelection);
  } catch {
    return { ok: false, error: "selection_mismatch" };
  }
  if (!sameValue(value.courseBriefOutput, canonicalOutput)) return { ok: false, error: "output_mismatch" };

  let routeBinding: CourseBriefAnchorRouteBindingV1;
  try {
    const parsedBinding = routeBindingSchema.safeParse(value.routeBinding);
    if (!parsedBinding.success) return { ok: false, error: "route_identity_mismatch" };
    const derived = await buildRouteAnalysisBinding(parsedBinding.data.routeId, value.routeAnalysis);
    if (parsedBinding.data.routeFingerprint !== derived.routeFingerprint
      || parsedBinding.data.routeFingerprintVersion !== derived.routeFingerprintVersion
      || parsedBinding.data.analysisInputFingerprint !== derived.analysisInputFingerprint
      || parsedBinding.data.analysisInputFingerprintVersion !== derived.analysisInputFingerprintVersion) {
      return { ok: false, error: "route_identity_mismatch" };
    }
    if (parsedBinding.data.distanceKm !== derived.distanceKm || !sameValue(parsedBinding.data.components, derived.components)) {
      return { ok: false, error: "route_bounds_mismatch" };
    }
    routeBinding = parsedBinding.data;
    const canonicalBrief = buildCourseBriefInputV2(value.routeAnalysis as CourseBriefNarrativeSource, courseBriefInput.versions.routeAnalysis);
    if (!sameValue(courseBriefInput, canonicalBrief)) return { ok: false, error: "route_identity_mismatch" };
  } catch {
    return { ok: false, error: "route_identity_mismatch" };
  }

  const matching = validateMatchingOutput(value.matchingOutput);
  if (!matching) return { ok: false, error: "invalid_matching_output" };
  const expectedGeometry = routeAnchorGeometryFromAnalysis(routeBinding.routeId, value.routeAnalysis);
  if (matching.dataset.routeBounds.routeId !== routeBinding.routeId
    || !sameValue(matching.dataset.routeBounds, expectedGeometry.bounds)) {
    return { ok: false, error: "route_bounds_mismatch" };
  }

  const observationById = new Map(canonicalOutput.observations.map((observation) => [observation.candidateId, observation]));
  const candidateById = new Map(pool.candidates.map((candidate) => [candidate.candidateId, candidate]));
  const windows: CourseBriefAnchorObservationWindow[] = [];
  const unresolvedWindows: Array<{ candidateId: string; componentIndex: number; startKm: number; endKm: number }> = [];
  for (const observation of canonicalOutput.observations) {
    const candidate = candidateById.get(observation.candidateId)!;
    const roundedRange = candidateRange(candidate, courseBriefInput);
    if (!roundedRange || roundKm(roundedRange.startKm) !== observation.startKm || roundKm(roundedRange.endKm) !== observation.endKm) {
      return { ok: false, error: "output_mismatch" };
    }
    const preciseStart = resolveFullPrecisionCourseBriefBoundary(
      value.routeAnalysis, observation.componentIndex, roundedRange.startKm, "start", routeBinding.components,
    );
    const preciseEnd = resolveFullPrecisionCourseBriefBoundary(
      value.routeAnalysis, observation.componentIndex, roundedRange.endKm, "end", routeBinding.components,
    );
    if (preciseStart.status !== "resolved" || preciseEnd.status !== "resolved" || preciseEnd.distanceKm < preciseStart.distanceKm) {
      unresolvedWindows.push({ candidateId: observation.candidateId, componentIndex: observation.componentIndex,
        startKm: observation.startKm, endKm: observation.endKm });
      continue;
    }
    windows.push({
      candidateId: observation.candidateId,
      componentIndex: observation.componentIndex,
      startKm: preciseStart.distanceKm,
      endKm: preciseEnd.distanceKm,
      transitionBoundaryKms: roleAndTransitionBoundaries(candidate, courseBriefInput, value.routeAnalysis, routeBinding.components),
    });
  }
  const finalComponentEnds = new Map(expectedGeometry.bounds.components.map((component) => [component.componentIndex, component.endKm]));
  const diagnostics: CourseBriefAnchorAttachmentDiagnostic[] = [];
  const owned: Array<{ result: RouteAnchorMatchingOutput["results"][number]; anchor: AttachableRouteAnchor; candidateId: string; role: CourseBriefAnchorRole }> = [];
  const evidenceById = new Map(matching.dataset.evidence.map((evidence) => [evidence.evidenceId, evidence]));

  for (const result of [...matching.results].sort((a, b) => a.contextLocationId.localeCompare(b.contextLocationId))) {
    const anchor = result.anchor;
    if (result.state !== "matched-exact" && result.state !== "matched-verified") {
      const code = diagnosticCodeForState(result.state);
      if (code) addDiagnostic(diagnostics, {
        code,
        contextLocationId: result.contextLocationId,
        anchorId: anchor?.anchorId ?? null,
        visitId: result.visitId,
        matchState: result.state,
        reasonCodes: result.reasonCodes,
        evidenceIds: result.evidenceIds,
        candidateIds: [],
        role: result.state === "context-only" ? "CONTEXT_ONLY" : null,
      });
      continue;
    }
    if (!anchor || !isAttachableRouteAnchor(anchor) || !result.positionSafe || !result.safeToMaterialize
      || (result.positionConfidence !== "exact-direct" && result.positionConfidence !== "verified-match")
      || anchor.positionConfidence !== result.positionConfidence
      || result.visitId === null || result.visitId !== anchor.visitId
      || !sameValue(result.position, anchor.position)) return { ok: false, error: "invalid_matching_output" };

    const position = anchor.position;
    const ownershipPosition: CourseBriefAnchorOwnershipPosition = position.type === "POINT"
      ? { ...position, anchorType: anchor.type }
      : { ...position, anchorType: anchor.type };
    const couldBelongToUnresolvedWindow = unresolvedWindows.some((window) => {
      if (window.componentIndex !== position.componentIndex) return false;
      if (position.type === "POINT") return position.distanceKm >= window.startKm && position.distanceKm <= window.endKm;
      return position.endKm > window.startKm && position.startKm < window.endKm;
    });
    if (couldBelongToUnresolvedWindow) {
      addDiagnostic(diagnostics, {
        code: "uncertain-observation-boundary",
        contextLocationId: result.contextLocationId,
        anchorId: anchor.anchorId,
        visitId: anchor.visitId,
        matchState: result.state,
        reasonCodes: result.reasonCodes,
        evidenceIds: result.evidenceIds,
        candidateIds: unresolvedWindows.filter((window) => window.componentIndex === position.componentIndex
          && (position.type === "POINT" ? position.distanceKm >= window.startKm && position.distanceKm <= window.endKm
            : position.endKm > window.startKm && position.startKm < window.endKm)).map(({ candidateId }) => candidateId),
        role: null,
      });
      continue;
    }
    const owner = resolveCourseBriefAnchorOwnership(windows, ownershipPosition, finalComponentEnds);
    if (owner.status !== "owned") {
      addDiagnostic(diagnostics, {
        code: owner.status === "ambiguous" ? "ambiguous-observation-owner" : "no-observation-owner",
        contextLocationId: result.contextLocationId,
        anchorId: anchor.anchorId,
        visitId: anchor.visitId,
        matchState: result.state,
        reasonCodes: result.reasonCodes,
        evidenceIds: result.evidenceIds,
        candidateIds: owner.status === "ambiguous" ? owner.candidateIds : [],
        role: null,
      });
      continue;
    }
    const observation = observationById.get(owner.candidateId);
    if (!observation || observation.componentIndex !== anchor.position.componentIndex) {
      return { ok: false, error: "invalid_matching_output" };
    }
    if (!anchor.evidenceIds.every((id) => evidenceById.has(id))) return { ok: false, error: "invalid_matching_output" };
    owned.push({ result, anchor, candidateId: owner.candidateId, role: owner.role });
  }

  const grouped = new Map<string, typeof owned>();
  for (const item of owned) grouped.set(item.candidateId, [...(grouped.get(item.candidateId) ?? []), item]);
  const winners = new Map<string, (typeof owned)[number]>();
  for (const [candidateId, items] of grouped) {
    const ranked = [...items].sort((left, right) => {
      const confidence = Number(right.anchor.positionConfidence === "exact-direct") - Number(left.anchor.positionConfidence === "exact-direct");
      const transition = Number(right.role === "TRANSITION") - Number(left.role === "TRANSITION");
      return confidence || transition;
    });
    const best = ranked.filter((item) => item.anchor.positionConfidence === ranked[0].anchor.positionConfidence
      && (item.role === "TRANSITION") === (ranked[0].role === "TRANSITION"));
    if (best.length !== 1) {
      for (const item of best) addDiagnostic(diagnostics, {
        code: "equal-priority-anchors",
        contextLocationId: item.result.contextLocationId,
        anchorId: item.anchor.anchorId,
        visitId: item.anchor.visitId,
        matchState: item.result.state,
        reasonCodes: item.result.reasonCodes,
        evidenceIds: item.result.evidenceIds,
        candidateIds: [candidateId],
        role: null,
      });
      for (const item of ranked.slice(best.length)) addDiagnostic(diagnostics, {
        code: "lower-priority-anchor",
        contextLocationId: item.result.contextLocationId,
        anchorId: item.anchor.anchorId,
        visitId: item.anchor.visitId,
        matchState: item.result.state,
        reasonCodes: item.result.reasonCodes,
        evidenceIds: item.result.evidenceIds,
        candidateIds: [candidateId],
        role: null,
      });
      continue;
    }
    winners.set(candidateId, best[0]);
    for (const item of ranked.slice(best.length)) addDiagnostic(diagnostics, {
      code: "lower-priority-anchor",
      contextLocationId: item.result.contextLocationId,
      anchorId: item.anchor.anchorId,
      visitId: item.anchor.visitId,
      matchState: item.result.state,
      reasonCodes: item.result.reasonCodes,
      evidenceIds: item.result.evidenceIds,
      candidateIds: [candidateId],
      role: null,
    });
  }

  const attachments: CourseBriefAnchorAttachment[] = [];
  const renderTokens: CourseBriefAnchorRenderTokenV1[] = [];
  for (const observation of canonicalOutput.observations) {
    const item = winners.get(observation.candidateId);
    if (!item) continue;
    const anchor = item.anchor;
    const sources = anchor.evidenceIds.map((evidenceId) => evidenceById.get(evidenceId)!).map((evidence) => ({
      evidenceId: evidence.evidenceId,
      sourceId: evidence.sourceId,
      provenance: evidence.provenance,
      sourceEditionYear: evidence.sourceEditionYear,
      evidenceKind: evidence.evidenceKind,
      verificationMethod: evidence.verificationMethod,
    })).sort((a, b) => a.evidenceId.localeCompare(b.evidenceId));
    const id = attachmentId(observation.candidateId, anchor.anchorId);
    const attachment: CourseBriefAnchorAttachment = {
      attachmentId: id,
      candidateId: observation.candidateId,
      observationId: observation.candidateId,
      anchorId: anchor.anchorId,
      contextLocationId: anchor.contextLocationId,
      placeId: anchor.placeId,
      visitId: anchor.visitId!,
      anchorType: anchor.type,
      componentIndex: anchor.position.componentIndex,
      position: anchor.position,
      positionConfidence: anchor.positionConfidence as "exact-direct" | "verified-match",
      evidenceIds: [...anchor.evidenceIds].sort(),
      sources,
      measuredOffsetM: item.result.offsetMeters,
      role: item.role,
    };
    attachments.push(attachment);
    renderTokens.push({
      kind: "route-anchor",
      attachmentId: id,
      candidateId: observation.candidateId,
      observationId: observation.candidateId,
      contextLocationId: anchor.contextLocationId,
      role: item.role,
    });
  }

  const orderedDiagnostics = diagnostics.sort((a, b) => a.contextLocationId.localeCompare(b.contextLocationId)
    || (a.anchorId ?? "").localeCompare(b.anchorId ?? "") || a.code.localeCompare(b.code));
  const cap = COURSE_BRIEF_ANCHOR_ATTACHMENT_MAX_DIAGNOSTICS;
  return {
    ok: true,
    attachment: {
      schemaVersion: COURSE_BRIEF_ANCHOR_ATTACHMENT_SCHEMA_VERSION,
      algorithmVersion: COURSE_BRIEF_ANCHOR_ATTACHMENT_VERSION,
      candidateAlgorithmVersion: COURSE_BRIEF_CANDIDATE_ALGORITHM_VERSION,
      courseBriefOutputSchemaVersion: COURSE_BRIEF_OUTPUT_V2_SCHEMA_VERSION,
      matchingAlgorithmVersion: matching.algorithmVersion,
      matchPolicyVersion: matching.matchPolicyVersion,
      routeBinding,
      attachments,
      renderTokens,
      diagnostics: { items: orderedDiagnostics.slice(0, cap), omittedCount: Math.max(0, orderedDiagnostics.length - cap) },
    },
  };
}
