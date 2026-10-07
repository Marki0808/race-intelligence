import type { RouteEmbeddedEvent, RouteSection } from "./routeSectionEngine.ts";
import { DEFAULT_ROUTE_DYNAMICS_CONFIG } from "./routeDynamics.ts";

export const COURSE_PHASE_ALGORITHM_VERSION = 1 as const;

export type CoursePhaseCharacter =
  | "climb-dominant"
  | "descent-dominant"
  | "repeated-vertical"
  | "low-vertical"
  | "mixed";

export type CoursePhaseInterruption = {
  factId: string;
  sourceSectionId: string;
  sourceEventId?: string;
  segmentIndex: number;
  character: CoursePhaseCharacter;
  startKm: number;
  endKm: number;
  distanceKm: number;
  ascentM: number;
  descentM: number;
  embeddedEventIds: string[];
};

export type CoursePhase = {
  id: string;
  ordinal: number;
  segmentIndex: number;
  startKm: number;
  endKm: number;
  distanceKm: number;
  sourceSectionIds: string[];
  character: CoursePhaseCharacter;
  ascentM: number;
  descentM: number;
  ascentMPerKm: number;
  descentMPerKm: number;
  verticalIntensityMPerKm: number;
  directionBalance: number;
  stability: number;
  embeddedEventIds: string[];
  interruptions: CoursePhaseInterruption[];
};

export type CoursePhaseTransition = {
  id: string;
  segmentIndex: number;
  fromPhaseId: string;
  toPhaseId: string;
  fromCharacter: CoursePhaseCharacter;
  toCharacter: CoursePhaseCharacter;
  fromEndKm: number;
  toStartKm: number;
};

export type CoursePhaseAnalysis = {
  algorithmVersion: typeof COURSE_PHASE_ALGORITHM_VERSION;
  phases: CoursePhase[];
  transitions: CoursePhaseTransition[];
};

export type CoursePhaseConfig = {
  /** Relative spatial support needed for a single-section phase candidate. */
  minimumPhaseDistanceShare: number;
  /** Relative vertical-work support needed for a single-section phase candidate. */
  minimumPhaseVerticalShare: number;
  /** Same-character adjacent sections provide persistent evidence for a phase. */
  persistentSectionCount: number;
};

export const DEFAULT_COURSE_PHASE_CONFIG: CoursePhaseConfig = {
  minimumPhaseDistanceShare: 0.08,
  minimumPhaseVerticalShare: 0.2,
  persistentSectionCount: 2,
};

type SectionSummary = {
  section: RouteSection;
  character: CoursePhaseCharacter;
  distanceKm: number;
  ascentM: number;
  descentM: number;
  verticalM: number;
  intensityMPerKm: number;
  directionBalance: number;
  stability: number;
  distanceShare: number;
  verticalShare: number;
};

type DraftPhase = {
  sections: SectionSummary[];
  interruptions: SectionSummary[];
};

const ROUTE_CONFIG = DEFAULT_ROUTE_DYNAMICS_CONFIG;

/** Groups final Route Sections into component-local runner-facing phases. */
export function analyzeCoursePhases(
  routeSections: readonly RouteSection[],
  config: CoursePhaseConfig = DEFAULT_COURSE_PHASE_CONFIG,
): CoursePhaseAnalysis {
  validateConfig(config);
  if (routeSections.length === 0) {
    return { algorithmVersion: COURSE_PHASE_ALGORITHM_VERSION, phases: [], transitions: [] };
  }

  const components = groupSectionsByComponent(routeSections);
  const phases: CoursePhase[] = [];
  const transitions: CoursePhaseTransition[] = [];

  for (const [segmentIndex, sections] of components) {
    const summaries = summarizeSections(sections);
    const totalDistanceKm = summaries.reduce((sum, summary) => sum + summary.distanceKm, 0);
    const totalVerticalM = summaries.reduce((sum, summary) => sum + summary.verticalM, 0);
    for (const summary of summaries) {
      summary.distanceShare = totalDistanceKm > 0 ? summary.distanceKm / totalDistanceKm : 0;
      summary.verticalShare = totalVerticalM > 0 ? summary.verticalM / totalVerticalM : 0;
    }

    const componentPhases = simplifyDraftPhases(
      createDraftPhases(summaries, totalDistanceKm, totalVerticalM, config),
      totalDistanceKm,
      totalVerticalM,
      config,
    );
    const componentResults = componentPhases.map((draft, index) =>
      createCoursePhase(draft, segmentIndex, phases.length + index + 1),
    );
    phases.push(...componentResults);

    for (let index = 1; index < componentResults.length; index += 1) {
      const previous = componentResults[index - 1];
      const next = componentResults[index];
      if (previous.character === next.character) continue;
      transitions.push({
        id: `course-transition-s${segmentIndex}-${previous.id}-${next.id}`,
        segmentIndex,
        fromPhaseId: previous.id,
        toPhaseId: next.id,
        fromCharacter: previous.character,
        toCharacter: next.character,
        fromEndKm: previous.endKm,
        toStartKm: next.startKm,
      });
    }
  }

  return { algorithmVersion: COURSE_PHASE_ALGORITHM_VERSION, phases, transitions };
}

