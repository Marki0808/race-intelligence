import type { GradientIntelligenceV1 } from "./gradientIntelligence.ts";
import type { RouteSection } from "./routeSectionEngine.ts";
import { buildRouteNarrativePhasesV2, type RouteNarrativePhaseV2, type RouteNarrativePhasesV2 } from "./routeNarrativePhases.ts";

export const ROUTE_SECTION_NARRATIVE_V2_PRESENTATION_VERSION = 2;
export const ROUTE_SECTION_NARRATIVE_V2_ALGORITHM_VERSION = 3;

export type RouteSectionNarrativeV2 = {
  presentationVersion: 2;
  algorithmVersion: 3;
  sectionId: string;
  segmentIndex: number;
  status: RouteNarrativePhasesV2["status"];
  phases: RouteNarrativePhasesV2;
  paragraphs: string[];
  trace: Array<{ paragraphIndex: number; sectionId: string; intervalIds: string[]; measuredFields: string[] }>;
};

/** Deterministically summarizes the validated chronological phases without changing their measurements or coverage. */
export function presentRouteSectionNarrativeV2(
  gradient: GradientIntelligenceV1 | undefined,
  routeSections: readonly RouteSection[],
  target: RouteSection,
): RouteSectionNarrativeV2 {
  const phases = buildRouteNarrativePhasesV2(gradient, routeSections, target);
  const base = { presentationVersion: 2 as const, algorithmVersion: 3 as const, sectionId: target.id, segmentIndex: target.segmentIndex };
  if ((phases.status !== "available" && phases.status !== "limited") || !phases.measurements || !phases.coverage.complete) {
    return { ...base, status: phases.status, phases, paragraphs: fallback(phases.status), trace: [] };
  }
  const rendered = render(phases, target);
  return {
    ...base,
    status: phases.status,
    phases,
    paragraphs: rendered.map(item => item.text),
    trace: rendered.map((item, paragraphIndex) => ({ paragraphIndex, sectionId: phases.sectionId, intervalIds: [...new Set(item.intervalIds)], measuredFields: item.measuredFields })),
  };
}

type Rendered = { text: string; intervalIds: string[]; measuredFields: string[] };

function render(model: RouteNarrativePhasesV2, target: RouteSection): Rendered[] {
  const selected = selectNarrativePhases(model);
  const paragraphs: Rendered[] = [overview(model, target)];
  let paragraphPhases: Array<{ phase: RouteNarrativePhaseV2; index: number }> = [];
  const flush = () => {
    if (!paragraphPhases.length) return;
    const item = describeSelectedRun(paragraphPhases, model);
    paragraphs.push({
      text: item.text,
      intervalIds: [...new Set(item.intervalIds)],
      measuredFields: [...new Set(item.measuredFields)],
    });
    paragraphPhases = [];
  };

  for (let index = 0; index < model.phases.length; index += 1) {
    const phase = model.phases[index];
    if (phase.direction === "unknown" || !selected.has(index)) {
      flush();
      continue;
    }
    if (phase.direction === "rolling" || phase.direction === "low-vertical-movement") {
      flush();
      paragraphPhases.push({ phase, index });
      flush();
      continue;
    }
    paragraphPhases.push({ phase, index });
  }
  flush();

  const unknownPhases = model.phases.filter(phase => phase.direction === "unknown");
  if (unknownPhases.length) {
    const unknownDistanceM = unknownPhases.reduce((sum, phase) => sum + phase.distanceM, 0);
    paragraphs.push({
      text: `Local interval direction is uncertain across ${km(unknownDistanceM)} in ${unknownPhases.length} ${unknownPhases.length === 1 ? "stretch" : "separate stretches"}; this does not change the section's overall elevation profile.`,
      intervalIds: unknownPhases.flatMap(phase => phase.intervalIds),
      measuredFields: ["phase.direction", "phase.distanceM", "phase.unknownReasonCodes"],
    });
  }
  return paragraphs;
}

