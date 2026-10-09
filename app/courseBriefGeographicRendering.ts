import { z } from "zod";
import {
  COURSE_BRIEF_CANDIDATE_ALGORITHM_VERSION,
  COURSE_BRIEF_OUTPUT_V2_SCHEMA_VERSION,
  renderCourseBriefV2,
  selectCourseBriefCandidates,
  validateCourseBriefCandidatePool,
  type CourseBriefCandidate,
  type CourseBriefObservationV2,
  type CourseBriefOutputV2,
} from "./courseBriefCandidates.ts";
import {
  buildCourseBriefInputV2,
  COURSE_BRIEF_INPUT_SCHEMA_VERSION,
  validateCourseBriefInputV2,
  type CourseBriefInputV2,
  type CourseBriefNarrativeSource,
  type NarrativeFact,
} from "./courseBriefNarrativeFacts.ts";
import { ANALYSIS_INPUT_FINGERPRINT_VERSION, createAnalysisInputFingerprint } from "./analysisInputFingerprint.ts";
import type { RouteAnalysisData } from "./gpxAnalysis.ts";
import {
  ROUTE_ANCHOR_EVIDENCE_KINDS,
  ROUTE_ANCHOR_PROVENANCE,
  ROUTE_ANCHOR_VERIFICATION_METHODS,
  routeAnchorDatasetV1Schema,
  validateRouteAnchorDataset,
  type RouteAnchorDatasetV1,
  type RouteAnchorPosition,
} from "./routeAnchors.ts";
import {
  ROUTE_ANCHOR_MATCHING_ALGORITHM_VERSION,
  ROUTE_ANCHOR_MATCH_POLICY_VERSION,
  ROUTE_ANCHOR_MATCH_STATES,
  ROUTE_ANCHOR_MATCH_METHODS,
  matchRouteAnchors,
  routeAnchorGeometryFromAnalysis,
} from "./routeAnchorMatching.ts";
import { ROUTE_FINGERPRINT_VERSION, createRouteFingerprint } from "./routeFingerprint.ts";
import {
  COURSE_BRIEF_ANCHOR_ATTACHMENT_SCHEMA_VERSION,
  COURSE_BRIEF_ANCHOR_ATTACHMENT_VERSION,
  COURSE_BRIEF_ANCHOR_ROLES,
  resolveCourseBriefAnchorOwnership,
  resolveFullPrecisionCourseBriefBoundary,
  type CourseBriefAnchorAttachment,
  type CourseBriefAnchorAttachmentV1,
  type CourseBriefAnchorObservationWindow,
} from "./courseBriefAnchorAttachment.ts";

export const COURSE_BRIEF_GEOGRAPHIC_PRESENTATION_SCHEMA_VERSION = 1 as const;
export const COURSE_BRIEF_GEOGRAPHIC_RENDERER_VERSION = 1 as const;
export const COURSE_BRIEF_GEOGRAPHIC_CLAIM_TYPES = [
  "START_POSITION", "FINISH_POSITION", "STRUCTURAL_TRANSITION_POSITION", "ROUTE_POINT",
  "EVENT_POINT", "FEATURE_POINT_PROXIMITY",
] as const;
export type CourseBriefGeographicClaimType = typeof COURSE_BRIEF_GEOGRAPHIC_CLAIM_TYPES[number];

export type CourseBriefGeographicStructuralSpan = {
  kind: "structural";
  observationId: string;
  candidateId: string;
  sourceFactIds: string[];
  text: string;
};

export type CourseBriefGeographicSpan = {
  kind: "geographic";
  observationId: string;
  candidateId: string;
  attachmentId: string;
  claimType: CourseBriefGeographicClaimType;
  templateId: string;
  sourceFactIds: string[];
  anchorId: string;
  contextLocationId: string;
  placeId: string;
  visitId: string;
  componentIndex: number;
  position: Extract<RouteAnchorPosition, { type: "POINT" }>;
  positionConfidence: "exact-direct" | "verified-match";
  evidenceIds: string[];
  sources: CourseBriefAnchorAttachment["sources"];
  measuredOffsetM: number | null;
  text: string;
};

export type CourseBriefGeographicPresentationObservationV1 = {
  candidateId: string;
  observationId: string;
  componentIndex: number;
  startKm: number;
  endKm: number;
  displayOrderKey: number;
  spans: Array<CourseBriefGeographicStructuralSpan | CourseBriefGeographicSpan>;
  text: string;
};

