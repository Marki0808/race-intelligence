import type { GradientIntelligenceV1 } from "./gradientIntelligence.ts";
import type { RouteSection } from "./routeSectionEngine.ts";
import { buildRouteNarrativePhasesV2, type RouteNarrativePhaseV2, type RouteNarrativePhasesV2, type RouteNarrativeRouteContextV2 } from "./routeNarrativePhases.ts";

export const ROUTE_SECTION_NARRATIVE_V2_PRESENTATION_VERSION = 2;
export const ROUTE_SECTION_NARRATIVE_V2_ALGORITHM_VERSION = 8;

export type RouteSectionNarrativeV2 = {
  presentationVersion: 2;
  algorithmVersion: 9;
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
  const base = { presentationVersion: 2 as const, algorithmVersion: 9 as const, sectionId: target.id, segmentIndex: target.segmentIndex };
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
  const details: Array<{ startDistanceM: number; text: string; intervalIds: string[]; phase: RouteNarrativePhaseV2; continuity?: "start" | "end"; composed?: boolean }> = [];
  const unknownShare = model.coverage.unknownDistanceM / Math.max(1, model.measurements!.distanceM);
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    relevant.add(event.index);
    const phase = event.phase;
    const claim = continuity.find((item) => item.direction === phase.direction &&
      (item.edge === "start" ? phase.startDistanceM <= model.bounds!.startDistanceM + 100 : phase.endDistanceM >= model.bounds!.endDistanceM - 100));
    details.push({ startDistanceM: phase.startDistanceM, text: featureSentence(phase, undefined, claim?.edge), intervalIds: phase.intervalIds, phase, continuity: claim?.edge });
  }

  // Mention only the longest materially uncertain stretch; all unknown intervals remain in structured phases.
  const unknown = model.phases.filter((phase) => phase.direction === "unknown")
    .sort((a, b) => b.distanceM - a.distanceM || a.startDistanceM - b.startDistanceM)[0];
  if (unknown && unknown.distanceM + 1 >= Math.max(1000, model.measurements!.distanceM * 0.1)) {
    details.push({ startDistanceM: unknown.startDistanceM, text: `The profile is unclear from ${range(unknown.startDistanceM, unknown.endDistanceM)}.`, intervalIds: unknown.intervalIds, phase: unknown });
    model.phases.forEach((phase, index) => { if (phase === unknown) relevant.add(index); });
  }
  details.sort((a, b) => a.startDistanceM - b.startDistanceM);

  // When three selected movements are adjacent and the middle one is a short reversal,
  // explain the interruption as one sequence instead of listing three detected events.
  for (let index = 0; index <= details.length - 3; index += 1) {
    const [first, interruption, last] = details.slice(index, index + 3);
    const firstIndex = model.phases.indexOf(first.phase);
    const interruptionIndex = model.phases.indexOf(interruption.phase);
    const lastIndex = model.phases.indexOf(last.phase);
    if (firstIndex + 1 !== interruptionIndex || interruptionIndex + 1 !== lastIndex ||
      first.phase.direction !== last.phase.direction || first.phase.direction === interruption.phase.direction ||
      interruption.phase.distanceM >= 1500) continue;
    const mainDirection = first.phase.direction === "climb" ? "climb" : "descent";
    const reverseDirection = interruption.phase.direction === "climb" ? "climb" : "descent";
    const reversePhrase = phaseAverageIsSteep(interruption.phase) ? `a short, steep ${reverseDirection}` : `a brief ${reverseDirection}`;
    const startClaim = continuity.find((item) => item.edge === "start" && item.direction === first.phase.direction);
    const endClaim = continuity.find((item) => item.edge === "end" && item.direction === last.phase.direction);
    const startText = startClaim
      ? `The ${mainDirection} carries into this section`
      : `The ${mainDirection} from ${range(first.phase.startDistanceM, first.phase.endDistanceM)}`;
    const resumeGrade = notableGradeSegments(last.phase).sort((a, b) => Math.abs(b.averageNetGradePct) - Math.abs(a.averageNetGradePct))[0];
    const endText = endClaim
      ? "then continues into the next section"
      : phaseAverageIsSteep(last.phase)
        ? `then resumes with a short, steep ${mainDirection} from ${range(last.phase.startDistanceM, last.phase.endDistanceM)}${resumeGrade ? ` averaging ${signedGrade(resumeGrade.averageNetGradePct)}` : ""}`
        : `then resumes from ${range(last.phase.startDistanceM, last.phase.endDistanceM)}`;
    details.splice(index, 3, {
      startDistanceM: first.startDistanceM,
      text: `${startText} is interrupted by ${reversePhrase} around km ${kmValue((interruption.phase.startDistanceM + interruption.phase.endDistanceM) / 2)}; it ${endText}.`,
      intervalIds: [...first.intervalIds, ...interruption.intervalIds, ...last.intervalIds],
      phase: first.phase,
      continuity: startClaim ? "start" : endClaim ? "end" : undefined,
      composed: true,
    });
    relevant.add(interruptionIndex);
    relevant.add(lastIndex);
  }

  const text: string[] = [];
  if (unknownShare >= 0.3) text.push(limitedCoverageLead(target, model));
  if (!details.some((item) => item.phase.direction !== "unknown")) {
    const lead = describeOverallCharacter(target, model);
    if (lead && !text.length) text.push(lead);
  }

  let previousFeature: RouteNarrativePhaseV2 | undefined;
  let hasDescribedFeature = false;
  for (const item of details) {
    if (item.phase.direction === "unknown") {
      text.push(item.text);
      previousFeature = undefined;
      continue;
    }
    if (item.composed) {
      text.push(item.text);
      previousFeature = model.phases[model.phases.indexOf(item.phase) + 2] ?? item.phase;
      hasDescribedFeature = true;
      continue;
    }
    const sentence = !hasDescribedFeature
      ? openingSentence(target, model, item.phase, item.continuity, unknownShare >= 0.3)
      : featureSentence(item.phase, previousFeature, item.continuity, model.bounds);
    text.push(sentence);
    previousFeature = item.phase;
    hasDescribedFeature = true;
  }

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

