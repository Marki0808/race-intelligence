import type { GpxRoutePointData } from "./gpxAnalysis";
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
