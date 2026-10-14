import { DEFAULT_ROUTE_DYNAMICS_CONFIG, type RouteDynamicsResult } from "./routeDynamics.ts";
import type { RouteSection } from "./routeSectionEngine.ts";

/** Characterization over Route Dynamics' component-scoped, already-smoothed 100 m profile. */
export const GRADIENT_INTELLIGENCE_SCHEMA_VERSION = 1;
export const GRADIENT_INTELLIGENCE_ALGORITHM_VERSION = 1;

export const GRADIENT_INTELLIGENCE_RULES = {
  minimumIntervalM: 500,
  cellLengthM: 500,
  minimumProgressionDistanceM: 1500,
  lowVerticalMaximumMPerKm: 12,
  directionalMinimumMPerKm: 18,
  directionalMinimumStrength: 0.32,
  rollingMinimumMPerKm: 24,
  rollingMaximumDirectionStrength: 0.55,
  rollingMinimumDirectionShare: 0.2,
  gentleMaximumGradePct: 2,
  moderateMaximumGradePct: 5,
  steepMinimumGradePct: 10,
  variableSpreadPercentagePoints: 4,
  meaningfulProgressionDeltaPercentagePoints: 2,
} as const;

export type GradientDirection = "climb" | "descent" | "rolling" | "low-vertical-movement" | "unknown";
export type GradientBand = "near-level" | "gentle" | "moderate" | "steep" | null;
export type GradientIntervalCharacter =
  | "low-vertical-movement"
  | "rolling"
  | "short-steep-ramp"
  | "sustained-steep-climb"
  | "sustained-steep-descent"
  | "steady-climb"
  | "steady-descent"
  | "variable-climb"
  | "variable-descent"
  | "short-interruption"
  | "directional-change"
  | "unknown";

export type GradientIntervalV1 = {
  intervalId: string;
  segmentIndex: number;
  startDistanceM: number;
  endDistanceM: number;
  distanceM: number;
  metrics: {
    netElevationChangeM: number;
    netGradientPct: number;
    ascentM: number;
    descentM: number;
    verticalIntensityMPerKm: number;
    cellNetGradientMinimumPct: number;
    cellNetGradientMaximumPct: number;
    cellNetGradientSpreadPercentagePoints: number;
  };
  direction: GradientDirection;
  gradientBand: GradientBand;
  character: GradientIntervalCharacter;
  confidence: "high" | "moderate" | "unknown";
};

export type GradientSectionV1 = {
  sectionId: string;
  segmentIndex: number;
  startDistanceM: number | null;
  endDistanceM: number | null;
  status: "available" | "unknown";
  sectionCharacter: "climbing" | "descending" | "rolling" | "low-vertical-movement" | "unknown";
  progression: "gradual-start-steeper-middle-easing-finish" | "gradual-start-steeper-middle" | "easing-finish" | "steady" | "variable" | "unknown";
  multiScaleMetrics: Array<{
    scale: "short" | "medium" | "long";
    windowM: number;
    sampleCount: number;
    meanNetGradientPct: number;
    meanVerticalIntensityMPerKm: number;
  }>;
  intervals: GradientIntervalV1[];
  unknownReason?: "insufficient-distance" | "insufficient-smoothed-samples" | "invalid-section-bounds";
};

export type GradientIntelligenceV1 = {
  schemaVersion: 1;
  algorithmVersion: 1;
  source: "route-dynamics-smoothed-profile";
  assumptions: { resampleIntervalM: number; medianFilterRadiusM: number; movingAverageRadiusM: number };
  sections: GradientSectionV1[];
};

type ProfilePoint = { distanceM: number; smoothedElevationM: number };
type Cell = {
  startDistanceM: number;
  endDistanceM: number;
  startElevationM: number;
  endElevationM: number;
  ascentM: number;
  descentM: number;
  gradientPct: number;
  intensity: number;
  direction: GradientDirection;
  band: GradientBand;
};

export function buildGradientIntelligenceV1(
  dynamics: RouteDynamicsResult,
  sections: readonly RouteSection[],
): GradientIntelligenceV1 {
  return {
    schemaVersion: 1,
    algorithmVersion: 1,
    source: "route-dynamics-smoothed-profile",
    assumptions: {
      resampleIntervalM: DEFAULT_ROUTE_DYNAMICS_CONFIG.resampleIntervalM,
      medianFilterRadiusM: DEFAULT_ROUTE_DYNAMICS_CONFIG.medianFilterRadiusM,
      movingAverageRadiusM: DEFAULT_ROUTE_DYNAMICS_CONFIG.movingAverageRadiusM,
    },
    sections: sections.map((section) => characterizeSection(dynamics, section)),
  };
}

