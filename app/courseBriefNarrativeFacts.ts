import { z } from "zod";
import { analyzeCoursePhases, COURSE_PHASE_ALGORITHM_VERSION, type CoursePhase, type CoursePhaseCharacter } from "./coursePhaseAnalysis.ts";
import { analyzeCourseNarrative, COURSE_NARRATIVE_ALGORITHM_VERSION, type CourseNarrativeEvent, type CourseNarrativeModel, type CourseNarrativeUnit } from "./courseNarrativeAnalysis.ts";
import type { RouteAnalysisData } from "./gpxAnalysis.ts";
import { findRouteElevationExtremes, selectStructuredRouteKeyMomentEvents } from "./routeKeyMoments.ts";
import { ROUTE_ANALYSIS_VERSION } from "./routePersistence.ts";

export const COURSE_BRIEF_INPUT_SCHEMA_VERSION = 2 as const;
export const NARRATIVE_FACT_SCHEMA_VERSION = 1 as const;
/** Evolution needs at least three consecutive phases and a route-relative 25% end-to-end intensity reduction. */
export const MINIMUM_EVOLUTION_PHASE_COUNT = 3 as const;
export const MINIMUM_EVOLUTION_REDUCTION_RATIO = 0.25 as const;
/** CoursePhase intensity is rounded to tenths, so smaller step differences are below its measurement resolution. */
export const MINIMUM_EVOLUTION_STEP_M_PER_KM = 0.1 as const;

export type NarrativeFactCategory = "direct-structural" | "bounded-interpretation";
export type NarrativeFactEligibilityReason = "eligible-structural-fact" | "eligible-anchor-support" | "brief-interruption-policy-conservative";
export type NarrativeFactFamily = "unit-character" | "transition" | "evolution" | "finish-character" | "anchor" | "interruption";

type NarrativeFactBase = {
  factId: string;
  schemaVersion: typeof NARRATIVE_FACT_SCHEMA_VERSION;
  category: NarrativeFactCategory;
  segmentIndex: number;
  courseOrder: number;
  startKm: number;
  endKm: number;
  narrativeGroupId: string;
  redundancyFamily: NarrativeFactFamily;
  groupRole: "primary" | "supporting";
  eligibility: { selectable: boolean; reasonCode: NarrativeFactEligibilityReason };
};

export type NarrativeFact =
  | (NarrativeFactBase & { type: "UNIT_CHARACTER"; unitId: string; character: CoursePhaseCharacter | "evolving" })
  | (NarrativeFactBase & {
      type: "STRUCTURAL_TRANSITION"; transitionId: string; fromUnitId: string; toUnitId: string;
      fromPhaseId: string; toPhaseId: string; fromCharacter: CoursePhaseCharacter; toCharacter: CoursePhaseCharacter;
      boundaryKm: number; beforeIntensityMPerKm: number; afterIntensityMPerKm: number; reasonCodes: string[];
    })
  | (NarrativeFactBase & {
      type: "VERTICAL_INTENSITY_EVOLUTION"; direction: "decreasing"; phaseIds: string[]; unitIds: string[];
      valuesMPerKm: number[]; reductionRatio: number; reasonCode: "consecutive-phase-intensity-decline";
    })
  | (NarrativeFactBase & {
      type: "PERSISTENT_FINISH_CHARACTER"; unitId: string; phaseId: string; character: CoursePhaseCharacter;
      componentEndKm: number; reasonCode: "character-persists-to-component-finish";
    })
  | (NarrativeFactBase & {
      type: "ANCHOR_WITHIN_UNIT"; unitId: string; sourceId: string; sourceFactId: string; anchorKind: "key-moment" | "highest" | "lowest";
      eventKind: "climb" | "descent" | null; roles: Array<"longest" | "largest">;
      measurements: { distanceKm: number | null; elevationChangeM: number | null; elevationM: number | null };
    })
  | (NarrativeFactBase & {
      type: "SIGNIFICANT_INTERRUPTION"; unitId: string; eventId: string; eventKind: "climb" | "descent";
      narrativeTier: "supporting-interruption" | "context-only"; ascentM: number; descentM: number;
      reasonCode: "brief-interruption-policy-conservative";
    });

export type CourseBriefInputV2 = {
  schemaVersion: typeof COURSE_BRIEF_INPUT_SCHEMA_VERSION;
  versions: {
    routeAnalysis: number;
    coursePhase: typeof COURSE_PHASE_ALGORITHM_VERSION;
    courseNarrative: typeof COURSE_NARRATIVE_ALGORITHM_VERSION;
    narrativeFactSchema: typeof NARRATIVE_FACT_SCHEMA_VERSION;
  };
  route: {
    distanceKm: number;
    components: Array<{ segmentIndex: number; startKm: number; endKm: number; traversedDistanceKm: number }>;
  };
  phases: Array<{
    phaseId: string; segmentIndex: number; startKm: number; endKm: number; character: CoursePhaseCharacter;
    verticalIntensityMPerKm: number; ascentM: number; descentM: number;
  }>;
  units: Array<{
    unitId: string; ordinal: number; segmentIndex: number; startKm: number; endKm: number;
    phaseIds: string[]; character: CourseNarrativeUnit["structuralPattern"];
  }>;
  facts: NarrativeFact[];
};