/** Keep major structure and noteworthy grades; use an adaptive budget only for ordinary phases. */
function selectNarrativePhases(model: RouteNarrativePhasesV2): Set<number> {
  const phases = model.phases;
  const measurements = model.measurements!;
  const candidates = phases.map((phase, index) => {
    const grades = importantGradeSegments(phase);
    const isDirectionalPhase = phase.direction === "climb" || phase.direction === "descent";
    const directionalTotal = phase.direction === "climb" ? measurements.ascentM : measurements.descentM;
    const contribution = phase.direction === "climb" ? phase.ascentM : phase.direction === "descent" ? phase.descentM : 0;
    const relativeContribution = directionalTotal > 0 ? contribution / directionalTotal : 0;
    const sectionShare = phase.distanceM / measurements.distanceM;
    const majorByShape = isDirectionalPhase && phase.distanceM >= 1500 && relativeContribution >= 0.2;
    const notableVerticalShare = isDirectionalPhase && phase.distanceM >= 500 && relativeContribution >= 0.25;
    const majorByExtent = isDirectionalPhase && phase.distanceM >= Math.max(2500, measurements.distanceM * 0.12);
    const sustainedStrongGrade = isDirectionalPhase && phase.distanceM >= 1500 && Math.abs(phase.averageNetGradePct ?? 0) >= 10;
    const notableNeutral = (phase.direction === "rolling" || phase.direction === "low-vertical-movement") &&
      phase.distanceM >= Math.max(1500, measurements.distanceM * 0.18);
    const preceding = phases[index - 1];
    const following = phases[index + 1];
    const significantReversalBefore = isDirectional(phase.direction) && isDirectional(preceding?.direction) &&
      phase.direction !== preceding.direction && phase.distanceM >= 1500 && preceding.distanceM >= 1500;
    const significantReversalAfter = isDirectional(phase.direction) && isDirectional(following?.direction) &&
      phase.direction !== following.direction && phase.distanceM >= 1500 && following.distanceM >= 1500;
    const significantReversal = significantReversalBefore || significantReversalAfter;
    const definingByExtent = isDirectionalPhase && phase.distanceM >= Math.max(3000, measurements.distanceM * 0.18);
    const definingByContribution = isDirectionalPhase && phase.distanceM >= 2500 && relativeContribution >= 0.15;
    const required = grades.length > 0 || isMeaningfulOppositeInterruption(phases, index) || significantReversal || definingByExtent || definingByContribution || notableVerticalShare;
    const eligible = required || majorByShape || majorByExtent || sustainedStrongGrade || notableNeutral;
    const score = (required ? 1000 : 0) + (significantReversal ? 500 : 0) + (majorByExtent ? 100 : 0) + (sustainedStrongGrade ? 75 : 0) + relativeContribution * 100 + sectionShare * 50 + phase.distanceM / 1000;
    return { index, eligible: eligible || significantReversal, required: required || significantReversal, score };
  });
  const eligible = candidates.filter(candidate => candidate.eligible);
  if (!eligible.length) {
    // Honest fallback for short or low-amplitude profiles: retain the longest known phase.
    const longest = candidates.filter(candidate => phases[candidate.index].direction !== "unknown")
      .sort((a, b) => phases[b.index].distanceM - phases[a.index].distanceM || a.index - b.index)[0];
    return new Set(longest ? [longest.index] : []);
  }
  const adaptiveBudget = Math.max(3, 2 + Math.ceil(Math.sqrt(phases.length)));
  const required = eligible.filter(candidate => candidate.required);
  const optional = eligible.filter(candidate => !candidate.required).sort((a, b) => b.score - a.score || a.index - b.index);
  const optionalSlots = Math.max(0, adaptiveBudget - required.length);
  return new Set([...required, ...optional.slice(0, optionalSlots)].map(candidate => candidate.index));
}

