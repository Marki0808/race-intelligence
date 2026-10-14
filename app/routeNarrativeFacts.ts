import { presentGradientExpectationV1 } from "./gradientIntelligencePresentation.ts";
import type { GradientIntelligenceV1, GradientIntervalV1 } from "./gradientIntelligence.ts";
import type { RouteSection } from "./routeSectionEngine.ts";

export const ROUTE_NARRATIVE_FACTS_SCHEMA_VERSION = 1;
export const ROUTE_NARRATIVE_FACTS_ALGORITHM_VERSION = 1;

export type NarrativeDirection = "climb" | "descent" | "rolling" | "low-vertical-movement" | "unknown";
export type NarrativeGradientBand = NonNullable<GradientIntervalV1["gradientBand"]>;

export type RouteNarrativeRunV1 = {
  direction: NarrativeDirection;
  startDistanceM: number;
  endDistanceM: number;
  distanceM: number;
  intervalIds: string[];
  averageGradePct: number;
  ascentM: number;
  descentM: number;
};

export type RouteNarrativePortionV1 = {
  intervalId: string;
  direction: "climb" | "descent";
  gradeBand: NarrativeGradientBand;
  startDistanceM: number;
  endDistanceM: number;
  distanceM: number;
  averageGradePct: number;
  confidence: "high" | "moderate";
  notable: boolean;
};

export type RouteNarrativeFactsV1 = {
  schemaVersion: 1;
  algorithmVersion: 1;
  sectionId: string;
  segmentIndex: number;
  status: "available" | "limited" | "unknown" | "missing-data" | "unsupported-version" | "invalid-data";
  bounds: { startDistanceM: number; endDistanceM: number } | null;
  measurements: { distanceM: number; ascentM: number; descentM: number; netElevationChangeM: number } | null;
  coverage: { intervalDistanceM: number; unknownDirectionDistanceM: number; unknownDirectionShare: number } | null;
  continuity: { longestRunDirection: NarrativeDirection | null; longestRunDistanceM: number; longestRunShare: number; directionChangeCount: number } | null;
  overallCharacter: "climbing" | "descending" | "rolling" | "low-vertical-movement" | "mixed" | "unknown";
  directionShare: { climb: number; descent: number; rolling: number; lowVertical: number; unknown: number } | null;
  unknownIntervals: Array<{ intervalId: string; startDistanceM: number; endDistanceM: number; reasonCodes: string[] }>;
  directionChanges: Array<{ from: NarrativeDirection; to: NarrativeDirection; atDistanceM: number; intervalIds: string[]; fromIntervalIds: string[]; toIntervalIds: string[]; viaDirections: NarrativeDirection[] }>;
  orderedRuns: RouteNarrativeRunV1[];
  gradientPortions: RouteNarrativePortionV1[];
};

const bandRank: Record<NarrativeGradientBand, number> = {
  "near-level": 0, gentle: 1, moderate: 2, steep: 3, "very-steep": 4, "extreme-grade": 5,
};

