import { DEFAULT_ROUTE_DYNAMICS_CONFIG, type RouteDynamicsResult, type ResampledRoutePoint } from "./routeDynamics.ts";

export const CLIMBING_PROFILE_MINIMUM_UPHILL_DISTANCE_M = 500;
export const GRADIENT_DISTRIBUTION_MINIMUM_DIRECTIONAL_DISTANCE_M = CLIMBING_PROFILE_MINIMUM_UPHILL_DISTANCE_M;
export const CLIMBING_PROFILE_MAXIMUM_SAMPLE_GAP_M = DEFAULT_ROUTE_DYNAMICS_CONFIG.resampleIntervalM * 1.5;
const GRADE_BOUNDARY_EPSILON_PCT = 1e-9;

export type ClimbingProfileCategory = "gentle" | "moderate" | "steep";
export type GradientDistributionDirection = "uphill" | "downhill";
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

  const distanceByCategory: Record<ClimbingProfileCategory, number> = { gentle: 0, moderate: 0, steep: 0 };
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
      // Preserve the previously approved uphill classification exactly; tolerate only floating-point
      // accumulation at the inclusive downhill cutoffs so an exact 10%/20% descent stays in-band.
      const category: ClimbingProfileCategory = direction === "uphill"
        ? gradePct <= 10 ? "gentle" : gradePct <= 20 ? "moderate" : "steep"
        : gradePct <= 10 + GRADE_BOUNDARY_EPSILON_PCT ? "gentle" : gradePct <= 20 + GRADE_BOUNDARY_EPSILON_PCT ? "moderate" : "steep";
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
    },
  };
}

function allocateWholePercentages(distances: Record<ClimbingProfileCategory, number>, total: number): Record<ClimbingProfileCategory, number> {
  const keys: ClimbingProfileCategory[] = ["gentle", "moderate", "steep"];
  const exact = Object.fromEntries(keys.map((key) => [key, distances[key] / total * 100])) as Record<ClimbingProfileCategory, number>;
  const result = Object.fromEntries(keys.map((key) => [key, Math.floor(exact[key])])) as Record<ClimbingProfileCategory, number>;
  const remainder = 100 - keys.reduce((sum, key) => sum + result[key], 0);
  const priority = [...keys].sort((left, right) => exact[right] - Math.floor(exact[right]) - (exact[left] - Math.floor(exact[left])) || keys.indexOf(left) - keys.indexOf(right));
  for (let index = 0; index < remainder; index += 1) result[priority[index % priority.length]] += 1;
  return result;
}