function describeSelectedRun(items: Array<{ phase: RouteNarrativePhaseV2; index: number }>, model: RouteNarrativePhasesV2) {
  const descriptions = items.map(({ phase, index }) => describePhase(phase, model, index));
  const hasInterruption = items.some(({ index }) => isMeaningfulOppositeInterruption(model.phases, index));
  const interruptionPosition = items.findIndex(({ index }) => isMeaningfulOppositeInterruption(model.phases, index));
  const hasCompleteInterruptionRun = interruptionPosition === 1 && items.length === 3 &&
    items[0].index + 1 === items[1].index && items[1].index + 1 === items[2].index &&
    items[0].phase.direction === items[2].phase.direction;
  const text = hasCompleteInterruptionRun
    ? describeCompleteInterruption(items[0].phase, items[1].phase, items[2].phase)
    : hasInterruption
    ? items.map(({ phase, index }, itemIndex) => {
      if (isMeaningfulOppositeInterruption(model.phases, index)) return descriptions[itemIndex];
      const previous = items[itemIndex - 1];
      if (previous && isMeaningfulOppositeInterruption(model.phases, previous.index)) {
        return `The ${phase.direction} resumes for ${km(phase.distanceM)}${phase.averageNetGradePct !== null && Math.abs(phase.averageNetGradePct) >= 5 ? `, averaging ${signedGrade(phase.averageNetGradePct)} smoothed net grade` : ""}.`;
      }
      return `${locationPhrase(phase, model)} ${descriptions[itemIndex]}.`;
    }).join(" ")
    : items.every(({ phase }) => isDirectional(phase.direction))
      ? descriptions.length === 1
        ? `${locationPhrase(items[0].phase, model)} ${descriptions[0]}.`
        : `${locationPhrase(items[0].phase, model)} the route moves through ${descriptions.join(", then ")}.`
      : descriptions.map((description, itemIndex) => {
        const phase = items[itemIndex].phase;
        return isDirectional(phase.direction) ? `${locationPhrase(phase, model)} ${description}.` : description;
      }).join(" ");
  const intervalIds = items.flatMap(({ phase, index }) => {
    const ids = [...phase.intervalIds];
    if (isMeaningfulOppositeInterruption(model.phases, index)) {
      ids.push(...model.phases[index - 1].intervalIds, ...model.phases[index + 1].intervalIds);
    }
    return ids;
  });
  const measuredFields = ["phase.direction", "phase.distanceM", "phase.averageNetGradePct", "phase.startDistanceM", "phase.endDistanceM"];
  if (items.some(({ phase, index }) => importantGradeSegments(phase, model.phases).length || isMeaningfulOppositeInterruption(model.phases, index))) {
    measuredFields.push("phase.gradeSegments.averageNetGradePct", "phase.gradeSegments.distanceM", "phase.gradeSegments.intervalIds");
  }
  return { text, intervalIds, measuredFields };
}

function describeCompleteInterruption(before: RouteNarrativePhaseV2, interruption: RouteNarrativePhaseV2, after: RouteNarrativePhaseV2) {
  const grade = importantGradeSegments(interruption, [before, interruption, after])[0];
  const gradeClause = grade ? ` averaging ${signedGrade(grade.averageNetGradePct)} smoothed net grade` : "";
  const gerund = before.direction === "climb" ? "climbing" : "descending";
  return `A short ${km(interruption.distanceM)} ${interruption.direction}${gradeClause} interrupts the ${gerund} sequence: ${km(before.distanceM)} before it and ${km(after.distanceM)} after it.`;
}

function describePhase(phase: RouteNarrativePhaseV2, model: RouteNarrativePhasesV2, index: number): string {
  const direction = phase.direction;
  const grade = phase.averageNetGradePct;
  const gradePhrase = grade !== null && Math.abs(grade) >= 5 ? `, averaging ${signedGrade(grade)} smoothed net grade` : "";
  const notable = importantGradeSegments(phase, model.phases);
  const featurePhrase = notable.length ? `, including ${notable.map(feature =>
    `${km(feature.distanceM)} ${feature.distanceM >= 1500 ? "sustained" : "short"} ${direction} at ${signedGrade(feature.averageNetGradePct)} smoothed net grade`).join(" and ")}` : "";
  if (direction === "rolling") {
    const alternations = Math.max(0, phase.directionSequence.length - 1);
    return alternations >= 2
      ? `${locationPhrase(phase, model)} climbs and descents alternate through ${km(phase.distanceM)} of the section.`
      : `${locationPhrase(phase, model)} a short climb and descent alternate through ${km(phase.distanceM)}.`;
  }
  if (direction === "low-vertical-movement") return `${locationPhrase(phase, model)} elevation changes stay limited across ${km(phase.distanceM)}.`;
  if (direction !== "climb" && direction !== "descent") return "";
  if (isMeaningfulOppositeInterruption(model.phases, index)) {
    const gradeClause = notable.length ? ` and averages ${signedGrade(notable[0].averageNetGradePct)} smoothed net grade over ${km(notable[0].distanceM)}` : "";
    const flank = model.phases[index - 1];
    return `A short ${direction} interrupts the longer ${flank.direction}${gradeClause}.`;
  }
  return `a ${km(phase.distanceM)} ${direction}${gradePhrase}${featurePhrase}`;
}

function locationPhrase(phase: RouteNarrativePhaseV2, model: RouteNarrativePhasesV2) {
  const location = phase.startDistanceM - model.bounds!.startDistanceM;
  const sectionDistance = model.measurements!.distanceM;
  const relativeStart = location / sectionDistance;
  const relativeEnd = (phase.endDistanceM - model.bounds!.startDistanceM) / sectionDistance;
  if (relativeStart <= 1 / 3) return "Early on,";
  if (relativeEnd >= 0.97) return "Near the finish,";
  if (relativeStart >= 2 / 3) return "Later,";
  return "Midway,";
}

