import { DEFAULT_ROUTE_DYNAMICS_CONFIG, type RouteDynamicsResult, type ResampledRoutePoint } from "./routeDynamics.ts";

export const CLIMBING_PROFILE_MINIMUM_UPHILL_DISTANCE_M = 500;
export const GRADIENT_DISTRIBUTION_MINIMUM_DIRECTIONAL_DISTANCE_M = CLIMBING_PROFILE_MINIMUM_UPHILL_DISTANCE_M;
export const CLIMBING_PROFILE_MAXIMUM_SAMPLE_GAP_M = DEFAULT_ROUTE_DYNAMICS_CONFIG.resampleIntervalM * 1.5;

export type ClimbingProfileCategory = "gentle" | "moderate" | "steep" | "very-steep" | "extreme";
export type GradientDistributionDirection = "uphill" | "downhill";
export function defaultSectionGradientDirection(dominantRhythm: "climb" | "descent" | "rolling" | "flat"): GradientDistributionDirection {
  return dominantRhythm === "descent" ? "downhill" : "uphill";
}

export type ClimbingProfileResult =
  | { status: "available"; measuredUphillDistanceM: number; categories: Record<ClimbingProfileCategory, { distanceM: number; percent: number }> }
  | { status: "unavailable"; reason: "missing-smoothed-profile" | "incomplete-smoothed-profile" | "insufficient-uphill-distance" };
export type GradientDistributionResult =
  | { status: "available"; measuredDistanceM: number; categories: Record<ClimbingProfileCategory, { distanceM: number; percent: number }> }
  | { status: "unavailable"; reason: "missing-smoothed-profile" | "incomplete-smoothed-profile" | "insufficient-uphill-distance" | "insufficient-downhill-distance" };

/**
 * Allocates 100 m-scale, already-smoothed profile intervals by their uphill grade.
 * Components are processed independently; unsupported spacing makes the result unavailable.
 */
export function calculateClimbingProfile(dynamics: Pick<RouteDynamicsResult, "resampledPoints">): ClimbingProfileResult {
  const result = calculateGradientDistribution(dynamics, "uphill");
  if (result.status === "unavailable") {
    return { status: "unavailable", reason: result.reason === "insufficient-downhill-distance" ? "insufficient-uphill-distance" : result.reason };
  }
  return { status: "available", measuredUphillDistanceM: result.measuredDistanceM, categories: result.categories };
}

/** Uses one shared interval classifier for uphill and downhill distance distributions. */
export function calculateGradientDistribution(
  dynamics: Pick<RouteDynamicsResult, "resampledPoints">,
  direction: GradientDistributionDirection,
): GradientDistributionResult {
  if (!Array.isArray(dynamics.resampledPoints) || dynamics.resampledPoints.length < 2) {
    return { status: "unavailable", reason: "missing-smoothed-profile" };
  }

  const byComponent = new Map<number, ResampledRoutePoint[]>();
  for (const point of dynamics.resampledPoints) {
    if (!Number.isFinite(point.distanceM) || !Number.isFinite(point.smoothedElevationM) || !Number.isInteger(point.segmentIndex)) {
      return { status: "unavailable", reason: "incomplete-smoothed-profile" };
    }
    const component = byComponent.get(point.segmentIndex) ?? [];
    component.push(point);
    byComponent.set(point.segmentIndex, component);
  }

  const distanceByCategory: Record<ClimbingProfileCategory, number> = { gentle: 0, moderate: 0, steep: 0, "very-steep": 0, extreme: 0 };
  let measuredDistanceM = 0;
  let directionalIntervals = 0;

  for (const component of byComponent.values()) {
    component.sort((a, b) => a.distanceM - b.distanceM);
    for (let index = 1; index < component.length; index += 1) {
      const previous = component[index - 1];
      const current = component[index];
      const intervalDistanceM = current.distanceM - previous.distanceM;
      if (intervalDistanceM <= 0 || intervalDistanceM > CLIMBING_PROFILE_MAXIMUM_SAMPLE_GAP_M) {
        return { status: "unavailable", reason: "incomplete-smoothed-profile" };
      }
      const elevationChangeM = current.smoothedElevationM - previous.smoothedElevationM;
      if (direction === "uphill" ? elevationChangeM <= 0 : elevationChangeM >= 0) continue;

      const gradePct = Math.abs(elevationChangeM) / intervalDistanceM * 100;
      const category = categoryForAbsoluteGrade(gradePct);
      distanceByCategory[category] += intervalDistanceM;
      measuredDistanceM += intervalDistanceM;
      directionalIntervals += 1;
    }
  }

  if (measuredDistanceM < GRADIENT_DISTRIBUTION_MINIMUM_DIRECTIONAL_DISTANCE_M || directionalIntervals < 5) {
    return { status: "unavailable", reason: direction === "uphill" ? "insufficient-uphill-distance" : "insufficient-downhill-distance" };
  }

  const percentages = allocateWholePercentages(distanceByCategory, measuredDistanceM);
  return {
    status: "available",
    measuredDistanceM,
    categories: {
      gentle: { distanceM: distanceByCategory.gentle, percent: percentages.gentle },
      moderate: { distanceM: distanceByCategory.moderate, percent: percentages.moderate },
      steep: { distanceM: distanceByCategory.steep, percent: percentages.steep },
      "very-steep": { distanceM: distanceByCategory["very-steep"], percent: percentages["very-steep"] },
      extreme: { distanceM: distanceByCategory.extreme, percent: percentages.extreme },
    },
  };
}