export type CourseBriefGeographicPresentationV1 = {
  schemaVersion: typeof COURSE_BRIEF_GEOGRAPHIC_PRESENTATION_SCHEMA_VERSION;
  rendererVersion: typeof COURSE_BRIEF_GEOGRAPHIC_RENDERER_VERSION;
  inputSchemaVersion: typeof COURSE_BRIEF_INPUT_SCHEMA_VERSION;
  candidateAlgorithmVersion: typeof COURSE_BRIEF_CANDIDATE_ALGORITHM_VERSION;
  structuralOutputSchemaVersion: typeof COURSE_BRIEF_OUTPUT_V2_SCHEMA_VERSION;
  attachmentSchemaVersion: typeof COURSE_BRIEF_ANCHOR_ATTACHMENT_SCHEMA_VERSION;
  attachmentAlgorithmVersion: typeof COURSE_BRIEF_ANCHOR_ATTACHMENT_VERSION;
  matchingAlgorithmVersion: typeof ROUTE_ANCHOR_MATCHING_ALGORITHM_VERSION;
  matchPolicyVersion: typeof ROUTE_ANCHOR_MATCH_POLICY_VERSION;
  /** The exact validated V2 object is retained unchanged. */
  structuralOutput: CourseBriefOutputV2;
  observations: CourseBriefGeographicPresentationObservationV1[];
  diagnostics: { attachedCount: number; omittedAttachmentCount: number };
};

export type CourseBriefGeographicRenderingInput = {
  courseBriefInput: unknown;
  candidatePool: unknown;
  selection: unknown;
  structuralOutput: unknown;
  routeAnalysis: RouteAnalysisData;
  attachment: unknown;
  matchingOutput: unknown;
};

export type CourseBriefGeographicRenderingResult =
  | { ok: true; presentation: CourseBriefGeographicPresentationV1 }
  | { ok: false; error:
      | "invalid_course_brief_input" | "invalid_candidate_pool" | "selection_mismatch" | "output_mismatch"
      | "route_identity_mismatch" | "route_bounds_mismatch" | "invalid_attachment" | "invalid_matching_output"
      | "attachment_reference_mismatch" | "ownership_mismatch" | "unsupported_evidence" };

const idSchema = z.string().min(1).max(600);
const kmSchema = z.number().finite().min(0).max(100_000);
const componentSchema = z.object({ segmentIndex: z.number().int().min(0).max(127), startKm: kmSchema,
  endKm: kmSchema, traversedDistanceKm: kmSchema }).strict();
const pointPositionSchema = z.object({ type: z.literal("POINT"), componentIndex: z.number().int().min(0).max(127), distanceKm: kmSchema,
  coordinate: z.object({ latitude: z.number().finite().min(-90).max(90), longitude: z.number().finite().min(-180).max(180) }).strict().optional(),
  routePointIndex: z.number().int().min(0).max(10_000_000).optional() }).strict();
const sourceSchema = z.object({ evidenceId: idSchema, sourceId: idSchema.nullable(), provenance: z.enum(ROUTE_ANCHOR_PROVENANCE),
  sourceEditionYear: z.number().int().min(1900).max(3000).nullable(), evidenceKind: z.enum(ROUTE_ANCHOR_EVIDENCE_KINDS),
  verificationMethod: z.enum(ROUTE_ANCHOR_VERIFICATION_METHODS) }).strict();
const attachmentItemSchema = z.object({
  attachmentId: idSchema, candidateId: idSchema, observationId: idSchema, anchorId: idSchema, contextLocationId: idSchema,
  placeId: idSchema, visitId: idSchema, anchorType: z.enum(["START", "FINISH", "NAMED_LOCATION", "AID_STATION"]),
  componentIndex: z.number().int().min(0).max(127), position: z.discriminatedUnion("type", [pointPositionSchema,
    z.object({ type: z.literal("RANGE"), componentIndex: z.number().int().min(0).max(127), startKm: kmSchema, endKm: kmSchema }).strict()]),
  positionConfidence: z.enum(["exact-direct", "verified-match"]), evidenceIds: z.array(idSchema).min(1).max(64),
  sources: z.array(sourceSchema).min(1).max(64), measuredOffsetM: z.number().finite().min(0).max(1_000_000).nullable(),
  role: z.enum(COURSE_BRIEF_ANCHOR_ROLES),
}).strict();
const attachmentDiagnosticSchema = z.object({ code: z.string().min(1), contextLocationId: idSchema, anchorId: idSchema.nullable(),
  visitId: idSchema.nullable(), matchState: z.enum(ROUTE_ANCHOR_MATCH_STATES), reasonCodes: z.array(z.string().min(1)),
  evidenceIds: z.array(idSchema), candidateIds: z.array(idSchema), role: z.literal("CONTEXT_ONLY").nullable() }).strict();
const routeBindingSchema = z.object({ routeId: idSchema, routeFingerprint: z.string().min(1).max(160),
  routeFingerprintVersion: z.literal(ROUTE_FINGERPRINT_VERSION), analysisInputFingerprint: z.string().min(1).max(160),
  analysisInputFingerprintVersion: z.literal(ANALYSIS_INPUT_FINGERPRINT_VERSION), distanceKm: kmSchema,
  components: z.array(componentSchema).min(1).max(128) }).strict();
