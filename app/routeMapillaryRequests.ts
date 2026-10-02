import { thinRouteForMatching } from "./geoEnrichment.ts";
import type { RouteAnalysisData } from "./gpxAnalysis.ts";
import type { MapillaryRoutePoint, MapillaryTerrainSectionRequest } from "./mapillaryTerrainProof.ts";
import type { RouteSection } from "./routeSectionEngine.ts";

export function buildMapillaryRequests(sections: readonly RouteSection[], points: RouteAnalysisData["points"]): MapillaryTerrainSectionRequest[] {
  return sections.map((section) => {
    const startM = section.startKm * 1000;
    const endM = section.endKm * 1000;
    const matching = points.filter((point) => point.distanceM >= startM && point.distanceM <= endM);
    const endpoints = [nearestPoint(points, startM), nearestPoint(points, endM)].filter((point): point is RouteAnalysisData["points"][number] => point !== null);
    const combined = [...new Map([...matching, ...endpoints].map((point) => [point.distanceM, point])).values()].sort((left, right) => left.distanceM - right.distanceM);
    const sampled = thinRouteForMatching(combined, 120).map(({ latitude, longitude, distanceM }) => ({ latitude, longitude, distanceM }));
    return { id: section.id, startDistanceKm: section.startKm, endDistanceKm: section.endKm, points: sampled };
  }).filter((section) => section.points.length >= 2);
}

function nearestPoint(points: RouteAnalysisData["points"], distanceM: number) {
  return points.reduce<RouteAnalysisData["points"][number] | null>((nearest, point) =>
    !nearest || Math.abs(point.distanceM - distanceM) < Math.abs(nearest.distanceM - distanceM) ? point : nearest, null);
}

export function toMapillaryRoutePoints(points: readonly MapillaryRoutePoint[]) {
  return points.map(({ latitude, longitude, distanceM }) => ({ latitude, longitude, distanceM }));
}
