import type { GpxRoutePointData } from "./gpxAnalysis";
import type { KeyMomentData } from "./raceTypes";
import type { RouteSection } from "./routeSectionEngine";

export function routeSectionSelectionKey(section: Pick<RouteSection, "id" | "segmentIndex">): string {
  return `${section.segmentIndex}:${section.id}`;
}

export function findSelectedRouteSection(
  sections: readonly RouteSection[],
  selectionKey: string | null,
): RouteSection | null {
  if (selectionKey === null) return null;
  return sections.find((section) => routeSectionSelectionKey(section) === selectionKey) ?? null;
}

export type RouteMomentInterval = {
  segmentIndex: number;
  startDistanceM: number;
  endDistanceM: number;
};

/** Resolves a Key Moment only when its distance interval can be bound to one GPX component. */
export function resolveKeyMomentInterval(
  points: readonly GpxRoutePointData[],
  moment: KeyMomentData,
): RouteMomentInterval | null {
  const components = [...new Set(points.map((point) => point.segmentIndex))];
  const hasStartPosition = moment.focusStartPosition !== undefined;
  const hasEndPosition = moment.focusEndPosition !== undefined;
  if (hasStartPosition !== hasEndPosition) return null;

  let segmentIndex: number;
  let startDistanceM: number;
  let endDistanceM: number;
  if (hasStartPosition && hasEndPosition) {
    const start = moment.focusStartPosition!;
    const end = moment.focusEndPosition!;
    if (start.segmentIndex !== end.segmentIndex) return null;
    if (moment.segmentIndex !== undefined && moment.segmentIndex !== start.segmentIndex) return null;
    segmentIndex = start.segmentIndex;
    startDistanceM = start.distanceM;
    endDistanceM = end.distanceM;
  } else {
    if (moment.segmentIndex !== undefined) segmentIndex = moment.segmentIndex;
    else if (components.length === 1) segmentIndex = components[0];
    else return null;
    startDistanceM = moment.focusStartKm * 1000;
    endDistanceM = moment.focusEndKm * 1000;
  }

  if (!Number.isFinite(startDistanceM) || !Number.isFinite(endDistanceM) || endDistanceM <= startDistanceM) return null;
  const componentPoints = points.filter((point) => point.segmentIndex === segmentIndex);
  if (componentPoints.length === 0) return null;
  const componentStart = componentPoints[0].distanceM;
  const componentEnd = componentPoints.at(-1)!.distanceM;
  const clippedStart = Math.max(startDistanceM, componentStart);
  const clippedEnd = Math.min(endDistanceM, componentEnd);
  if (clippedEnd <= clippedStart) return null;
  return { segmentIndex, startDistanceM: clippedStart, endDistanceM: clippedEnd };
}

/** Clips the selected Key Moment to its proven component and full-precision interval. */
export function clipRoutePointsToKeyMoment(
  points: readonly GpxRoutePointData[],
  moment: KeyMomentData,
): GpxRoutePointData[] {
  const interval = resolveKeyMomentInterval(points, moment);
  if (!interval) return [];
  return clipRoutePointsToSection(points, {
    segmentIndex: interval.segmentIndex,
    startPosition: { distanceM: interval.startDistanceM, segmentIndex: interval.segmentIndex },
    endPosition: { distanceM: interval.endDistanceM, segmentIndex: interval.segmentIndex },
  });
}

export function toggleKeyMomentSelection(current: string | null, momentId: string): string | null {
  return current === momentId ? null : momentId;
}

/** Clips only traversed edges from the section's own GPX component to its full-precision interval. */
export function clipRoutePointsToSection(
  points: readonly GpxRoutePointData[],
  section: Pick<RouteSection, "segmentIndex" | "startPosition" | "endPosition">,
): GpxRoutePointData[] {
  const startM = section.startPosition.distanceM;
  const endM = section.endPosition.distanceM;
  if (
    section.startPosition.segmentIndex !== section.segmentIndex ||
    section.endPosition.segmentIndex !== section.segmentIndex ||
    !Number.isFinite(startM) ||
    !Number.isFinite(endM) ||
    endM < startM
  ) return [];

  const component = points.filter((point) => point.segmentIndex === section.segmentIndex);
  if (component.length === 1) {
    const point = component[0];
    return point.distanceM >= startM && point.distanceM <= endM ? [{ ...point }] : [];
  }

  const clipped: GpxRoutePointData[] = [];
  for (let index = 1; index < component.length; index += 1) {
    const left = component[index - 1];
    const right = component[index];
    const edgeStart = Math.max(startM, left.distanceM);
    const edgeEnd = Math.min(endM, right.distanceM);
    if (edgeEnd < edgeStart || right.distanceM < left.distanceM) continue;
    appendUnique(clipped, interpolatePoint(left, right, edgeStart));
    appendUnique(clipped, interpolatePoint(left, right, edgeEnd));
  }
  return clipped;
}

function interpolatePoint(left: GpxRoutePointData, right: GpxRoutePointData, distanceM: number): GpxRoutePointData {
  if (distanceM <= left.distanceM) return { ...left };
  if (distanceM >= right.distanceM) return { ...right };
  const ratio = (distanceM - left.distanceM) / (right.distanceM - left.distanceM);
  return {
    latitude: left.latitude + (right.latitude - left.latitude) * ratio,
    longitude: left.longitude + (right.longitude - left.longitude) * ratio,
    elevationM: left.elevationM + (right.elevationM - left.elevationM) * ratio,
    distanceM,
    segmentIndex: left.segmentIndex,
  };
}

function appendUnique(points: GpxRoutePointData[], point: GpxRoutePointData) {
  const previous = points.at(-1);
  if (!previous || previous.segmentIndex !== point.segmentIndex || previous.distanceM !== point.distanceM) points.push(point);
}
