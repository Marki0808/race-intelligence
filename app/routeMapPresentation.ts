export type RouteMapPoint = {
  latitude: number;
  longitude: number;
  segmentIndex: number;
};

export type RouteMapLineFeature = {
  type: "Feature";
  properties: { name: string };
  geometry: { type: "MultiLineString"; coordinates: Array<Array<[number, number]>> };
};

export type RouteMapPointFeatureCollection = {
  type: "FeatureCollection";
  features: Array<{
    type: "Feature";
    properties: { label: "START" | "END" };
    geometry: { type: "Point"; coordinates: [number, number] };
  }>;
};

export function getRouteMapLineStyles(hasSelectedSection: boolean) {
  return hasSelectedSection
    ? {
        contextHalo: { color: "#17211c", width: 5, opacity: 0.38 },
        contextLine: { color: "#b7e363", width: 2.5, opacity: 0.48 },
        selectedHalo: { color: "#17211c", width: 12, opacity: 1 },
        selectedLine: { color: "#f2a23a", width: 7, opacity: 1 },
      }
    : {
        contextHalo: { color: "#17211c", width: 9, opacity: 0.96 },
        contextLine: { color: "#b7e363", width: 5, opacity: 1 },
        selectedHalo: { color: "#17211c", width: 12, opacity: 1 },
        selectedLine: { color: "#f2a23a", width: 7, opacity: 1 },
      };
}

/** Mark exact clipped interval endpoints only when they belong to one ordered GPX component. */
export function buildSelectedSectionEndpointFeatures(
  points: readonly (RouteMapPoint & { distanceM?: number })[],
): RouteMapPointFeatureCollection {
  const empty: RouteMapPointFeatureCollection = { type: "FeatureCollection", features: [] };
  if (points.length < 2 || points.some((point) =>
    !Number.isFinite(point.latitude) || point.latitude < -90 || point.latitude > 90 ||
    !Number.isFinite(point.longitude) || point.longitude < -180 || point.longitude > 180 ||
    !Number.isInteger(point.segmentIndex)
  )) return empty;
  const componentIndex = points[0].segmentIndex;
  if (points.some((point, index) => point.segmentIndex !== componentIndex ||
    (index > 0 && point.distanceM !== undefined && points[index - 1].distanceM !== undefined &&
      (!Number.isFinite(point.distanceM) || point.distanceM! < points[index - 1].distanceM!)))) return empty;
  const first = points[0];
  const last = points.at(-1)!;
  if (first.distanceM !== undefined && last.distanceM !== undefined && last.distanceM <= first.distanceM) return empty;
  return {
    type: "FeatureCollection",
    features: [
      { type: "Feature", properties: { label: "START" }, geometry: { type: "Point", coordinates: [first.longitude, first.latitude] } },
      { type: "Feature", properties: { label: "END" }, geometry: { type: "Point", coordinates: [last.longitude, last.latitude] } },
    ],
  };
}

/** Build route geometry in source order, keeping disconnected GPX components separate. */
export function buildRouteMapFeature(points: readonly RouteMapPoint[], name: string): RouteMapLineFeature | null {
  const bySegment = new Map<number, Array<[number, number]>>();
  for (const point of points) {
    if (!Number.isFinite(point.latitude) || !Number.isFinite(point.longitude)) continue;
    const coordinates = bySegment.get(point.segmentIndex) ?? [];
    coordinates.push([point.longitude, point.latitude]);
    bySegment.set(point.segmentIndex, coordinates);
  }

  const coordinates = [...bySegment.values()].filter((component) => component.length >= 2);
  if (coordinates.length === 0) return null;
  return { type: "Feature", properties: { name }, geometry: { type: "MultiLineString", coordinates } };
}

export function getRouteMapBounds(points: readonly RouteMapPoint[]): [[number, number], [number, number]] | null {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  let count = 0;
  for (const point of points) {
    if (!Number.isFinite(point.latitude) || !Number.isFinite(point.longitude)) continue;
    west = Math.min(west, point.longitude);
    south = Math.min(south, point.latitude);
    east = Math.max(east, point.longitude);
    north = Math.max(north, point.latitude);
    count += 1;
  }
  return count < 2 ? null : [[west, south], [east, north]];
}

export function buildRouteMapFeatures<T extends RouteMapPoint>(points: readonly T[], selectedPoints: readonly T[]) {
  return {
    route: buildRouteMapFeature(points, "GPX route"),
    selected: buildRouteMapFeature(selectedPoints, "Selected GPX interval"),
  };
}