/** Calculates the same directional distribution within one already-clipped section profile. */
export function calculateSectionGradientDistribution(
  section: {
    startPosition: { distanceM: number; segmentIndex: number };
    endPosition: { distanceM: number; segmentIndex: number };
    elevationProfile: readonly { distanceM: number; elevationM: number }[];
  },
  direction: GradientDistributionDirection,
): GradientDistributionResult {
  const startM = section.startPosition.distanceM;
  const endM = section.endPosition.distanceM;
  if (!Number.isFinite(startM) || !Number.isFinite(endM) || endM <= startM ||
      section.startPosition.segmentIndex !== section.endPosition.segmentIndex) {
    return { status: "unavailable", reason: "incomplete-smoothed-profile" };
  }
  const source = section.elevationProfile;
  if (!Array.isArray(source) || source.length < 2 || source.some((point) => !Number.isFinite(point.distanceM) || !Number.isFinite(point.elevationM))) {
    return { status: "unavailable", reason: "missing-smoothed-profile" };
  }
  const points: Array<{ distanceM: number; elevationM: number }> = [];
  for (const point of source) {
    const previous = points.at(-1);
    if (previous && point.distanceM < previous.distanceM) return { status: "unavailable", reason: "incomplete-smoothed-profile" };
    if (previous && point.distanceM === previous.distanceM) {
      if (Math.abs(point.elevationM - previous.elevationM) > 1e-6) return { status: "unavailable", reason: "incomplete-smoothed-profile" };
      continue;
    }
    points.push(point);
  }
  if (points.length < 2 || points[0].distanceM > startM + 0.01 || points.at(-1)!.distanceM < endM - 0.01) {
    return { status: "unavailable", reason: "incomplete-smoothed-profile" };
  }
  const clipped = [interpolateSectionProfile(points, startM),
    ...points.filter((point) => point.distanceM > startM && point.distanceM < endM),
    interpolateSectionProfile(points, endM)];
  if (clipped.some((point) => !point)) return { status: "unavailable", reason: "incomplete-smoothed-profile" };
  const distanceByCategory: Record<ClimbingProfileCategory, number> = { gentle: 0, moderate: 0, steep: 0, "very-steep": 0, extreme: 0 };
  let measuredDistanceM = 0;
  let directionalIntervals = 0;
  for (let index = 1; index < clipped.length; index += 1) {
    const previous = clipped[index - 1]!;
    const current = clipped[index]!;
    const intervalDistanceM = current.distanceM - previous.distanceM;
    if (intervalDistanceM <= 0 || intervalDistanceM > CLIMBING_PROFILE_MAXIMUM_SAMPLE_GAP_M) {
      return { status: "unavailable", reason: "incomplete-smoothed-profile" };
    }
    const elevationChangeM = current.elevationM - previous.elevationM;
    if (direction === "uphill" ? elevationChangeM <= 0 : elevationChangeM >= 0) continue;
    const category = categoryForAbsoluteGrade(Math.abs(elevationChangeM) / intervalDistanceM * 100);
    distanceByCategory[category] += intervalDistanceM;
    measuredDistanceM += intervalDistanceM;
    directionalIntervals += 1;
  }
  if (measuredDistanceM < GRADIENT_DISTRIBUTION_MINIMUM_DIRECTIONAL_DISTANCE_M || directionalIntervals < 5) {
    return { status: "unavailable", reason: direction === "uphill" ? "insufficient-uphill-distance" : "insufficient-downhill-distance" };
  }
  const percentages = allocateWholePercentages(distanceByCategory, measuredDistanceM);
  return {
    status: "available",
    measuredDistanceM,
    categories: {
      gentle: { distanceM: distanceByCategory.gentle, percent: percentages.gentle },
      moderate: { distanceM: distanceByCategory.moderate, percent: percentages.moderate },
      steep: { distanceM: distanceByCategory.steep, percent: percentages.steep },
      "very-steep": { distanceM: distanceByCategory["very-steep"], percent: percentages["very-steep"] },
      extreme: { distanceM: distanceByCategory.extreme, percent: percentages.extreme },
    },
  };
}