export type CourseBriefNarrativeSource = Pick<RouteAnalysisData, "metrics" | "segments" | "points" | "routeSections" | "routeDynamics">;

const segmentIndexSchema = z.number().int().min(0).max(127);
const idSchema = z.string().min(1).max(240).regex(/^[a-zA-Z0-9._:-]+$/);
const kmSchema = z.number().finite().min(0).max(10_000);
const measureSchema = z.number().finite().min(0).max(100_000);
const characterSchema = z.enum(["climb-dominant", "descent-dominant", "repeated-vertical", "low-vertical", "mixed"]);
const patternSchema = z.enum(["climb-dominant", "descent-dominant", "repeated-vertical", "low-vertical", "mixed", "evolving"]);
const commonSchema = z.object({
  factId: idSchema,
  schemaVersion: z.literal(NARRATIVE_FACT_SCHEMA_VERSION),
  category: z.enum(["direct-structural", "bounded-interpretation"]),
  segmentIndex: segmentIndexSchema,
  courseOrder: z.number().int().min(1).max(100_000),
  startKm: kmSchema,
  endKm: kmSchema,
  narrativeGroupId: idSchema,
  redundancyFamily: z.enum(["unit-character", "transition", "evolution", "finish-character", "anchor", "interruption"]),
  groupRole: z.enum(["primary", "supporting"]),
  eligibility: z.object({ selectable: z.boolean(), reasonCode: z.enum([
    "eligible-structural-fact", "eligible-anchor-support", "brief-interruption-policy-conservative",
  ]) }).strict(),
}).strict();

const narrativeFactSchema = z.discriminatedUnion("type", [
  commonSchema.extend({ type: z.literal("UNIT_CHARACTER"), unitId: idSchema, character: patternSchema }),
  commonSchema.extend({
    type: z.literal("STRUCTURAL_TRANSITION"), transitionId: idSchema, fromUnitId: idSchema, toUnitId: idSchema,
    fromPhaseId: idSchema, toPhaseId: idSchema, fromCharacter: characterSchema, toCharacter: characterSchema,
    boundaryKm: kmSchema, beforeIntensityMPerKm: measureSchema, afterIntensityMPerKm: measureSchema,
    reasonCodes: z.array(z.enum(["directional-reversal", "persistent-character-after-transition", "key-moment-near-transition", "character-persists-to-component-finish"])).min(1).max(4),
  }),
  commonSchema.extend({
    type: z.literal("VERTICAL_INTENSITY_EVOLUTION"), direction: z.literal("decreasing"),
    phaseIds: z.array(idSchema).min(MINIMUM_EVOLUTION_PHASE_COUNT).max(128), unitIds: z.array(idSchema).min(1).max(128),
    valuesMPerKm: z.array(measureSchema).min(MINIMUM_EVOLUTION_PHASE_COUNT).max(128), reductionRatio: z.number().finite().min(0).max(1),
    reasonCode: z.literal("consecutive-phase-intensity-decline"),
  }),
  commonSchema.extend({
    type: z.literal("PERSISTENT_FINISH_CHARACTER"), unitId: idSchema, phaseId: idSchema, character: characterSchema,
    componentEndKm: kmSchema, reasonCode: z.literal("character-persists-to-component-finish"),
  }),
  commonSchema.extend({
    type: z.literal("ANCHOR_WITHIN_UNIT"), unitId: idSchema, sourceId: idSchema, sourceFactId: idSchema,
    anchorKind: z.enum(["key-moment", "highest", "lowest"]), eventKind: z.enum(["climb", "descent"]).nullable(),
    roles: z.array(z.enum(["longest", "largest"])).max(2),
    measurements: z.object({ distanceKm: measureSchema.nullable(), elevationChangeM: measureSchema.nullable(),
      elevationM: z.number().finite().min(-1000).max(10_000).nullable() }).strict(),
  }),
  commonSchema.extend({
    type: z.literal("SIGNIFICANT_INTERRUPTION"), unitId: idSchema, eventId: idSchema,
    eventKind: z.enum(["climb", "descent"]), narrativeTier: z.enum(["supporting-interruption", "context-only"]),
    ascentM: measureSchema, descentM: measureSchema, reasonCode: z.literal("brief-interruption-policy-conservative"),
  }),
]);