function groupSectionsByComponent(sections: readonly RouteSection[]): Map<number, RouteSection[]> {
  const grouped = new Map<number, Array<{ section: RouteSection; inputIndex: number }>>();
  sections.forEach((section, inputIndex) => {
    const segmentIndex = section.segmentIndex ?? 0;
    const component = grouped.get(segmentIndex) ?? [];
    component.push({ section, inputIndex });
    grouped.set(segmentIndex, component);
  });
  return new Map([...grouped].sort(([left], [right]) => left - right).map(([segmentIndex, component]) => [
    segmentIndex,
    component
      .sort((left, right) => left.section.startKm - right.section.startKm || left.section.endKm - right.section.endKm || left.inputIndex - right.inputIndex)
      .map(({ section }) => section),
  ]));
}

function summarizeSections(sections: readonly RouteSection[]): SectionSummary[] {
  return sections.map((section) => {
    const distanceKm = Math.max(0, section.distanceKm);
    const ascentM = Math.max(0, section.ascentM);
    const descentM = Math.max(0, section.descentM);
    const verticalM = ascentM + descentM;
    const intensityMPerKm = distanceKm > 0 ? verticalM / distanceKm : 0;
    const directionBalance = verticalM > 0 ? (ascentM - descentM) / verticalM : 0;
    const summary: SectionSummary = {
      section,
      character: "mixed",
      distanceKm,
      ascentM,
      descentM,
      verticalM,
      intensityMPerKm,
      directionBalance,
      stability: clamp(section.dynamicsSummary.stability),
      distanceShare: 0,
      verticalShare: 0,
    };
    summary.character = characterize([summary]);
    return summary;
  });
}

function createDraftPhases(
  summaries: SectionSummary[],
  totalDistanceKm: number,
  totalVerticalM: number,
  config: CoursePhaseConfig,
): DraftPhase[] {
  const runs: SectionSummary[][] = [];
  for (const summary of summaries) {
    const previousRun = runs.at(-1);
    if (previousRun && previousRun[0].character === summary.character) previousRun.push(summary);
    else runs.push([summary]);
  }

  const anchored = runs.map((run) => isMeaningfulRun(run, totalDistanceKm, totalVerticalM, config));
  const drafts: DraftPhase[] = [];
  for (let index = 0; index < runs.length;) {
    if (anchored[index]) {
      drafts.push({ sections: [...runs[index]], interruptions: [] });
      index += 1;
      continue;
    }
    const start = index;
    while (index < runs.length && !anchored[index]) index += 1;
    const sections = runs.slice(start, index).flat();
    drafts.push({ sections, interruptions: [] });
  }
  return drafts;
}

function isMeaningfulRun(run: SectionSummary[], totalDistanceKm: number, totalVerticalM: number, config: CoursePhaseConfig): boolean {
  const stats = summarize(run);
  const persistent = run.length >= config.persistentSectionCount;
  // Single-section candidates reuse Route Dynamics' existing stability floor;
  // persistence or component-relative spatial/vertical support supplies significance.
  return persistent || stats.stability >= ROUTE_CONFIG.minimumPhaseStability &&
    hasRelativeSupport(stats.distanceKm, stats.verticalM, totalDistanceKm, totalVerticalM, config);
}

function isMeaningfulDraft(draft: DraftPhase, totalDistanceKm: number, totalVerticalM: number, config: CoursePhaseConfig): boolean {
  const stats = summarize(draft.sections);
  return stats.stability >= ROUTE_CONFIG.minimumPhaseStability &&
    hasRelativeSupport(stats.distanceKm, stats.verticalM, totalDistanceKm, totalVerticalM, config) || hasRepeatedVerticalPattern(draft.sections);
}

