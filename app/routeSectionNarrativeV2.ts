import type { GradientIntelligenceV1 } from "./gradientIntelligence.ts";
import type { RouteSection } from "./routeSectionEngine.ts";
import { buildRouteNarrativePhasesV2, type RouteNarrativePhaseV2, type RouteNarrativePhasesV2 } from "./routeNarrativePhases.ts";

export const ROUTE_SECTION_NARRATIVE_V2_PRESENTATION_VERSION = 2;
export const ROUTE_SECTION_NARRATIVE_V2_ALGORITHM_VERSION = 2;

export type RouteSectionNarrativeV2 = {
  presentationVersion: 2;
  algorithmVersion: 2;
  sectionId: string;
  segmentIndex: number;
  status: RouteNarrativePhasesV2["status"];
  phases: RouteNarrativePhasesV2;
  paragraphs: string[];
  trace: Array<{ paragraphIndex: number; sectionId: string; intervalIds: string[]; measuredFields: string[] }>;
};

/** Deterministically explains the full validated Route Section in chronological phases. */
export function presentRouteSectionNarrativeV2(
  gradient: GradientIntelligenceV1 | undefined,
  routeSections: readonly RouteSection[],
  target: RouteSection,
): RouteSectionNarrativeV2 {
  const phases = buildRouteNarrativePhasesV2(gradient, routeSections, target);
  const base = { presentationVersion: 2 as const, algorithmVersion: 2 as const, sectionId: target.id, segmentIndex: target.segmentIndex };
  if ((phases.status !== "available" && phases.status !== "limited") || !phases.measurements || !phases.coverage.complete) {
    return { ...base, status: phases.status, phases, paragraphs: fallback(phases.status), trace: [] };
  }
  const rendered = render(phases);
  return {
    ...base,
    status: phases.status,
    phases,
    paragraphs: rendered.map(item => item.text),
    trace: rendered.map((item, paragraphIndex) => ({ paragraphIndex, sectionId: phases.sectionId, intervalIds: [...new Set(item.intervalIds)], measuredFields: item.measuredFields })),
  };
}

type Rendered = { text: string; intervalIds: string[]; measuredFields: string[] };