function allocateWholePercentages(distances: Record<ClimbingProfileCategory, number>, total: number): Record<ClimbingProfileCategory, number> {
  const keys: ClimbingProfileCategory[] = ["gentle", "moderate", "steep", "very-steep", "extreme"];
  const exact = Object.fromEntries(keys.map((key) => [key, distances[key] / total * 100])) as Record<ClimbingProfileCategory, number>;
  const result = Object.fromEntries(keys.map((key) => [key, Math.floor(exact[key])])) as Record<ClimbingProfileCategory, number>;
  const remainder = 100 - keys.reduce((sum, key) => sum + result[key], 0);
  const priority = [...keys].sort((left, right) => exact[right] - Math.floor(exact[right]) - (exact[left] - Math.floor(exact[left])) || keys.indexOf(left) - keys.indexOf(right));
  for (let index = 0; index < remainder; index += 1) result[priority[index % priority.length]] += 1;
  return result;
}

/** Bands are [0,5), [5,10), [10,15), [15,20), and [20,+∞); flat intervals are excluded before classification. */
export function categoryForAbsoluteGrade(gradePct: number): ClimbingProfileCategory {
  if (!Number.isFinite(gradePct) || gradePct < 0) throw new RangeError("Gradient must be a finite non-negative percentage.");
  if (gradePct < 5) return "gentle";
  if (gradePct < 10) return "moderate";
  if (gradePct < 15) return "steep";
  if (gradePct < 20) return "very-steep";
  return "extreme";
}

function interpolateSectionProfile(points: readonly { distanceM: number; elevationM: number }[], distanceM: number) {
  if (distanceM < points[0].distanceM - 0.01 || distanceM > points.at(-1)!.distanceM + 0.01) return null;
  for (let index = 1; index < points.length; index += 1) {
    const left = points[index - 1];
    const right = points[index];
    if (distanceM <= right.distanceM) {
      const spanM = right.distanceM - left.distanceM;
      if (spanM <= 0) return null;
      const fraction = Math.max(0, Math.min(1, (distanceM - left.distanceM) / spanM));
      return { distanceM, elevationM: left.elevationM + (right.elevationM - left.elevationM) * fraction };
    }
  }
  const last = points.at(-1)!;
  return Math.abs(distanceM - last.distanceM) <= 0.01 ? { ...last, distanceM } : null;
}
