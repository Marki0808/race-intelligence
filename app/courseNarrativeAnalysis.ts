import type { CoursePhase, CoursePhaseCharacter, CoursePhaseTransition } from "./coursePhaseAnalysis.ts";
import { DEFAULT_COURSE_PHASE_CONFIG } from "./coursePhaseAnalysis.ts";
import type { RouteSection } from "./routeSectionEngine.ts";
import type { StructuredRouteKeyMomentEvent } from "./routeKeyMoments.ts";

export const COURSE_NARRATIVE_ALGORITHM_VERSION = 1 as const;

/** Event magnitude must account for at least one fifth of its containing phase's vertical work. */
export const MINIMUM_SUPPORTING_EVENT_PHASE_VERTICAL_SHARE = 0.2 as const;

export type NarrativeEventTier = "anchor" | "supporting-interruption" | "context-only";
export type NarrativeStructuralPattern = CoursePhaseCharacter | "evolving";
export type NarrativeSignificance = "significant" | "context-only";

export type CourseNarrativeReasonCode =
  | "single-phase-component"
  | "persistent-phase"
  | "component-distance-support"
  | "component-vertical-support"
  | "key-moment-anchor"
  | "supporting-interruption"
  | "weak-bridge-attached"
  | "coherent-finish-evolution"
  | "directional-reversal"
  | "persistent-character-after-transition"
  | "key-moment-near-transition"
  | "character-persists-to-component-finish"
  | "event-below-relative-materiality"
  | "event-not-contrary"
  | "event-zero-vertical-work";

export type CourseNarrativeUnit = {
  id: string;
  ordinal: number;
  segmentIndex: number;
  startKm: number;
  endKm: number;
  phaseIds: string[];
  sourceSectionIds: string[];
  structuralPattern: NarrativeStructuralPattern;
  transitionIds: string[];
  significantEventIds: string[];
  supportingFactIds: string[];
  reasonCodes: CourseNarrativeReasonCode[];
};

export type NarrativeTransition = {
  id: string;
  sourceTransitionId: string;
  segmentIndex: number;
  fromPhaseId: string;
  toPhaseId: string;
  fromCharacter: CoursePhaseCharacter;
  toCharacter: CoursePhaseCharacter;
  boundaryKm: number;
  verticalIntensityBeforeMPerKm: number;
  verticalIntensityAfterMPerKm: number;
  intensityDeltaMPerKm: number;
  significance: NarrativeSignificance;
  reasonCodes: CourseNarrativeReasonCode[];
  fromUnitId: string;
  toUnitId: string;
  isInternalToUnit: boolean;
};

export type CourseNarrativeEvent = {
  id: string;
  sourceEventId: string;
  segmentIndex: number;
  kind: "climb" | "descent" | "rolling" | "flat" | "transition";
  startKm: number;
  endKm: number;
  ascentM: number;
  descentM: number;
  keyMomentRoles: Array<"longest" | "largest">;
  tier: NarrativeEventTier;
  phaseIds: string[];
  unitIds: string[];
  reasonCodes: CourseNarrativeReasonCode[];
};

export type CourseNarrativeEvolutionFact =
  | {
      id: string;
      type: "vertical-intensity-decreases";
      segmentIndex: number;
      phaseIds: string[];
      unitIds: string[];
      valuesMPerKm: number[];
    }
  | {
      id: string;
      type: "low-vertical-to-component-finish";
      segmentIndex: number;
      phaseIds: string[];
      unitIds: string[];
      endKm: number;
    }
  | {
      id: string;
      type: "key-moment-within-unit";
      segmentIndex: number;
      phaseIds: string[];
      unitIds: string[];
      eventId: string;
    };

export type CourseNarrativeRouteExtreme = {
  kind: "highest" | "lowest";
  segmentIndex: number;
  atKm: number;
  elevationM: number;
  phaseId: string | null;
  unitId: string | null;
};

export type CourseNarrativeModel = {
  algorithmVersion: typeof COURSE_NARRATIVE_ALGORITHM_VERSION;
  units: CourseNarrativeUnit[];
  transitions: NarrativeTransition[];
  events: CourseNarrativeEvent[];
  routeExtrema: CourseNarrativeRouteExtreme[];
  evolutionFacts: CourseNarrativeEvolutionFact[];
};