function render(model: RouteNarrativePhasesV2): Rendered[] {
  const paragraphs: Rendered[] = [overview(model)];
  for (let index = 0; index < model.phases.length; index += 1) {
    const phase = model.phases[index];
    const before = model.phases[index - 1];
    const after = model.phases[index + 1];
    if (phase.direction === "unknown") {
      paragraphs.push({
        text: `About ${km(phase.distanceM)} of the section has uncertain interval direction, so no local rise-or-fall pattern is assigned there.`,
        intervalIds: phase.intervalIds,
        measuredFields: ["phase.direction", "phase.distanceM", "phase.unknownReasonCodes"],
      });
      continue;
    }
    // A single sub-kilometer neutral cell is retained in the phase model but is not a useful prose beat.
    if ((phase.direction === "rolling" || phase.direction === "low-vertical-movement") && phase.distanceM < 1000 && index > 0 && index < model.phases.length - 1) continue;
    if (phase.direction === "rolling") {
      const alternations = Math.max(0, phase.directionSequence.length - 1);
      const text = alternations >= 2
        ? `Climbs and descents alternate across about ${km(phase.distanceM)} of the section.`
        : alternations === 1
          ? `A brief ${phase.directionSequence[0]} leads into a ${phase.directionSequence[1]} across about ${km(phase.distanceM)}.`
          : `The profile rolls with little net change across about ${km(phase.distanceM)}.`;
      paragraphs.push({
        text,
        intervalIds: phase.intervalIds,
        measuredFields: ["phase.directionSequence", "phase.distanceM", "phase.startDistanceM", "phase.endDistanceM"],
      });
      continue;
    }
    if (phase.direction === "low-vertical-movement") {
      paragraphs.push({
        text: `Elevation changes remain limited through about ${km(phase.distanceM)} of the section.`,
        intervalIds: phase.intervalIds,
        measuredFields: ["phase.direction", "phase.distanceM"],
      });
      continue;
    }
    const oppositeInterruption = phase.distanceM < 1500 && (phase.direction === "climb" || phase.direction === "descent") &&
      before && after && (before.direction === "climb" || before.direction === "descent") &&
      before.direction === after.direction && before.direction !== phase.direction && before.distanceM >= phase.distanceM && after.distanceM >= phase.distanceM;
    if (oppositeInterruption) {
      const grade = phase.gradeSegments.find(item => isSteep(item.gradeBand) && item.distanceM >= 500);
      const bothSustained = before.distanceM >= 1500 && after.distanceM >= 1500;
      const text = bothSustained
        ? grade
          ? `A short ${phase.direction} interrupts the longer ${before.direction}. The ${phase.direction} averages about ${signedGrade(grade.averageNetGradePct)} smoothed net grade over ${km(grade.distanceM)}.`
          : `A short ${phase.direction} interrupts the longer ${before.direction}.`
        : `Between the ${before.direction}s, a short ${phase.direction} covers about ${km(phase.distanceM)}${grade ? ` and averages ${signedGrade(grade.averageNetGradePct)} smoothed net grade` : ""}.`;
      paragraphs.push({
        text,
        intervalIds: [...before.intervalIds, ...phase.intervalIds, ...after.intervalIds],
        measuredFields: ["phase.direction", "phase.distanceM", "phase.startDistanceM", "phase.endDistanceM", ...(grade ? ["phase.gradeSegments.averageNetGradePct"] : [])],
      });
    } else {
      const average = phase.averageNetGradePct!;
      const gradePhrase = phase.distanceM >= 1500 && Math.abs(average) >= 5 ? `, averaging ${signedGrade(average)} smoothed net grade` : "";
      const opener = index === 0 ? "It opens with" : index === model.phases.length - 1 ? "It finishes with"
        : before?.direction === "unknown" ? "Beyond that uncertain stretch is" : before && (before.direction === "climb" || before.direction === "descent") && before.direction !== phase.direction
          ? `After the ${before.direction} comes` : phase.role === "broad" ? "Across the broad middle, there is" : "Next is";
      const text = `${opener} a ${km(phase.distanceM)} ${phase.direction}${gradePhrase}.`;
      paragraphs.push({ text, intervalIds: phase.intervalIds, measuredFields: ["phase.direction", "phase.role", "phase.distanceM", "phase.averageNetGradePct"] });
    }
    if (!oppositeInterruption) for (const feature of notableGradeSegments(phase)) {
      paragraphs.push({
        text: `Within that ${phase.direction}, a ${feature.distanceM >= 1500 ? "sustained" : "short"} subsection averages ${signedGrade(feature.averageNetGradePct)} smoothed net grade over ${km(feature.distanceM)}.`,
        intervalIds: feature.intervalIds,
        measuredFields: ["phase.gradeSegments.gradeBand", "phase.gradeSegments.averageNetGradePct", "phase.gradeSegments.distanceM", "phase.gradeSegments.startDistanceM"],
      });
    }
  }
  return paragraphs;
}

function overview(model: RouteNarrativePhasesV2): Rendered {
  const measurements = model.measurements!;
  const distance = km(measurements.distanceM);
  const net = measurements.netElevationChangeM;
  const text = net >= 30
    ? `Across ${distance}, the section ends ${Math.round(net)} m higher than it starts.`
    : net <= -30
      ? `Across ${distance}, the section ends ${Math.round(Math.abs(net))} m lower than it starts.`
      : `Across ${distance}, the start and finish elevations differ by ${Math.round(Math.abs(net))} m, despite ${Math.round(measurements.ascentM)} m of ascent and ${Math.round(measurements.descentM)} m of descent.`;
  return { text, intervalIds: model.phases.flatMap(phase => phase.intervalIds), measuredFields: ["measurements.distanceM", "measurements.netElevationChangeM", "measurements.ascentM", "measurements.descentM"] };
}

function notableGradeSegments(phase: RouteNarrativePhaseV2) {
  return phase.gradeSegments.filter(segment => isSteep(segment.gradeBand) &&
    (segment.distanceM >= 1500 || (segment.distanceM >= 500 && segment.gradeBand === "extreme-grade")));
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