function characterizeSection(dynamics: RouteDynamicsResult, section: RouteSection): GradientSectionV1 {
  const segmentIndex = section.segmentIndex ?? 0;
  const startDistanceM = section.startPosition?.distanceM;
  const endDistanceM = section.endPosition?.distanceM;
  const base = {
    sectionId: section.id,
    segmentIndex,
    startDistanceM: Number.isFinite(startDistanceM) ? startDistanceM! : null,
    endDistanceM: Number.isFinite(endDistanceM) ? endDistanceM! : null,
  };
  if (!Number.isFinite(startDistanceM) || !Number.isFinite(endDistanceM) || endDistanceM! <= startDistanceM!) {
    return { ...base, status: "unknown", sectionCharacter: "unknown", progression: "unknown", multiScaleMetrics: [], intervals: [], unknownReason: "invalid-section-bounds" };
  }
  const lengthM = endDistanceM! - startDistanceM!;
  if (lengthM < GRADIENT_INTELLIGENCE_RULES.minimumIntervalM) {
    return { ...base, status: "unknown", sectionCharacter: "unknown", progression: "unknown", multiScaleMetrics: [], intervals: [], unknownReason: "insufficient-distance" };
  }
  const points = dynamics.resampledPoints
    .filter((point) => point.segmentIndex === segmentIndex && Number.isFinite(point.distanceM) && Number.isFinite(point.smoothedElevationM))
    .sort((a, b) => a.distanceM - b.distanceM);
  const profile = clipProfile(points, startDistanceM!, endDistanceM!);
  if (profile.length < 2 || profile.at(-1)!.distanceM - profile[0].distanceM < lengthM * 0.95 || !hasSupportedSpacing(profile)) {
    return { ...base, status: "unknown", sectionCharacter: "unknown", progression: "unknown", multiScaleMetrics: [], intervals: [], unknownReason: "insufficient-smoothed-samples" };
  }
  const cells = makeCells(profile);
  const merged = mergeCells(cells);
  const intervals = merged.map((group, index) => toInterval(group, index, segmentIndex, section.dominantRhythm));
  return {
    ...base,
    status: intervals.length ? "available" : "unknown",
    sectionCharacter: sectionRhythm(section.dominantRhythm),
    progression: describeProgression(cells, lengthM),
    multiScaleMetrics: summarizeDynamicsScales(dynamics, segmentIndex, startDistanceM!, endDistanceM!),
    intervals,
    ...(!intervals.length ? { unknownReason: "insufficient-smoothed-samples" as const } : {}),
  };
}

function summarizeDynamicsScales(dynamics: RouteDynamicsResult, segmentIndex: number, startM: number, endM: number): GradientSectionV1["multiScaleMetrics"] {
  return (["short", "medium", "long"] as const).flatMap((scale) => {
    const metric = (sample: RouteDynamicsResult["samples"][number]) => sample[scale];
    const matching = dynamics.samples.flatMap((sample) => {
      if (sample.segmentIndex !== segmentIndex) return [];
      const value = metric(sample);
      return value.startDistanceM >= startM && value.endDistanceM <= endM ? [value] : [];
    });
    if (!matching.length) return [];
    return [{
      scale,
      windowM: matching[0].scaleM,
      sampleCount: matching.length,
      meanNetGradientPct: round2(matching.reduce((sum, value) => sum + value.gradientPct, 0) / matching.length),
      meanVerticalIntensityMPerKm: round1(matching.reduce((sum, value) => sum + value.verticalIntensityMPerKm, 0) / matching.length),
    }];
  });
}

function hasSupportedSpacing(points: readonly ProfilePoint[]) {
  const maximumGapM = DEFAULT_ROUTE_DYNAMICS_CONFIG.resampleIntervalM * 1.5;
  return points.every((point, index) => {
    if (index === 0) return true;
    const gapM = point.distanceM - points[index - 1].distanceM;
    return gapM > 0 && gapM <= maximumGapM;
  });
}

function clipProfile(points: readonly ProfilePoint[], startM: number, endM: number): ProfilePoint[] {
  const inside = points.filter((point) => point.distanceM >= startM && point.distanceM <= endM);
  const start = interpolateAt(points, startM);
  const end = interpolateAt(points, endM);
  if (!start || !end) return [];
  return [start, ...inside.filter((point) => point.distanceM > startM && point.distanceM < endM), end];
}

function interpolateAt(points: readonly ProfilePoint[], distanceM: number): ProfilePoint | null {
  const exact = points.find((point) => point.distanceM === distanceM);
  if (exact) return exact;
  const rightIndex = points.findIndex((point) => point.distanceM > distanceM);
  if (rightIndex <= 0) return null;
  const left = points[rightIndex - 1];
  const right = points[rightIndex];
  const ratio = (distanceM - left.distanceM) / (right.distanceM - left.distanceM);
  return { distanceM, smoothedElevationM: left.smoothedElevationM + (right.smoothedElevationM - left.smoothedElevationM) * ratio };
}