const attachmentSchema = z.object({ schemaVersion: z.literal(COURSE_BRIEF_ANCHOR_ATTACHMENT_SCHEMA_VERSION),
  algorithmVersion: z.literal(COURSE_BRIEF_ANCHOR_ATTACHMENT_VERSION),
  candidateAlgorithmVersion: z.literal(COURSE_BRIEF_CANDIDATE_ALGORITHM_VERSION),
  courseBriefOutputSchemaVersion: z.literal(COURSE_BRIEF_OUTPUT_V2_SCHEMA_VERSION),
  matchingAlgorithmVersion: z.literal(ROUTE_ANCHOR_MATCHING_ALGORITHM_VERSION),
  matchPolicyVersion: z.literal(ROUTE_ANCHOR_MATCH_POLICY_VERSION), routeBinding: routeBindingSchema,
  attachments: z.array(attachmentItemSchema).max(10_000), renderTokens: z.array(z.object({ kind: z.literal("route-anchor"),
    attachmentId: idSchema, candidateId: idSchema, observationId: idSchema, contextLocationId: idSchema,
    role: z.enum(COURSE_BRIEF_ANCHOR_ROLES) }).strict()).max(10_000),
  diagnostics: z.object({ items: z.array(attachmentDiagnosticSchema).max(256), omittedCount: z.number().int().nonnegative() }).strict(),
}).strict();
const matchResultSchema = z.object({ contextLocationId: idSchema, placeId: idSchema, visitId: idSchema.nullable(),
  state: z.enum(ROUTE_ANCHOR_MATCH_STATES), method: z.enum(ROUTE_ANCHOR_MATCH_METHODS), evidenceIds: z.array(idSchema),
  componentIndex: z.number().int().min(0).max(100_000).nullable(), position: z.unknown().nullable(),
  offsetMeters: z.number().finite().min(0).max(1_000_000).nullable(), candidateProjections: z.array(z.unknown()),
  reasonCodes: z.array(z.string().min(1)), safeToMaterialize: z.boolean(), positionSafe: z.boolean(),
  positionConfidence: z.enum(["exact-direct", "verified-match", "approximate", "context-only", "conflicting"]).nullable(),
  anchor: z.unknown().nullable() }).strict();
const matchingOutputSchema = z.object({ algorithmVersion: z.literal(ROUTE_ANCHOR_MATCHING_ALGORITHM_VERSION),
  matchPolicyVersion: z.literal(ROUTE_ANCHOR_MATCH_POLICY_VERSION), dataset: z.unknown(),
  results: z.array(matchResultSchema).max(10_000) }).strict();

function stable(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stable(object[key])}`).join(",")}}`;
}
function same(left: unknown, right: unknown): boolean { return stable(left) === stable(right); }
function roundKm(value: number): number { return Number(value.toFixed(2)); }
function sortedUnique(values: readonly string[]): string[] { return [...new Set(values)].sort(); }
function equalStringSets(left: readonly string[], right: readonly string[]): boolean { return same(sortedUnique(left), sortedUnique(right)); }
function validLabel(value: string): boolean { return value.trim() === value && value.length > 0 && value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value); }

function routeAnalysisInput(analysis: RouteAnalysisData) {
  const geometrySegments = analysis.segments.map((segment) => segment.points.map(({ latitude, longitude }) => ({ latitude, longitude })));
  const analysisSegments = analysis.segments.map((segment) => segment.points.map(({ latitude, longitude, elevationM }) => ({ latitude, longitude, elevationM })));
  return Promise.all([createRouteFingerprint(geometrySegments), createAnalysisInputFingerprint(analysisSegments)]);
}

function derivedComponents(analysis: RouteAnalysisData) {
  return analysis.segments.map((segment) => ({ segmentIndex: segment.segmentIndex,
    startKm: segment.startDistanceM / 1000, endKm: segment.endDistanceM / 1000,
    traversedDistanceKm: (segment.endDistanceM - segment.startDistanceM) / 1000 }));
}

function candidateRange(candidate: CourseBriefCandidate, input: CourseBriefInputV2): { startKm: number; endKm: number } | null {
  const facts = new Map(input.facts.map((fact) => [fact.factId, fact]));
  const linked = [candidate.primaryFactId, ...candidate.supportingFactIds].flatMap((id) => {
    const fact = facts.get(id); return fact === undefined ? [] : [fact];
  });
  const units = linked.filter((fact) => fact.type === "UNIT_CHARACTER");
  const primary = facts.get(candidate.primaryFactId);
  if (units.length) return { startKm: Math.min(...units.map((fact) => fact.startKm)), endKm: Math.max(...units.map((fact) => fact.endKm)) };
  return primary ? { startKm: primary.startKm, endKm: primary.endKm } : null;
}

function transitionFactsFor(candidate: CourseBriefCandidate, input: CourseBriefInputV2): Extract<NarrativeFact, { type: "STRUCTURAL_TRANSITION" }>[] {
  const byId = new Map(input.facts.map((fact) => [fact.factId, fact]));
  const linked = [candidate.primaryFactId, ...candidate.supportingFactIds].flatMap((id) => {
    const fact = byId.get(id); return fact === undefined ? [] : [fact];
  });
  return linked.filter((fact): fact is Extract<NarrativeFact, { type: "STRUCTURAL_TRANSITION" }> => {
    if (fact.type !== "STRUCTURAL_TRANSITION" || fact.segmentIndex !== candidate.componentIndex) return false;
    return candidate.primaryFactId === fact.factId
      || linked.some((item) => item.type === "UNIT_CHARACTER" && item.unitId === fact.toUnitId);
  });
}