export type CourseNarrativeInput = {
  phases: readonly CoursePhase[];
  transitions: readonly CoursePhaseTransition[];
  routeSections: readonly RouteSection[];
  keyMoments: readonly StructuredRouteKeyMomentEvent[];
  extrema?: readonly Pick<CourseNarrativeRouteExtreme, "kind" | "segmentIndex" | "atKm" | "elevationM">[];
};

type UnitDraft = {
  segmentIndex: number;
  phases: CoursePhase[];
  reasonCodes: CourseNarrativeReasonCode[];
};

type EventDraft = Omit<CourseNarrativeEvent, "tier" | "phaseIds" | "unitIds" | "reasonCodes"> & {
  phaseIds: string[];
  keyMomentRoles: Array<"longest" | "largest">;
};

// Reuse Phase 3A's documented component-support boundaries; no new phase thresholds are introduced here.
const MINIMUM_PHASE_DISTANCE_SHARE = DEFAULT_COURSE_PHASE_CONFIG.minimumPhaseDistanceShare;
const MINIMUM_PHASE_VERTICAL_SHARE = DEFAULT_COURSE_PHASE_CONFIG.minimumPhaseVerticalShare;
const PERSISTENT_SECTION_COUNT = DEFAULT_COURSE_PHASE_CONFIG.persistentSectionCount;

/** Builds reference-based narrative structure without prose, route advice, or provider evidence. */
export function analyzeCourseNarrative(input: CourseNarrativeInput): CourseNarrativeModel {
  validateInput(input);
  const orderedPhases = orderPhases(input.phases);
  const events = classifyEvents(input, orderedPhases);
  const phaseKeyMoments = new Set(events.filter((event) => event.keyMomentRoles.length > 0).flatMap((event) => event.phaseIds));
  const supportingPhaseEvents = new Set(events.filter((event) => event.tier === "supporting-interruption").flatMap((event) => event.phaseIds));
  const drafts = createUnits(orderedPhases, phaseKeyMoments, supportingPhaseEvents);
  const phaseToUnit = new Map<string, string>();
  const units = drafts.map((draft, index) => {
    const first = draft.phases[0];
    const last = draft.phases.at(-1)!;
    const id = `narrative-unit-s${draft.segmentIndex}-${stableKm(first.startKm)}-${stableKm(last.endKm)}`;
    for (const phase of draft.phases) phaseToUnit.set(phase.id, id);
    const phaseIds = draft.phases.map((phase) => phase.id);
    const transitions = input.transitions.filter((transition) => phaseIds.includes(transition.fromPhaseId) && phaseIds.includes(transition.toPhaseId));
    const unitEvents = events.filter((event) => event.phaseIds.some((phaseId) => phaseIds.includes(phaseId)) && event.tier !== "context-only");
    return {
      id,
      ordinal: index + 1,
      segmentIndex: draft.segmentIndex,
      startKm: first.startKm,
      endKm: last.endKm,
      phaseIds,
      sourceSectionIds: unique(draft.phases.flatMap((phase) => phase.sourceSectionIds)),
      structuralPattern: phaseIds.length === 1 ? first.character : "evolving",
      transitionIds: transitions.map((transition) => transition.id),
      significantEventIds: unique(unitEvents.map((event) => event.id)),
      supportingFactIds: unique([
        ...phaseIds.map((phaseId) => `phase:${phaseId}`),
        ...transitions.map((transition) => `transition:${transition.id}`),
        ...unitEvents.map((event) => `event:${event.id}`),
        ...(input.extrema ?? []).flatMap((extreme) => {
          const phase = draft.phases.find((candidate) => candidate.segmentIndex === extreme.segmentIndex && candidate.startKm <= extreme.atKm && extreme.atKm <= candidate.endKm);
          return phase ? [`extreme:${extreme.kind}:${extreme.segmentIndex}:${extreme.atKm}`] : [];
        }),
      ]),
      reasonCodes: unique(draft.reasonCodes),
    } satisfies CourseNarrativeUnit;
  });

  const transitions = input.transitions.map((source) => {
    const before = orderedPhases.find((phase) => phase.id === source.fromPhaseId)!;
    const after = orderedPhases.find((phase) => phase.id === source.toPhaseId)!;
    const reasonCodes: CourseNarrativeReasonCode[] = [];
    if (isDirectionalReversal(before.character, after.character)) reasonCodes.push("directional-reversal");
    if (before.sourceSectionIds.length >= PERSISTENT_SECTION_COUNT || after.sourceSectionIds.length >= PERSISTENT_SECTION_COUNT) {
      reasonCodes.push("persistent-character-after-transition");
    }
    if (phaseKeyMoments.has(before.id) || phaseKeyMoments.has(after.id)) reasonCodes.push("key-moment-near-transition");
    if (after.character === "low-vertical" && isComponentFinish(after, orderedPhases)) {
      reasonCodes.push("character-persists-to-component-finish");
    }
    const fromUnitId = phaseToUnit.get(before.id)!;
    const toUnitId = phaseToUnit.get(after.id)!;
    return {
      id: `narrative-${source.id}`,
      sourceTransitionId: source.id,
      segmentIndex: source.segmentIndex,
      fromPhaseId: source.fromPhaseId,
      toPhaseId: source.toPhaseId,
      fromCharacter: source.fromCharacter,
      toCharacter: source.toCharacter,
      boundaryKm: source.fromEndKm,
      verticalIntensityBeforeMPerKm: before.verticalIntensityMPerKm,
      verticalIntensityAfterMPerKm: after.verticalIntensityMPerKm,
      intensityDeltaMPerKm: round1(after.verticalIntensityMPerKm - before.verticalIntensityMPerKm),
      significance: reasonCodes.length ? "significant" : "context-only",
      reasonCodes,
      fromUnitId,
      toUnitId,
      isInternalToUnit: fromUnitId === toUnitId,
    } satisfies NarrativeTransition;
  });

  const classifiedEvents = events.map((event) => {
    const unitIds = unique(event.phaseIds.flatMap((phaseId) => {
      const unitId = phaseToUnit.get(phaseId);
      return unitId ? [unitId] : [];
    }));
    return { ...event, unitIds };
  });
  const routeExtrema = (input.extrema ?? []).map((extreme): CourseNarrativeRouteExtreme => {
    const phase = orderedPhases.find((candidate) => candidate.segmentIndex === extreme.segmentIndex && candidate.startKm <= extreme.atKm && extreme.atKm <= candidate.endKm);
    return {
      ...extreme,
      phaseId: phase?.id ?? null,
      unitId: phase ? phaseToUnit.get(phase.id) ?? null : null,
    };
  });
  const evolutionFacts = buildEvolutionFacts(orderedPhases, units, classifiedEvents, transitions);
  return { algorithmVersion: COURSE_NARRATIVE_ALGORITHM_VERSION, units, transitions, events: classifiedEvents, routeExtrema, evolutionFacts };
}

