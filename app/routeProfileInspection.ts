import type { GpxRoutePointData } from "./gpxAnalysis";

/** Returns an actual GPX sample nearest the inspected profile position; it never interpolates elevation. */
export function nearestRouteProfilePoint(
  points: readonly GpxRoutePointData[],
  distanceM: number,
  elevationM: number,
): GpxRoutePointData | null {
  if (!Number.isFinite(distanceM) || !Number.isFinite(elevationM) || points.length === 0) return null;
  let nearest: GpxRoutePointData | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  let bestElevation = Number.POSITIVE_INFINITY;
  for (const point of points) {
    if (!Number.isFinite(point.distanceM) || !Number.isFinite(point.elevationM)) continue;
    const distanceDelta = Math.abs(point.distanceM - distanceM);
    const elevationDelta = Math.abs(point.elevationM - elevationM);
    if (distanceDelta < bestDistance || (distanceDelta === bestDistance && elevationDelta < bestElevation)) {
      nearest = point;
      bestDistance = distanceDelta;
      bestElevation = elevationDelta;
    }
  }
  return nearest;
}
