import { z } from "zod";
import type { EvidenceProvenance } from "./geoEnrichment";

export const RACE_CONTEXT_SCHEMA_VERSION = 1 as const;
export const ROUTE_ANCHOR_SCHEMA_VERSION = 1 as const;
export const ROUTE_ANCHOR_EVIDENCE_SCHEMA_VERSION = 1 as const;
export const ROUTE_ANCHOR_INDEX_ALGORITHM_VERSION = 1 as const;

export const ROUTE_ANCHOR_TYPES = ["START", "FINISH", "NAMED_LOCATION", "AID_STATION"] as const;
export const ROUTE_ANCHOR_PROVENANCE = ["official", "gpx-derived", "previous-edition", "estimated", "unknown"] as const satisfies readonly (EvidenceProvenance | "gpx-derived")[];
export const ROUTE_ANCHOR_POSITION_CONFIDENCE = ["exact-direct", "verified-match", "approximate", "context-only", "conflicting"] as const;
export const ROUTE_ANCHOR_EVIDENCE_KINDS = [
  "official-structured-position",
  "official-text-context",
  "official-text-order",
  "gpx-waypoint",
  "official-map-or-coordinate",
  "geographic-match",
  "previous-edition-reference",
  "curated-verification",
] as const;
export const ROUTE_ANCHOR_VERIFICATION_METHODS = [
  "structured-source",
  "text-review",
  "gpx-waypoint",
  "geographic-match",
  "manual-curation",
  "historical-reference",
  "unknown",
] as const;

const idSchema = z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const yearSchema = z.number().int().min(1900).max(3000);
const finiteKmSchema = z.number().finite().min(0).max(100_000);
const componentIndexSchema = z.number().int().min(0).max(100_000);
const coordinateSchema = z.object({
  latitude: z.number().finite().min(-90).max(90),
  longitude: z.number().finite().min(-180).max(180),
}).strict();

const pointPositionSchema = z.object({
  type: z.literal("POINT"),
  componentIndex: componentIndexSchema,
  distanceKm: finiteKmSchema,
  coordinate: coordinateSchema.optional(),
  routePointIndex: z.number().int().min(0).max(10_000_000).optional(),
}).strict();
const rangePositionSchema = z.object({
  type: z.literal("RANGE"),
  componentIndex: componentIndexSchema,
  startKm: finiteKmSchema,
  endKm: finiteKmSchema,
}).strict();
const orderedPositionSchema = z.object({
  type: z.literal("ORDERED_ONLY"),
  componentIndex: componentIndexSchema.optional(),
}).strict();
const unpositionedSchema = z.object({ type: z.literal("UNPOSITIONED") }).strict();
const positionSchema = z.discriminatedUnion("type", [
  pointPositionSchema,
  rangePositionSchema,
  orderedPositionSchema,
  unpositionedSchema,
]);
const raceContextLocationSchema = z.object({
  locationId: idSchema,
  placeId: idSchema,
  name: z.string().min(1).max(200).refine((name) => name === name.trim()),
  type: z.enum(ROUTE_ANCHOR_TYPES),
  sourceEditionYear: yearSchema.nullable(),
  evidenceIds: z.array(idSchema).min(1).max(64),
}).strict();

export const raceContextV1Schema = z.object({
  schemaVersion: z.literal(RACE_CONTEXT_SCHEMA_VERSION),
  raceId: idSchema,
  editionYear: yearSchema,
  raceName: z.string().min(1).max(200).refine((name) => name === name.trim()).optional(),
  sourceIds: z.array(idSchema).max(256),
  locations: z.array(raceContextLocationSchema).max(2_000),
}).strict();

const routeBoundsComponentSchema = z.object({
  componentIndex: componentIndexSchema,
  startKm: finiteKmSchema,
  endKm: finiteKmSchema,
  traversedDistanceKm: finiteKmSchema,
}).strict();

export const routeAnchorRouteBoundsSchema = z.object({
  routeId: idSchema,
  distanceKm: finiteKmSchema,
  components: z.array(routeBoundsComponentSchema).max(128),
}).strict();

