import type { GpxRoutePointData } from "./gpxAnalysis.ts";

export type RouteSourceElevationExtrema = { minimum: number; maximum: number };

/** Measures a component-bounded interval from source GPX elevations, interpolating only its two boundaries. */
export function measureRouteSourceElevationExtrema(
  points: readonly GpxRoutePointData[],
  segmentIndex: number,
  startDistanceM: number,
  endDistanceM: number,
): RouteSourceElevationExtrema | null {
  if (!Number.isInteger(segmentIndex) || !Number.isFinite(startDistanceM) || !Number.isFinite(endDistanceM) || endDistanceM <= startDistanceM) return null;
  const component = points.filter((point) => point.segmentIndex === segmentIndex && Number.isFinite(point.distanceM) && Number.isFinite(point.elevationM));
  if (component.length < 2 || startDistanceM < component[0].distanceM || endDistanceM > component.at(-1)!.distanceM) return null;

  const elevations = component
    .filter((point) => point.distanceM >= startDistanceM && point.distanceM <= endDistanceM)
    .map((point) => point.elevationM);
  const startElevation = interpolateSourceElevation(component, startDistanceM);
  const endElevation = interpolateSourceElevation(component, endDistanceM);
  if (startElevation === null || endElevation === null) return null;
  elevations.push(startElevation, endElevation);
  return {
    minimum: elevations.reduce((minimum, elevation) => Math.min(minimum, elevation), Number.POSITIVE_INFINITY),
    maximum: elevations.reduce((maximum, elevation) => Math.max(maximum, elevation), Number.NEGATIVE_INFINITY),
  };
}

function interpolateSourceElevation(points: readonly GpxRoutePointData[], distanceM: number) {
  const rightIndex = points.findIndex((point) => point.distanceM >= distanceM);
  if (rightIndex < 0) return null;
  const right = points[rightIndex];
  if (Math.abs(right.distanceM - distanceM) < 0.001) return right.elevationM;
  if (rightIndex === 0) return null;
  const left = points[rightIndex - 1];
  const span = right.distanceM - left.distanceM;
  if (span <= 0) return left.elevationM;
  const ratio = (distanceM - left.distanceM) / span;
  return left.elevationM + (right.elevationM - left.elevationM) * ratio;
}