function exactTransitionBoundaries(candidate: CourseBriefCandidate, input: CourseBriefInputV2, analysis: RouteAnalysisData,
  components: ReturnType<typeof derivedComponents>): number[] {
  return transitionFactsFor(candidate, input).flatMap((fact) => {
    const result = resolveFullPrecisionCourseBriefBoundary(analysis, fact.segmentIndex, fact.boundaryKm, "start", components);
    return result.status === "resolved" ? [result.distanceKm] : [];
  });
}

function makeOwnershipWindows(input: CourseBriefInputV2, candidates: readonly CourseBriefCandidate[],
  observations: readonly CourseBriefObservationV2[], analysis: RouteAnalysisData, components: ReturnType<typeof derivedComponents>) {
  const byId = new Map(candidates.map((candidate) => [candidate.candidateId, candidate]));
  const windows: CourseBriefAnchorObservationWindow[] = [];
  for (const observation of observations) {
    const candidate = byId.get(observation.candidateId);
    const range = candidate && candidateRange(candidate, input);
    if (!candidate || !range || roundKm(range.startKm) !== observation.startKm || roundKm(range.endKm) !== observation.endKm) return null;
    const start = resolveFullPrecisionCourseBriefBoundary(analysis, observation.componentIndex, range.startKm, "start", components);
    const end = resolveFullPrecisionCourseBriefBoundary(analysis, observation.componentIndex, range.endKm, "end", components);
    if (start.status !== "resolved" || end.status !== "resolved" || end.distanceKm < start.distanceKm) return null;
    windows.push({ candidateId: observation.candidateId, componentIndex: observation.componentIndex,
      startKm: start.distanceKm, endKm: end.distanceKm,
      transitionBoundaryKms: exactTransitionBoundaries(candidate, input, analysis, components) });
  }
  return windows;
}

function evidenceSourceEqual(source: z.infer<typeof sourceSchema>, evidence: RouteAnchorDatasetV1["evidence"][number]): boolean {
  return source.evidenceId === evidence.evidenceId && source.sourceId === evidence.sourceId && source.provenance === evidence.provenance
    && source.sourceEditionYear === evidence.sourceEditionYear && source.evidenceKind === evidence.evidenceKind
    && source.verificationMethod === evidence.verificationMethod;
}

type ValidatedAttachmentRefs = {
  dataset: RouteAnchorDatasetV1;
  location: RouteAnchorDatasetV1["context"]["locations"][number];
  anchor: RouteAnchorDatasetV1["anchors"][number];
  result: z.infer<typeof matchResultSchema>;
  evidence: RouteAnchorDatasetV1["evidence"];
};

function validateAttachmentReferences(item: CourseBriefAnchorAttachment, dataset: RouteAnchorDatasetV1,
  resultsByLocation: Map<string, z.infer<typeof matchResultSchema>>): ValidatedAttachmentRefs | null {
  const location = dataset.context.locations.find((entry) => entry.locationId === item.contextLocationId);
  const anchor = dataset.anchors.find((entry) => entry.anchorId === item.anchorId);
  const result = resultsByLocation.get(item.contextLocationId);
  if (!location || !anchor || !result || !validLabel(location.name) || location.placeId !== item.placeId
    || anchor.contextLocationId !== item.contextLocationId || anchor.placeId !== item.placeId
    || anchor.visitId !== item.visitId || result.placeId !== item.placeId || result.visitId !== item.visitId
    || result.anchor === null || !same(result.anchor, anchor) || !same(result.position, anchor.position)
    || result.componentIndex !== item.componentIndex || item.positionConfidence !== anchor.positionConfidence
    || item.positionConfidence !== result.positionConfidence || !result.positionSafe || !result.safeToMaterialize
    || (result.state !== "matched-exact" && result.state !== "matched-verified")
    || !same(item.position, anchor.position) || !equalStringSets(item.evidenceIds, anchor.evidenceIds)
    || !equalStringSets(result.evidenceIds, anchor.evidenceIds)) return null;
  if (anchor.position.type !== "POINT" || anchor.position.componentIndex !== item.componentIndex) return null;
  if (result.offsetMeters !== item.measuredOffsetM) return null;
  const evidence = anchor.evidenceIds.map((id) => dataset.evidence.find((entry) => entry.evidenceId === id));
  if (evidence.some((entry) => entry === undefined)) return null;
  const completeEvidence = evidence as RouteAnchorDatasetV1["evidence"];
  const expectedSources = completeEvidence.map((entry) => item.sources.find((source) => source.evidenceId === entry.evidenceId));
  if (expectedSources.some((source) => source === undefined)
    || item.sources.length !== completeEvidence.length
    || !expectedSources.every((source, index) => evidenceSourceEqual(source!, completeEvidence[index]))) return null;
  return { dataset, location, anchor, result, evidence: completeEvidence };
}

function isRootTrustedEvidence(evidence: RouteAnchorDatasetV1["evidence"][number], location: ValidatedAttachmentRefs["location"]): boolean {
  return location.evidenceIds.includes(evidence.evidenceId)
    && (evidence.provenance === "official" || evidence.provenance === "gpx-derived")
    && evidence.sourceEditionYear === null && evidence.sourceId !== null;
}