function makeCells(profile: readonly ProfilePoint[]): Cell[] {
  const start = profile[0].distanceM;
  const end = profile.at(-1)!.distanceM;
  const boundaries = [start];
  for (let boundary = start + GRADIENT_INTELLIGENCE_RULES.cellLengthM; boundary < end; boundary += GRADIENT_INTELLIGENCE_RULES.cellLengthM) boundaries.push(boundary);
  boundaries.push(end);
  if (boundaries.length > 2 && boundaries.at(-1)! - boundaries.at(-2)! < GRADIENT_INTELLIGENCE_RULES.minimumIntervalM) {
    boundaries.splice(boundaries.length - 2, 1);
  }
  return boundaries.slice(0, -1).flatMap((cellStart, index) => {
    const cellEnd = boundaries[index + 1];
    const distanceM = cellEnd - cellStart;
    if (distanceM < GRADIENT_INTELLIGENCE_RULES.minimumIntervalM) return [];
    const samples = [
      interpolateAt(profile, cellStart),
      ...profile.filter((point) => point.distanceM > cellStart && point.distanceM < cellEnd),
      interpolateAt(profile, cellEnd),
    ].filter((point): point is ProfilePoint => point !== null);
    if (samples.length < 2) return [];
    let ascentM = 0;
    let descentM = 0;
    for (let sampleIndex = 1; sampleIndex < samples.length; sampleIndex += 1) {
      const delta = samples[sampleIndex].smoothedElevationM - samples[sampleIndex - 1].smoothedElevationM;
      if (delta > 0) ascentM += delta;
      else descentM += -delta;
    }
    const startElevationM = samples[0].smoothedElevationM;
    const endElevationM = samples.at(-1)!.smoothedElevationM;
    const gradientPct = (endElevationM - startElevationM) / distanceM * 100;
    const intensity = (ascentM + descentM) / (distanceM / 1000);
    const direction = directionFor(ascentM, descentM, intensity);
    return [{
      startDistanceM: cellStart, endDistanceM: cellEnd, startElevationM, endElevationM,
      ascentM, descentM, gradientPct, intensity, direction, band: bandFor(gradientPct, direction),
    }];
  });
}

function directionFor(ascentM: number, descentM: number, intensity: number): GradientDirection {
  const vertical = ascentM + descentM;
  const strength = vertical > 0 ? Math.abs(ascentM - descentM) / vertical : 0;
  if (intensity <= GRADIENT_INTELLIGENCE_RULES.lowVerticalMaximumMPerKm) return "low-vertical-movement";
  if (intensity >= GRADIENT_INTELLIGENCE_RULES.rollingMinimumMPerKm && strength <= GRADIENT_INTELLIGENCE_RULES.rollingMaximumDirectionStrength &&
    ascentM / vertical >= GRADIENT_INTELLIGENCE_RULES.rollingMinimumDirectionShare && descentM / vertical >= GRADIENT_INTELLIGENCE_RULES.rollingMinimumDirectionShare) return "rolling";
  if (intensity < GRADIENT_INTELLIGENCE_RULES.directionalMinimumMPerKm || strength < GRADIENT_INTELLIGENCE_RULES.directionalMinimumStrength) return "unknown";
  return ascentM > descentM ? "climb" : "descent";
}

function bandFor(gradientPct: number, direction: GradientDirection): GradientBand {
  if (direction !== "climb" && direction !== "descent") return null;
  const grade = Math.abs(gradientPct);
  if (grade < GRADIENT_INTELLIGENCE_RULES.gentleMaximumGradePct) return "near-level";
  if (grade < GRADIENT_INTELLIGENCE_RULES.moderateMaximumGradePct) return "gentle";
  if (grade < GRADIENT_INTELLIGENCE_RULES.steepMinimumGradePct) return "moderate";
  return "steep";
}

function mergeCells(cells: Cell[]): Cell[][] {
  const groups: Cell[][] = [];
  for (const cell of cells) {
    const previous = groups.at(-1);
    if (previous && previous.at(-1)!.direction === cell.direction && previous.at(-1)!.band === cell.band) previous.push(cell);
    else groups.push([cell]);
  }
  return groups;
}