/** Build a traceable whole-section fact summary from the validated V1.1 interval sequence. */
export function buildRouteNarrativeFactsV1(
  gradient: GradientIntelligenceV1 | undefined,
  routeSections: readonly RouteSection[],
  target: RouteSection,
): RouteNarrativeFactsV1 {
  const validation = presentGradientExpectationV1(gradient, routeSections, target);
  const base = {
    schemaVersion: ROUTE_NARRATIVE_FACTS_SCHEMA_VERSION as 1,
    algorithmVersion: ROUTE_NARRATIVE_FACTS_ALGORITHM_VERSION as 1,
    sectionId: target.id,
    segmentIndex: target.segmentIndex,
  };
  if (validation.status !== "available" || !gradient) {
    return {
      ...base,
      status: validation.status,
      bounds: null,
      measurements: null,
      coverage: null,
      continuity: null,
      overallCharacter: "unknown",
      directionShare: null,
      unknownIntervals: [],
      directionChanges: [],
      orderedRuns: [],
      gradientPortions: [],
    };
  }
  if (![target.ascentM, target.descentM, target.elevationStartM, target.elevationEndM].every(Number.isFinite) ||
      target.ascentM < 0 || target.descentM < 0) {
    return {
      ...base, status: "invalid-data", bounds: null, measurements: null, coverage: null,
      continuity: null, overallCharacter: "unknown", directionShare: null, unknownIntervals: [], directionChanges: [], orderedRuns: [], gradientPortions: [],
    };
  }

  const source = gradient.sections.find((item) => item.sectionId === target.id && item.segmentIndex === target.segmentIndex)!;
  const intervals = source.intervals;
  const intervalDistanceM = intervals.reduce((sum, interval) => sum + interval.distanceM, 0);
  const byDirection = {
    climb: distanceFor(intervals, "climb"),
    descent: distanceFor(intervals, "descent"),
    rolling: distanceFor(intervals, "rolling"),
    lowVertical: distanceFor(intervals, "low-vertical-movement"),
    unknown: distanceFor(intervals, "unknown"),
  };
  const share = (distance: number) => intervalDistanceM > 0 ? distance / intervalDistanceM : 0;
  const directionShare = {
    climb: share(byDirection.climb), descent: share(byDirection.descent), rolling: share(byDirection.rolling),
    lowVertical: share(byDirection.lowVertical), unknown: share(byDirection.unknown),
  };
  const overallCharacter = characterize(source.sectionCharacter, directionShare);
  const orderedRuns = makeRuns(intervals);
  const directionChanges: RouteNarrativeFactsV1["directionChanges"] = [];
  for (let index = 0; index < orderedRuns.length; index += 1) {
    const from = orderedRuns[index];
    if (from.direction !== "climb" && from.direction !== "descent") continue;
    let next = index + 1;
    while (next < orderedRuns.length && orderedRuns[next].direction !== "climb" && orderedRuns[next].direction !== "descent" && orderedRuns[next].direction !== "unknown") next += 1;
    const to = orderedRuns[next];
    if (!to || to.direction === "unknown" || to.direction === from.direction) continue;
    const viaRuns = orderedRuns.slice(index + 1, next);
    const chain = [from, ...viaRuns, to];
    if (chain.some((run, chainIndex) => chainIndex > 0 && Math.abs(chain[chainIndex - 1].endDistanceM - run.startDistanceM) > 0.02)) continue;
    directionChanges.push({
      from: from.direction,
      to: to.direction,
      atDistanceM: to.startDistanceM,
      intervalIds: [...from.intervalIds, ...viaRuns.flatMap((run) => run.intervalIds), ...to.intervalIds],
      fromIntervalIds: from.intervalIds,
      toIntervalIds: to.intervalIds,
      viaDirections: viaRuns.map((run) => run.direction),
    });
    index = next - 1;
  }
  const gradientPortions = intervals.flatMap((interval) => {
    if ((interval.direction !== "climb" && interval.direction !== "descent") || !interval.gradientBand) return [];
    const notable = interval.distanceM >= 1500 && bandRank[interval.gradientBand] >= bandRank.steep ||
      interval.distanceM >= 500 && interval.gradientBand === "extreme-grade";
    return [{
      intervalId: interval.intervalId,
      direction: interval.direction,
      gradeBand: interval.gradientBand,
      startDistanceM: interval.startDistanceM,
      endDistanceM: interval.endDistanceM,
      distanceM: interval.distanceM,
      averageGradePct: interval.metrics.netGradientPct,
      confidence: interval.confidence as "high" | "moderate",
      notable,
    }];
  });
  const sectionDistanceM = target.endPosition.distanceM - target.startPosition.distanceM;
  const unknownDirectionShare = share(byDirection.unknown);
  const longestRun = [...orderedRuns].sort((a, b) => b.distanceM - a.distanceM || a.startDistanceM - b.startDistanceM)[0];
  return {
    ...base,
    status: unknownDirectionShare > 0.2 ? "limited" : "available",
    bounds: { startDistanceM: target.startPosition.distanceM, endDistanceM: target.endPosition.distanceM },
    measurements: {
      distanceM: sectionDistanceM,
      ascentM: target.ascentM,
      descentM: target.descentM,
      netElevationChangeM: target.elevationEndM - target.elevationStartM,
    },
    coverage: { intervalDistanceM, unknownDirectionDistanceM: byDirection.unknown, unknownDirectionShare },
    continuity: {
      longestRunDirection: longestRun?.direction ?? null,
      longestRunDistanceM: longestRun?.distanceM ?? 0,
      longestRunShare: sectionDistanceM > 0 ? (longestRun?.distanceM ?? 0) / sectionDistanceM : 0,
      directionChangeCount: directionChanges.length,
    },
    overallCharacter,
    directionShare,
    unknownIntervals: intervals.filter((interval) => interval.direction === "unknown").map((interval) => ({
      intervalId: interval.intervalId,
      startDistanceM: interval.startDistanceM,
      endDistanceM: interval.endDistanceM,
      reasonCodes: [...(interval.unknownReasons ?? [])],
    })),
    directionChanges,
    orderedRuns,
    gradientPortions,
  };
}