function openingSentence(target: RouteSection, model: RouteNarrativePhasesV2, phase: RouteNarrativePhaseV2, continuity?: "start" | "end", limitedCoverage = false) {
  if (phase.direction === "rolling") return `The section rolls between climbs and descents from ${range(phase.startDistanceM, phase.endDistanceM)}.`;
  if (phase.direction === "low-vertical-movement") return "The opening stretch has little change in elevation.";
  const direction = phase.direction === "climb" ? "climb" : "descent";
  const adjective = phase.distanceM >= 4000 ? "a long " : phase.distanceM >= 1500 ? "a sustained " : phaseAverageIsSteep(phase) ? "a short, steep " : "a brief ";
  const overallDirection = target.dominantRhythm === "climb" ? "uphill" : target.dominantRhythm === "descent" ? "downhill" : null;
  const isOpening = phase.startDistanceM <= model.bounds!.startDistanceM + 100;
  let movement: string;
  if (continuity === "start") movement = overallDirection && overallDirection !== (direction === "climb" ? "uphill" : "downhill")
    ? `Although mostly ${overallDirection}, the ${direction} continues into this section through ${range(phase.startDistanceM, phase.endDistanceM)}`
    : overallDirection
      ? `The route trends ${overallDirection}, with the ${direction} continuing into this section through ${range(phase.startDistanceM, phase.endDistanceM)}`
      : `The ${direction} continues into this section through ${range(phase.startDistanceM, phase.endDistanceM)}`;
  else if (continuity === "end") movement = overallDirection && overallDirection !== (direction === "climb" ? "uphill" : "downhill")
    ? `Although mostly ${overallDirection}, a ${direction} from ${range(phase.startDistanceM, phase.endDistanceM)} continues into the next section`
    : `The ${direction} from ${range(phase.startDistanceM, phase.endDistanceM)} continues into the next section`;
  else if (!limitedCoverage && overallDirection && overallDirection !== (direction === "climb" ? "uphill" : "downhill")) {
    movement = isOpening
      ? `Although mostly ${overallDirection}, the section opens with ${adjective}${direction} from ${range(phase.startDistanceM, phase.endDistanceM)}`
      : `Although mostly ${overallDirection}, a ${direction} interrupts the section from ${range(phase.startDistanceM, phase.endDistanceM)}`;
  } else if (limitedCoverage) {
    movement = isOpening
      ? `Measured portions open with ${adjective}${direction} from ${range(phase.startDistanceM, phase.endDistanceM)}`
      : `A measured ${direction} stands out from ${range(phase.startDistanceM, phase.endDistanceM)}`;
  } else if (target.dominantRhythm === "rolling") {
    movement = `The section rolls between climbs and descents, with ${adjective}${direction} from ${range(phase.startDistanceM, phase.endDistanceM)}`;
  } else if (target.dominantRhythm === "flat") {
    movement = `Most of the section has little elevation change, though ${adjective}${direction} runs from ${range(phase.startDistanceM, phase.endDistanceM)}`;
  } else if (overallDirection) movement = isOpening
    ? `The route trends ${overallDirection}, opening with ${adjective}${direction} from ${range(phase.startDistanceM, phase.endDistanceM)}`
    : `The route trends ${overallDirection}, with ${adjective}${direction} from ${range(phase.startDistanceM, phase.endDistanceM)}`;
  else if (isOpening) movement = `The section opens with ${adjective}${direction} from ${range(phase.startDistanceM, phase.endDistanceM)}`;
  else movement = `A ${direction} stands out from ${range(phase.startDistanceM, phase.endDistanceM)}`;
  const gradeSegment = notableGradeSegments(phase).sort((a, b) =>
    Math.abs(b.averageNetGradePct) - Math.abs(a.averageNetGradePct) || b.distanceM - a.distanceM)[0];
  const grade = gradeSegment
    ? `, including a steeper stretch from ${range(gradeSegment.startDistanceM, gradeSegment.endDistanceM)} averaging ${signedGrade(gradeSegment.averageNetGradePct)}`
    : Math.abs(phase.averageNetGradePct ?? 0) >= 10 ? `, averaging ${signedGrade(phase.averageNetGradePct!)} over this interval` : "";
  return `${movement}${grade}.`;
}

