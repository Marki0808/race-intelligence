import type { GpxRoutePointData } from "./gpxAnalysis.ts";
import type { RouteSection } from "./routeSectionEngine.ts";
import { avoidRouteDistanceTickLabelOverlap, getNiceAxisScale, getPositionedRouteDistanceTicks } from "./routeProfilePresentation.ts";
import { formatDistanceMeters, type RouteUnitSystem } from "./routeUnits.ts";

export const ROUTE_SECTION_OVERVIEW_HEIGHT = 124;
export const ROUTE_SECTION_OVERVIEW_EDGE = { left: 42, right: 12, top: 22, bottom: 28 };

export type RouteOverviewPoint = Pick<GpxRoutePointData, "distanceM" | "elevationM" | "segmentIndex">;
export type RouteOverviewRun = { segmentIndex: number; points: RouteOverviewPoint[] };
export type RouteOverviewTick = { distanceM: number; x: number; label: string; isFinish: boolean };
export type RouteSectionOverviewLayout = {
  width: number;
  height: number;
  totalDistanceM: number;
  elevationScale: ReturnType<typeof getNiceAxisScale>;
  components: RouteOverviewRun[];
  selectedRuns: RouteOverviewRun[];
  selectedRange: { startDistanceM: number; endDistanceM: number; startX: number; endX: number } | null;
  distanceTicks: RouteOverviewTick[];
  xForDistance: (distanceM: number) => number;
  yForElevation: (elevationM: number) => number;
};

/** Builds a compact, full-route elevation context while retaining component gaps and exact section bounds. */
export function createRouteSectionOverviewLayout(
  routePoints: readonly GpxRoutePointData[],
  section: Pick<RouteSection, "segmentIndex" | "startPosition" | "endPosition">,
  width: number,
  units: RouteUnitSystem = "metric",
): RouteSectionOverviewLayout | null {
  const edge = ROUTE_SECTION_OVERVIEW_EDGE;
  const height = ROUTE_SECTION_OVERVIEW_HEIGHT;
  if (!Number.isFinite(width) || width <= edge.left + edge.right) return null;

  let totalDistanceM = 0;
  for (const point of routePoints) {
    if (Number.isFinite(point.distanceM)) totalDistanceM = Math.max(totalDistanceM, point.distanceM);
  }
  if (!(totalDistanceM > 0)) return null;

  const components = splitElevationRuns(routePoints);
  let minimumElevationM = Number.POSITIVE_INFINITY;
  let maximumElevationM = Number.NEGATIVE_INFINITY;
  for (const run of components) for (const point of run.points) {
    minimumElevationM = Math.min(minimumElevationM, point.elevationM);
    maximumElevationM = Math.max(maximumElevationM, point.elevationM);
  }
  if (minimumElevationM === Number.POSITIVE_INFINITY) return null;
  const plotWidth = width - edge.left - edge.right;
  const plotHeight = height - edge.top - edge.bottom;
  const elevationScale = getNiceAxisScale(minimumElevationM, maximumElevationM, 3);
  const xForDistance = (distanceM: number) => edge.left + Math.max(0, Math.min(totalDistanceM, distanceM)) / totalDistanceM * plotWidth;
  const yForElevation = (elevationM: number) => edge.top + (elevationScale.maximum - elevationM) / (elevationScale.maximum - elevationScale.minimum) * plotHeight;
  const startDistanceM = section.startPosition.distanceM;
  const endDistanceM = section.endPosition.distanceM;
  let componentStartM = Number.POSITIVE_INFINITY;
  let componentEndM = Number.NEGATIVE_INFINITY;
  for (const point of routePoints) {
    if (point.segmentIndex !== section.segmentIndex || !Number.isFinite(point.distanceM)) continue;
    componentStartM = Math.min(componentStartM, point.distanceM);
    componentEndM = Math.max(componentEndM, point.distanceM);
  }
  const hasValidSectionRange = section.startPosition.segmentIndex === section.segmentIndex &&
    section.endPosition.segmentIndex === section.segmentIndex &&
    Number.isFinite(startDistanceM) && Number.isFinite(endDistanceM) &&
    endDistanceM > startDistanceM && startDistanceM >= componentStartM && endDistanceM <= componentEndM && endDistanceM <= totalDistanceM;
  const selectedRange = hasValidSectionRange ? {
    startDistanceM,
    endDistanceM,
    startX: xForDistance(startDistanceM),
    endX: xForDistance(endDistanceM),
  } : null;
  const distanceTicks = avoidRouteDistanceTickLabelOverlap(
    getPositionedRouteDistanceTicks(totalDistanceM, edge.left, width - edge.right, 5, units),
    9,
  ).map(({ distanceM, x, label, isFinish }) => ({ distanceM, x, label, isFinish }));

  return {
    width,
    height,
    totalDistanceM,
    elevationScale,
    components,
    selectedRuns: selectedRange ? clipRunsToRange(components, section.segmentIndex, startDistanceM, endDistanceM) : [],
    selectedRange,
    distanceTicks,
    xForDistance,
    yForElevation,
  };
}