export const courseBriefInputV2Schema = z.object({
  schemaVersion: z.literal(COURSE_BRIEF_INPUT_SCHEMA_VERSION),
  versions: z.object({ routeAnalysis: z.number().int().min(1).max(10_000), coursePhase: z.literal(COURSE_PHASE_ALGORITHM_VERSION),
    courseNarrative: z.literal(COURSE_NARRATIVE_ALGORITHM_VERSION), narrativeFactSchema: z.literal(NARRATIVE_FACT_SCHEMA_VERSION) }).strict(),
  route: z.object({ distanceKm: kmSchema, components: z.array(z.object({ segmentIndex: segmentIndexSchema, startKm: kmSchema, endKm: kmSchema, traversedDistanceKm: kmSchema }).strict()).min(1).max(128) }).strict(),
  phases: z.array(z.object({ phaseId: idSchema, segmentIndex: segmentIndexSchema, startKm: kmSchema, endKm: kmSchema,
    character: characterSchema, verticalIntensityMPerKm: measureSchema, ascentM: measureSchema, descentM: measureSchema }).strict()).max(512),
  units: z.array(z.object({ unitId: idSchema, ordinal: z.number().int().min(1).max(512), segmentIndex: segmentIndexSchema,
    startKm: kmSchema, endKm: kmSchema, phaseIds: z.array(idSchema).min(1).max(128), character: patternSchema }).strict()).max(512),
  facts: z.array(narrativeFactSchema).max(10_000),
}).strict();

export type CourseBriefInputV2ValidationError = "malformed_input" | "inconsistent_input" | "duplicate_fact_id";
export type CourseBriefInputV2ValidationResult = { ok: true; input: CourseBriefInputV2 } | { ok: false; error: CourseBriefInputV2ValidationError };

/** Derives Course Phases, Narrative Units, and compact Narrative Facts from a route analysis. */
export function buildCourseBriefInputV2(analysis: CourseBriefNarrativeSource, analysisVersion = ROUTE_ANALYSIS_VERSION): CourseBriefInputV2 {
  if (!Number.isInteger(analysisVersion) || analysisVersion < 1) throw new Error("CourseBriefInputV2 requires a valid analysis version.");
  const phaseAnalysis = analyzeCoursePhases(analysis.routeSections);
  const moments = selectStructuredRouteKeyMomentEvents(analysis.routeDynamics);
  const extremes = findRouteElevationExtremes(analysis.points);
  const narrative = analyzeCourseNarrative({
    phases: phaseAnalysis.phases,
    transitions: phaseAnalysis.transitions,
    routeSections: analysis.routeSections,
    keyMoments: moments,
    extrema: [
      { kind: "highest", segmentIndex: extremes.highest.point.segmentIndex, atKm: extremes.highest.point.distanceM / 1000, elevationM: extremes.highest.elevationM },
      { kind: "lowest", segmentIndex: extremes.lowest.point.segmentIndex, atKm: extremes.lowest.point.distanceM / 1000, elevationM: extremes.lowest.elevationM },
    ],
  });
  const components = analysis.segments.map((segment) => ({
    segmentIndex: segment.segmentIndex, startKm: roundKm(segment.startDistanceM / 1000), endKm: roundKm(segment.endDistanceM / 1000),
    traversedDistanceKm: roundKm((segment.endDistanceM - segment.startDistanceM) / 1000),
  }));
  return projectCourseBriefInputV2(analysis.metrics.distanceKm, components, phaseAnalysis.phases, narrative, analysisVersion);
}

