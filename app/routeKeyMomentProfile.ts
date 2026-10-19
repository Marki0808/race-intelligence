import type { GpxRoutePointData } from "./gpxAnalysis.ts";
import type { KeyMomentData } from "./raceTypes.ts";
import { resolveKeyMomentInterval } from "./routeSectionSelection.ts";

/** Uses only actual GPX samples inside a validated, component-bound Key Moment interval. */
export function getKeyMomentProfilePoints(
  points: readonly GpxRoutePointData[],
  moment: Pick<KeyMomentData, "focusStartKm" | "focusEndKm" | "segmentIndex" | "focusStartPosition" | "focusEndPosition">,
): GpxRoutePointData[] {
  const interval = resolveKeyMomentInterval(points, moment);
  if (!interval) return [];
  return points.filter((point) => point.segmentIndex === interval.segmentIndex
    && point.distanceM >= interval.startDistanceM
    && point.distanceM <= interval.endDistanceM
    && Number.isFinite(point.elevationM));
}

export function keyMomentProfilePolyline(points: readonly GpxRoutePointData[], width = 320, height = 68): string | null {
  if (points.length < 2 || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  const min = Math.min(...points.map((point) => point.elevationM));
  const max = Math.max(...points.map((point) => point.elevationM));
  const range = Math.max(1, max - min);
  return points.map((point, index) => {
    const x = (index / (points.length - 1)) * width;
    const y = height - 4 - ((point.elevationM - min) / range) * (height - 8);
    return `${x},${y}`;
  }).join(" ");
}