function hasRelativeSupport(distanceKm: number, verticalM: number, totalDistanceKm: number, totalVerticalM: number, config: CoursePhaseConfig): boolean {
  const distanceShare = totalDistanceKm > 0 ? distanceKm / totalDistanceKm : 0;
  const verticalShare = totalVerticalM > 0 ? verticalM / totalVerticalM : 0;
  return distanceShare >= config.minimumPhaseDistanceShare || verticalShare >= config.minimumPhaseVerticalShare;
}

function simplifyDraftPhases(
  input: DraftPhase[],
  totalDistanceKm: number,
  totalVerticalM: number,
  config: CoursePhaseConfig,
): DraftPhase[] {
  const drafts = input.map((draft) => ({ sections: [...draft.sections], interruptions: [...draft.interruptions] }));
  let index = 0;
  while (drafts.length > 1 && index < drafts.length) {
    const candidate = drafts[index];
    const meaningful = isMeaningfulDraft(candidate, totalDistanceKm, totalVerticalM, config) ||
      candidate.sections.length >= config.persistentSectionCount && sameCharacterRun(candidate.sections);
    if (meaningful) {
      index += 1;
      continue;
    }

    const previous = drafts[index - 1];
    const next = drafts[index + 1];
    if (previous && next && characterize(previous.sections) === characterize(next.sections)) {
      previous.sections.push(...candidate.sections, ...next.sections);
      previous.interruptions.push(...candidate.interruptions, ...contrarySections(candidate.sections, characterize(previous.sections)));
      previous.interruptions.push(...contrarySections(next.sections, characterize(previous.sections)));
      drafts.splice(index, 2);
      index = Math.max(0, index - 1);
      continue;
    }

    const receiverSide = chooseReceiver(candidate, previous, next);
    if (receiverSide === null) {
      index += 1;
      continue;
    }
    const receiverIndex = receiverSide === "previous" ? index - 1 : index + 1;
    const receiver = drafts[receiverIndex];
    const candidateCharacter = characterize(candidate.sections);
    const receiverCharacter = characterize(receiver.sections);
    const interruptions = contrarySections(candidate.sections, receiverCharacter);
    if (receiverSide === "previous") {
      receiver.sections.push(...candidate.sections);
      receiver.interruptions.push(...candidate.interruptions, ...interruptions);
      drafts.splice(index, 1);
      index = Math.max(0, index - 1);
    } else {
      receiver.sections.unshift(...candidate.sections);
      receiver.interruptions.unshift(...candidate.interruptions, ...interruptions);
      drafts.splice(index, 1);
    }
    if (candidateCharacter === receiverCharacter) receiver.interruptions.push(...candidate.interruptions);
  }

  // A whole component is always represented, including a one-section component.
  if (drafts.length === 0 && input.length > 0) return [input[0]];
  return mergeSameCharacterNeighbors(drafts);
}

function chooseReceiver(candidate: DraftPhase, previous: DraftPhase | undefined, next: DraftPhase | undefined): "previous" | "next" | null {
  if (!previous) return next ? "next" : null;
  if (!next) return "previous";
  const candidateCharacter = characterize(candidate.sections);
  const previousCharacter = characterize(previous.sections);
  const nextCharacter = characterize(next.sections);
  const previousScore = similarityScore(candidate.sections, previous.sections, candidateCharacter === previousCharacter);
  const nextScore = similarityScore(candidate.sections, next.sections, candidateCharacter === nextCharacter);
  return previousScore >= nextScore ? "previous" : "next";
}

function similarityScore(left: SectionSummary[], right: SectionSummary[], sameCharacter: boolean): number {
  const leftStats = summarize(left);
  const rightStats = summarize(right);
  const balanceSimilarity = 1 - Math.abs(leftStats.directionBalance - rightStats.directionBalance) / 2;
  const intensitySimilarity = 1 / (1 + Math.abs(Math.log((leftStats.intensityMPerKm + 1) / (rightStats.intensityMPerKm + 1))));
  return (sameCharacter ? 2 : 0) + balanceSimilarity + intensitySimilarity;
}

function mergeSameCharacterNeighbors(input: DraftPhase[]): DraftPhase[] {
  const output: DraftPhase[] = [];
  for (const draft of input) {
    const previous = output.at(-1);
    if (previous && characterize(previous.sections) === characterize(draft.sections)) {
      previous.sections.push(...draft.sections);
      previous.interruptions.push(...draft.interruptions);
    } else output.push({ sections: [...draft.sections], interruptions: [...draft.interruptions] });
  }
  return output;
}