type GeographicTemplate = { claimType: CourseBriefGeographicClaimType; templateId: string; text: string; };
function metersText(value: number): string { return `${Math.ceil(value)} m`; }

function exactDirectEvidenceMatches(
  entry: RouteAnchorDatasetV1["evidence"][number], componentIndex: number, distanceKm: number,
): boolean {
  const hasDirectPosition = entry.routeKmFact !== undefined || entry.positionFact !== undefined;
  const routeKmConsistent = entry.routeKmFact === undefined || (entry.routeKmFact.distanceKm === distanceKm
    && (entry.routeKmFact.componentIndex === undefined || entry.routeKmFact.componentIndex === componentIndex));
  const positionConsistent = entry.positionFact === undefined || (entry.positionFact.type === "POINT"
    && entry.positionFact.componentIndex === componentIndex && entry.positionFact.distanceKm === distanceKm);
  return hasDirectPosition && routeKmConsistent && positionConsistent;
}

function expectedCoordinateMethod(evidence: RouteAnchorDatasetV1["evidence"][number]): string {
  return evidence.verificationMethod === "manual-curation" || evidence.evidenceKind === "curated-verification"
    ? "curated-geographic-coordinate"
    : evidence.evidenceKind === "official-map-or-coordinate" && evidence.provenance === "official"
      ? "direct-route-coordinate" : "curated-geographic-coordinate";
}

function renderGeographicTemplate(item: CourseBriefAnchorAttachment, refs: ValidatedAttachmentRefs,
  structuralFacts: readonly NarrativeFact[], fullPrecisionKm: number): GeographicTemplate | null {
  const { anchor, location, result, evidence } = refs;
  const label = location.name;
  const isOfficialPosition = evidence.some((entry) => entry.provenance === "official" && isRootTrustedEvidence(entry, location));
  const directPositionLabel = isOfficialPosition ? "official route position" : "GPX-derived route position";
  if (anchor.type === "START" && item.role !== "START") return null;
  if (anchor.type === "FINISH" && item.role !== "FINISH") return null;
  if ((item.role === "START") !== (anchor.type === "START") || (item.role === "FINISH") !== (anchor.type === "FINISH")) return null;

  if (result.state === "matched-exact") {
    const direct = evidence.filter((entry) => isRootTrustedEvidence(entry, location)
      && entry.evidenceKind === "official-structured-position"
      && (entry.routeKmFact !== undefined || entry.positionFact?.type === "POINT"));
    if (result.method !== "direct-route-km" || !result.reasonCodes.includes("matched-direct-km") || direct.length === 0
      || !direct.some((entry) => exactDirectEvidenceMatches(entry, item.componentIndex, fullPrecisionKm))
      || direct.some((entry) => !exactDirectEvidenceMatches(entry, item.componentIndex, fullPrecisionKm))) return null;
    if (item.role === "START") return { claimType: "START_POSITION", templateId: "exact-start-v1",
      text: `The ${directPositionLabel} for ${label} marks the start.` };
    if (item.role === "FINISH") return { claimType: "FINISH_POSITION", templateId: "exact-finish-v1",
      text: `The ${directPositionLabel} for ${label} marks the finish.` };
    if (item.role === "TRANSITION") {
      const fact = matchingTransition(structuralFacts, item.componentIndex, fullPrecisionKm);
      if (!fact) return null;
      return { claimType: "STRUCTURAL_TRANSITION_POSITION", templateId: "exact-transition-v1",
        text: `The documented shift from ${fact.fromCharacter} to ${fact.toCharacter} occurs at the ${directPositionLabel} for ${label}.` };
    }
    const placement = item.role === "ENTRY" ? "begins" : item.role === "EXIT" ? "ends" : "falls within";
    const phrase = item.role === "INTERNAL" ? `${isOfficialPosition ? "An" : "A"} ${directPositionLabel} for ${label} ${placement} this phase.`
      : `This phase ${placement} at the ${directPositionLabel} for ${label}.`;
    return { claimType: "ROUTE_POINT", templateId: `exact-${item.role.toLowerCase()}-v1`, text: phrase };
  }

  if (result.state !== "matched-verified" || result.method === "direct-route-km" || result.offsetMeters === null
    || !result.reasonCodes.some((code) => code === "matched-route-projection" || code === "matched-endpoint-coordinate")) return null;
  const semantics = [...new Set(evidence.flatMap((entry) => entry.coordinateFact ? [entry.coordinateFact.semantics] : []))];
  if (semantics.length !== 1 || !evidence.some((entry) => isRootTrustedEvidence(entry, location)
    && entry.coordinateFact?.semantics === semantics[0] && expectedCoordinateMethod(entry) === result.method)) return null;
  const semantic = semantics[0];
  if (semantic === "place-reference-point") return null;
  const offset = metersText(result.offsetMeters);
  if (semantic === "route-point") {
    if (item.role === "START") return { claimType: "START_POSITION", templateId: "matched-start-route-point-v1",
      text: `The start is matched to the route point for ${label} (${offset} from its source coordinate).` };
    if (item.role === "FINISH") return { claimType: "FINISH_POSITION", templateId: "matched-finish-route-point-v1",
      text: `The finish is matched to the route point for ${label} (${offset} from its source coordinate).` };
    if (item.role === "TRANSITION") {
      const fact = matchingTransition(structuralFacts, item.componentIndex, fullPrecisionKm);
      if (!fact) return null;
      return { claimType: "STRUCTURAL_TRANSITION_POSITION", templateId: "matched-transition-route-point-v1",
        text: `The documented shift from ${fact.fromCharacter} to ${fact.toCharacter} is matched to the route point for ${label} (${offset} from its source coordinate).` };
    }
    const where = item.role === "ENTRY" ? "begins" : item.role === "EXIT" ? "ends" : "contains";
    return { claimType: "ROUTE_POINT", templateId: `matched-${item.role.toLowerCase()}-route-point-v1`,
      text: item.role === "INTERNAL"
        ? `This phase contains a route point matched to the source coordinate for ${label} (${offset} away).`
        : `This phase ${where} at a route point matched to the source coordinate for ${label} (${offset} away).` };
  }
  if (semantic === "event-point") {
    if (anchor.type === "NAMED_LOCATION") return null;
    const claimType = item.role === "START" ? "START_POSITION" : item.role === "FINISH" ? "FINISH_POSITION"
      : item.role === "TRANSITION" ? "STRUCTURAL_TRANSITION_POSITION" : "EVENT_POINT";
    if (item.role === "TRANSITION") {
      const fact = matchingTransition(structuralFacts, item.componentIndex, fullPrecisionKm);
      if (!fact) return null;
      return { claimType, templateId: "matched-transition-event-point-v1",
        text: `The documented shift from ${fact.fromCharacter} to ${fact.toCharacter} is matched to the event point for ${label} (${offset} from its source coordinate).` };
    }
    return { claimType, templateId: `matched-${item.role.toLowerCase()}-event-point-v1`,
      text: item.role === "START" ? `The start is matched to the event point for ${label} (${offset} from its source coordinate).`
        : item.role === "FINISH" ? `The finish is matched to the event point for ${label} (${offset} from its source coordinate).`
          : `This phase has a route position matched to the event point for ${label} (${offset} from its source coordinate).` };
  }
  if (semantic === "feature-point") {
    if (anchor.type !== "AID_STATION") return null;
    return { claimType: "FEATURE_POINT_PROXIMITY", templateId: "feature-point-proximity-v1",
      text: `The route passes within ${offset} of the feature point reference for ${label}.` };
  }
  return null;
}