/** Projects supplied deterministic phase/narrative outputs; useful for fixtures and offline reproducibility. */
export function projectCourseBriefInputV2(
  distanceKm: number,
  components: CourseBriefInputV2["route"]["components"],
  phases: readonly CoursePhase[],
  narrative: CourseNarrativeModel,
  analysisVersion = ROUTE_ANALYSIS_VERSION,
): CourseBriefInputV2 {
  const phaseById = new Map(phases.map((phase) => [phase.id, phase]));
  const units = [...narrative.units].sort(compareUnits).map((unit, index) => ({
    unitId: unit.id, ordinal: index + 1, segmentIndex: unit.segmentIndex, startKm: unit.startKm, endKm: unit.endKm,
    phaseIds: [...unit.phaseIds], character: unit.structuralPattern,
  }));
  const unitById = new Map(units.map((unit) => [unit.unitId, unit]));
  const phaseToUnit = new Map<string, string>();
  for (const unit of units) for (const phaseId of unit.phaseIds) phaseToUnit.set(phaseId, unit.unitId);
  const facts: NarrativeFact[] = [];

  for (const unit of narrative.units) {
    facts.push(makeBase({
      factId: `narrative-fact.unit.${unit.id}`, type: "UNIT_CHARACTER", category: "direct-structural", segmentIndex: unit.segmentIndex,
      startKm: unit.startKm, endKm: unit.endKm, narrativeGroupId: `narrative-group.${unit.id}`, redundancyFamily: "unit-character",
      groupRole: "primary", eligibility: eligible("eligible-structural-fact"), unitId: unit.id, character: unit.structuralPattern,
    }));
  }

  for (const transition of narrative.transitions.filter((item) => item.significance === "significant")) {
    const unit = unitById.get(transition.fromUnitId);
    if (!unit) continue;
    facts.push(makeBase({
      factId: `narrative-fact.transition.${transition.id}`, type: "STRUCTURAL_TRANSITION", category: "direct-structural",
      segmentIndex: transition.segmentIndex, startKm: transition.boundaryKm, endKm: transition.boundaryKm,
      narrativeGroupId: `narrative-group.transition.${transition.id}`, redundancyFamily: "transition", groupRole: "primary",
      eligibility: eligible("eligible-structural-fact"), transitionId: transition.id, fromUnitId: transition.fromUnitId,
      toUnitId: transition.toUnitId, fromPhaseId: transition.fromPhaseId, toPhaseId: transition.toPhaseId,
      fromCharacter: transition.fromCharacter, toCharacter: transition.toCharacter, boundaryKm: transition.boundaryKm,
      beforeIntensityMPerKm: transition.verticalIntensityBeforeMPerKm, afterIntensityMPerKm: transition.verticalIntensityAfterMPerKm,
      reasonCodes: [...transition.reasonCodes],
    }));
  }

  const orderedPhases = [...phases].sort(comparePhases);
  for (const sequence of findDecreasingIntensitySequences(orderedPhases)) {
    const first = sequence[0]; const last = sequence.at(-1)!;
    const unitIds = unique(sequence.flatMap((phase) => phaseToUnit.has(phase.id) ? [phaseToUnit.get(phase.id)!] : []));
    if (unitIds.length === 0) continue;
    facts.push(makeBase({
      factId: `narrative-fact.evolution.decreasing.${sequence[0].id}.${last.id}`, type: "VERTICAL_INTENSITY_EVOLUTION",
      category: "bounded-interpretation", segmentIndex: first.segmentIndex, startKm: first.startKm, endKm: last.endKm,
      narrativeGroupId: `narrative-group.evolution.s${first.segmentIndex}.${first.id}`, redundancyFamily: "evolution", groupRole: "supporting",
      eligibility: eligible("eligible-structural-fact"), direction: "decreasing", phaseIds: sequence.map((phase) => phase.id), unitIds,
      valuesMPerKm: sequence.map((phase) => phase.verticalIntensityMPerKm),
      reductionRatio: reductionRatio(sequence[0].verticalIntensityMPerKm, last.verticalIntensityMPerKm),
      reasonCode: "consecutive-phase-intensity-decline",
    }));
  }

  for (const evolution of narrative.evolutionFacts) {
    if (evolution.type !== "low-vertical-to-component-finish") continue;
    const phase = phaseById.get(evolution.phaseIds[0]);
    const unitId = phaseToUnit.get(evolution.phaseIds[0]);
    if (!phase || !unitId || phase.character !== "low-vertical") continue;
    const component = components.find((item) => item.segmentIndex === phase.segmentIndex);
    if (!component || !close(phase.endKm, component.endKm)) continue;
    facts.push(makeBase({
      factId: `narrative-fact.finish.${phase.id}`, type: "PERSISTENT_FINISH_CHARACTER", category: "direct-structural",
      segmentIndex: phase.segmentIndex, startKm: phase.startKm, endKm: phase.endKm,
      narrativeGroupId: `narrative-group.${unitId}`, redundancyFamily: "finish-character", groupRole: "supporting",
      eligibility: eligible("eligible-structural-fact"), unitId, phaseId: phase.id, character: phase.character,
      componentEndKm: component.endKm, reasonCode: "character-persists-to-component-finish",
    }));
  }

  for (const event of narrative.events.filter((item) => item.tier === "anchor")) {
    if (event.unitIds.length !== 1 || event.keyMomentRoles.length === 0) continue;
    const unit = unitById.get(event.unitIds[0]);
    if (!unit || unit.segmentIndex !== event.segmentIndex || !rangeWithin(event.startKm, event.endKm, unit.startKm, unit.endKm)) continue;
    facts.push(makeBase({
      factId: `narrative-fact.anchor.${event.id}`, type: "ANCHOR_WITHIN_UNIT", category: "direct-structural",
      segmentIndex: event.segmentIndex, startKm: event.startKm, endKm: event.endKm,
      narrativeGroupId: `narrative-group.${unit.unitId}`, redundancyFamily: "anchor", groupRole: "supporting",
      eligibility: eligible("eligible-anchor-support"), unitId: unit.unitId, sourceId: event.sourceEventId, anchorKind: "key-moment",
      sourceFactId: `key.${event.kind}.s${event.segmentIndex}.${event.sourceEventId}`,
      eventKind: event.kind === "climb" || event.kind === "descent" ? event.kind : null,
      roles: [...event.keyMomentRoles].sort(roleOrder),
      measurements: { distanceKm: event.endKm - event.startKm, elevationChangeM: event.kind === "climb" ? event.ascentM : event.descentM, elevationM: null },
    }));
  }
  for (const extreme of narrative.routeExtrema) {
    if (!extreme.unitId) continue;
    const unit = unitById.get(extreme.unitId);
    if (!unit || unit.segmentIndex !== extreme.segmentIndex || !rangeWithin(extreme.atKm, extreme.atKm, unit.startKm, unit.endKm)) continue;
    facts.push(makeBase({
      factId: `narrative-fact.anchor.extreme.${extreme.kind}.s${extreme.segmentIndex}.${numberToken(extreme.atKm)}`,
      type: "ANCHOR_WITHIN_UNIT", category: "direct-structural", segmentIndex: extreme.segmentIndex,
      startKm: extreme.atKm, endKm: extreme.atKm, narrativeGroupId: `narrative-group.${unit.unitId}`,
      redundancyFamily: "anchor", groupRole: "supporting", eligibility: eligible("eligible-anchor-support"), unitId: unit.unitId,
      sourceId: `extreme:${extreme.kind}:${extreme.segmentIndex}:${numberToken(extreme.atKm)}`,
      sourceFactId: `route.extreme.${extreme.kind}.s${extreme.segmentIndex}.${numberToken(extreme.atKm)}`,
      anchorKind: extreme.kind, eventKind: null, roles: [],
      measurements: { distanceKm: null, elevationChangeM: null, elevationM: extreme.elevationM },
    }));
  }

  for (const event of narrative.events.filter(isInterruptionCandidate)) {
    if (event.tier === "anchor") continue;
    if (event.unitIds.length !== 1) continue;
    const unit = unitById.get(event.unitIds[0]);
    if (!unit || unit.segmentIndex !== event.segmentIndex || !rangeWithin(event.startKm, event.endKm, unit.startKm, unit.endKm)) continue;
    facts.push(makeBase({
      factId: `narrative-fact.interruption.${event.id}`, type: "SIGNIFICANT_INTERRUPTION", category: "bounded-interpretation",
      segmentIndex: event.segmentIndex, startKm: event.startKm, endKm: event.endKm,
      narrativeGroupId: `narrative-group.${unit.unitId}`, redundancyFamily: "interruption", groupRole: "supporting",
      eligibility: { selectable: false, reasonCode: "brief-interruption-policy-conservative" }, unitId: unit.unitId,
      eventId: event.sourceEventId, eventKind: event.kind as "climb" | "descent", narrativeTier: event.tier,
      ascentM: event.ascentM, descentM: event.descentM, reasonCode: "brief-interruption-policy-conservative",
    }));
  }

  facts.sort(compareFacts);
  facts.forEach((fact, index) => { fact.courseOrder = index + 1; });
  const input: CourseBriefInputV2 = {
    schemaVersion: COURSE_BRIEF_INPUT_SCHEMA_VERSION,
    versions: { routeAnalysis: analysisVersion, coursePhase: COURSE_PHASE_ALGORITHM_VERSION,
      courseNarrative: COURSE_NARRATIVE_ALGORITHM_VERSION, narrativeFactSchema: NARRATIVE_FACT_SCHEMA_VERSION },
    route: { distanceKm, components: [...components].sort((a, b) => a.segmentIndex - b.segmentIndex) },
    phases: orderedPhases.map((phase) => ({ phaseId: phase.id, segmentIndex: phase.segmentIndex, startKm: phase.startKm, endKm: phase.endKm,
      character: phase.character, verticalIntensityMPerKm: phase.verticalIntensityMPerKm, ascentM: phase.ascentM, descentM: phase.descentM })),
    units,
    facts,
  };
  const validation = validateCourseBriefInputV2(input);
  if (!validation.ok) throw new Error(`CourseBriefInputV2 projection failed validation: ${validation.error}`);
  return validation.input;
}