function sameCharacterRun(sections: SectionSummary[]): boolean {
  return sections.every((summary) => summary.character === sections[0].character);
}

function characterize(sections: readonly SectionSummary[]): CoursePhaseCharacter {
  const stats = summarize(sections);
  if (stats.distanceKm <= 0 || stats.intensityMPerKm <= ROUTE_CONFIG.flatMaximumIntensityMPerKm) return "low-vertical";
  if (hasRepeatedVerticalPattern(sections)) return "repeated-vertical";
  const strength = Math.abs(stats.directionBalance);
  if (stats.intensityMPerKm >= ROUTE_CONFIG.minimumDirectionalIntensityMPerKm && strength >= ROUTE_CONFIG.minimumDirectionStrength) {
    return stats.directionBalance > 0 ? "climb-dominant" : "descent-dominant";
  }
  return "mixed";
}

function hasRepeatedVerticalPattern(sections: readonly SectionSummary[]): boolean {
  const stats = summarize(sections);
  if (stats.intensityMPerKm < ROUTE_CONFIG.rollingMinimumIntensityMPerKm) return false;
  const ascentShare = stats.verticalM > 0 ? stats.ascentM / stats.verticalM : 0;
  const descentShare = stats.verticalM > 0 ? stats.descentM / stats.verticalM : 0;
  if (ascentShare < ROUTE_CONFIG.rollingMinimumContributionShare || descentShare < ROUTE_CONFIG.rollingMinimumContributionShare) return false;
  if (Math.abs(stats.directionBalance) > ROUTE_CONFIG.rollingMaximumDirectionStrength) return false;

  const directions = sections.flatMap(({ section }) => {
    if (section.dominantRhythm === "climb" || section.dominantRhythm === "descent") return [section.dominantRhythm];
    if (section.dominantRhythm === "rolling") return ["rolling" as const];
    return [];
  });
  let changes = 0;
  let previous: "climb" | "descent" | null = null;
  let includesRolling = false;
  for (const direction of directions) {
    if (direction === "rolling") {
      includesRolling = true;
      continue;
    }
    if (previous !== null && direction !== previous) changes += 1;
    previous = direction;
  }
  return includesRolling || changes >= ROUTE_CONFIG.rollingMinimumDirectionChanges;
}

function summarize(sections: readonly SectionSummary[]) {
  const distanceKm = sections.reduce((sum, item) => sum + item.distanceKm, 0);
  const ascentM = sections.reduce((sum, item) => sum + item.ascentM, 0);
  const descentM = sections.reduce((sum, item) => sum + item.descentM, 0);
  const verticalM = ascentM + descentM;
  const intensityMPerKm = distanceKm > 0 ? verticalM / distanceKm : 0;
  const directionBalance = verticalM > 0 ? (ascentM - descentM) / verticalM : 0;
  const stability = distanceKm > 0
    ? sections.reduce((sum, item) => sum + item.stability * item.distanceKm, 0) / distanceKm
    : 0;
  return { distanceKm, ascentM, descentM, verticalM, intensityMPerKm, directionBalance, stability };
}

