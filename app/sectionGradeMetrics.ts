import { CLIMBING_PROFILE_MAXIMUM_SAMPLE_GAP_M } from "./climbingProfileModel.ts";
import { DEFAULT_ROUTE_DYNAMICS_CONFIG } from "./routeDynamics.ts";

export const SECTION_GRADE_WINDOWS_M = [100, 500] as const;
export const SECTION_GRADE_MINIMUM_VERTICAL_CHANGE_M = DEFAULT_ROUTE_DYNAMICS_CONFIG.meaningfulElevationStepM;

export function formatSectionGradePercent(gradePct: number): string {
  const rounded = Math.abs(gradePct) < 0.05 ? 0 : gradePct;
  return `${rounded > 0 ? "+" : rounded < 0 ? "−" : ""}${Math.abs(rounded).toFixed(1)}%`;
}

export type SectionGradeWindow = { gradePct: number; startDistanceM: number; endDistanceM: number };
export type SectionGradeMetrics = {
  status: "available";
  netGradePct: number;
  averageUphillGradePct: number | null;
  averageDownhillGradePct: number | null;
  steepestUphill100m: SectionGradeWindow | null;
  steepestUphill500m: SectionGradeWindow | null;
  steepestDownhill100m: SectionGradeWindow | null;
  steepestDownhill500m: SectionGradeWindow | null;
} | { status: "unavailable"; reason: "invalid-or-incomplete-profile" };

type ProfilePoint = { distanceM: number; elevationM: number };
type SectionProfileInput = {
  startPosition: { distanceM: number; segmentIndex: number };
  endPosition: { distanceM: number; segmentIndex: number };
  elevationProfile: readonly ProfilePoint[];
};

/**
 * Measures section grades from the section engine's already-smoothed profile.
 * Sustained grades are net elevation change over exact horizontal windows; small
 * reversals inside a window are retained in that net change.
 */
export function calculateSectionGradeMetrics(section: SectionProfileInput): SectionGradeMetrics {
  const startM = section.startPosition.distanceM;
  const endM = section.endPosition.distanceM;
  if (!Number.isFinite(startM) || !Number.isFinite(endM) || endM <= startM || section.startPosition.segmentIndex !== section.endPosition.segmentIndex) {
    return { status: "unavailable", reason: "invalid-or-incomplete-profile" };
  }

  const source = section.elevationProfile;
  if (!Array.isArray(source) || source.length < 2 || source.some((point) => !Number.isFinite(point.distanceM) || !Number.isFinite(point.elevationM))) {
    return { status: "unavailable", reason: "invalid-or-incomplete-profile" };
  }
  const points: ProfilePoint[] = [];
  for (const point of source) {
    const previous = points.at(-1);
    if (previous && point.distanceM < previous.distanceM) return { status: "unavailable", reason: "invalid-or-incomplete-profile" };
    if (previous && point.distanceM === previous.distanceM) {
      if (Math.abs(point.elevationM - previous.elevationM) > 1e-6) return { status: "unavailable", reason: "invalid-or-incomplete-profile" };
      continue;
    }
    points.push(point);
  }
  if (points.length < 2 || points[0].distanceM > startM + 0.01 || points.at(-1)!.distanceM < endM - 0.01) {
    return { status: "unavailable", reason: "invalid-or-incomplete-profile" };
  }

  const clipped: ProfilePoint[] = [interpolateProfile(points, startM)!];
  clipped.push(...points.filter((point) => point.distanceM > startM && point.distanceM < endM));
  clipped.push(interpolateProfile(points, endM)!);
  for (let index = 1; index < clipped.length; index += 1) {
    const gapM = clipped[index].distanceM - clipped[index - 1].distanceM;
    if (gapM <= 0 || gapM > CLIMBING_PROFILE_MAXIMUM_SAMPLE_GAP_M) return { status: "unavailable", reason: "invalid-or-incomplete-profile" };
  }

  const lengthM = endM - startM;
  let uphillChangeM = 0;
  let uphillDistanceM = 0;
  let downhillChangeM = 0;
  let downhillDistanceM = 0;
  for (let index = 1; index < clipped.length; index += 1) {
    const previous = clipped[index - 1];
    const current = clipped[index];
    const distanceM = current.distanceM - previous.distanceM;
    const elevationChangeM = current.elevationM - previous.elevationM;
    if (elevationChangeM > 0) {
      uphillChangeM += elevationChangeM;
      uphillDistanceM += distanceM;
    } else if (elevationChangeM < 0) {
      downhillChangeM += Math.abs(elevationChangeM);
      downhillDistanceM += distanceM;
    }
  }

  const windowMetric = (windowM: typeof SECTION_GRADE_WINDOWS_M[number], direction: "uphill" | "downhill") =>
    findSteepestWindow(clipped, startM, endM, windowM, direction);
  const uphill100 = lengthM >= 100 ? windowMetric(100, "uphill") : null;
  const uphill500 = lengthM >= 500 ? windowMetric(500, "uphill") : null;
  const downhill100 = lengthM >= 100 ? windowMetric(100, "downhill") : null;
  const downhill500 = lengthM >= 500 ? windowMetric(500, "downhill") : null;

  return {
    status: "available",
    netGradePct: (clipped.at(-1)!.elevationM - clipped[0].elevationM) / lengthM * 100,
    averageUphillGradePct: uphillChangeM >= SECTION_GRADE_MINIMUM_VERTICAL_CHANGE_M && uphillDistanceM > 0 ? uphillChangeM / uphillDistanceM * 100 : null,
    averageDownhillGradePct: downhillChangeM >= SECTION_GRADE_MINIMUM_VERTICAL_CHANGE_M && downhillDistanceM > 0 ? downhillChangeM / downhillDistanceM * 100 : null,
    steepestUphill100m: uphill100,
    steepestUphill500m: uphill500,
    steepestDownhill100m: downhill100,
    steepestDownhill500m: downhill500,
  };
}