export const routeAnchorEvidenceV1Schema = z.object({
  schemaVersion: z.literal(ROUTE_ANCHOR_EVIDENCE_SCHEMA_VERSION),
  evidenceId: idSchema,
  raceId: idSchema,
  editionYear: yearSchema,
  sourceEditionYear: yearSchema.nullable(),
  sourceId: idSchema.nullable(),
  evidenceKind: z.enum(ROUTE_ANCHOR_EVIDENCE_KINDS),
  provenance: z.enum(ROUTE_ANCHOR_PROVENANCE),
  verificationMethod: z.enum(ROUTE_ANCHOR_VERIFICATION_METHODS),
  positionFact: positionSchema.optional(),
  orderingFact: z.object({ beforeVisitId: idSchema, afterVisitId: idSchema }).strict().optional(),
  measuredOffsetM: z.number().finite().min(0).max(1_000_000).optional(),
  matchingPolicyVersion: z.number().int().min(1).max(10_000).optional(),
  diagnosticCode: idSchema.optional(),
}).strict();

const routeAnchorV1Schema = z.object({
  schemaVersion: z.literal(ROUTE_ANCHOR_SCHEMA_VERSION),
  anchorId: idSchema,
  raceId: idSchema,
  editionYear: yearSchema,
  contextLocationId: idSchema,
  placeId: idSchema,
  visitId: idSchema.nullable(),
  type: z.enum(ROUTE_ANCHOR_TYPES),
  position: positionSchema,
  positionConfidence: z.enum(ROUTE_ANCHOR_POSITION_CONFIDENCE),
  evidenceIds: z.array(idSchema).min(1).max(64),
}).strict();

const orderingConstraintSchema = z.object({
  beforeVisitId: idSchema,
  afterVisitId: idSchema,
  evidenceIds: z.array(idSchema).min(1).max(64),
}).strict();

export const routeAnchorDatasetV1Schema = z.object({
  schemaVersion: z.literal(ROUTE_ANCHOR_SCHEMA_VERSION),
  context: raceContextV1Schema,
  routeBounds: routeAnchorRouteBoundsSchema,
  anchors: z.array(routeAnchorV1Schema).max(10_000),
  evidence: z.array(routeAnchorEvidenceV1Schema).max(20_000),
  orderingConstraints: z.array(orderingConstraintSchema).max(20_000),
}).strict();

export type RouteAnchorType = typeof ROUTE_ANCHOR_TYPES[number];
export type RouteAnchorProvenance = typeof ROUTE_ANCHOR_PROVENANCE[number];
export type RouteAnchorPositionConfidence = typeof ROUTE_ANCHOR_POSITION_CONFIDENCE[number];
export type RouteAnchorPosition = z.infer<typeof positionSchema>;
export type RouteAnchorEvidenceV1 = z.infer<typeof routeAnchorEvidenceV1Schema>;
export type RaceContextV1 = z.infer<typeof raceContextV1Schema>;
export type RouteAnchorRouteBounds = z.infer<typeof routeAnchorRouteBoundsSchema>;
export type RouteAnchorDatasetV1 = z.infer<typeof routeAnchorDatasetV1Schema>;
export type RouteAnchorV1 = RouteAnchorDatasetV1["anchors"][number];

export type RouteAnchorValidationIssue = {
  code: string;
  path: string;
  message: string;
};

export type RouteAnchorValidationResult =
  | { success: true; data: RouteAnchorDatasetV1 }
  | { success: false; issues: RouteAnchorValidationIssue[] };

function issue(code: string, path: string, message: string): RouteAnchorValidationIssue {
  return { code, path, message };
}

function positionComponent(position: RouteAnchorPosition): number | undefined {
  return "componentIndex" in position ? position.componentIndex : undefined;
}

function positionStartKm(position: RouteAnchorPosition): number | undefined {
  if (position.type === "POINT") return position.distanceKm;
  if (position.type === "RANGE") return position.startKm;
  return undefined;
}

function positionEndKm(position: RouteAnchorPosition): number | undefined {
  if (position.type === "POINT") return position.distanceKm;
  if (position.type === "RANGE") return position.endKm;
  return undefined;
}

function samePosition(left: RouteAnchorPosition, right: RouteAnchorPosition): boolean {
  const stable = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
    if (value !== null && typeof value === "object") {
      const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
      return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${stable(child)}`).join(",")}}`;
    }
    return JSON.stringify(value);
  };
  return stable(left) === stable(right);
}