function matchingTransition(facts: readonly NarrativeFact[], componentIndex: number, boundaryKm: number) {
  const matching = facts.filter((fact): fact is Extract<NarrativeFact, { type: "STRUCTURAL_TRANSITION" }> =>
    fact.type === "STRUCTURAL_TRANSITION" && fact.segmentIndex === componentIndex && fact.boundaryKm === boundaryKm);
  return matching.length === 1 ? matching[0] : null;
}

function sourceFactsForObservation(input: CourseBriefInputV2, observation: CourseBriefObservationV2): NarrativeFact[] | null {
  const byId = new Map(input.facts.map((fact) => [fact.factId, fact]));
  const facts = observation.sourceFactIds.map((id) => byId.get(id));
  return facts.some((fact) => fact === undefined) ? null : facts as NarrativeFact[];
}

/** Deterministic geography-only presentation; the original structural V2 object and text are preserved. */
export async function renderCourseBriefGeographicPresentation(
  value: CourseBriefGeographicRenderingInput,
): Promise<CourseBriefGeographicRenderingResult> {
  const validatedInput = validateCourseBriefInputV2(value.courseBriefInput);
  if (!validatedInput.ok) return { ok: false, error: "invalid_course_brief_input" };
  const courseBriefInput = validatedInput.input;
  const pool = validateCourseBriefCandidatePool(courseBriefInput, value.candidatePool);
  if (!pool.ok) return { ok: false, error: "invalid_candidate_pool" };
  const expectedSelection = selectCourseBriefCandidates(courseBriefInput, pool.candidates);
  if (!expectedSelection.ok || !same(value.selection, expectedSelection)) return { ok: false, error: "selection_mismatch" };
  let canonicalOutput: CourseBriefOutputV2;
  try { canonicalOutput = renderCourseBriefV2(courseBriefInput, pool.candidates, expectedSelection); }
  catch { return { ok: false, error: "selection_mismatch" }; }
  if (!same(value.structuralOutput, canonicalOutput)) return { ok: false, error: "output_mismatch" };

  const parsedAttachment = attachmentSchema.safeParse(value.attachment);
  if (!parsedAttachment.success) return { ok: false, error: "invalid_attachment" };
  const attachment = parsedAttachment.data as CourseBriefAnchorAttachmentV1;
  const matchingParsed = matchingOutputSchema.safeParse(value.matchingOutput);
  if (!matchingParsed.success) return { ok: false, error: "invalid_matching_output" };
  const validatedDataset = validateRouteAnchorDataset(matchingParsed.data.dataset);
  if (!validatedDataset.success || !routeAnchorDatasetV1Schema.safeParse(validatedDataset.data).success) {
    return { ok: false, error: "invalid_matching_output" };
  }
  const dataset = validatedDataset.data;
  const analysis = value.routeAnalysis;
  let physical: Awaited<ReturnType<typeof createRouteFingerprint>>;
  let analysisFingerprint: Awaited<ReturnType<typeof createAnalysisInputFingerprint>>;
  try { [physical, analysisFingerprint] = await routeAnalysisInput(analysis); }
  catch { return { ok: false, error: "route_identity_mismatch" }; }
  let components: ReturnType<typeof derivedComponents>;
  let expectedGeometry: ReturnType<typeof routeAnchorGeometryFromAnalysis>;
  try {
    components = derivedComponents(analysis);
    expectedGeometry = routeAnchorGeometryFromAnalysis(attachment.routeBinding.routeId, analysis);
  } catch { return { ok: false, error: "route_identity_mismatch" }; }
  const binding = attachment.routeBinding;
  if (binding.routeFingerprint !== physical.routeFingerprint || binding.routeFingerprintVersion !== physical.routeFingerprintVersion
    || binding.analysisInputFingerprint !== analysisFingerprint || binding.analysisInputFingerprintVersion !== ANALYSIS_INPUT_FINGERPRINT_VERSION) {
    return { ok: false, error: "route_identity_mismatch" };
  }
  if (binding.distanceKm !== (analysis.segments.at(-1)?.endDistanceM ?? 0) / 1000 || !same(binding.components, components)) {
    return { ok: false, error: "route_bounds_mismatch" };
  }
  let rebuiltInput: CourseBriefInputV2;
  try { rebuiltInput = buildCourseBriefInputV2(analysis as CourseBriefNarrativeSource, courseBriefInput.versions.routeAnalysis); }
  catch { return { ok: false, error: "route_identity_mismatch" }; }
  if (!same(courseBriefInput, rebuiltInput)) return { ok: false, error: "route_identity_mismatch" };
  if (dataset.routeBounds.routeId !== binding.routeId || !same(dataset.routeBounds, expectedGeometry.bounds)) {
    return { ok: false, error: "route_bounds_mismatch" };
  }
  if (matchingParsed.data.algorithmVersion !== attachment.matchingAlgorithmVersion
    || matchingParsed.data.matchPolicyVersion !== attachment.matchPolicyVersion) return { ok: false, error: "invalid_matching_output" };
  let recomputedMatching: ReturnType<typeof matchRouteAnchors>;
  try {
    recomputedMatching = matchRouteAnchors({ context: dataset.context,
      evidence: dataset.evidence.filter((entry) => entry.derivedFromEvidenceIds === undefined),
      route: expectedGeometry, orderingConstraints: dataset.orderingConstraints });
  } catch { return { ok: false, error: "invalid_matching_output" }; }
  const sortResults = (results: readonly unknown[]) => [...results].sort((left, right) => {
    const leftId = (left as { contextLocationId?: string }).contextLocationId ?? "";
    const rightId = (right as { contextLocationId?: string }).contextLocationId ?? "";
    return leftId.localeCompare(rightId);
  });
  if (!same(sortResults(matchingParsed.data.results), sortResults(recomputedMatching.results))) {
    return { ok: false, error: "invalid_matching_output" };
  }

  const observationById = new Map(canonicalOutput.observations.map((observation) => [observation.candidateId, observation]));
  const candidateById = new Map(pool.candidates.map((candidate) => [candidate.candidateId, candidate]));
  const windows = makeOwnershipWindows(courseBriefInput, pool.candidates, canonicalOutput.observations, analysis, components);
  if (!windows) return { ok: false, error: "ownership_mismatch" };
  const finalEnds = new Map(expectedGeometry.bounds.components.map((component) => [component.componentIndex, component.endKm]));
  const resultsByLocation = new Map<string, z.infer<typeof matchResultSchema>>();
  for (const result of matchingParsed.data.results) {
    if (resultsByLocation.has(result.contextLocationId)) return { ok: false, error: "invalid_matching_output" };
    resultsByLocation.set(result.contextLocationId, result);
  }
  const attachmentIds = new Set<string>();
  const attachedCandidates = new Set<string>();
  const attachedAnchors = new Set<string>();
  const attachedVisits = new Set<string>();
  const tokensByAttachment = new Map(attachment.renderTokens.map((token) => [token.attachmentId, token]));
  if (tokensByAttachment.size !== attachment.renderTokens.length || tokensByAttachment.size !== attachment.attachments.length) {
    return { ok: false, error: "invalid_attachment" };
  }
  const geographicByCandidate = new Map<string, CourseBriefGeographicSpan>();
  for (const item of attachment.attachments) {
    const position = item.position;
    if (position.type !== "POINT") return { ok: false, error: "invalid_attachment" };
    if (attachmentIds.has(item.attachmentId) || attachedCandidates.has(item.candidateId) || attachedAnchors.has(item.anchorId)
      || attachedVisits.has(item.visitId)) return { ok: false, error: "invalid_attachment" };
    attachmentIds.add(item.attachmentId); attachedCandidates.add(item.candidateId); attachedAnchors.add(item.anchorId); attachedVisits.add(item.visitId);
    const observation = observationById.get(item.candidateId);
    const candidate = candidateById.get(item.candidateId);
    const token = tokensByAttachment.get(item.attachmentId);
    if (!observation || !candidate || item.observationId !== item.candidateId || observation.componentIndex !== item.componentIndex
      || !token || token.kind !== "route-anchor" || token.candidateId !== item.candidateId || token.observationId !== item.observationId
      || token.contextLocationId !== item.contextLocationId || token.role !== item.role) return { ok: false, error: "attachment_reference_mismatch" };
    const refs = validateAttachmentReferences(item, dataset, resultsByLocation);
    if (!refs) return { ok: false, error: "attachment_reference_mismatch" };
    const ownership = resolveCourseBriefAnchorOwnership(windows, { type: "POINT", componentIndex: item.componentIndex,
      distanceKm: position.distanceKm, anchorType: item.anchorType }, finalEnds);
    if (ownership.status !== "owned" || ownership.candidateId !== item.candidateId || ownership.role !== item.role) {
      return { ok: false, error: "ownership_mismatch" };
    }
    const facts = sourceFactsForObservation(courseBriefInput, observation);
    if (!facts) return { ok: false, error: "output_mismatch" };
    if (item.role === "TRANSITION") {
      const transitions = transitionFactsFor(candidate, courseBriefInput);
      const supported = transitions.some((fact) => {
        const exact = resolveFullPrecisionCourseBriefBoundary(analysis, fact.segmentIndex, fact.boundaryKm, "start", components);
        return exact.status === "resolved" && exact.distanceKm === position.distanceKm
          && facts.some((linked) => linked.factId === fact.factId);
      });
      if (!supported) return { ok: false, error: "unsupported_evidence" };
    }
    const template = renderGeographicTemplate(item, refs, facts, position.distanceKm);
    if (!template) return { ok: false, error: "unsupported_evidence" };
    geographicByCandidate.set(item.candidateId, {
      kind: "geographic", observationId: observation.candidateId, candidateId: observation.candidateId,
      attachmentId: item.attachmentId, claimType: template.claimType, templateId: template.templateId,
      sourceFactIds: item.role === "TRANSITION" ? facts.filter((fact) => fact.type === "STRUCTURAL_TRANSITION"
        && fact.segmentIndex === item.componentIndex && fact.boundaryKm === position.distanceKm).map((fact) => fact.factId) : [],
      anchorId: item.anchorId, contextLocationId: item.contextLocationId, placeId: item.placeId, visitId: item.visitId,
      componentIndex: item.componentIndex, position, positionConfidence: item.positionConfidence,
      evidenceIds: [...item.evidenceIds].sort(), sources: [...item.sources].sort((a, b) => a.evidenceId.localeCompare(b.evidenceId)),
      measuredOffsetM: item.measuredOffsetM, text: template.text,
    });
  }
  if (attachment.renderTokens.some((token) => !attachmentIds.has(token.attachmentId))) return { ok: false, error: "invalid_attachment" };

  const observations: CourseBriefGeographicPresentationObservationV1[] = canonicalOutput.observations.map((observation) => {
    const structural: CourseBriefGeographicStructuralSpan = { kind: "structural", observationId: observation.candidateId,
      candidateId: observation.candidateId, sourceFactIds: [...observation.sourceFactIds], text: observation.text };
    const geographic = geographicByCandidate.get(observation.candidateId);
    const spans = geographic ? [structural, geographic] : [structural];
    return { candidateId: observation.candidateId, observationId: observation.candidateId, componentIndex: observation.componentIndex,
      startKm: observation.startKm, endKm: observation.endKm, displayOrderKey: observation.displayOrderKey,
      spans, text: spans.map((span) => span.text).join(" ") };
  });
  return { ok: true, presentation: {
    schemaVersion: COURSE_BRIEF_GEOGRAPHIC_PRESENTATION_SCHEMA_VERSION,
    rendererVersion: COURSE_BRIEF_GEOGRAPHIC_RENDERER_VERSION,
    inputSchemaVersion: COURSE_BRIEF_INPUT_SCHEMA_VERSION,
    candidateAlgorithmVersion: COURSE_BRIEF_CANDIDATE_ALGORITHM_VERSION,
    structuralOutputSchemaVersion: COURSE_BRIEF_OUTPUT_V2_SCHEMA_VERSION,
    attachmentSchemaVersion: COURSE_BRIEF_ANCHOR_ATTACHMENT_SCHEMA_VERSION,
    attachmentAlgorithmVersion: COURSE_BRIEF_ANCHOR_ATTACHMENT_VERSION,
    matchingAlgorithmVersion: ROUTE_ANCHOR_MATCHING_ALGORITHM_VERSION,
    matchPolicyVersion: ROUTE_ANCHOR_MATCH_POLICY_VERSION,
    structuralOutput: value.structuralOutput as CourseBriefOutputV2,
    observations,
    diagnostics: { attachedCount: geographicByCandidate.size, omittedAttachmentCount: attachment.diagnostics.omittedCount },
  } };
}