export function validateCourseBriefInputV2(value: unknown): CourseBriefInputV2ValidationResult {
  const parsed = courseBriefInputV2Schema.safeParse(value);
  if (!parsed.success) return { ok: false, error: "malformed_input" };
  const input = parsed.data as CourseBriefInputV2;
  const ids = [
    ...input.phases.map((phase) => phase.phaseId), ...input.units.map((unit) => unit.unitId), ...input.facts.map((fact) => fact.factId),
  ];
  if (new Set(ids).size !== ids.length) return { ok: false, error: "duplicate_fact_id" };
  if (!validateV2Relationships(input)) return { ok: false, error: "inconsistent_input" };
  return { ok: true, input };
}

function validateV2Relationships(input: CourseBriefInputV2): boolean {
  const { components } = input.route;
  if (components.some((component, index) => component.segmentIndex !== index || component.endKm < component.startKm ||
    !close(component.endKm - component.startKm, component.traversedDistanceKm) ||
    (index > 0 && !close(component.startKm, components[index - 1].endKm)))) return false;
  if (!components.length || !close(components.at(-1)!.endKm, input.route.distanceKm, 0.02)) return false;
  const componentByIndex = new Map(components.map((component) => [component.segmentIndex, component]));
  const phaseById = new Map(input.phases.map((phase) => [phase.phaseId, phase]));
  const unitById = new Map(input.units.map((unit) => [unit.unitId, unit]));
  if (phaseById.size !== input.phases.length || unitById.size !== input.units.length) return false;
  if (input.phases.some((phase, index) => {
    const component = componentByIndex.get(phase.segmentIndex);
    const previous = input.phases[index - 1];
    return !component || phase.endKm < phase.startKm || phase.startKm < component.startKm - 0.01 || phase.endKm > component.endKm + 0.01 ||
      !close(phase.verticalIntensityMPerKm * 10, Math.round(phase.verticalIntensityMPerKm * 10)) ||
      (previous && comparePhaseRecords(previous, phase) > 0);
  })) return false;
  if (input.units.some((unit, index) => {
    const component = componentByIndex.get(unit.segmentIndex);
    const previous = input.units[index - 1];
    return unit.ordinal !== index + 1 || !component || unit.endKm < unit.startKm || unit.startKm < component.startKm - 0.01 ||
      unit.endKm > component.endKm + 0.01 || (previous && compareUnitRecords(previous, unit) > 0) ||
      unit.phaseIds.some((phaseId) => {
        const phase = phaseById.get(phaseId);
        return !phase || phase.segmentIndex !== unit.segmentIndex || phase.startKm < unit.startKm - 0.01 || phase.endKm > unit.endKm + 0.01;
      }) || new Set(unit.phaseIds).size !== unit.phaseIds.length;
  })) return false;
  const phaseOwner = new Map<string, string>();
  for (const unit of input.units) for (const phaseId of unit.phaseIds) {
    if (phaseOwner.has(phaseId)) return false;
    phaseOwner.set(phaseId, unit.unitId);
  }
  if (phaseOwner.size !== input.phases.length) return false;
  for (const unit of input.units) {
    const selected = unit.phaseIds.map((phaseId) => phaseById.get(phaseId)!);
    if (!close(unit.startKm, selected[0].startKm) || !close(unit.endKm, selected.at(-1)!.endKm) ||
      (selected.length === 1 ? unit.character !== selected[0].character : unit.character !== "evolving") ||
      selected.some((phase, index) => index > 0 && (!close(selected[index - 1].endKm, phase.startKm) || comparePhaseRecords(selected[index - 1], phase) >= 0))) return false;
  }
  for (let index = 0; index < input.facts.length; index += 1) {
    const fact = input.facts[index];
    if (fact.courseOrder !== index + 1 || (index > 0 && compareFacts(input.facts[index - 1], fact) > 0)) return false;
    const component = componentByIndex.get(fact.segmentIndex);
    if (!component || fact.endKm < fact.startKm || fact.startKm < component.startKm - 0.01 || fact.endKm > component.endKm + 0.01) return false;
    const unitFact = "unitId" in fact ? unitById.get(fact.unitId) : null;
    if ("unitId" in fact && (!unitFact || unitFact.segmentIndex !== fact.segmentIndex || !rangeWithin(fact.startKm, fact.endKm, unitFact.startKm, unitFact.endKm))) return false;
    if (fact.type === "UNIT_CHARACTER" && (fact.category !== "direct-structural" || unitFact?.character !== fact.character ||
      fact.factId !== `narrative-fact.unit.${fact.unitId}` ||
      fact.redundancyFamily !== "unit-character" || fact.groupRole !== "primary" || fact.narrativeGroupId !== `narrative-group.${fact.unitId}` ||
      fact.eligibility.selectable !== true || fact.eligibility.reasonCode !== "eligible-structural-fact")) return false;
    if (fact.type === "STRUCTURAL_TRANSITION") {
      const from = unitById.get(fact.fromUnitId); const to = unitById.get(fact.toUnitId);
      const fromPhase = phaseById.get(fact.fromPhaseId); const toPhase = phaseById.get(fact.toPhaseId);
      const orderedPhases = [...input.phases].sort(comparePhaseRecords);
      const fromIndex = orderedPhases.findIndex((phase) => phase.phaseId === fact.fromPhaseId);
      if (!from || !to || !fromPhase || !toPhase || fact.segmentIndex !== from.segmentIndex || fact.segmentIndex !== to.segmentIndex ||
        fact.factId !== `narrative-fact.transition.${fact.transitionId}` ||
        !from.phaseIds.includes(fact.fromPhaseId) || !to.phaseIds.includes(fact.toPhaseId) || fromPhase.segmentIndex !== toPhase.segmentIndex ||
        fromIndex < 0 || orderedPhases[fromIndex + 1]?.phaseId !== fact.toPhaseId ||
        !close(fact.boundaryKm, fact.startKm) || !close(fact.boundaryKm, fact.endKm) || !close(fromPhase.endKm, fact.boundaryKm) ||
        !close(toPhase.startKm, fact.boundaryKm) || fromPhase.character !== fact.fromCharacter || toPhase.character !== fact.toCharacter ||
        !close(fromPhase.verticalIntensityMPerKm, fact.beforeIntensityMPerKm) || !close(toPhase.verticalIntensityMPerKm, fact.afterIntensityMPerKm) ||
        fact.category !== "direct-structural" || fact.redundancyFamily !== "transition" || fact.groupRole !== "primary" ||
        fact.eligibility.selectable !== true || fact.eligibility.reasonCode !== "eligible-structural-fact") return false;
    }
    if (fact.type === "VERTICAL_INTENSITY_EVOLUTION") {
      const selected = fact.phaseIds.map((phaseId) => phaseById.get(phaseId));
      if (selected.some((phase) => !phase) || selected.length !== fact.valuesMPerKm.length || new Set(fact.phaseIds).size !== fact.phaseIds.length) return false;
      const actual = selected as NonNullable<(typeof selected)[number]>[];
      if (actual.length < MINIMUM_EVOLUTION_PHASE_COUNT || actual.some((phase, at) => phase.segmentIndex !== fact.segmentIndex ||
        (at > 0 && (!close(actual[at - 1].endKm, phase.startKm) ||
          actual[at - 1].verticalIntensityMPerKm - phase.verticalIntensityMPerKm + 1e-9 < MINIMUM_EVOLUTION_STEP_M_PER_KM)) ||
        !close(phase.verticalIntensityMPerKm, fact.valuesMPerKm[at]))) return false;
      const ratio = reductionRatio(actual[0].verticalIntensityMPerKm, actual.at(-1)!.verticalIntensityMPerKm);
      const expectedUnitIds = unique(actual.map((phase) => phaseOwner.get(phase.phaseId) ?? ""));
      if (ratio < MINIMUM_EVOLUTION_REDUCTION_RATIO || !close(ratio, fact.reductionRatio, 0.000001) ||
        fact.factId !== `narrative-fact.evolution.decreasing.${fact.phaseIds[0]}.${fact.phaseIds.at(-1)}` ||
        !sameOrderedMembers(fact.unitIds, expectedUnitIds) ||
        !close(fact.startKm, actual[0].startKm) || !close(fact.endKm, actual.at(-1)!.endKm) ||
        fact.category !== "bounded-interpretation" || fact.redundancyFamily !== "evolution" || fact.groupRole !== "supporting" ||
        fact.reasonCode !== "consecutive-phase-intensity-decline" || fact.eligibility.selectable !== true) return false;
    }
    if (fact.type === "PERSISTENT_FINISH_CHARACTER") {
      const phase = phaseById.get(fact.phaseId);
      if (!phase || phase.segmentIndex !== fact.segmentIndex || !unitFact?.phaseIds.includes(fact.phaseId) || phase.character !== fact.character ||
        fact.factId !== `narrative-fact.finish.${fact.phaseId}` ||
        fact.character !== "low-vertical" || !close(phase.endKm, component.endKm) || !close(fact.componentEndKm, component.endKm) ||
        fact.category !== "direct-structural" || fact.redundancyFamily !== "finish-character" || fact.groupRole !== "supporting" ||
        fact.narrativeGroupId !== `narrative-group.${fact.unitId}` || fact.eligibility.selectable !== true) return false;
    }
    if (fact.type === "ANCHOR_WITHIN_UNIT") {
      if (fact.category !== "direct-structural" || fact.redundancyFamily !== "anchor" || fact.groupRole !== "supporting" ||
        fact.narrativeGroupId !== `narrative-group.${fact.unitId}` || fact.eligibility.selectable !== true || fact.eligibility.reasonCode !== "eligible-anchor-support") return false;
      const values = fact.measurements;
      if (fact.anchorKind === "key-moment" && (!fact.eventKind || fact.roles.length === 0 || values.distanceKm === null || values.elevationChangeM === null || values.elevationM !== null ||
        (fact.roles.length === 2 && (fact.roles[0] !== "longest" || fact.roles[1] !== "largest")) ||
        fact.factId !== `narrative-fact.anchor.narrative-event-s${fact.segmentIndex}-${fact.sourceId}` ||
        fact.sourceFactId !== `key.${fact.eventKind}.s${fact.segmentIndex}.${fact.sourceId}`)) return false;
      if ((fact.anchorKind === "highest" || fact.anchorKind === "lowest") && (fact.eventKind !== null || fact.roles.length !== 0 || values.elevationM === null ||
        values.distanceKm !== null || values.elevationChangeM !== null || fact.startKm !== fact.endKm ||
        fact.factId !== `narrative-fact.anchor.extreme.${fact.anchorKind}.s${fact.segmentIndex}.${numberToken(fact.startKm)}` ||
        fact.sourceFactId !== `route.extreme.${fact.anchorKind}.s${fact.segmentIndex}.${numberToken(fact.startKm)}`)) return false;
    }
    if (fact.type === "SIGNIFICANT_INTERRUPTION" && (fact.eligibility.selectable !== false ||
      fact.eligibility.reasonCode !== "brief-interruption-policy-conservative" || fact.reasonCode !== "brief-interruption-policy-conservative" ||
      fact.factId !== `narrative-fact.interruption.narrative-event-s${fact.segmentIndex}-${fact.eventId}` ||
      fact.category !== "bounded-interpretation" || fact.redundancyFamily !== "interruption" || fact.groupRole !== "supporting" ||
      fact.narrativeGroupId !== `narrative-group.${fact.unitId}` || fact.ascentM + fact.descentM <= 0)) return false;
  }
  return true;
}

