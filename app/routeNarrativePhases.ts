import { presentGradientExpectationV1 } from "./gradientIntelligencePresentation.ts";
import type { GradientIntelligenceV1, GradientIntervalV1 } from "./gradientIntelligence.ts";
import type { RouteSection } from "./routeSectionEngine.ts";

export const ROUTE_NARRATIVE_PHASES_SCHEMA_VERSION = 2;
export const ROUTE_NARRATIVE_PHASES_ALGORITHM_VERSION = 2;

export type RouteNarrativePhaseV2 = {
  id: string;
  direction: "climb" | "descent" | "rolling" | "low-vertical-movement" | "unknown";
  role: "opening" | "middle" | "closing" | "broad";
  startDistanceM: number;
  endDistanceM: number;
  distanceM: number;
  averageNetGradePct: number | null;
  ascentM: number;
  descentM: number;
  confidence: "high" | "moderate" | "unknown";
  coverage: { measuredDistanceM: number; unknownDistanceM: number; measuredShare: number };
  intervalIds: string[];
  directionSequence: Array<"climb" | "descent">;
  gradeSegments: Array<{
    direction: "climb" | "descent";
    gradeBand: NonNullable<GradientIntervalV1["gradientBand"]>;
    startDistanceM: number;
    endDistanceM: number;
    distanceM: number;
    averageNetGradePct: number;
    intervalIds: string[];
  }>;
  unknownReasonCodes: string[];
};

export type RouteNarrativePhasesV2 = {
  schemaVersion: 2;
  algorithmVersion: 2;
  sectionId: string;
  segmentIndex: number;
  status: "available" | "limited" | "unknown" | "missing-data" | "unsupported-version" | "invalid-data";
  bounds: { startDistanceM: number; endDistanceM: number } | null;
  coverage: { coveredDistanceM: number; unknownDistanceM: number; complete: boolean };
  measurements: { distanceM: number; ascentM: number; descentM: number; netElevationChangeM: number } | null;
  phases: RouteNarrativePhaseV2[];
};

type DirectionalRun = { direction: RouteNarrativePhaseV2["direction"]; intervals: GradientIntervalV1[] };

/** Builds a whole-section chronological model from the validated, component-scoped V1.1 intervals. */
export function buildRouteNarrativePhasesV2(
  gradient: GradientIntelligenceV1 | undefined,
  routeSections: readonly RouteSection[],
  target: RouteSection,
): RouteNarrativePhasesV2 {
  const validation = presentGradientExpectationV1(gradient, routeSections, target);
  const sectionId = target.id;
  const base = { schemaVersion: 2 as const, algorithmVersion: 2 as const, sectionId, segmentIndex: target.segmentIndex };
  if (validation.status !== "available" || !gradient) {
    return { ...base, status: validation.status, bounds: null, coverage: { coveredDistanceM: 0, unknownDistanceM: 0, complete: false }, measurements: null, phases: [] };
  }
  const source = gradient.sections.find((item) => item.sectionId === sectionId && item.segmentIndex === target.segmentIndex);
  if (!source?.intervals.length || ![target.ascentM, target.descentM, target.elevationStartM, target.elevationEndM].every(Number.isFinite) || target.ascentM < 0 || target.descentM < 0) {
    return { ...base, status: "invalid-data", bounds: null, coverage: { coveredDistanceM: 0, unknownDistanceM: 0, complete: false }, measurements: null, phases: [] };
  }
  const intervals = source.intervals;
  const startDistanceM = target.startPosition.distanceM;
  const endDistanceM = target.endPosition.distanceM;
  const runs = makeRuns(intervals);
  const merged = mergeShortAlternationRuns(runs);
  const phases = merged.map((run, index) => makePhase(run, index, startDistanceM, endDistanceM));
  const coveredDistanceM = phases.reduce((sum, phase) => sum + phase.distanceM, 0);
  const unknownDistanceM = phases.reduce((sum, phase) => sum + (phase.direction === "unknown" ? phase.distanceM : 0), 0);
  const firstPhase = phases[0];
  const lastPhase = phases.at(-1);
  const complete = Boolean(firstPhase && lastPhase) && Math.abs(firstPhase!.startDistanceM - startDistanceM) <= 0.02 &&
    Math.abs(lastPhase!.endDistanceM - endDistanceM) <= 0.02 &&
    phases.every((phase, index) => index === 0 || Math.abs(phases[index - 1].endDistanceM - phase.startDistanceM) <= 0.02) &&
    Math.abs(coveredDistanceM - (endDistanceM - startDistanceM)) <= 0.05;
  if (!complete) return { ...base, status: "invalid-data", bounds: null, coverage: { coveredDistanceM, unknownDistanceM, complete: false }, measurements: null, phases: [] };
  return {
    ...base,
    status: unknownDistanceM / coveredDistanceM > 0.2 ? "limited" : "available",
    bounds: { startDistanceM, endDistanceM },
    coverage: { coveredDistanceM, unknownDistanceM, complete: true },
    measurements: {
      distanceM: endDistanceM - startDistanceM,
      ascentM: target.ascentM,
      descentM: target.descentM,
      netElevationChangeM: target.elevationEndM - target.elevationStartM,
    },
    phases,
  };
}

function makeRuns(intervals: readonly GradientIntervalV1[]): DirectionalRun[] {
  const runs: DirectionalRun[] = [];
  for (const interval of intervals) {
    const direction = interval.direction;
    const last = runs.at(-1);
    if (last?.direction === direction) last.intervals.push(interval);
    else runs.push({ direction, intervals: [interval] });
  }
  return runs;
}

