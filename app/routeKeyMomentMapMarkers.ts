import type { GpxRoutePointData } from "./gpxAnalysis.ts";
import type { KeyMomentData } from "./raceTypes.ts";
import type { KeyMomentCardPresentation } from "./routeKeyMomentPresentation.ts";
import { presentKeyMomentCard } from "./routeKeyMomentPresentation.ts";
import { clipRoutePointsToKeyMoment, resolveKeyMomentInterval } from "./routeSectionSelection.ts";
import { formatDistanceMeters, type RouteUnitSystem } from "./routeUnits.ts";

export type KeyMomentMapMarker = {
  id: string;
  number: string;
  title: string;
  kind: "point" | "range";
  distanceM: number;
  distanceLabel: string;
  startDistanceM: number;
  endDistanceM: number;
  longitude: number;
  latitude: number;
  focusPoints: GpxRoutePointData[];
};

/** Builds map markers only from existing card presentations and proven GPX component locations. */
export function buildKeyMomentMapMarkers(
  displayable: readonly { moment: KeyMomentData; card: KeyMomentCardPresentation; number: string }[],
  points: readonly GpxRoutePointData[],
  totalDistanceM: number,
  units: RouteUnitSystem,
): KeyMomentMapMarker[] {
  return displayable.flatMap(({ moment, number }) => {
    const card = presentKeyMomentCard(moment, points, totalDistanceM, units);
    if (!card) return [];
    const interval = resolveKeyMomentInterval(points, moment);
    const clipped = clipRoutePointsToKeyMoment(points, moment);
    if (!interval || clipped.length === 0 || clipped.some((point) => point.segmentIndex !== interval.segmentIndex)) return [];
    const kind = moment.measurement?.kind === "point" ? "point" : "range";
    const distanceM = kind === "point" ? interval.startDistanceM : interval.startDistanceM;
    const location = sampleComponent(clipped, distanceM);
    if (!location || !Number.isFinite(location.latitude) || !Number.isFinite(location.longitude)) return [];
    const focusPoints = moment.measurement?.kind === "point"
      ? points.filter((point) => point.segmentIndex === interval.segmentIndex && Math.abs(point.distanceM - distanceM) <= 500)
      : clipped;
    return [{
      id: moment.id,
      number,
      title: card.title,
      kind,
      distanceM,
      distanceLabel: formatDistanceMeters(distanceM, units),
      startDistanceM: interval.startDistanceM,
      endDistanceM: interval.endDistanceM,
      longitude: location.longitude,
      latitude: location.latitude,
      focusPoints: focusPoints.length ? focusPoints : clipped,
    }];
  });
}

function sampleComponent(points: readonly GpxRoutePointData[], distanceM: number): GpxRoutePointData | null {
  if (points.length === 1) return Math.abs(points[0].distanceM - distanceM) < 0.001 ? points[0] : null;
  for (let index = 1; index < points.length; index += 1) {
    const left = points[index - 1];
    const right = points[index];
    if (left.segmentIndex !== right.segmentIndex || distanceM < left.distanceM || distanceM > right.distanceM) continue;
    const span = right.distanceM - left.distanceM;
    if (span <= 0) return left.distanceM === distanceM ? left : null;
    const ratio = (distanceM - left.distanceM) / span;
    return {
      ...left,
      distanceM,
      latitude: left.latitude + (right.latitude - left.latitude) * ratio,
      longitude: left.longitude + (right.longitude - left.longitude) * ratio,
      elevationM: Number.isFinite(left.elevationM) && Number.isFinite(right.elevationM)
        ? left.elevationM + (right.elevationM - left.elevationM) * ratio
        : Number.NaN,
    };
  }
  return null;
}