function isDirectional(direction: RouteNarrativePhaseV2["direction"] | undefined): direction is "climb" | "descent" {
  return direction === "climb" || direction === "descent";
}

function overview(model: RouteNarrativePhasesV2, target: RouteSection): Rendered {
  const hasClimb = model.phases.some((phase) => phase.direction === "climb");
  const hasDescent = model.phases.some((phase) => phase.direction === "descent");
  const character = target.dominantRhythm === "climb"
    ? `Climbing is the stronger pattern across this section${hasDescent ? ", with descending intervals also shaping the profile" : ""}.`
    : target.dominantRhythm === "descent"
      ? `Descending is the stronger pattern across this section${hasClimb ? ", with climbs also shaping the profile" : ""}.`
      : target.dominantRhythm === "rolling"
        ? "Climbing and descending both shape the profile across this section."
        : "Elevation changes remain limited across most of this section.";
  let transition: string | null = null;
  for (let index = 1; index < model.phases.length; index += 1) {
    const before = model.phases[index - 1];
    const after = model.phases[index];
    const bothDirectional = (before.direction === "climb" || before.direction === "descent") &&
      (after.direction === "climb" || after.direction === "descent");
    if (bothDirectional && before.direction !== after.direction && before.distanceM >= 1500 && after.distanceM >= 1500 &&
      before.confidence !== "unknown" && after.confidence !== "unknown" &&
      Math.abs(before.endDistanceM - after.startDistanceM) <= 1) {
      transition = `A ${before.direction === "climb" ? "sustained climb" : "sustained descent"} is followed by a ${after.direction === "climb" ? "sustained climb" : "sustained descent"}.`;
      break;
    }
  }
  const text = [character, transition].filter(Boolean).join(" ");
  return { text, intervalIds: model.phases.flatMap(phase => phase.intervalIds), measuredFields: ["section.dominantRhythm", "phase.direction", "phase.distanceM", "phase.startDistanceM", "phase.endDistanceM", "phase.confidence", "measurements.ascentM", "measurements.descentM", "measurements.netElevationChangeM"] };
}

function notableGradeSegments(phase: RouteNarrativePhaseV2) {
  return phase.gradeSegments.filter(segment => isSteep(segment.gradeBand) &&
    (segment.distanceM >= 1500 || (segment.distanceM >= 500 && segment.gradeBand === "extreme-grade")) &&
    segment.distanceM < phase.distanceM - 100 &&
    (segment.gradeBand === "extreme-grade" || segment.distanceM < phase.distanceM * 0.5 ||
      Math.abs(segment.averageNetGradePct - (phase.averageNetGradePct ?? segment.averageNetGradePct)) > 1));
}

function importantGradeSegments(phase: RouteNarrativePhaseV2, phases: readonly RouteNarrativePhaseV2[] = []): RouteNarrativePhaseV2["gradeSegments"] {
  const notable = notableGradeSegments(phase);
  if (notable.length) return notable;
  const index = phases.indexOf(phase);
  return isMeaningfulOppositeInterruption(phases, index)
    ? phase.gradeSegments.filter(segment => isSteep(segment.gradeBand) && segment.distanceM >= 500)
    : [];
}

function isMeaningfulOppositeInterruption(phases: readonly RouteNarrativePhaseV2[], index: number): boolean {
  const phase = phases[index];
  const before = phases[index - 1];
  const after = phases[index + 1];
  return Boolean(phase && before && after && phase.distanceM < 1500 && phase.distanceM >= 500 &&
    (phase.direction === "climb" || phase.direction === "descent") && before.direction === after.direction &&
    (before.direction === "climb" || before.direction === "descent") && before.direction !== phase.direction &&
    before.distanceM >= phase.distanceM && after.distanceM >= phase.distanceM &&
    phase.gradeSegments.some(segment => isSteep(segment.gradeBand) && segment.distanceM >= 500));
}

function isSteep(band: string) { return band === "steep" || band === "very-steep" || band === "extreme-grade"; }
function signedGrade(value: number) { return `${value < 0 ? "−" : "+"}${Math.round(Math.abs(value))}%`; }
function km(distanceM: number) { return `${(distanceM / 1000).toFixed(1)} km`; }

function fallback(status: RouteSectionNarrativeV2["status"]): string[] {
  if (status === "missing-data") return ["A section narrative is not available for this analysis."];
  if (status === "unsupported-version") return ["A section narrative is not available for this version of the elevation analysis."];
  if (status === "invalid-data") return ["A reliable section narrative is not available for this elevation profile."];
  return ["The elevation profile does not support a clear section narrative."];
}
