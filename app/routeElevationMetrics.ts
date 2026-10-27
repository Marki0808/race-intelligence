import type { GpxRoutePointData } from "./gpxAnalysis.ts";

/** Elevation reporting is measured on a 50 m route grid with a 50 m-radius median filter. */
export const ROUTE_ELEVATION_METRIC_INTERVAL_M = 50;
export const ROUTE_ELEVATION_METRIC_MEDIAN_RADIUS_M = 50;
export const ROUTE_ELEVATION_METRIC_DESCRIPTION = "Elevation gain and loss use GPX elevations sampled every 50 m and a 50 m-radius median filter to reduce isolated altitude spikes. The displayed profile is smoothed separately.";

type MetricProfilePoint = {
  distanceM: number;
  elevationM: number;
  cumulativeAscentM: number;
  cumulativeDescentM: number;
};

type MetricComponent = {
  segmentIndex: number;
  baseAscentM: number;
  baseDescentM: number;
  points: MetricProfilePoint[];
};

export type RouteElevationMetricModel = { components: readonly MetricComponent[]; ascentM: number; descentM: number };
export type RouteElevationIntervalMetrics = { ascentM: number; descentM: number };

/**
 * Creates one distance-resampled, lightly median-filtered elevation sequence per GPX component.
 * Filtering on a fixed route-distance grid keeps dense GPX files from receiving more smoothing
 * merely because they contain more points. Components are independent: no connector is created.
 */
export function buildRouteElevationMetricModel(points: readonly GpxRoutePointData[]): RouteElevationMetricModel {
  const grouped = new Map<number, GpxRoutePointData[]>();
  for (const point of points) {
    const segmentIndex = point.segmentIndex ?? 0;
    const group = grouped.get(segmentIndex) ?? [];
    group.push(point);
    grouped.set(segmentIndex, group);
  }

  const components: MetricComponent[] = [];
  let totalAscentM = 0;
  let totalDescentM = 0;
  for (const [segmentIndex, source] of grouped) {
    // Do not bridge across an invalid sample or repair unordered component input.
    if (source.some((point, index) => !Number.isFinite(point.distanceM) || !Number.isFinite(point.elevationM) ||
        (index > 0 && point.distanceM < source[index - 1].distanceM))) continue;
    const route = source.filter((point) => Number.isFinite(point.distanceM) && Number.isFinite(point.elevationM));
    if (route.length < 2) continue;
    const unique: GpxRoutePointData[] = [];
    for (const point of route) {
      const previous = unique.at(-1);
      if (previous && point.distanceM === previous.distanceM) unique[unique.length - 1] = point;
      else unique.push(point);
    }
    if (unique.length < 2 || unique.at(-1)!.distanceM <= unique[0].distanceM) continue;

    const sampled = resample(unique);
    const filtered = medianFilterByDistanceGrid(sampled);
    const component: MetricComponent = {
      segmentIndex,
      baseAscentM: totalAscentM,
      baseDescentM: totalDescentM,
      points: [],
    };
    let localAscentM = 0;
    let localDescentM = 0;
    filtered.forEach((point, index) => {
      if (index > 0) {
        const change = point.elevationM - filtered[index - 1].elevationM;
        if (change > 0) localAscentM += change;
        else localDescentM -= change;
      }
      component.points.push({
        ...point,
        cumulativeAscentM: component.baseAscentM + localAscentM,
        cumulativeDescentM: component.baseDescentM + localDescentM,
      });
    });
    totalAscentM += localAscentM;
    totalDescentM += localDescentM;
    components.push(component);
  }
  return { components, ascentM: Math.round(totalAscentM), descentM: Math.round(totalDescentM) };
}

/** Returns integer-meter allocations from the same cumulative curve used for whole-route totals. */
export function measureRouteElevationInterval(
  model: RouteElevationMetricModel,
  segmentIndex: number,
  startDistanceM: number,
  endDistanceM: number,
): RouteElevationIntervalMetrics | null {
  if (!Number.isFinite(startDistanceM) || !Number.isFinite(endDistanceM) || endDistanceM <= startDistanceM) return null;
  const component = model.components.find((item) => item.segmentIndex === segmentIndex);
  if (!component || !component.points.length || startDistanceM < component.points[0].distanceM - 0.001 ||
      endDistanceM > component.points.at(-1)!.distanceM + 0.001) return null;
  const start = cumulativeAt(component, startDistanceM);
  const end = cumulativeAt(component, endDistanceM);
  if (!start || !end) return null;
  return {
    ascentM: Math.max(0, Math.round(end.ascentM) - Math.round(start.ascentM)),
    descentM: Math.max(0, Math.round(end.descentM) - Math.round(start.descentM)),
  };
}

function resample(points: readonly GpxRoutePointData[]) {
  const start = points[0].distanceM;
  const end = points.at(-1)!.distanceM;
  const distances = [start];
  for (let distance = start + ROUTE_ELEVATION_METRIC_INTERVAL_M; distance < end; distance += ROUTE_ELEVATION_METRIC_INTERVAL_M) distances.push(distance);
  distances.push(end);
  let cursor = 0;
  return distances.map((distanceM) => {
    while (cursor < points.length - 2 && points[cursor + 1].distanceM < distanceM) cursor += 1;
    const left = points[cursor];
    const right = points[Math.min(cursor + 1, points.length - 1)];
    const span = right.distanceM - left.distanceM;
    const ratio = span > 0 ? Math.max(0, Math.min(1, (distanceM - left.distanceM) / span)) : 0;
    return { distanceM, elevationM: left.elevationM + (right.elevationM - left.elevationM) * ratio };
  });
}

function medianFilterByDistanceGrid(points: readonly { distanceM: number; elevationM: number }[]) {
  const radius = Math.round(ROUTE_ELEVATION_METRIC_MEDIAN_RADIUS_M / ROUTE_ELEVATION_METRIC_INTERVAL_M);
  return points.map((point, index) => {
    const values = Array.from({ length: radius * 2 + 1 }, (_, offset) => {
      const sampleIndex = Math.max(0, Math.min(points.length - 1, index + offset - radius));
      return points[sampleIndex].elevationM;
    }).sort((left, right) => left - right);
    return { distanceM: point.distanceM, elevationM: values[Math.floor(values.length / 2)] };
  });
}

function cumulativeAt(component: MetricComponent, distanceM: number) {
  const points = component.points;
  const exact = points.find((point) => Math.abs(point.distanceM - distanceM) < 0.001);
  if (exact) return { ascentM: exact.cumulativeAscentM, descentM: exact.cumulativeDescentM };
  const rightIndex = points.findIndex((point) => point.distanceM > distanceM);
  if (rightIndex <= 0) return null;
  const left = points[rightIndex - 1];
  const right = points[rightIndex];
  const ratio = (distanceM - left.distanceM) / (right.distanceM - left.distanceM);
  const elevation = left.elevationM + (right.elevationM - left.elevationM) * ratio;
  const change = elevation - left.elevationM;
  return {
    ascentM: left.cumulativeAscentM + Math.max(0, change),
    descentM: left.cumulativeDescentM + Math.max(0, -change),
  };
}