export type CourseBriefNarrativeFactIndex = {
  byId: ReadonlyMap<string, NarrativeFact>;
  orderedFacts: readonly NarrativeFact[];
  eligibleFacts: readonly NarrativeFact[];
};

export function buildCourseBriefNarrativeFactIndex(input: CourseBriefInputV2): CourseBriefNarrativeFactIndex | null {
  const validation = validateCourseBriefInputV2(input);
  if (!validation.ok) return null;
  const orderedFacts = [...validation.input.facts];
  const byId = new Map(orderedFacts.map((fact) => [fact.factId, fact]));
  if (byId.size !== orderedFacts.length) return null;
  return { byId, orderedFacts, eligibleFacts: orderedFacts.filter((fact) => fact.eligibility.selectable) };
}

export function findDecreasingIntensitySequences(phases: readonly CoursePhase[]): CoursePhase[][] {
  const output: CoursePhase[][] = [];
  const grouped = new Map<number, CoursePhase[]>();
  for (const phase of [...phases].sort(comparePhases)) {
    const component = grouped.get(phase.segmentIndex) ?? [];
    component.push(phase); grouped.set(phase.segmentIndex, component);
  }
  for (const component of grouped.values()) {
    let start = 0;
    while (start <= component.length - MINIMUM_EVOLUTION_PHASE_COUNT) {
      let end = start + 1;
      while (end < component.length && close(component[end - 1].endKm, component[end].startKm) &&
        component[end - 1].verticalIntensityMPerKm - component[end].verticalIntensityMPerKm + 1e-9 >= MINIMUM_EVOLUTION_STEP_M_PER_KM) end += 1;
      const sequence = component.slice(start, end);
      if (sequence.length >= MINIMUM_EVOLUTION_PHASE_COUNT &&
        reductionRatio(sequence[0].verticalIntensityMPerKm, sequence.at(-1)!.verticalIntensityMPerKm) >= MINIMUM_EVOLUTION_REDUCTION_RATIO) {
        output.push(sequence);
        start = end;
      } else start += 1;
    }
  }
  return output;
}

