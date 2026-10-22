import type { GradientIntelligenceV1 } from "./gradientIntelligence.ts";
import type { RouteSection } from "./routeSectionEngine.ts";
import { buildRouteNarrativePhasesV2, type RouteNarrativePhaseV2, type RouteNarrativePhasesV2 } from "./routeNarrativePhases.ts";

export const ROUTE_SECTION_NARRATIVE_V2_PRESENTATION_VERSION = 2;
export const ROUTE_SECTION_NARRATIVE_V2_ALGORITHM_VERSION = 4;

export type RouteSectionNarrativeV2 = {
  presentationVersion: 2;
  algorithmVersion: 4;
  sectionId: string;
  segmentIndex: number;
  status: RouteNarrativePhasesV2["status"];
  phases: RouteNarrativePhasesV2;
  paragraphs: string[];
  trace: Array<{ paragraphIndex: number; sectionId: string; intervalIds: string[]; measuredFields: string[] }>;
};

type StoryEvent = { phase: RouteNarrativePhaseV2; index: number };

/** Builds runner-facing prose from selected facts while preserving the validated chronological phase model. */
export function presentRouteSectionNarrativeV2(
  gradient: GradientIntelligenceV1 | undefined,
  routeSections: readonly RouteSection[],
  target: RouteSection,
): RouteSectionNarrativeV2 {
  const phases = buildRouteNarrativePhasesV2(gradient, routeSections, target);
  const base = { presentationVersion: 2 as const, algorithmVersion: 4 as const, sectionId: target.id, segmentIndex: target.segmentIndex };
  if ((phases.status !== "available" && phases.status !== "limited") || !phases.measurements || !phases.coverage.complete) {
    return { ...base, status: phases.status, phases, paragraphs: fallback(phases.status), trace: [] };
  }
  const story = composeStory(phases, target);
  return {
    ...base,
    status: phases.status,
    phases,
    paragraphs: story.text ? [story.text] : fallback(phases.status),
    trace: story.text ? [{ paragraphIndex: 0, sectionId: phases.sectionId, intervalIds: story.intervalIds, measuredFields: story.measuredFields }] : [],
  };
}