function createUnits(
  phases: readonly CoursePhase[],
  keyMomentPhaseIds: ReadonlySet<string>,
  supportingEventPhaseIds: ReadonlySet<string>,
): UnitDraft[] {
  const bySegment = groupBySegment(phases);
  const output: UnitDraft[] = [];
  for (const [segmentIndex, componentPhases] of bySegment) {
    const totalDistance = componentPhases.reduce((sum, phase) => sum + phase.distanceKm, 0);
    const totalVertical = componentPhases.reduce((sum, phase) => sum + phase.ascentM + phase.descentM, 0);
    const material = componentPhases.map((phase) => {
      const reasons: CourseNarrativeReasonCode[] = [];
      if (componentPhases.length === 1) reasons.push("single-phase-component");
      if (phase.sourceSectionIds.length >= PERSISTENT_SECTION_COUNT) reasons.push("persistent-phase");
      if (meetsRelativeShare(phase.distanceKm, totalDistance, MINIMUM_PHASE_DISTANCE_SHARE)) reasons.push("component-distance-support");
      if (meetsRelativeShare(phase.ascentM + phase.descentM, totalVertical, MINIMUM_PHASE_VERTICAL_SHARE)) reasons.push("component-vertical-support");
      if (keyMomentPhaseIds.has(phase.id)) reasons.push("key-moment-anchor");
      if (supportingEventPhaseIds.has(phase.id)) reasons.push("supporting-interruption");
      return { phase, reasons };
    });

    const componentDrafts: UnitDraft[] = [];
    for (let index = 0; index < material.length; index += 1) {
      const { phase, reasons } = material[index];
      const meaningful = reasons.length > 0;
      if (meaningful || material.length === 1) {
        componentDrafts.push({ segmentIndex, phases: [phase], reasonCodes: reasons });
        continue;
      }
      const previous = componentDrafts.at(-1);
      const next = material[index + 1];
      if (previous && next && previous.phases.at(-1)!.character === next.phase.character) {
        previous.phases.push(phase, next.phase);
        previous.reasonCodes.push("weak-bridge-attached");
        index += 1;
        continue;
      }
      const previousSupport = previous ? supportRank(previous.phases.at(-1)!, totalDistance, totalVertical, keyMomentPhaseIds) : -1;
      const nextSupport = next ? supportRank(next.phase, totalDistance, totalVertical, keyMomentPhaseIds) : -1;
      if (!previous && next) {
        componentDrafts.push({ segmentIndex, phases: [phase, next.phase], reasonCodes: ["weak-bridge-attached", ...next.reasons] });
        index += 1;
      } else if (next && nextSupport > previousSupport) {
        componentDrafts.push({ segmentIndex, phases: [phase, next.phase], reasonCodes: ["weak-bridge-attached", ...next.reasons] });
        index += 1;
      } else if (previous) {
        previous.phases.push(phase);
        previous.reasonCodes.push("weak-bridge-attached");
      } else {
        componentDrafts.push({ segmentIndex, phases: [phase], reasonCodes: ["single-phase-component"] });
      }
    }

    // A lower-intensity low-vertical finish is a coherent evolution of a preceding descent.
    for (let index = 1; index < componentDrafts.length; index += 1) {
      const previous = componentDrafts[index - 1];
      const current = componentDrafts[index];
      const priorPhase = previous.phases.at(-1)!;
      const finishPhase = current.phases[0];
      if (priorPhase.character === "descent-dominant" && finishPhase.character === "low-vertical" &&
        finishPhase.verticalIntensityMPerKm < priorPhase.verticalIntensityMPerKm && isComponentFinish(finishPhase, componentPhases)) {
        previous.phases.push(...current.phases);
        previous.reasonCodes.push("coherent-finish-evolution");
        componentDrafts.splice(index, 1);
        index -= 1;
      }
    }
    output.push(...componentDrafts);
  }
  return output;
}