/** Compress only short, non-steep alternating runs. Steep members remain visible as their own phases. */
function mergeShortAlternationRuns(runs: DirectionalRun[]): DirectionalRun[] {
  const output: DirectionalRun[] = [];
  let index = 0;
  while (index < runs.length) {
    if (runs[index].direction !== "climb" && runs[index].direction !== "descent") {
      output.push(runs[index++]);
      continue;
    }
    let end = index + 1;
    const directionalRuns: DirectionalRun[] = [runs[index]];
    let neutralDistanceM = 0;
    while (end < runs.length) {
      const candidate = runs[end];
      if (candidate.direction === "unknown") break;
      if (candidate.direction === "rolling" || candidate.direction === "low-vertical-movement") {
        const next = runs[end + 1];
        const bridgeDistance = runLength(candidate);
        if (!next || (next.direction !== "climb" && next.direction !== "descent") || bridgeDistance > 1000 ||
            next.direction === directionalRuns.at(-1)!.direction || neutralDistanceM + bridgeDistance > 1000) break;
        neutralDistanceM += bridgeDistance;
        end += 1;
        continue;
      }
      if (candidate.direction !== "climb" && candidate.direction !== "descent") break;
      if (candidate.direction === directionalRuns.at(-1)!.direction) break;
      directionalRuns.push(candidate);
      end += 1;
    }
    const group = runs.slice(index, end);
    const lengths = directionalRuns.map(run => runLength(run));
    const hasNotableGrade = directionalRuns.some(run => run.intervals.some(interval =>
      (interval.gradientBand === "steep" || interval.gradientBand === "very-steep" || interval.gradientBand === "extreme-grade") && interval.distanceM >= 500));
    if (directionalRuns.length >= 3 && lengths.every(length => length <= 1500) && !hasNotableGrade) {
      output.push({ direction: "rolling", intervals: group.flatMap(run => run.intervals) });
    } else output.push(...group);
    index = end;
  }
  return output;
}

function runLength(run: DirectionalRun) {
  return run.intervals.reduce((sum, interval) => sum + interval.distanceM, 0);
}

function makePhase(run: DirectionalRun, index: number, sectionStartM: number, sectionEndM: number): RouteNarrativePhaseV2 {
  const intervals = run.intervals;
  const first = intervals[0];
  const last = intervals.at(-1)!;
  const distanceM = last.endDistanceM - first.startDistanceM;
  const netElevationChangeM = intervals.reduce((sum, interval) => sum + interval.metrics.netElevationChangeM, 0);
  const distanceRatioStart = (first.startDistanceM - sectionStartM) / (sectionEndM - sectionStartM);
  const distanceRatioEnd = (last.endDistanceM - sectionStartM) / (sectionEndM - sectionStartM);
  const role = distanceM / (sectionEndM - sectionStartM) >= 0.5 ? "broad"
    : distanceRatioEnd <= 1 / 3 ? "opening" : distanceRatioStart >= 2 / 3 ? "closing" : "middle";
  return {
    id: `phase-${index + 1}`,
    direction: run.direction,
    role,
    startDistanceM: first.startDistanceM,
    endDistanceM: last.endDistanceM,
    distanceM,
    averageNetGradePct: run.direction === "climb" || run.direction === "descent" ? netElevationChangeM / distanceM * 100 : null,
    ascentM: intervals.reduce((sum, interval) => sum + interval.metrics.ascentM, 0),
    descentM: intervals.reduce((sum, interval) => sum + interval.metrics.descentM, 0),
    confidence: run.direction === "unknown" ? "unknown" : intervals.some(interval => interval.confidence === "moderate") ? "moderate" : "high",
    coverage: { measuredDistanceM: run.direction === "unknown" ? 0 : distanceM, unknownDistanceM: run.direction === "unknown" ? distanceM : 0, measuredShare: run.direction === "unknown" ? 0 : 1 },
    intervalIds: intervals.map(interval => interval.intervalId),
    directionSequence: run.direction === "rolling" ? intervals.map(interval => interval.direction).filter((direction): direction is "climb" | "descent" => direction === "climb" || direction === "descent") : [],
    gradeSegments: makeGradeSegments(intervals),
    unknownReasonCodes: [...new Set(intervals.flatMap(interval => interval.unknownReasons ?? []))],
  };
}

function makeGradeSegments(intervals: readonly GradientIntervalV1[]): RouteNarrativePhaseV2["gradeSegments"] {
  const segments: RouteNarrativePhaseV2["gradeSegments"] = [];
  for (const interval of intervals) {
    if ((interval.direction !== "climb" && interval.direction !== "descent") || !interval.gradientBand) continue;
    const last = segments.at(-1);
    if (last && last.direction === interval.direction && last.gradeBand === interval.gradientBand && Math.abs(last.endDistanceM - interval.startDistanceM) <= 0.02) {
      last.endDistanceM = interval.endDistanceM;
      last.distanceM = last.endDistanceM - last.startDistanceM;
      last.averageNetGradePct = (last.averageNetGradePct * (last.distanceM - interval.distanceM) + interval.metrics.netGradientPct * interval.distanceM) / last.distanceM;
      last.intervalIds.push(interval.intervalId);
    } else segments.push({
      direction: interval.direction, gradeBand: interval.gradientBand,
      startDistanceM: interval.startDistanceM, endDistanceM: interval.endDistanceM, distanceM: interval.distanceM,
      averageNetGradePct: interval.metrics.netGradientPct, intervalIds: [interval.intervalId],
    });
  }
  return segments;
}