function composeStory(model: RouteNarrativePhasesV2, target: RouteSection) {
  const events = selectStoryEvents(model);
  const sentences: string[] = [];
  const relevant = new Set<number>();
  if (events.length === 3 && isInterruptionSequence(model, events[0], events[1], events[2])) {
    const text = interruptionSentence(events[0].phase, events[1].phase);
    return { text, intervalIds: [...new Set(events.flatMap(event => event.phase.intervalIds))], measuredFields: storyMeasuredFields };
  }
  if (events.length === 2 && hasNoUnknownBetween(model, events[0].phase, events[1].phase)) {
    const [first, second] = events;
    const middle = model.phases.slice(first.index + 1, second.index);
    const secondAtFinish = second.phase.endDistanceM >= model.bounds!.endDistanceM - Math.max(100, model.measurements!.distanceM * 0.02);
    if (first.phase.direction === "descent" && second.phase.direction === "climb" && secondAtFinish) {
      return {
        text: `${capitalise(eventPhrase(first.phase))} is followed near the finish by ${eventPhrase(second.phase)}.`,
        intervalIds: [...new Set([first.phase, ...middle, second.phase].flatMap(phase => phase.intervalIds))],
        measuredFields: storyMeasuredFields,
      };
    }
    if (first.phase.direction === second.phase.direction && middle.every(phase => phase.direction === "low-vertical-movement")) {
      const direction = first.phase.direction === "climb" ? "ascent" : "descent";
      const continuation = second.phase.distanceM >= 4000
        ? ` before another ${first.phase.direction} of about ${km(second.phase.distanceM)}`
        : ` before ${first.phase.direction === "climb" ? "the climb" : "the descent"} resumes`;
      return { text: `The ${direction} eases briefly${continuation}.`, intervalIds: [...new Set([first.phase, second.phase, ...middle].flatMap(phase => phase.intervalIds))], measuredFields: storyMeasuredFields };
    }
    return {
      text: `${locationPrefixFor(first.phase, model)}, ${eventPhrase(first.phase)} is followed by ${eventPhrase(second.phase)}.`,
      intervalIds: [...new Set([first.phase, ...middle, second.phase].flatMap(phase => phase.intervalIds))],
      measuredFields: storyMeasuredFields,
    };
  }
  if (events.length === 2 && events[0].phase.direction === events[1].phase.direction && isNarrativeDirection(events[0].phase.direction)) {
    const [first, second] = events;
    const between = model.phases.slice(first.index + 1, second.index);
    const otherDirection = between.some(phase => isNarrativeDirection(phase.direction) && phase.direction !== first.phase.direction);
    const direction = first.phase.direction === "climb" ? "climbs" : "descents";
    const adjective = first.phase.distanceM >= 2500 && second.phase.distanceM >= 2500 ? "long " : "sustained ";
    const separator = otherDirection
      ? `, with a shorter ${first.phase.direction === "climb" ? "descent" : "climb"} between them`
      : ", separated by an unclear stretch";
    return {
      text: `Two ${adjective}${direction} shape the section${separator}.`,
      intervalIds: [...new Set([first.phase, ...between, second.phase].flatMap(phase => phase.intervalIds))],
      measuredFields: storyMeasuredFields,
    };
  }
  if (!events.length) {
    const trend = describeOverallCharacter(target, model);
    if (trend) {
      sentences.push(trend);
      model.phases.forEach((phase, index) => relevant.add(index));
    }
  }

  const groups = [[], [], []] as StoryEvent[][];
  for (const event of events) {
    const midpoint = (event.phase.startDistanceM + event.phase.endDistanceM) / 2;
    const relative = (midpoint - model.bounds!.startDistanceM) / model.measurements!.distanceM;
    groups[relative < 1 / 3 ? 0 : relative < 2 / 3 ? 1 : 2].push(event);
    relevant.add(event.index);
  }
  groups.forEach((group, groupIndex) => {
    if (!group.length) return;
    const summary = summarizeRegion(model, group, groupIndex);
    sentences.push(summary.text);
    summary.indices.forEach(index => relevant.add(index));
  });

  // Unknown intervals remain fully represented in structured phases and are summarized once, without exposing diagnostics.
  if (model.status === "limited" && model.coverage.unknownDistanceM > 0) {
    const unknown = model.phases.map((phase, index) => ({ phase, index })).filter(({ phase }) => phase.direction === "unknown");
    if (unknown.length) {
      sentences.push("Some local elevation changes are unclear, so smaller transitions through those stretches are uncertain.");
      unknown.forEach(({ index }) => relevant.add(index));
    }
  }

  if (!sentences.length) {
    const longest = model.phases.reduce((best, phase, index) => !best || phase.distanceM > best.phase.distanceM ? { phase, index } : best, null as StoryEvent | null);
    if (longest) {
      relevant.add(longest.index);
      sentences.push(longest.phase.direction === "low-vertical-movement"
        ? "Elevation changes stay limited across this section."
        : longest.phase.direction === "rolling"
          ? "The route moves between climbs and descents through this section."
          : "The elevation profile does not show a clear dominant pattern.");
    }
  }

  return {
    text: sentences.join(" "),
    intervalIds: [...new Set([...relevant].sort((a, b) => a - b).flatMap(index => model.phases[index].intervalIds))],
    measuredFields: storyMeasuredFields,
  };
}

const storyMeasuredFields = [
  "section.dominantRhythm", "phase.direction", "phase.distanceM", "phase.startDistanceM", "phase.endDistanceM",
  "phase.confidence", "phase.gradeSegments.gradeBand", "phase.gradeSegments.distanceM", "phase.unknownReasonCodes",
  "measurements.ascentM", "measurements.descentM", "measurements.netElevationChangeM",
];