function classifyEvents(input: CourseNarrativeInput, phases: readonly CoursePhase[]): CourseNarrativeEvent[] {
  const keyByEvent = new Map(input.keyMoments.map((moment) => [`${moment.segmentIndex}:${moment.eventId}`, moment]));
  const drafts = new Map<string, EventDraft>();
  for (const section of input.routeSections) {
    for (const embedded of section.embeddedEvents) {
      const segmentIndex = embedded.segmentIndex ?? section.segmentIndex;
      const key = `${segmentIndex}:${embedded.id}`;
      const moment = keyByEvent.get(key);
      drafts.set(key, {
        id: `narrative-event-s${segmentIndex}-${embedded.id}`,
        sourceEventId: embedded.id,
        segmentIndex,
        kind: embedded.rhythm,
        startKm: embedded.startKm,
        endKm: embedded.endKm,
        ascentM: embedded.ascentM,
        descentM: embedded.descentM,
        keyMomentRoles: moment?.roles ?? [],
        phaseIds: findOverlappingPhases(phases, segmentIndex, embedded.startKm, embedded.endKm),
      });
    }
  }
  for (const moment of input.keyMoments) {
    const key = `${moment.segmentIndex}:${moment.eventId}`;
    if (drafts.has(key)) continue;
    drafts.set(key, {
      id: `narrative-event-s${moment.segmentIndex}-${moment.eventId}`,
      sourceEventId: moment.eventId,
      segmentIndex: moment.segmentIndex,
      kind: moment.kind,
      startKm: moment.startKm,
      endKm: moment.endKm,
      ascentM: moment.kind === "climb" ? moment.elevationChangeM : 0,
      descentM: moment.kind === "descent" ? moment.elevationChangeM : 0,
      keyMomentRoles: moment.roles,
      phaseIds: findOverlappingPhases(phases, moment.segmentIndex, moment.startKm, moment.endKm),
    });
  }

  const phaseById = new Map(phases.map((phase) => [phase.id, phase]));
  return [...drafts.values()].sort((left, right) => left.segmentIndex - right.segmentIndex || left.startKm - right.startKm || left.endKm - right.endKm)
    .map((event) => {
      const reasons: CourseNarrativeReasonCode[] = [];
      let tier: NarrativeEventTier = "context-only";
      if (event.keyMomentRoles.length) {
        tier = "anchor";
        reasons.push("key-moment-anchor");
      } else {
        const phase = event.phaseIds.map((id) => phaseById.get(id)!).find((candidate) => candidate.segmentIndex === event.segmentIndex);
        const eventVertical = event.ascentM + event.descentM;
        const phaseVertical = phase ? phase.ascentM + phase.descentM : 0;
        const contrary = phase && ((phase.character === "descent-dominant" && event.kind === "climb") ||
          (phase.character === "climb-dominant" && event.kind === "descent") ||
          (phase.character === "low-vertical" && (event.kind === "climb" || event.kind === "descent")));
        if (eventVertical === 0) reasons.push("event-zero-vertical-work");
        else if (!contrary) reasons.push("event-not-contrary");
        else if (phaseVertical > 0 && eventVertical / phaseVertical >= MINIMUM_SUPPORTING_EVENT_PHASE_VERTICAL_SHARE) {
          tier = "supporting-interruption";
          reasons.push("supporting-interruption");
        } else reasons.push("event-below-relative-materiality");
      }
      return { ...event, tier, unitIds: [], reasonCodes: reasons };
    });
}