function isHistorical(provenance: RouteAnchorProvenance): boolean {
  return provenance === "previous-edition";
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

export function validateRouteAnchorDataset(value: unknown): RouteAnchorValidationResult {
  const parsed = routeAnchorDatasetV1Schema.safeParse(value);
  if (!parsed.success) {
    return {
      success: false,
      issues: parsed.error.issues.map((entry) => issue(
        `schema.${entry.code}`,
        entry.path.map(String).join("."),
        entry.message,
      )),
    };
  }

  const data = parsed.data;
  const issues: RouteAnchorValidationIssue[] = [];
  const add = (code: string, path: string, message: string) => issues.push(issue(code, path, message));
  const context = data.context;
  const bounds = data.routeBounds;

  if (bounds.components.some((component) => component.endKm < component.startKm
    || Math.abs(component.traversedDistanceKm - (component.endKm - component.startKm)) > 1e-6)) {
    add("bounds.invalid-component-range", "routeBounds.components", "Component bounds or traversed distance are inconsistent.");
  }
  if (bounds.components.some((component) => component.endKm > bounds.distanceKm + 1e-9)) {
    add("bounds.component-outside-route", "routeBounds.components", "A component exceeds total route distance.");
  }
  const componentIds = bounds.components.map((component) => component.componentIndex);
  if (new Set(componentIds).size !== componentIds.length) {
    add("bounds.duplicate-component", "routeBounds.components", "Component indices must be unique.");
  }
  if (bounds.components.some((component, index) => component.componentIndex !== index)) {
    add("bounds.component-index-order", "routeBounds.components", "Components must use contiguous zero-based indices in route order.");
  }
  if (bounds.components.some((component, index) => index > 0
    && (component.startKm < bounds.components[index - 1].startKm || component.endKm < bounds.components[index - 1].endKm))) {
    add("bounds.component-order", "routeBounds.components", "Component bounds must be nondecreasing in route order.");
  }
  if (bounds.components.length === 0 && bounds.distanceKm !== 0) {
    add("bounds.distance-without-components", "routeBounds.distanceKm", "A route without components must have zero distance.");
  }
  if (bounds.components.length > 0 && Math.abs(Math.max(...bounds.components.map((component) => component.endKm)) - bounds.distanceKm) > 1e-6) {
    add("bounds.route-distance-mismatch", "routeBounds.distanceKm", "Route distance must match the last component end.");
  }

  const sourceIds = new Set(context.sourceIds);
  if (sourceIds.size !== context.sourceIds.length) add("context.duplicate-source-id", "context.sourceIds", "Source IDs must be unique.");
  const locationById = new Map(context.locations.map((location) => [location.locationId, location]));
  if (locationById.size !== context.locations.length) add("context.duplicate-location-id", "context.locations", "Location IDs must be unique.");
  for (let index = 0; index < context.locations.length; index += 1) {
    const location = context.locations[index];
    if (location.sourceEditionYear !== null && location.sourceEditionYear >= context.editionYear) {
      add("context.invalid-source-edition", `context.locations.${index}.sourceEditionYear`, "Historical context must refer to an earlier edition.");
    }
  }

  const evidenceById = new Map(data.evidence.map((entry) => [entry.evidenceId, entry]));
  if (evidenceById.size !== data.evidence.length) add("evidence.duplicate-id", "evidence", "Evidence IDs must be unique.");
  for (let index = 0; index < data.evidence.length; index += 1) {
    const evidence = data.evidence[index];
    const path = `evidence.${index}`;
    if (evidence.raceId !== context.raceId) add("evidence.race-mismatch", `${path}.raceId`, "Evidence must belong to the selected race.");
    if (evidence.editionYear !== context.editionYear) add("evidence.edition-mismatch", `${path}.editionYear`, "Evidence must belong to the selected edition.");
    if (evidence.sourceId !== null && !sourceIds.has(evidence.sourceId)) add("evidence.unknown-source", `${path}.sourceId`, "Evidence sourceId must reference Race Context.");
    if (evidence.provenance === "previous-edition") {
      if (evidence.sourceEditionYear === null || evidence.sourceEditionYear >= context.editionYear) {
        add("evidence.invalid-historical-source", `${path}.sourceEditionYear`, "Previous-edition evidence must name an earlier source edition.");
      }
    } else if (evidence.sourceEditionYear !== null && evidence.sourceEditionYear !== context.editionYear) {
      add("evidence.source-edition-misuse", `${path}.sourceEditionYear`, "Only previous-edition evidence may refer to a different edition.");
    }
  }

  for (let index = 0; index < context.locations.length; index += 1) {
    const location = context.locations[index];
    const linkedLocationEvidence = location.evidenceIds.map((evidenceId) => evidenceById.get(evidenceId)).filter((entry): entry is RouteAnchorEvidenceV1 => entry !== undefined);
    if (linkedLocationEvidence.length > 0 && linkedLocationEvidence.every((entry) => entry.provenance === "previous-edition")
      && location.sourceEditionYear === null) {
      add("context.historical-source-unmarked", `context.locations.${index}.sourceEditionYear`, "Context supported only by previous-edition evidence must retain its source edition.");
    }
    for (const evidenceId of context.locations[index].evidenceIds) {
      const evidence = evidenceById.get(evidenceId);
      if (!evidence) add("context.missing-evidence", `context.locations.${index}.evidenceIds`, `Evidence '${evidenceId}' does not exist.`);
      else if (evidence.raceId !== context.raceId || evidence.editionYear !== context.editionYear) {
        add("context.evidence-edition-mismatch", `context.locations.${index}.evidenceIds`, "Race Context evidence must match its race and edition.");
      }
      const sourceEditionYear = context.locations[index].sourceEditionYear;
      if (sourceEditionYear !== null && evidence
        && (evidence.provenance !== "previous-edition" || evidence.sourceEditionYear !== sourceEditionYear)) {
        add("context.source-edition-evidence-mismatch", `context.locations.${index}.evidenceIds`, "Historical Race Context must reference matching previous-edition evidence.");
      }
    }
  }

  for (let index = 0; index < data.evidence.length; index += 1) {
    const evidence = data.evidence[index];
    if (evidence.evidenceKind === "official-text-order" && evidence.orderingFact === undefined) {
      add("evidence.missing-ordering-fact", `evidence.${index}.orderingFact`, "Official text-order evidence must retain its ordered visits.");
    }
    if (evidence.orderingFact !== undefined && evidence.evidenceKind !== "official-text-order") {
      add("evidence.invalid-ordering-kind", `evidence.${index}.orderingFact`, "Ordering facts require official-text-order evidence kind.");
    }
  }

  const componentById = new Map(bounds.components.map((component) => [component.componentIndex, component]));
  const anchorById = new Map(data.anchors.map((anchor) => [anchor.anchorId, anchor]));
  const visitById = new Map<string, RouteAnchorV1>();
  if (anchorById.size !== data.anchors.length) add("anchor.duplicate-id", "anchors", "Anchor IDs must be unique.");

  for (let index = 0; index < data.anchors.length; index += 1) {
    const anchor = data.anchors[index];
    const path = `anchors.${index}`;
    if (anchor.raceId !== context.raceId) add("anchor.race-mismatch", `${path}.raceId`, "Anchor must belong to the Race Context race.");
    if (anchor.editionYear !== context.editionYear) add("anchor.edition-mismatch", `${path}.editionYear`, "Anchor must belong to the Race Context edition.");
    const location = locationById.get(anchor.contextLocationId);
    if (!location) add("anchor.missing-context-location", `${path}.contextLocationId`, "Anchor must reference an existing Race Context location.");
    else {
      if (location.placeId !== anchor.placeId) add("anchor.place-mismatch", `${path}.placeId`, "Anchor placeId must match its Race Context location.");
      if (location.type !== anchor.type) add("anchor.type-mismatch", `${path}.type`, "Anchor type must match its Race Context location.");
      if (location.sourceEditionYear !== null
        && (anchor.positionConfidence === "exact-direct" || anchor.positionConfidence === "verified-match")) {
        add("anchor.historical-context-not-current-position", `${path}.positionConfidence`, "Historical Race Context alone cannot establish a current-edition exact or verified position.");
      }
    }
    if (anchor.visitId !== null) {
      if (visitById.has(anchor.visitId)) add("anchor.duplicate-visit-id", `${path}.visitId`, "Each route visit must have a unique visitId.");
      else visitById.set(anchor.visitId, anchor);
    }
    const pointOrRange = anchor.position.type === "POINT" || anchor.position.type === "RANGE";
    if (anchor.position.type === "UNPOSITIONED" && anchor.visitId !== null) {
      add("anchor.unpositioned-has-visit", `${path}.visitId`, "An unpositioned place cannot claim a route visit identity.");
    }
    if (pointOrRange && anchor.visitId === null) add("anchor.position-missing-visit", `${path}.visitId`, "A positioned route visit requires visitId.");
    if (anchor.position.type === "ORDERED_ONLY" && anchor.visitId === null) add("anchor.ordered-missing-visit", `${path}.visitId`, "An ordered route visit requires visitId.");
    if (anchor.positionConfidence === "context-only" && pointOrRange) add("anchor.context-only-positioned", `${path}.position`, "Context-only anchors cannot carry a point or range.");
    if (anchor.positionConfidence === "exact-direct" && !pointOrRange) add("anchor.exact-without-position", `${path}.position`, "Exact-direct confidence requires a point or range.");
    if (anchor.positionConfidence === "verified-match" && !pointOrRange) add("anchor.verified-without-position", `${path}.position`, "Verified-match confidence requires a point or range.");
    if (anchor.positionConfidence === "approximate" && !pointOrRange) add("anchor.approximate-without-bounds", `${path}.position`, "Approximate confidence requires a bounded point or range.");
    if (anchor.positionConfidence === "conflicting" && anchor.evidenceIds.length < 2) add("anchor.conflict-evidence-insufficient", `${path}.evidenceIds`, "A conflicting anchor must retain at least two evidence references.");
    if ((anchor.type === "START" || anchor.type === "FINISH") && pointOrRange && anchor.position.type !== "POINT") {
      add("anchor.endpoint-requires-point", `${path}.position`, "START and FINISH anchors require a point position.");
    }

    const componentIndex = positionComponent(anchor.position);
    const component = componentIndex === undefined ? undefined : componentById.get(componentIndex);
    if (componentIndex !== undefined && !component) add("anchor.unknown-component", `${path}.position.componentIndex`, "Position references an unknown route component.");
    if (component && anchor.position.type === "POINT"
      && (anchor.position.distanceKm < component.startKm - 1e-9 || anchor.position.distanceKm > component.endKm + 1e-9)) {
      add("anchor.point-outside-component", `${path}.position.distanceKm`, "Point lies outside its component bounds.");
    }
    if (component && anchor.position.type === "RANGE"
      && (anchor.position.endKm <= anchor.position.startKm
        || anchor.position.startKm < component.startKm - 1e-9
        || anchor.position.endKm > component.endKm + 1e-9)) {
      add("anchor.invalid-range", `${path}.position`, "Range must be ordered and lie within its component bounds.");
    }
    if (anchor.type === "START" && anchor.position.type === "POINT") {
      const traversed = bounds.components.filter((item) => item.traversedDistanceKm > 0);
      const first = traversed[0];
      if (!first || anchor.position.componentIndex !== first.componentIndex || Math.abs(anchor.position.distanceKm - first.startKm) > 1e-6) {
        add("anchor.start-not-route-start", `${path}.position`, "A positioned START must match the first traversed component start.");
      }
    }
    if (anchor.type === "FINISH" && anchor.position.type === "POINT") {
      const traversed = bounds.components.filter((item) => item.traversedDistanceKm > 0);
      const last = traversed.at(-1);
      if (!last || anchor.position.componentIndex !== last.componentIndex || Math.abs(anchor.position.distanceKm - last.endKm) > 1e-6) {
        add("anchor.finish-not-route-finish", `${path}.position`, "A positioned FINISH must match the last traversed component end.");
      }
    }

    const linkedEvidence: RouteAnchorEvidenceV1[] = [];
    for (const evidenceId of anchor.evidenceIds) {
      const evidence = evidenceById.get(evidenceId);
      if (!evidence) add("anchor.missing-evidence", `${path}.evidenceIds`, `Evidence '${evidenceId}' does not exist.`);
      else {
        linkedEvidence.push(evidence);
        if (evidence.raceId !== anchor.raceId || evidence.editionYear !== anchor.editionYear) {
          add("anchor.evidence-edition-mismatch", `${path}.evidenceIds`, "Anchor evidence must match its race and edition.");
        }
      }
    }
    const spatialSupport = linkedEvidence.some((evidence) => evidence.positionFact !== undefined
      && samePosition(evidence.positionFact, anchor.position));
    if (pointOrRange && !spatialSupport) add("anchor.position-without-support", `${path}.evidenceIds`, "A positioned anchor requires evidence for its exact position.");
    const matchingPositionEvidence = linkedEvidence.filter((evidence) => evidence.positionFact !== undefined
      && samePosition(evidence.positionFact, anchor.position));
    if (pointOrRange && matchingPositionEvidence.length > 0
      && matchingPositionEvidence.every((evidence) => isHistorical(evidence.provenance))) {
      add("anchor.historical-position-only", `${path}.evidenceIds`, "Previous-edition position evidence alone cannot position a current-edition anchor.");
    }
    if (anchor.positionConfidence === "exact-direct") {
      const directSupport = linkedEvidence.some((evidence) =>
        (evidence.evidenceKind === "official-structured-position" || evidence.evidenceKind === "gpx-waypoint")
        && evidence.positionFact !== undefined
        && samePosition(evidence.positionFact, anchor.position)
        && !isHistorical(evidence.provenance)
        && evidence.provenance !== "estimated"
        && evidence.provenance !== "unknown");
      if (!directSupport) add("anchor.exact-without-direct-evidence", `${path}.evidenceIds`, "Exact-direct position requires current direct structured or GPX evidence.");
    }
    if (anchor.positionConfidence === "verified-match") {
      const verifiedSupport = linkedEvidence.some((evidence) => {
        const methodMatches = evidence.evidenceKind === "geographic-match"
          ? evidence.verificationMethod === "geographic-match"
          : evidence.evidenceKind === "curated-verification" && evidence.verificationMethod === "manual-curation";
        return methodMatches
          && evidence.positionFact !== undefined
          && samePosition(evidence.positionFact, anchor.position)
          && !isHistorical(evidence.provenance)
          && evidence.provenance !== "estimated"
          && evidence.provenance !== "unknown";
      });
      if (!verifiedSupport) add("anchor.verified-without-match-evidence", `${path}.evidenceIds`, "Verified-match requires current geographic-match or curated-verification evidence.");
    }
    if (anchor.positionConfidence === "approximate" && !spatialSupport) {
      add("anchor.approximate-without-support", `${path}.evidenceIds`, "Approximate position requires evidence that supports its bounds.");
    }
    if (anchor.positionConfidence === "approximate" && anchor.position.type === "POINT"
      && !linkedEvidence.some((evidence) => evidence.measuredOffsetM !== undefined)) {
      add("anchor.approximate-point-unbounded", `${path}.position`, "An approximate point requires a measured error bound; otherwise use a range.");
    }
  }

  const graph = new Map<string, Set<string>>();
  const orderingPairs = new Set<string>();
  for (let index = 0; index < data.orderingConstraints.length; index += 1) {
    const constraint = data.orderingConstraints[index];
    const path = `orderingConstraints.${index}`;
    const pair = `${constraint.beforeVisitId}\u0000${constraint.afterVisitId}`;
    if (orderingPairs.has(pair)) add("ordering.duplicate-edge", path, "Ordering constraints must not duplicate an edge.");
    orderingPairs.add(pair);
    const before = visitById.get(constraint.beforeVisitId);
    const after = visitById.get(constraint.afterVisitId);
    if (constraint.beforeVisitId === constraint.afterVisitId) add("ordering.self-reference", path, "A visit cannot be ordered before itself.");
    if (!before) add("ordering.missing-before-visit", `${path}.beforeVisitId`, "Ordering references a missing visit.");
    if (!after) add("ordering.missing-after-visit", `${path}.afterVisitId`, "Ordering references a missing visit.");
    if (before && after) {
      const beforeComponent = positionComponent(before.position);
      const afterComponent = positionComponent(after.position);
      if (beforeComponent !== undefined && afterComponent !== undefined && beforeComponent !== afterComponent) {
        if (beforeComponent > afterComponent) {
          add("ordering.cross-component", path, "Declared visit order contradicts the route component order.");
        }
      }
      const beforeEnd = positionEndKm(before.position);
      const afterStart = positionStartKm(after.position);
      if (beforeComponent !== undefined && beforeComponent === afterComponent
        && beforeEnd !== undefined && afterStart !== undefined && beforeEnd > afterStart + 1e-9) {
        add("ordering.position-contradiction", path, "Declared order contradicts positioned route distances.");
      }
    }
    let hasCurrentOrderingEvidence = false;
    for (const evidenceId of constraint.evidenceIds) {
      const evidence = evidenceById.get(evidenceId);
      if (!evidence) add("ordering.missing-evidence", `${path}.evidenceIds`, `Evidence '${evidenceId}' does not exist.`);
      else if (evidence.evidenceKind !== "official-text-order"
        || evidence.orderingFact?.beforeVisitId !== constraint.beforeVisitId
        || evidence.orderingFact?.afterVisitId !== constraint.afterVisitId) {
        add("ordering.unsupported-edge", `${path}.evidenceIds`, "Ordering edge must be supported by evidence for the same ordered visits.");
      } else if (!isHistorical(evidence.provenance)) {
        hasCurrentOrderingEvidence = true;
      }
    }
    if (!hasCurrentOrderingEvidence) add("ordering.historical-only", `${path}.evidenceIds`, "Previous-edition ordering alone cannot establish current-edition order.");
    if (!graph.has(constraint.beforeVisitId)) graph.set(constraint.beforeVisitId, new Set());
    graph.get(constraint.beforeVisitId)?.add(constraint.afterVisitId);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const hasCycle = (visitId: string): boolean => {
    if (visiting.has(visitId)) return true;
    if (visited.has(visitId)) return false;
    visiting.add(visitId);
    for (const next of graph.get(visitId) ?? []) if (hasCycle(next)) return true;
    visiting.delete(visitId);
    visited.add(visitId);
    return false;
  };
  for (const visitId of graph.keys()) {
    if (hasCycle(visitId)) {
      add("ordering.cycle", "orderingConstraints", "Ordering constraints must be acyclic.");
      break;
    }
  }

  return issues.length > 0
    ? { success: false, issues }
    : { success: true, data: deepFreeze(data) };
}

export type RouteAnchorPositionSafety = "exact" | "qualified" | "none";

export function routeAnchorPositionSafety(anchor: RouteAnchorV1): RouteAnchorPositionSafety {
  if (anchor.positionConfidence === "exact-direct" || anchor.positionConfidence === "verified-match") return "exact";
  if (anchor.positionConfidence === "approximate") return "qualified";
  return "none";
}

export type RouteAnchorIndex = {
  /** Returns position-safe points/ranges on one component; ordered-only and unpositioned facts are excluded. */
  anchorsForComponent(componentIndex: number, options?: { includeConflicting?: boolean }): RouteAnchorV1[];
  /** Uses half-open point ownership [startKm, endKm); only a terminal FINISH is included at the component's final endpoint. Ranges use strict interval overlap. */
  anchorsInRange(componentIndex: number, startKm: number, endKm: number, options?: { includeConflicting?: boolean }): RouteAnchorV1[];
  anchorsNearDistance(componentIndex: number, km: number, toleranceKm: number, options?: { includeConflicting?: boolean }): RouteAnchorV1[];
  anchorById(anchorId: string): RouteAnchorV1 | null;
  visitById(visitId: string): RouteAnchorV1 | null;
  startAnchors(options?: { includeConflicting?: boolean }): RouteAnchorV1[];
  finishAnchors(options?: { includeConflicting?: boolean }): RouteAnchorV1[];
  /** Returns direct ordering edges only; ordering never creates route distances. */
  orderingBefore(visitId: string): string[];
  orderingAfter(visitId: string): string[];
};

function queryPositionStart(position: RouteAnchorPosition): number {
  if (position.type === "POINT") return position.distanceKm;
  if (position.type === "RANGE") return position.startKm;
  return Number.POSITIVE_INFINITY;
}

function compareAnchors(left: RouteAnchorV1, right: RouteAnchorV1): number {
  const leftComponent = positionComponent(left.position) ?? Number.MAX_SAFE_INTEGER;
  const rightComponent = positionComponent(right.position) ?? Number.MAX_SAFE_INTEGER;
  return leftComponent - rightComponent
    || queryPositionStart(left.position) - queryPositionStart(right.position)
    || left.anchorId.localeCompare(right.anchorId);
}

export function createRouteAnchorIndex(value: unknown): RouteAnchorIndex {
  const validation = validateRouteAnchorDataset(value);
  if (!validation.success) {
    throw new TypeError(`Invalid Route Anchor dataset: ${validation.issues.map((entry) => entry.code).join(", ")}`);
  }
  const data = validation.data;
  const anchors = data.anchors;
  const byId = new Map(anchors.map((anchor) => [anchor.anchorId, anchor]));
  const byVisit = new Map(anchors.flatMap((anchor) => anchor.visitId === null ? [] : [[anchor.visitId, anchor] as const]));
  const before = new Map<string, string[]>();
  const after = new Map<string, string[]>();
  for (const constraint of data.orderingConstraints) {
    before.set(constraint.beforeVisitId, [...(before.get(constraint.beforeVisitId) ?? []), constraint.afterVisitId]);
    after.set(constraint.afterVisitId, [...(after.get(constraint.afterVisitId) ?? []), constraint.beforeVisitId]);
  }
  for (const values of [...before.values(), ...after.values()]) values.sort((a, b) => a.localeCompare(b));

  const allowed = (anchor: RouteAnchorV1, includeConflicting = false) =>
    (anchor.position.type === "POINT" || anchor.position.type === "RANGE")
    && (includeConflicting || (anchor.positionConfidence !== "conflicting" && routeAnchorPositionSafety(anchor) !== "none"));
  const query = (predicate: (anchor: RouteAnchorV1) => boolean, includeConflicting = false) =>
    anchors.filter((anchor) => allowed(anchor, includeConflicting) && predicate(anchor)).sort(compareAnchors);
  const validateQueryNumber = (number: number, name: string) => {
    if (!Number.isFinite(number)) throw new RangeError(`${name} must be finite.`);
  };

  return Object.freeze({
    anchorsForComponent(componentIndex: number, options?: { includeConflicting?: boolean }) {
      if (!Number.isSafeInteger(componentIndex) || componentIndex < 0) return [];
      return query((anchor) => positionComponent(anchor.position) === componentIndex, options?.includeConflicting);
    },
    anchorsInRange(componentIndex: number, startKm: number, endKm: number, options?: { includeConflicting?: boolean }) {
      validateQueryNumber(startKm, "startKm");
      validateQueryNumber(endKm, "endKm");
      if (!Number.isSafeInteger(componentIndex) || componentIndex < 0 || startKm < 0 || endKm <= startKm) return [];
      const component = data.routeBounds.components.find((item) => item.componentIndex === componentIndex);
      if (!component) return [];
      return query((anchor) => {
        if (positionComponent(anchor.position) !== componentIndex) return false;
        if (anchor.position.type === "POINT") {
          const terminalFinish = anchor.type === "FINISH" && endKm === component.endKm && anchor.position.distanceKm === component.endKm;
          return anchor.position.distanceKm >= startKm && (anchor.position.distanceKm < endKm || terminalFinish);
        }
        if (anchor.position.type === "RANGE") return anchor.position.startKm < endKm && anchor.position.endKm > startKm;
        return false;
      }, options?.includeConflicting);
    },
    anchorsNearDistance(componentIndex: number, km: number, toleranceKm: number, options?: { includeConflicting?: boolean }) {
      validateQueryNumber(km, "km");
      validateQueryNumber(toleranceKm, "toleranceKm");
      if (!Number.isSafeInteger(componentIndex) || componentIndex < 0 || km < 0 || toleranceKm < 0) return [];
      const lower = km - toleranceKm;
      const upper = km + toleranceKm;
      return query((anchor) => {
        if (positionComponent(anchor.position) !== componentIndex) return false;
        if (anchor.position.type === "POINT") return anchor.position.distanceKm >= lower && anchor.position.distanceKm <= upper;
        if (anchor.position.type === "RANGE") return anchor.position.startKm <= upper && anchor.position.endKm >= lower;
        return false;
      }, options?.includeConflicting);
    },
    anchorById(anchorId: string) { return byId.get(anchorId) ?? null; },
    visitById(visitId: string) { return byVisit.get(visitId) ?? null; },
    startAnchors(options?: { includeConflicting?: boolean }) { return query((anchor) => anchor.type === "START", options?.includeConflicting); },
    finishAnchors(options?: { includeConflicting?: boolean }) { return query((anchor) => anchor.type === "FINISH", options?.includeConflicting); },
    orderingBefore(visitId: string) { return [...(before.get(visitId) ?? [])]; },
    orderingAfter(visitId: string) { return [...(after.get(visitId) ?? [])]; },
  });
}