function summarizeRegion(model: RouteNarrativePhasesV2, events: StoryEvent[], region: number) {
  const first = events[0];
  const last = events.at(-1)!;
  const indices = events.map(event => event.index);
  const location = region === 0 ? "Early on" : region === 1 ? "In the middle" : "Toward the end";
  if (events.length === 1) {
    const phase = first.phase;
    if (phase.direction === "rolling") return { text: `${location}, the route moves between climbs and descents.`, indices };
    if (phase.direction === "low-vertical-movement") return { text: `${location}, elevation changes stay limited.`, indices };
    if (phase.distanceM < 1500 && hasSteepGrade(phase)) return { text: `${location}, a brief but steep ${phase.direction} stands out.`, indices };
    const length = phase.distanceM >= 1500 ? ` for about ${km(phase.distanceM)}` : "";
    const steepness = notableGradeSegments(phase).length ? ", with a notably steep stretch" : "";
    const direction = phase.direction === "climb" ? "climbs" : "descends";
    return { text: `${location}, the route ${direction}${length}${steepness}.`, indices };
  }

  const directions = events.map(event => event.phase.direction);
  const hasUnknownBetween = model.phases.slice(first.index + 1, last.index).some(phase => phase.direction === "unknown");
  const exactInterruption = events.length === 3 && first.index + 1 === events[1].index && events[1].index + 1 === last.index &&
    first.phase.direction === last.phase.direction && first.phase.direction !== events[1].phase.direction && events[1].phase.distanceM < 1500;
  if (exactInterruption) return { text: `${location}, ${lowerFirst(interruptionSentence(first.phase, events[1].phase))}`, indices };

  const allSame = directions.every(direction => direction === directions[0]);
  if (allSame && (directions[0] === "climb" || directions[0] === "descent")) {
    const hasOppositeBetween = model.phases.slice(first.index + 1, last.index).some(phase => phase.direction !== directions[0] && phase.direction !== "low-vertical-movement");
    if (!hasOppositeBetween && !hasUnknownBetween) {
      const noun = directions[0] === "climb" ? "ascent" : "descent";
      return { text: `${location}, the ${noun} comes in more than one sustained stretch, with a brief easing in between.`, indices };
    }
  }

  const firstDirection = directions.find(isNarrativeDirection);
  const lastDirection = [...directions].reverse().find(isNarrativeDirection);
  if (firstDirection && lastDirection && firstDirection !== lastDirection) {
    const firstNoun = firstDirection === "climb" ? "climb" : "descent";
    const lastNoun = lastDirection === "climb" ? "climb" : "descent";
    if (hasUnknownBetween) {
      const lastAtFinish = last.phase.endDistanceM >= model.bounds!.endDistanceM - Math.max(100, model.measurements!.distanceM * 0.02);
      if (region === 2 && firstNoun === "descent" && lastNoun === "climb" && lastAtFinish) {
        return { text: "The closing kilometres include a long descent, with climbing returning at the finish.", indices };
      }
      const adjective = first.phase.distanceM >= 2500 ? "long " : first.phase.distanceM >= 1500 ? "sustained " : "";
      const laterAdjective = last.phase.distanceM >= 2500 ? "long " : last.phase.distanceM >= 1500 ? "sustained " : "";
      return { text: `${location}, a ${adjective}${firstNoun} is followed later by a ${laterAdjective}${lastNoun}, with an unclear stretch between.`, indices };
    }
    return { text: `${location}, the route moves from a ${firstNoun} into a ${lastNoun}.`, indices };
  }
  if (firstDirection && lastDirection) {
    const sequence = model.phases.slice(first.index, last.index + 1).filter(phase => isNarrativeDirection(phase.direction)).map(phase => phase.direction);
    const collapsed = sequence.filter((direction, index) => index === 0 || direction !== sequence[index - 1]);
    if (collapsed.length === 3 && collapsed[0] === collapsed[2] && events.length >= 3) {
      const interruption = collapsed[1] === "climb" ? "climb" : "descent";
      const broad = collapsed[0] === "climb" ? "climb" : "descent";
      const middle = model.phases.slice(first.index + 1, last.index).filter(phase => phase.direction === interruption);
      const lastAtFinish = last.phase.endDistanceM >= model.bounds!.endDistanceM - Math.max(100, model.measurements!.distanceM * 0.02);
      if (region === 2 && interruption === "descent" && broad === "climb" && lastAtFinish && middle.some(phase => phase.distanceM >= 1500)) {
        return { text: "The closing kilometres include a long descent, with the route climbing again at the finish.", indices };
      }
      if (middle.length === 1 && middle[0].distanceM < 1500) {
        const shortSteep = hasSteepGrade(middle[0]);
        return { text: `${location}, ${shortSteep ? "a short, steep" : "a brief"} ${interruption} breaks up the ${broad}, which resumes afterward.`, indices };
      }
      if (hasUnknownBetween) {
        if (region === 2 && interruption === "descent" && broad === "climb" && lastAtFinish) {
          return { text: "The closing kilometres include a long descent, with the route climbing again at the finish.", indices };
        }
        return { text: `${location}, the route has a longer ${interruption} before climbing returns${lastAtFinish && broad === "climb" ? " near the finish" : ""}.`, indices };
      }
      return { text: `${location}, the profile shifts from a ${broad} into a longer ${interruption}, then returns to the ${broad}${lastAtFinish ? " near the finish" : ""}.`, indices };
    }
    if (collapsed.length > 1) return { text: `${location}, climbing and descending alternate in this part of the route.`, indices };
    const noun = firstDirection === "climb" ? "ascent" : "descent";
    return { text: `${location}, the ${noun} comes in more than one sustained stretch.`, indices };
  }
  return { text: `${location}, the profile shifts between climbing and descending.`, indices };
}