function findSteepestWindow(
  points: readonly ProfilePoint[],
  sectionStartM: number,
  sectionEndM: number,
  windowM: number,
  direction: "uphill" | "downhill",
): SectionGradeWindow | null {
  const latestStartM = sectionEndM - windowM;
  const candidateStarts = new Set<number>([sectionStartM, latestStartM]);
  for (const point of points) {
    for (const candidate of [point.distanceM, point.distanceM - windowM]) {
      if (candidate >= sectionStartM && candidate <= latestStartM) candidateStarts.add(candidate);
    }
  }

  let best: SectionGradeWindow | null = null;
  for (const startDistanceM of candidateStarts) {
    const endDistanceM = startDistanceM + windowM;
    const start = interpolateProfile(points, startDistanceM);
    const end = interpolateProfile(points, endDistanceM);
    if (!start || !end) continue;
    const changeM = end.elevationM - start.elevationM;
    if (direction === "uphill" ? changeM < SECTION_GRADE_MINIMUM_VERTICAL_CHANGE_M : changeM > -SECTION_GRADE_MINIMUM_VERTICAL_CHANGE_M) continue;
    const gradePct = changeM / windowM * 100;
    if (!best || (direction === "uphill" ? gradePct > best.gradePct : gradePct < best.gradePct)) {
      best = { gradePct, startDistanceM, endDistanceM };
    }
  }
  return best;
}

function interpolateProfile(points: readonly ProfilePoint[], distanceM: number): ProfilePoint | null {
  if (distanceM < points[0].distanceM - 0.01 || distanceM > points.at(-1)!.distanceM + 0.01) return null;
  for (let index = 1; index < points.length; index += 1) {
    const right = points[index];
    const left = points[index - 1];
    if (distanceM <= right.distanceM) {
      const spanM = right.distanceM - left.distanceM;
      if (spanM <= 0) return null;
      const ratio = Math.max(0, Math.min(1, (distanceM - left.distanceM) / spanM));
      return { distanceM, elevationM: left.elevationM + (right.elevationM - left.elevationM) * ratio };
    }
  }
  return Math.abs(distanceM - points.at(-1)!.distanceM) <= 0.01 ? { ...points.at(-1)!, distanceM } : null;
}