function buildEvolutionFacts(
  phases: readonly CoursePhase[],
  units: readonly CourseNarrativeUnit[],
  events: readonly CourseNarrativeEvent[],
  transitions: readonly NarrativeTransition[],
): CourseNarrativeEvolutionFact[] {
  const facts: CourseNarrativeEvolutionFact[] = [];
  for (const segment of groupBySegment(phases).values()) {
    for (let start = 0; start < segment.length - 1; start += 1) {
      let end = start + 1;
      while (end < segment.length && segment[end].verticalIntensityMPerKm < segment[end - 1].verticalIntensityMPerKm) end += 1;
      if (end - start >= 2) {
        const selected = segment.slice(start, end);
        const phaseIds = selected.map((phase) => phase.id);
        facts.push({
          id: `evolution-intensity-decreases-${phaseIds[0]}-${phaseIds.at(-1)}`,
          type: "vertical-intensity-decreases",
          segmentIndex: selected[0].segmentIndex,
          phaseIds,
          unitIds: unique(phaseIds.flatMap((id) => {
            const unit = units.find((candidate) => candidate.phaseIds.includes(id));
            return unit ? [unit.id] : [];
          })),
          valuesMPerKm: selected.map((phase) => phase.verticalIntensityMPerKm),
        });
        start = end - 1;
      }
    }
  }
  for (const phase of phases) {
    if (phase.character === "low-vertical" && isComponentFinish(phase, phases)) {
      const unit = units.find((candidate) => candidate.phaseIds.includes(phase.id));
      facts.push({
        id: `evolution-low-finish-${phase.id}`,
        type: "low-vertical-to-component-finish",
        segmentIndex: phase.segmentIndex,
        phaseIds: [phase.id],
        unitIds: unit ? [unit.id] : [],
        endKm: phase.endKm,
      });
    }
  }
  for (const event of events.filter((candidate) => candidate.tier === "anchor")) {
    if (!event.unitIds.length) continue;
    facts.push({
      id: `evolution-key-moment-${event.id}`,
      type: "key-moment-within-unit",
      segmentIndex: event.segmentIndex,
      phaseIds: event.phaseIds,
      unitIds: event.unitIds,
      eventId: event.id,
    });
  }
  // Transitions are already first-class facts. Keep this read here as a consistency assertion.
  if (transitions.some((transition) => transition.isInternalToUnit && !units.some((unit) => unit.id === transition.fromUnitId))) {
    throw new Error("Course Narrative internal transition references an unknown unit.");
  }
  return facts;
}

function isComponentFinish(phase: CoursePhase, phases: readonly CoursePhase[]): boolean {
  return phase.endKm === Math.max(...phases.filter((candidate) => candidate.segmentIndex === phase.segmentIndex).map((candidate) => candidate.endKm));
}

function findOverlappingPhases(phases: readonly CoursePhase[], segmentIndex: number, startKm: number, endKm: number): string[] {
  return phases.filter((phase) => phase.segmentIndex === segmentIndex && phase.startKm <= endKm && phase.endKm >= startKm)
    .map((phase) => phase.id);
}

function supportRank(phase: CoursePhase, totalDistance: number, totalVertical: number, keyMoments: ReadonlySet<string>): number {
  if (keyMoments.has(phase.id)) return 4;
  if (phase.sourceSectionIds.length >= PERSISTENT_SECTION_COUNT) return 3;
  if (meetsRelativeShare(phase.distanceKm, totalDistance, MINIMUM_PHASE_DISTANCE_SHARE)) return 2;
  if (meetsRelativeShare(phase.ascentM + phase.descentM, totalVertical, MINIMUM_PHASE_VERTICAL_SHARE)) return 1;
  return 0;
}