function splitElevationRuns(points: readonly GpxRoutePointData[]): RouteOverviewRun[] {
  const runs: RouteOverviewRun[] = [];
  let current: RouteOverviewPoint[] = [];
  let currentSegment: number | null = null;
  const flush = () => {
    if (current.length) runs.push({ segmentIndex: current[0].segmentIndex, points: current });
    current = [];
    currentSegment = null;
  };

  for (const point of points) {
    const valid = Number.isInteger(point.segmentIndex) && Number.isFinite(point.distanceM) && Number.isFinite(point.elevationM);
    if (!valid) { flush(); continue; }
    if (current.length && (point.segmentIndex !== currentSegment || point.distanceM < current.at(-1)!.distanceM)) flush();
    currentSegment = point.segmentIndex;
    current.push({ distanceM: point.distanceM, elevationM: point.elevationM, segmentIndex: point.segmentIndex });
  }
  flush();
  return runs;
}

function clipRunsToRange(runs: readonly RouteOverviewRun[], segmentIndex: number, startM: number, endM: number): RouteOverviewRun[] {
  const clippedRuns: RouteOverviewRun[] = [];
  for (const run of runs) {
    if (run.segmentIndex !== segmentIndex) continue;
    if (run.points.length === 1) {
      const point = run.points[0];
      if (point.distanceM >= startM && point.distanceM <= endM) clippedRuns.push({ segmentIndex, points: [{ ...point }] });
      continue;
    }
    let clipped: RouteOverviewPoint[] = [];
    const flush = () => {
      if (clipped.length) clippedRuns.push({ segmentIndex, points: clipped });
      clipped = [];
    };
    for (let index = 1; index < run.points.length; index += 1) {
      const left = run.points[index - 1];
      const right = run.points[index];
      const overlapStart = Math.max(startM, left.distanceM);
      const overlapEnd = Math.min(endM, right.distanceM);
      if (overlapEnd < overlapStart) { flush(); continue; }
      appendUnique(clipped, interpolate(left, right, overlapStart));
      appendUnique(clipped, interpolate(left, right, overlapEnd));
    }
    flush();
  }
  return clippedRuns;
}

function interpolate(left: RouteOverviewPoint, right: RouteOverviewPoint, distanceM: number): RouteOverviewPoint {
  if (distanceM <= left.distanceM) return { ...left };
  if (distanceM >= right.distanceM) return { ...right };
  const span = right.distanceM - left.distanceM;
  if (!(span > 0)) return { ...left };
  const ratio = (distanceM - left.distanceM) / span;
  return { distanceM, elevationM: left.elevationM + (right.elevationM - left.elevationM) * ratio, segmentIndex: left.segmentIndex };
}

function appendUnique(points: RouteOverviewPoint[], point: RouteOverviewPoint) {
  if (points.at(-1)?.distanceM !== point.distanceM) points.push(point);
}

export function describeRouteSectionOverview(startDistanceM: number, endDistanceM: number, totalDistanceM: number, units: RouteUnitSystem) {
  return `Full route elevation overview from start to finish over ${formatDistanceMeters(totalDistanceM, units, 2)}. Selected section highlighted from ${formatDistanceMeters(startDistanceM, units, 2)} to ${formatDistanceMeters(endDistanceM, units, 2)}.`;
}