function createCoursePhase(draft: DraftPhase, segmentIndex: number, ordinal: number): CoursePhase {
  const ordered = [...draft.sections].sort((left, right) => left.section.startKm - right.section.startKm || left.section.endKm - right.section.endKm);
  const stats = summarize(ordered);
  const character = characterize(ordered);
  const startKm = ordered[0].section.startKm;
  const endKm = ordered.at(-1)!.section.endKm;
  const sourceSectionIds = ordered.map(({ section }) => section.id);
  const id = `course-phase-s${segmentIndex}-${stableKm(startKm)}-${stableKm(endKm)}-${character}`;
  const embeddedEventIds = unique(ordered.flatMap(({ section }) => section.embeddedEvents.map((event) => event.id)));
  const contrary = [
    ...draft.interruptions,
    ...contrarySections(ordered, character),
  ];
  const sectionInterruptions = uniqueBy(contrary, ({ section }) => section.id).map(({ section, character }) => ({
    factId: `phase-interruption-s${segmentIndex}-${stableKm(section.startKm)}-${stableKm(section.endKm)}-${section.id}`,
    sourceSectionId: section.id,
    segmentIndex,
    character,
    startKm: section.startKm,
    endKm: section.endKm,
    distanceKm: section.distanceKm,
    ascentM: section.ascentM,
    descentM: section.descentM,
    embeddedEventIds: section.embeddedEvents.map((event) => event.id),
  }));
  const eventInterruptions = ordered.flatMap(({ section }) => section.embeddedEvents
    .filter((event) => isContraryEvent(event, character))
    .map((event) => ({
      factId: `phase-interruption-s${segmentIndex}-${event.id}`,
      sourceSectionId: section.id,
      sourceEventId: event.id,
      segmentIndex,
      character: characterForEvent(event),
      startKm: event.startKm,
      endKm: event.endKm,
      distanceKm: event.distanceKm,
      ascentM: event.ascentM,
      descentM: event.descentM,
      embeddedEventIds: [event.id],
    })));
  const interruptions = [...sectionInterruptions, ...eventInterruptions]
    .sort((left, right) => left.startKm - right.startKm || left.endKm - right.endKm);
  return {
    id,
    ordinal,
    segmentIndex,
    startKm,
    endKm,
    distanceKm: stats.distanceKm,
    sourceSectionIds,
    character,
    ascentM: Math.round(stats.ascentM),
    descentM: Math.round(stats.descentM),
    ascentMPerKm: round1(stats.distanceKm > 0 ? stats.ascentM / stats.distanceKm : 0),
    descentMPerKm: round1(stats.distanceKm > 0 ? stats.descentM / stats.distanceKm : 0),
    verticalIntensityMPerKm: round1(stats.intensityMPerKm),
    directionBalance: round3(stats.directionBalance),
    stability: round3(stats.stability),
    embeddedEventIds,
    interruptions,
  };
}

function contrarySections(sections: readonly SectionSummary[], phaseCharacter: CoursePhaseCharacter): SectionSummary[] {
  return sections.filter(({ character }) => isContraryCharacter(character, phaseCharacter));
}

function isContraryCharacter(candidate: CoursePhaseCharacter, phase: CoursePhaseCharacter): boolean {
  if (phase === "climb-dominant") return candidate === "descent-dominant" || candidate === "low-vertical";
  if (phase === "descent-dominant") return candidate === "climb-dominant" || candidate === "low-vertical";
  if (phase === "low-vertical") return candidate === "climb-dominant" || candidate === "descent-dominant" || candidate === "repeated-vertical";
  if (phase === "repeated-vertical") return candidate === "low-vertical";
  return false;
}

function characterForEvent(event: RouteEmbeddedEvent): CoursePhaseCharacter {
  if (event.rhythm === "climb") return "climb-dominant";
  if (event.rhythm === "descent") return "descent-dominant";
  if (event.rhythm === "rolling") return "repeated-vertical";
  if (event.rhythm === "flat") return "low-vertical";
  return "mixed";
}

function isContraryEvent(event: RouteEmbeddedEvent, phase: CoursePhaseCharacter): boolean {
  const candidate = characterForEvent(event);
  // Only directionally contrary vertical events are called interruptions here;
  // neutral/transition events remain available through embeddedEventIds.
  return (candidate === "climb-dominant" || candidate === "descent-dominant") &&
    isContraryCharacter(candidate, phase);
}

function uniqueBy<T, K>(items: readonly T[], key: (item: T) => K): T[] {
  return [...new Map(items.map((item) => [key(item), item])).values()];
}

function unique(items: readonly string[]): string[] { return [...new Set(items)]; }
function stableKm(value: number): string { return (Object.is(value, -0) ? 0 : value).toFixed(3).replace(".", "p"); }
function round1(value: number): number { return Number(value.toFixed(1)); }
function round3(value: number): number { return Number(value.toFixed(3)); }
function clamp(value: number): number { return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0)); }

function validateConfig(config: CoursePhaseConfig): void {
  if (!Number.isFinite(config.minimumPhaseDistanceShare) || config.minimumPhaseDistanceShare < 0 || config.minimumPhaseDistanceShare > 1 ||
    !Number.isFinite(config.minimumPhaseVerticalShare) || config.minimumPhaseVerticalShare < 0 || config.minimumPhaseVerticalShare > 1 ||
    !Number.isInteger(config.persistentSectionCount) || config.persistentSectionCount < 1) {
    throw new RangeError("Course Phase config thresholds must be finite shares and a positive section count.");
  }
}
