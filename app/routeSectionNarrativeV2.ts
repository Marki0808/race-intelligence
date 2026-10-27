import type { GradientIntelligenceV1 } from "./gradientIntelligence.ts";
import type { RouteSection } from "./routeSectionEngine.ts";
import { buildRouteNarrativePhasesV2, type RouteNarrativePhaseV2, type RouteNarrativePhasesV2, type RouteNarrativeRouteContextV2 } from "./routeNarrativePhases.ts";

export const ROUTE_SECTION_NARRATIVE_V2_PRESENTATION_VERSION = 2;
export const ROUTE_SECTION_NARRATIVE_V2_ALGORITHM_VERSION = 8;

export type RouteSectionNarrativeV2 = {
  presentationVersion: 2;
  algorithmVersion: 8;
  sectionId: string;
  segmentIndex: number;
  status: RouteNarrativePhasesV2["status"];
  phases: RouteNarrativePhasesV2;
  paragraphs: string[];
  trace: Array<{ paragraphIndex: number; sectionId: string; intervalIds: string[]; routeContextIntervalIds?: string[]; measuredFields: string[] }>;
};

type StoryEvent = { phase: RouteNarrativePhaseV2; index: number };

/** Builds runner-facing prose from selected facts while preserving the validated chronological phase model. */
export function presentRouteSectionNarrativeV2(
  gradient: GradientIntelligenceV1 | undefined,
  routeSections: readonly RouteSection[],
  target: RouteSection,
  routeContext?: RouteNarrativeRouteContextV2,
): RouteSectionNarrativeV2 {
  const phases = buildRouteNarrativePhasesV2(gradient, routeSections, target);
  const base = { presentationVersion: 2 as const, algorithmVersion: 8 as const, sectionId: target.id, segmentIndex: target.segmentIndex };
  if ((phases.status !== "available" && phases.status !== "limited") || !phases.measurements || !phases.coverage.complete) {
    return { ...base, status: phases.status, phases, paragraphs: fallback(phases.status), trace: [] };
  }
  const continuity = routeContext ? describeBoundaryContinuity(routeContext, target, phases) : [];
  const story = composeStory(phases, target, routeSections, continuity);
  const text = story.text;
  return {
    ...base,
    status: phases.status,
    phases,
    paragraphs: text ? [text] : fallback(phases.status),
    trace: text ? [{
      paragraphIndex: 0,
      sectionId: phases.sectionId,
      intervalIds: story.intervalIds,
      ...(story.routeContextIntervalIds.length ? { routeContextIntervalIds: story.routeContextIntervalIds } : {}),
      measuredFields: [...story.measuredFields, ...(story.routeContextIntervalIds.length ? ["routeContext.phase.direction", "routeContext.phase.startDistanceM", "routeContext.phase.endDistanceM", "routeContext.boundary"] : [])],
    }] : [],
  };
}

type BoundaryClaim = { edge: "start" | "end"; direction: "climb" | "descent"; intervalIds: string[] };

function composeStory(model: RouteNarrativePhasesV2, target: RouteSection, _routeSections: readonly RouteSection[], continuity: BoundaryClaim[]) {
  const events = selectStoryEvents(model).slice(0, 3);
  const relevant = new Set<number>();
  const text: string[] = [];
  const details: Array<{ startDistanceM: number; text: string }> = [];
  const unknownShare = model.coverage.unknownDistanceM / Math.max(1, model.measurements!.distanceM);
  const lead = describeOverallCharacter(target, model);
  if (lead) text.push(unknownShare >= 0.3 ? limitedCoverageLead(target, model) : lead);

  for (const event of events) {
    relevant.add(event.index);
    const phase = event.phase;
    const claim = continuity.find((item) => item.direction === phase.direction &&
      (item.edge === "start" ? phase.startDistanceM <= model.bounds!.startDistanceM + 100 : phase.endDistanceM >= model.bounds!.endDistanceM - 100));
    details.push({ startDistanceM: phase.startDistanceM, text: featureSentence(phase, claim?.edge) });
  }

  // Mention only the longest materially uncertain stretch; all unknown intervals remain in structured phases.
  const unknown = model.phases.filter((phase) => phase.direction === "unknown")
    .sort((a, b) => b.distanceM - a.distanceM || a.startDistanceM - b.startDistanceM)[0];
  if (unknown && unknown.distanceM + 1 >= Math.max(1000, model.measurements!.distanceM * 0.1)) {
    details.push({ startDistanceM: unknown.startDistanceM, text: `Direction is unclear from ${range(unknown.startDistanceM, unknown.endDistanceM)}, so this stretch is left out of the climb/descent sequence.` });
    model.phases.forEach((phase, index) => { if (phase === unknown) relevant.add(index); });
  }
  details.sort((a, b) => a.startDistanceM - b.startDistanceM);
  text.push(...details.map((item) => item.text));

  if (!text.length) {
    const longest = model.phases.reduce((best, phase, index) => !best || phase.distanceM > best.phase.distanceM ? { phase, index } : best, null as StoryEvent | null);
    if (longest) {
      relevant.add(longest.index);
      text.push(longest.phase.direction === "low-vertical-movement" ? "Elevation changes stay limited across this section."
        : longest.phase.direction === "rolling" ? "Climbs and descents alternate through this section."
        : "The profile does not show a clear dominant pattern.");
    }
  }
  return {
    text: text.join(" "),
    intervalIds: [...new Set([...relevant].sort((a, b) => a - b).flatMap((index) => model.phases[index].intervalIds))],
    routeContextIntervalIds: continuity.filter((claim) => events.some(({ phase }) => phase.direction === claim.direction &&
      (claim.edge === "start" ? phase.startDistanceM <= model.bounds!.startDistanceM + 100 : phase.endDistanceM >= model.bounds!.endDistanceM - 100)))
      .flatMap((claim) => claim.intervalIds),
    measuredFields: storyMeasuredFields,
  };
}