function makeBase<T extends Omit<NarrativeFactBase, "schemaVersion" | "courseOrder"> & { type: NarrativeFact["type"] }>(fact: T): T & Pick<NarrativeFactBase, "schemaVersion" | "courseOrder"> {
  return { ...fact, schemaVersion: NARRATIVE_FACT_SCHEMA_VERSION, courseOrder: 1 };
}
function eligible(reasonCode: NarrativeFactEligibilityReason): NarrativeFactBase["eligibility"] { return { selectable: true, reasonCode }; }
function isInterruptionCandidate(event: CourseNarrativeEvent): boolean {
  return event.kind !== "rolling" && event.kind !== "flat" && event.kind !== "transition" && event.tier !== "anchor" &&
    (event.tier === "supporting-interruption" || event.reasonCodes.includes("event-below-relative-materiality"));
}
function compareFacts(a: NarrativeFact, b: NarrativeFact): number {
  return a.segmentIndex - b.segmentIndex || a.startKm - b.startKm || a.endKm - b.endKm || factRank(a.type) - factRank(b.type) || a.factId.localeCompare(b.factId);
}
function factRank(type: NarrativeFact["type"]): number {
  return ({ UNIT_CHARACTER: 0, STRUCTURAL_TRANSITION: 1, VERTICAL_INTENSITY_EVOLUTION: 2, PERSISTENT_FINISH_CHARACTER: 3, ANCHOR_WITHIN_UNIT: 4, SIGNIFICANT_INTERRUPTION: 5 } as const)[type];
}
function compareUnits(a: CourseNarrativeUnit, b: CourseNarrativeUnit): number { return a.segmentIndex - b.segmentIndex || a.startKm - b.startKm || a.endKm - b.endKm || a.id.localeCompare(b.id); }
function comparePhases(a: CoursePhase, b: CoursePhase): number { return a.segmentIndex - b.segmentIndex || a.startKm - b.startKm || a.endKm - b.endKm || a.id.localeCompare(b.id); }
function comparePhaseRecords(a: CourseBriefInputV2["phases"][number], b: CourseBriefInputV2["phases"][number]): number { return a.segmentIndex - b.segmentIndex || a.startKm - b.startKm || a.endKm - b.endKm || a.phaseId.localeCompare(b.phaseId); }
function compareUnitRecords(a: CourseBriefInputV2["units"][number], b: CourseBriefInputV2["units"][number]): number { return a.segmentIndex - b.segmentIndex || a.startKm - b.startKm || a.endKm - b.endKm || a.unitId.localeCompare(b.unitId); }
function reductionRatio(first: number, last: number): number { return first > 0 ? (first - last) / first : 0; }
function rangeWithin(start: number, end: number, outerStart: number, outerEnd: number): boolean { return start >= outerStart - 0.01 && end <= outerEnd + 0.01; }
function close(a: number, b: number, tolerance = 0.001): boolean { return Math.abs(a - b) <= tolerance; }
function sameOrderedMembers(a: readonly string[], b: readonly string[]): boolean { return a.length === b.length && a.every((item, index) => item === b[index]); }
function unique<T>(items: readonly T[]): T[] { return [...new Set(items)]; }
function roleOrder(a: "longest" | "largest", b: "longest" | "largest"): number { return a === b ? 0 : a === "longest" ? -1 : 1; }
function numberToken(value: number): string { return (Object.is(value, -0) ? "0" : String(value)).replaceAll(".", "p"); }
function roundKm(value: number): number { return Number(value.toFixed(2)); }