function isDirectionalReversal(before: CoursePhaseCharacter, after: CoursePhaseCharacter): boolean {
  return before === "climb-dominant" && after === "descent-dominant" || before === "descent-dominant" && after === "climb-dominant";
}

function meetsRelativeShare(value: number, total: number, threshold: number): boolean {
  if (total <= 0) return false;
  const share = value / total;
  // Preserve inclusive exact-boundary semantics despite binary floating-point division.
  return share >= threshold || Math.abs(share - threshold) <= Number.EPSILON * 4;
}

function groupBySegment(phases: readonly CoursePhase[]): Map<number, CoursePhase[]> {
  const grouped = new Map<number, CoursePhase[]>();
  for (const phase of orderPhases(phases)) {
    const component = grouped.get(phase.segmentIndex) ?? [];
    component.push(phase);
    grouped.set(phase.segmentIndex, component);
  }
  return grouped;
}

function orderPhases(phases: readonly CoursePhase[]): CoursePhase[] {
  return [...phases].sort((left, right) => left.segmentIndex - right.segmentIndex || left.startKm - right.startKm || left.endKm - right.endKm || left.ordinal - right.ordinal);
}

function validateInput(input: CourseNarrativeInput): void {
  const ids = new Set<string>();
  for (const phase of input.phases) {
    if (!phase.id || ids.has(phase.id) || !Number.isInteger(phase.segmentIndex) || phase.segmentIndex < 0 ||
      !Number.isFinite(phase.startKm) || !Number.isFinite(phase.endKm) || phase.endKm < phase.startKm ||
      !Number.isFinite(phase.distanceKm) || phase.distanceKm < 0 || !Number.isFinite(phase.ascentM) || phase.ascentM < 0 ||
      !Number.isFinite(phase.descentM) || phase.descentM < 0 || !Number.isFinite(phase.verticalIntensityMPerKm) || phase.verticalIntensityMPerKm < 0) {
      throw new Error("Course Narrative phases must have unique IDs and finite, non-negative route measurements.");
    }
    ids.add(phase.id);
  }
  const transitions = new Set<string>();
  for (const transition of input.transitions) {
    const from = input.phases.find((phase) => phase.id === transition.fromPhaseId);
    const to = input.phases.find((phase) => phase.id === transition.toPhaseId);
    if (!from || !to || from.segmentIndex !== to.segmentIndex || transition.segmentIndex !== from.segmentIndex ||
      transition.fromCharacter !== from.character || transition.toCharacter !== to.character ||
      transition.fromEndKm !== transition.toStartKm || transition.fromPhaseId === transition.toPhaseId || transitions.has(transition.id)) {
      throw new Error("Course Narrative transitions must reference adjacent phases within one traversed component.");
    }
    transitions.add(transition.id);
  }
  for (const section of input.routeSections) {
    if (!input.phases.some((phase) => phase.segmentIndex === section.segmentIndex && phase.sourceSectionIds.includes(section.id))) {
      throw new Error("Course Narrative sections must belong to a supplied Course Phase.");
    }
  }
  for (const moment of input.keyMoments) {
    if (!Number.isInteger(moment.segmentIndex) || moment.segmentIndex < 0 || !Number.isFinite(moment.startKm) ||
      !Number.isFinite(moment.endKm) || moment.endKm < moment.startKm || !Number.isFinite(moment.elevationChangeM) || moment.elevationChangeM < 0) {
      throw new Error("Course Narrative Key Moments must have valid component-local ranges and vertical values.");
    }
  }
  for (const extreme of input.extrema ?? []) {
    if (!Number.isInteger(extreme.segmentIndex) || extreme.segmentIndex < 0 || !Number.isFinite(extreme.atKm) ||
      extreme.atKm < 0 || !Number.isFinite(extreme.elevationM)) {
      throw new Error("Course Narrative extrema must have a valid component position and finite elevation.");
    }
  }
}

function unique<T>(items: readonly T[]): T[] { return [...new Set(items)]; }
function stableKm(value: number): string { return String(Number(value.toFixed(3))).replaceAll(".", "p"); }
function round1(value: number): number { return Number(value.toFixed(1)); }