function isNarrativeDirection(direction: RouteNarrativePhaseV2["direction"]): direction is "climb" | "descent" {
  return direction === "climb" || direction === "descent";
}

/** Keep section-defining movements, large reversals, notable grade spans, and meaningful opening/closing changes. */
function selectStoryEvents(model: RouteNarrativePhasesV2): StoryEvent[] {
  const phases = model.phases;
  const measurements = model.measurements!;
  const directionalTotals = { climb: measurements.ascentM, descent: measurements.descentM };
  const selected = new Set<number>();
  phases.forEach((phase, index) => {
    if (phase.direction !== "climb" && phase.direction !== "descent") return;
    const contribution = phase.direction === "climb" ? phase.ascentM : phase.descentM;
    const share = directionalTotals[phase.direction] > 0 ? contribution / directionalTotals[phase.direction] : 0;
    const sectionShare = phase.distanceM / measurements.distanceM;
    const notableGrade = notableGradeSegments(phase).length > 0;
    const notableShortSteep = phase.distanceM >= 500 && hasSteepGrade(phase);
    const definingExtent = phase.distanceM >= Math.max(2500, measurements.distanceM * 0.12) && share >= 0.1;
    const significantContribution = phase.distanceM >= 1000 && contribution >= 50 && share >= 0.14;
    const preceding = phases[index - 1];
    const meaningfulReversal = (preceding?.direction === "climb" || preceding?.direction === "descent") &&
      preceding.direction !== phase.direction && preceding.distanceM >= 1500 && phase.distanceM >= 1500;
    const openingOrClosing = (index === 0 || index === phases.length - 1) && phase.distanceM >= 700 && share >= 0.08;
    if (notableGrade || notableShortSteep || definingExtent || significantContribution || meaningfulReversal || openingOrClosing || sectionShare >= 0.2) selected.add(index);
  });

  // Retain a shorter opposite-direction phase when it interrupts two selected movements in the same direction.
  for (let index = 1; index < phases.length - 1; index += 1) {
    const phase = phases[index];
    if (phase.direction !== "climb" && phase.direction !== "descent") continue;
    if (phase.distanceM < 500 || phase.distanceM >= 1500 || !hasSteepGrade(phase)) continue;
    const before = phases[index - 1];
    const after = phases[index + 1];
    if (before.direction === after.direction && before.direction !== phase.direction && selected.has(index - 1) && selected.has(index + 1)) selected.add(index);
  }

  if (!selected.size) {
    const longest = phases.map((phase, index) => ({ phase, index })).filter(({ phase }) => phase.direction !== "unknown")
      .sort((a, b) => b.phase.distanceM - a.phase.distanceM || a.index - b.index)[0];
    if (longest) selected.add(longest.index);
  }
  return [...selected].sort((a, b) => a - b).map(index => ({ phase: phases[index], index }));
}