function toInterval(cells: Cell[], index: number, segmentIndex: number, sectionRhythmValue: RouteSection["dominantRhythm"]): GradientIntervalV1 {
  const first = cells[0];
  const last = cells.at(-1)!;
  const distanceM = last.endDistanceM - first.startDistanceM;
  const ascentM = cells.reduce((sum, cell) => sum + cell.ascentM, 0);
  const descentM = cells.reduce((sum, cell) => sum + cell.descentM, 0);
  const gradientPct = (last.endElevationM - first.startElevationM) / distanceM * 100;
  const localGradients = cells.map((cell) => cell.gradientPct);
  const min = Math.min(...localGradients);
  const max = Math.max(...localGradients);
  const spread = max - min;
  const verticalIntensity = (ascentM + descentM) / (distanceM / 1000);
  const direction = cells.every((cell) => cell.direction === first.direction) ? first.direction : "unknown";
  const interruption = (sectionRhythmValue === "climb" && direction === "descent") || (sectionRhythmValue === "descent" && direction === "climb");
  const variable = distanceM >= 1000 && spread >= GRADIENT_INTELLIGENCE_RULES.variableSpreadPercentagePoints;
  const steep = first.band === "steep" && (direction === "climb" || direction === "descent");
  const character: GradientIntervalCharacter = direction === "unknown"
    ? "unknown"
    : direction === "low-vertical-movement" ? "low-vertical-movement"
      : direction === "rolling" ? "rolling"
        : interruption && distanceM <= 1500 ? "short-interruption"
          : steep && distanceM < 1500 ? "short-steep-ramp"
            : steep && direction === "climb" ? "sustained-steep-climb"
              : steep ? "sustained-steep-descent"
                : variable ? direction === "climb" ? "variable-climb" : "variable-descent"
                  : distanceM >= 1000 ? direction === "climb" ? "steady-climb" : "steady-descent"
                    : "directional-change";
  return {
    intervalId: `gradient-${segmentIndex}-${index + 1}`,
    segmentIndex,
    startDistanceM: first.startDistanceM,
    endDistanceM: last.endDistanceM,
    distanceM,
    metrics: {
      netElevationChangeM: Number((last.endElevationM - first.startElevationM).toFixed(1)),
      netGradientPct: Number(gradientPct.toFixed(2)),
      ascentM: Number(ascentM.toFixed(1)),
      descentM: Number(descentM.toFixed(1)),
      verticalIntensityMPerKm: Number(verticalIntensity.toFixed(1)),
      cellNetGradientMinimumPct: Number(min.toFixed(2)),
      cellNetGradientMaximumPct: Number(max.toFixed(2)),
      cellNetGradientSpreadPercentagePoints: Number(spread.toFixed(2)),
    },
    direction,
    gradientBand: first.band,
    character,
    confidence: direction === "unknown" ? "unknown" : cells.length > 1 || distanceM >= 1000 ? "high" : "moderate",
  };
}

function describeProgression(cells: Cell[], sectionLengthM: number): GradientSectionV1["progression"] {
  if (sectionLengthM < GRADIENT_INTELLIGENCE_RULES.minimumProgressionDistanceM || cells.length < 3) return "unknown";
  const first = cells[0].gradientPct;
  const middle = cells[Math.floor(cells.length / 2)].gradientPct;
  const last = cells.at(-1)!.gradientPct;
  if (Math.sign(first) !== Math.sign(middle) || Math.sign(middle) !== Math.sign(last)) return "variable";
  if (Math.max(Math.abs(first), Math.abs(middle), Math.abs(last)) < GRADIENT_INTELLIGENCE_RULES.gentleMaximumGradePct) return "steady";
  if (Math.abs(middle) < GRADIENT_INTELLIGENCE_RULES.gentleMaximumGradePct) return "variable";
  const delta = GRADIENT_INTELLIGENCE_RULES.meaningfulProgressionDeltaPercentagePoints;
  const startGentler = Math.abs(first) + delta <= Math.abs(middle);
  const finishEases = Math.abs(last) + delta <= Math.abs(middle);
  if (startGentler && finishEases) return "gradual-start-steeper-middle-easing-finish";
  if (startGentler) return "gradual-start-steeper-middle";
  if (finishEases) return "easing-finish";
  const spread = Math.max(Math.abs(first), Math.abs(middle), Math.abs(last)) - Math.min(Math.abs(first), Math.abs(middle), Math.abs(last));
  return spread <= delta ? "steady" : "variable";
}

function sectionRhythm(rhythm: RouteSection["dominantRhythm"]): GradientSectionV1["sectionCharacter"] {
  if (rhythm === "climb") return "climbing";
  if (rhythm === "descent") return "descending";
  if (rhythm === "rolling") return "rolling";
  return rhythm === "flat" ? "low-vertical-movement" : "unknown";
}

function round1(value: number) { return Number(value.toFixed(1)); }
function round2(value: number) { return Number(value.toFixed(2)); }