function distanceFor(intervals: readonly GradientIntervalV1[], direction: NarrativeDirection) {
  return intervals.reduce((sum, interval) => sum + (interval.direction === direction ? interval.distanceM : 0), 0);
}

function characterize(
  source: GradientIntelligenceV1["sections"][number]["sectionCharacter"],
  shares: NonNullable<RouteNarrativeFactsV1["directionShare"]>,
): RouteNarrativeFactsV1["overallCharacter"] {
  const directional = shares.climb + shares.descent;
  if (shares.lowVertical >= 0.55 && shares.lowVertical >= directional) return "low-vertical-movement";
  if (source === "rolling" && shares.climb >= 0.15 && shares.descent >= 0.15) return "rolling";
  if (shares.climb >= 0.6) return "climbing";
  if (shares.descent >= 0.6) return "descending";
  if (shares.climb >= 0.15 && shares.descent >= 0.15) return "mixed";
  if (source === "rolling" && shares.rolling >= 0.35) return "rolling";
  if (directional >= 0.3 && shares.climb > shares.descent) return "climbing";
  if (directional >= 0.3 && shares.descent > shares.climb) return "descending";
  if (source === "low-vertical-movement" && shares.rolling >= 0.25) return "rolling";
  return "unknown";
}

function makeRuns(intervals: readonly GradientIntervalV1[]): RouteNarrativeRunV1[] {
  const runs: RouteNarrativeRunV1[] = [];
  for (const interval of intervals) {
    const last = runs.at(-1);
    if (last && last.direction === interval.direction && Math.abs(last.endDistanceM - interval.startDistanceM) <= 0.02) {
      last.endDistanceM = interval.endDistanceM;
      last.distanceM = last.endDistanceM - last.startDistanceM;
      last.intervalIds.push(interval.intervalId);
      last.averageGradePct = weightedGrade(last.intervalIds, intervals);
      last.ascentM += interval.metrics.ascentM;
      last.descentM += interval.metrics.descentM;
    } else {
      runs.push({
        direction: interval.direction,
        startDistanceM: interval.startDistanceM,
        endDistanceM: interval.endDistanceM,
        distanceM: interval.distanceM,
        intervalIds: [interval.intervalId],
        averageGradePct: interval.metrics.netGradientPct,
        ascentM: interval.metrics.ascentM,
        descentM: interval.metrics.descentM,
      });
    }
  }
  return runs;
}

function weightedGrade(ids: readonly string[], intervals: readonly GradientIntervalV1[]) {
  const selected = intervals.filter((interval) => ids.includes(interval.intervalId));
  const distance = selected.reduce((sum, interval) => sum + interval.distanceM, 0);
  const change = selected.reduce((sum, interval) => sum + interval.metrics.netElevationChangeM, 0);
  return distance > 0 ? change / distance * 100 : 0;
}