function describeOverallCharacter(target: RouteSection, model: RouteNarrativePhasesV2): string | null {
  const hasClimb = model.phases.some(phase => phase.direction === "climb");
  const hasDescent = model.phases.some(phase => phase.direction === "descent");
  if (target.dominantRhythm === "climb") return hasDescent ? "Climbing shapes most of the elevation change, with descents breaking up the ascent." : "The section is shaped by climbing.";
  if (target.dominantRhythm === "descent") return hasClimb ? "Descending shapes most of the elevation change, with climbs breaking up the descent." : "The section is shaped by descending.";
  if (target.dominantRhythm === "rolling") return "Climbing and descending both shape the section.";
  if (!hasClimb && !hasDescent) return "Elevation changes stay limited across the section.";
  return null;
}

function isInterruptionSequence(model: RouteNarrativePhasesV2, before: StoryEvent, interruption: StoryEvent, after?: StoryEvent) {
  return Boolean(after && before.index + 1 === interruption.index && interruption.index + 1 === after.index &&
    before.phase.direction === after.phase.direction && before.phase.direction !== interruption.phase.direction &&
    interruption.phase.distanceM >= 500 && interruption.phase.distanceM < 1500 &&
    before.phase.distanceM >= interruption.phase.distanceM && after.phase.distanceM >= interruption.phase.distanceM &&
    hasNoUnknownBetween(model, before.phase, after.phase));
}

function interruptionSentence(before: RouteNarrativePhaseV2, interruption: RouteNarrativePhaseV2) {
  const interrupted = before.direction === "climb" ? "climbing" : "descending";
  const isSteep = hasSteepGrade(interruption);
  const noun = before.direction === "climb" ? "climb" : "descent";
  return `${isSteep ? "A short, steep" : "A brief"} ${interruption.direction} breaks up the ${interrupted}; the ${noun} resumes afterward.`;
}

function eventPhrase(phase: RouteNarrativePhaseV2) {
  if (phase.distanceM < 1500 && hasSteepGrade(phase)) return `a short, steep ${phase.direction}`;
  const length = phase.distanceM >= 1500 ? ` of about ${km(phase.distanceM)}` : "";
  const duration = phase.distanceM >= 2500 ? "long " : phase.distanceM >= 1500 ? "sustained " : "";
  const grade = notableGradeSegments(phase).length ? " with a notably steep stretch" : "";
  return `a ${duration}${phase.direction}${length}${grade}`;
}

function hasNoUnknownBetween(model: RouteNarrativePhasesV2, before: RouteNarrativePhaseV2, after: RouteNarrativePhaseV2) {
  const from = model.phases.indexOf(before);
  const to = model.phases.indexOf(after);
  return from >= 0 && to > from && model.phases.slice(from + 1, to).every(phase => phase.direction !== "unknown");
}

function locationPrefixFor(phase: RouteNarrativePhaseV2, model: RouteNarrativePhasesV2) {
  const midpoint = ((phase.startDistanceM + phase.endDistanceM) / 2 - model.bounds!.startDistanceM) / model.measurements!.distanceM;
  return midpoint < 1 / 3 ? "Early on" : midpoint < 2 / 3 ? "In the middle" : "Toward the end";
}

function notableGradeSegments(phase: RouteNarrativePhaseV2) {
  return phase.gradeSegments.filter(segment =>
    (segment.gradeBand === "steep" || segment.gradeBand === "very-steep" || segment.gradeBand === "extreme-grade") &&
    (segment.distanceM >= 1500 || (segment.distanceM >= 500 && segment.gradeBand === "extreme-grade")) &&
    segment.distanceM < phase.distanceM - 100);
}

function hasSteepGrade(phase: RouteNarrativePhaseV2) {
  return phase.gradeSegments.some(segment =>
    (segment.gradeBand === "steep" || segment.gradeBand === "very-steep" || segment.gradeBand === "extreme-grade") && segment.distanceM >= 500);
}

function km(distanceM: number) { return `${(distanceM / 1000).toFixed(1)} km`; }
function capitalise(value: string) { return value[0].toUpperCase() + value.slice(1); }
function lowerFirst(value: string) { return value[0].toLowerCase() + value.slice(1); }

function fallback(status: RouteSectionNarrativeV2["status"]): string[] {
  if (status === "missing-data") return ["A section narrative is not available for this analysis."];
  if (status === "unsupported-version") return ["A section narrative is not available for this version of the elevation analysis."];
  if (status === "invalid-data") return ["A reliable section narrative is not available for this elevation profile."];
  return ["The elevation profile does not support a clear section narrative."];
}