function featureSentence(
  phase: RouteNarrativePhaseV2,
  previous?: RouteNarrativePhaseV2,
  continuity?: "start" | "end",
  bounds?: RouteNarrativePhasesV2["bounds"],
) {
  if (phase.direction === "rolling") return `From there, the route alternates between climbs and descents through ${range(phase.startDistanceM, phase.endDistanceM)}.`;
  if (phase.direction === "low-vertical-movement") return `The route briefly levels out from ${range(phase.startDistanceM, phase.endDistanceM)}.`;
  const direction = phase.direction === "climb" ? "climb" : "descent";
  const location = range(phase.startDistanceM, phase.endDistanceM);
  const gapM = previous ? phase.startDistanceM - previous.endDistanceM : Number.POSITIVE_INFINITY;
  const adjacent = previous && previous.direction !== "unknown" && gapM >= -100 && gapM <= 100;
  let movement: string;
  if (continuity === "start") movement = `The ${direction} continues into this section through ${location}`;
  else if (continuity === "end") movement = `The ${direction} continues into the next section from ${location}`;
  else if (adjacent && previous.direction !== phase.direction) movement = phase.direction === "climb"
    ? `From there, the route climbs through ${location}` : `From there, the route turns downhill through ${location}`;
  else if (adjacent) movement = `The ${direction} then continues through ${location}`;
  else {
    const position = bounds && bounds.endDistanceM > bounds.startDistanceM
      ? (phase.startDistanceM - bounds.startDistanceM) / (bounds.endDistanceM - bounds.startDistanceM)
      : 0;
    const transition = position >= 0.7 ? "Toward the end of this section" : position >= 0.35 ? "Later" : "A little later";
    movement = phase.direction === "climb"
      ? `${transition}, the route climbs again from ${location}` : `${transition}, the route descends from ${location}`;
  }
  const gradeSegment = notableGradeSegments(phase).sort((a, b) =>
    Math.abs(b.averageNetGradePct) - Math.abs(a.averageNetGradePct) || b.distanceM - a.distanceM)[0];
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

function phaseAverageIsSteep(phase: RouteNarrativePhaseV2) {
  return phase.averageNetGradePct !== null && Math.abs(phase.averageNetGradePct) >= 10;
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
function fallback(status: RouteSectionNarrativeV2["status"]): string[] {
  if (status === "missing-data") return ["A section narrative is not available for this analysis."];
  if (status === "unsupported-version") return ["A section narrative is not available for this version of the elevation analysis."];
  if (status === "invalid-data") return ["A reliable section narrative is not available for this elevation profile."];
  return ["The elevation profile does not support a clear section narrative."];
}