const storyMeasuredFields = [
  "section.dominantRhythm", "phase.direction", "phase.distanceM", "phase.startDistanceM", "phase.endDistanceM",
  "phase.confidence", "phase.gradeSegments.gradeBand", "phase.gradeSegments.distanceM", "phase.unknownReasonCodes",
  "measurements.ascentM", "measurements.descentM", "measurements.netElevationChangeM",
];

function featureSentence(phase: RouteNarrativePhaseV2, continuity?: "start" | "end") {
  if (phase.direction === "rolling") return `Climbs and descents alternate from ${range(phase.startDistanceM, phase.endDistanceM)}.`;
  if (phase.direction === "low-vertical-movement") return `Elevation changes stay limited from ${range(phase.startDistanceM, phase.endDistanceM)}.`;
  const direction = phase.direction === "climb" ? "climb" : "descent";
  const adjective = phase.distanceM >= 4000 ? "a long " : phase.distanceM >= 1500 ? "a sustained " : hasSteepGrade(phase) ? "a short, steep " : "a brief ";
  const gradeSegment = notableGradeSegments(phase).sort((a, b) =>
    Math.abs(b.averageNetGradePct) - Math.abs(a.averageNetGradePct) || b.distanceM - a.distanceM)[0];
  const subject = `${adjective}${direction}`;
  const movement = continuity === "start"
    ? `${capitalise(subject)} that began before this section runs from ${range(phase.startDistanceM, phase.endDistanceM)}`
    : `${capitalise(subject)} runs from ${range(phase.startDistanceM, phase.endDistanceM)}${continuity === "end" ? " and continues beyond this section" : ""}`;
  const grade = gradeSegment
    ? `, including a steeper stretch from ${range(gradeSegment.startDistanceM, gradeSegment.endDistanceM)} averaging ${signedGrade(gradeSegment.averageNetGradePct)}`
    : Math.abs(phase.averageNetGradePct ?? 0) >= 10 ? `, averaging ${signedGrade(phase.averageNetGradePct!)} over this interval` : "";
  return `${movement}${grade}.`;
}

/** Keep section-defining movements, large reversals, notable grade spans, and meaningful opening/closing changes. */
function selectStoryEvents(model: RouteNarrativePhasesV2): StoryEvent[] {
  const phases = model.phases;
  const candidates = phases.map((phase, index) => {
    if (phase.direction !== "climb" && phase.direction !== "descent") return null;
    const vertical = phase.direction === "climb" ? phase.ascentM : phase.descentM;
    const steepestGrade = Math.max(0, ...phase.gradeSegments
      .filter((segment) => segment.distanceM >= 500)
      .map((segment) => Math.abs(segment.averageNetGradePct)));
    const notableSteepness = hasSteepGrade(phase) ? Math.max(0, steepestGrade - 10) * 45 : 0;
    if (phase.distanceM < 500 && !hasSteepGrade(phase)) return null;
    return { phase, index, score: phase.distanceM + vertical * 20 + notableSteepness };
  }).filter((event): event is StoryEvent & { score: number } => event !== null);
  if (!candidates.length) {
    const longest = phases.map((phase, index) => ({ phase, index }))
      .filter(({ phase }) => phase.direction !== "unknown")
      .sort((a, b) => b.phase.distanceM - a.phase.distanceM || a.index - b.index)[0];
    return longest ? [longest] : [];
  }

  // Preserve the strongest measured feature in each direction, then spend one remaining slot on the next most notable fact.
  const selected = new Map<number, StoryEvent & { score: number }>();
  for (const direction of ["climb", "descent"] as const) {
    const best = candidates.filter((event) => event.phase.direction === direction)
      .sort((a, b) => b.score - a.score || a.index - b.index)[0];
    if (best) selected.set(best.index, best);
  }
  for (const event of [...candidates].sort((a, b) => b.score - a.score || a.index - b.index)) {
    if (selected.size >= 3) break;
    selected.set(event.index, event);
  }
  return [...selected.values()].sort((a, b) => a.index - b.index).map(({ phase, index }) => ({ phase, index }));
}

function describeOverallCharacter(target: RouteSection, model: RouteNarrativePhasesV2): string | null {
  const hasClimb = model.phases.some(phase => phase.direction === "climb");
  const hasDescent = model.phases.some(phase => phase.direction === "descent");
  if (target.dominantRhythm === "climb") return hasDescent ? "Mostly climbing, with descents breaking up the ascent." : "The section is mostly climbing.";
  if (target.dominantRhythm === "descent") return hasClimb ? "Mostly descending, with climbs breaking up the descent." : "The section is mostly descending.";
  if (target.dominantRhythm === "rolling") return "The section alternates between climbing and descending.";
  if (!hasClimb && !hasDescent) return "Elevation changes stay limited across the section.";
  return null;
}

function limitedCoverageLead(target: RouteSection, model: RouteNarrativePhasesV2) {
  const hasClimb = model.phases.some((phase) => phase.direction === "climb");
  const hasDescent = model.phases.some((phase) => phase.direction === "descent");
  if (target.dominantRhythm === "climb") return `Measured portions are mostly climbing${hasDescent ? ", with descents breaking up the ascent" : ""}.`;
  if (target.dominantRhythm === "descent") return `Measured portions are mostly descending${hasClimb ? ", with climbs breaking up the descent" : ""}.`;
  if (target.dominantRhythm === "rolling") return "Measured portions alternate between climbing and descending.";
  return "Measured elevation changes stay limited.";
}

function notableGradeSegments(phase: RouteNarrativePhaseV2) {
  return phase.gradeSegments.filter(segment =>
    (segment.gradeBand === "steep" || segment.gradeBand === "very-steep" || segment.gradeBand === "extreme-grade") &&
    (segment.distanceM >= 1500 || (segment.distanceM >= 500 && Math.abs(segment.averageNetGradePct) >= 15)) &&
    segment.distanceM < phase.distanceM - 100);
}

function hasSteepGrade(phase: RouteNarrativePhaseV2) {
  return phase.gradeSegments.some(segment =>
    (segment.gradeBand === "steep" || segment.gradeBand === "very-steep" || segment.gradeBand === "extreme-grade") && segment.distanceM >= 500);
}

function describeBoundaryContinuity(
  context: RouteNarrativeRouteContextV2,
  target: RouteSection,
  local: RouteNarrativePhasesV2,
): BoundaryClaim[] {
  const component = context.componentSections.find((section) => section.segmentIndex === target.segmentIndex);
  if (!component) return [];
  const model = buildRouteNarrativePhasesV2(context.gradientIntelligence, context.componentSections, component);
  if ((model.status !== "available" && model.status !== "limited") || !model.coverage.complete) return [];
  const startM = target.startPosition.distanceM;
  const endM = target.endPosition.distanceM;
  const claims: BoundaryClaim[] = [];
  for (const edge of ["start", "end"] as const) {
    const candidates = model.phases.filter((phase) => {
    if (phase.direction !== "climb" && phase.direction !== "descent") return false;
      const boundary = edge === "start" ? startM : endM;
      const crosses = edge === "start"
        ? phase.startDistanceM < boundary - 100 && phase.endDistanceM > boundary + 0.02
        : phase.startDistanceM < boundary - 0.02 && phase.endDistanceM > boundary + 100;
      const overlapM = Math.min(phase.endDistanceM, endM) - Math.max(phase.startDistanceM, startM);
      const localTouch = local.phases.some((item) => item.direction === phase.direction &&
        (edge === "start" ? item.startDistanceM <= startM + 100 && item.endDistanceM > startM + 0.02
          : item.endDistanceM >= endM - 100 && item.startDistanceM < endM - 0.02));
      return crosses && phase.distanceM >= 1500 && overlapM >= Math.max(500, phase.distanceM * 0.15) && localTouch;
    }).sort((left, right) => right.distanceM - left.distanceM || left.startDistanceM - right.startDistanceM);
    const feature = candidates[0];
    if (feature) claims.push({ edge, direction: feature.direction as "climb" | "descent", intervalIds: feature.intervalIds });
  }
  return claims;
}

function range(startDistanceM: number, endDistanceM: number) {
  return `km ${kmValue(startDistanceM)}–${kmValue(endDistanceM)}`;
}

function signedGrade(grade: number) {
  return `${grade >= 0 ? "+" : "−"}${Math.abs(grade).toFixed(1)}%`;
}

function kmValue(distanceM: number) { return (distanceM / 1000).toFixed(1); }
function capitalise(value: string) { return value[0].toUpperCase() + value.slice(1); }

function fallback(status: RouteSectionNarrativeV2["status"]): string[] {
  if (status === "missing-data") return ["A section narrative is not available for this analysis."];
  if (status === "unsupported-version") return ["A section narrative is not available for this version of the elevation analysis."];
  if (status === "invalid-data") return ["A reliable section narrative is not available for this elevation profile."];
  return ["The elevation profile does not support a clear section narrative."];
}
