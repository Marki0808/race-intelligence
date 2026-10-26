import type { AidStationDiscoveryV1 } from "./aidStationDiscovery.ts";
import type { RouteAnalysisData } from "./gpxAnalysis";
import { DEFAULT_ROUTE_DYNAMICS_CONFIG, type RouteDominantRhythm, type ResampledRoutePoint } from "./routeDynamics.ts";
import type { RouteSection } from "./routeSectionEngine.ts";
import { routeSectionSelectionKey } from "./routeSectionSelection.ts";

export type AidStationSectionLabels = { from: string; to: string };
export type AidStationSectionsResult =
  | { available: true; sections: RouteSection[]; labels: ReadonlyMap<string, AidStationSectionLabels>; positionMode: "verified" | "official-kilometer-approximate" }
  | { available: false; reason: string; sections: []; labels: ReadonlyMap<string, AidStationSectionLabels> };

const ENDPOINT_TOLERANCE_M = 5;
const MAX_COVERAGE_ERROR_KM = 0.01;
const MAX_INTERPOLATION_GAP_M = 250;

/** Builds a display-only section set from a complete, verified station sequence and existing smoothed GPX dynamics. */
export function buildAidStationSections(
  discovery: AidStationDiscoveryV1 | null | undefined,
  analysis: Pick<RouteAnalysisData, "points" | "routeDynamics" | "metrics">,
): AidStationSectionsResult {
  const unavailable = (reason: string): AidStationSectionsResult => ({ available: false, reason, sections: [], labels: new Map() });
  if (!discovery || discovery.status !== "available" || !discovery.stationSegmentation.available || discovery.completeness.status !== "complete") return unavailable("station-segmentation-unavailable");
  const positionMode = discovery.stationSegmentation.positionMode ??
    (discovery.gpxProvenance.bindingStatus === "verified" ? "verified" : null);
  if (positionMode === "verified" && discovery.gpxProvenance.bindingStatus !== "verified") return unavailable("gpx-binding-unverified");
  if (positionMode === "official-kilometer-approximate" && discovery.gpxProvenance.bindingStatus !== "approximate") return unavailable("gpx-binding-unverified");
  if (!positionMode) return unavailable("gpx-binding-unverified");
  const visits = discovery.visits;
  if (visits.length < 2 || visits[0].sequenceRole !== "start" || visits.at(-1)?.sequenceRole !== "finish") return unavailable("start-or-finish-unavailable");
  const intermediates = visits.slice(1, -1);
  if (discovery.completeness.extractedCount !== visits.length) return unavailable("visit-count-mismatch");
  if (discovery.completeness.declaredCount != null && discovery.completeness.declaredCount !== intermediates.length) return unavailable("station-count-mismatch");
  const approximateModeIsSupported = positionMode === "official-kilometer-approximate" &&
    discovery.completeness.declaredCount === intermediates.length &&
    discovery.selectedContext.eventName != null && discovery.selectedContext.editionYear != null &&
    discovery.selectedContext.courseDistanceKm != null &&
    Math.abs(discovery.selectedContext.courseDistanceKm - analysis.metrics.distanceKm) <= Math.max(2, discovery.selectedContext.courseDistanceKm * 0.05) &&
    !discovery.reasonCodes.some((reason) => ["course-identity-conflict", "cross-source-identity-conflict", "route-distance-mismatch", "source-position-out-of-range", "source-distance-not-cumulative", "station-count-conflict"].includes(reason)) &&
    visits.every((visit, index) => {
      if (index === 0 || index === visits.length - 1) return visit.position.confidence === "verified" && visit.position.method === "route-endpoint";
      return visit.position.confidence === "approximate" && visit.position.method === "source-distance" &&
        visit.position.distanceKm != null && Number.isFinite(visit.position.distanceKm) &&
        visit.sourcePosition?.semantics === "cumulative" && visit.sourcePosition.qualifier === "exact" &&
        Math.abs(visit.sourcePosition.normalizedKm - visit.position.distanceKm) <= 0.001 && visit.roles.includes("aid-station") &&
        visit.context.eventName === discovery.selectedContext.eventName && visit.context.editionYear === discovery.selectedContext.editionYear &&
        visit.context.courseDistanceKm === discovery.selectedContext.courseDistanceKm;
    });
  const expectedPositionConfidence = positionMode === "verified" ? "verified" : null;
  if (positionMode === "official-kilometer-approximate" && !approximateModeIsSupported) return unavailable("official-kilometer-evidence-unverified");
  if (positionMode === "verified" && visits.some((visit) => visit.position.confidence !== expectedPositionConfidence)) return unavailable("visit-position-or-role-unverified");
  if (visits.some((visit, index) => {
    const endpointRoleValid = index === 0 ? visit.sequenceRole === "start" : index === visits.length - 1 ? visit.sequenceRole === "finish" : visit.sequenceRole === "intermediate-candidate";
    const position = visit.position;
    const stationRoleValid = index === 0 || index === visits.length - 1 || visit.roles.some((role) => ["aid-station", "water-only", "checkpoint"].includes(role));
    return !endpointRoleValid || !stationRoleValid || !visit.name?.trim() || position.confidence === "unresolved" ||
      !Number.isFinite(position.distanceKm) || position.componentIndex == null;
  })) return unavailable("visit-position-or-role-unverified");

  const routePoints = analysis.points;
  const components = [...new Set(routePoints.map((point) => point.segmentIndex))];
  if (components.length !== 1 || routePoints.length < 2) return unavailable("disconnected-or-insufficient-route");
  const componentIndex = components[0];
  const componentPoints = routePoints.filter((point) => point.segmentIndex === componentIndex);
  const startM = componentPoints[0]?.distanceM;
  const finishM = componentPoints.at(-1)?.distanceM;
  const routeDistanceKm = analysis.metrics.distanceKm;
  if (!Number.isFinite(startM) || !Number.isFinite(finishM) || finishM! <= startM! ||
    Math.abs(startM!) > ENDPOINT_TOLERANCE_M || Math.abs(finishM! / 1000 - routeDistanceKm) > MAX_COVERAGE_ERROR_KM) return unavailable("route-boundary-mismatch");

  const projectedBoundaries = visits.map((visit) => ({
    name: visit.name!.trim(),
    sourceOrder: visit.sourceOrder,
    componentIndex: visit.position.componentIndex!,
    distanceM: visit.position.distanceKm! * 1000,
  }));
  if (projectedBoundaries.some((boundary, index) => boundary.componentIndex !== componentIndex ||
    boundary.distanceM < startM! - ENDPOINT_TOLERANCE_M || boundary.distanceM > finishM! + ENDPOINT_TOLERANCE_M ||
    (index > 0 && (boundary.sourceOrder <= projectedBoundaries[index - 1].sourceOrder || boundary.distanceM <= projectedBoundaries[index - 1].distanceM)))) {
    return unavailable("visit-order-or-component-mismatch");
  }
  if (Math.abs(projectedBoundaries[0].distanceM - startM!) > ENDPOINT_TOLERANCE_M || Math.abs(projectedBoundaries.at(-1)!.distanceM - finishM!) > ENDPOINT_TOLERANCE_M ||
    Math.abs((projectedBoundaries.at(-1)!.distanceM - projectedBoundaries[0].distanceM) / 1000 - routeDistanceKm) > MAX_COVERAGE_ERROR_KM) {
    return unavailable("route-coverage-mismatch");
  }
  // The verified source endpoints identify race start/finish; use the analyzed GPX endpoints to close sub-metre projection rounding.
  const boundaries = projectedBoundaries.map((boundary, index) => ({
    ...boundary,
    distanceM: index === 0 ? startM! : index === projectedBoundaries.length - 1 ? finishM! : boundary.distanceM,
  }));

  const dynamics = analysis.routeDynamics.resampledPoints.filter((point) => point.segmentIndex === componentIndex);
  if (dynamics.length < 2) return unavailable("smoothed-elevation-unavailable");
  const sections: RouteSection[] = [];
  const labels = new Map<string, AidStationSectionLabels>();
  for (let index = 0; index < boundaries.length - 1; index += 1) {
    const from = boundaries[index];
    const to = boundaries[index + 1];
    const profile = smoothedProfileBetween(dynamics, from.distanceM, to.distanceM);
    if (!profile || profile.length < 2) return unavailable("smoothed-elevation-unavailable");
    const sectionSamples = analysis.routeDynamics.samples.filter((point) => point.segmentIndex === componentIndex && point.distanceM >= from.distanceM && point.distanceM <= to.distanceM);
    if (!sectionSamples.length) return unavailable("smoothed-elevation-unavailable");
    let ascentM = 0;
    let descentM = 0;
    for (let pointIndex = 1; pointIndex < profile.length; pointIndex += 1) {
      const delta = profile[pointIndex].elevationM - profile[pointIndex - 1].elevationM;
      if (delta > 0) ascentM += delta;
      else descentM += Math.abs(delta);
    }
    const distanceKm = (to.distanceM - from.distanceM) / 1000;
    const verticalM = ascentM + descentM;
    const intensity = distanceKm > 0 ? verticalM / distanceKm : 0;
    const directionStrength = verticalM > 0 ? Math.abs(ascentM - descentM) / verticalM : 0;
    const dominantRhythm: RouteDominantRhythm = intensity <= DEFAULT_ROUTE_DYNAMICS_CONFIG.flatMaximumIntensityMPerKm
      ? "flat"
      : intensity >= DEFAULT_ROUTE_DYNAMICS_CONFIG.minimumDirectionalIntensityMPerKm && directionStrength >= DEFAULT_ROUTE_DYNAMICS_CONFIG.minimumDirectionStrength
        ? ascentM >= descentM ? "climb" : "descent"
        : "rolling";
    const id = `aid-station-section-${from.sourceOrder}-${to.sourceOrder}`;
    const section: RouteSection = {
      id,
      segmentIndex: componentIndex,
      startPosition: { distanceM: from.distanceM, segmentIndex: componentIndex },
      endPosition: { distanceM: to.distanceM, segmentIndex: componentIndex },
      startKm: round2(from.distanceM / 1000),
      endKm: round2(to.distanceM / 1000),
      distanceKm: round2(distanceKm),
      dominantRhythm,
      elevationStartM: Math.round(profile[0].elevationM),
      elevationEndM: Math.round(profile.at(-1)!.elevationM),
      elevationMinM: Math.round(Math.min(...profile.map((point) => point.elevationM))),
      elevationMaxM: Math.round(Math.max(...profile.map((point) => point.elevationM))),
      ascentM: Math.round(ascentM),
      descentM: Math.round(descentM),
      elevationProfile: profile,
      embeddedEvents: [],
      dynamicsSummary: {
        verticalIntensityMPerKm: round1(intensity),
        directionBalance: round2(verticalM ? (ascentM - descentM) / verticalM : 0),
        directionStrength: round2(directionStrength),
        stability: round2(sectionSamples.reduce((sum, point) => sum + point.stability, 0) / sectionSamples.length),
      },
      description: `Route segment between ${from.name} and ${to.name}.`,
    };
    sections.push(section);
    labels.set(routeSectionSelectionKey(section), { from: from.name, to: to.name });
  }
  const sectionDistance = sections.reduce((sum, section) => sum + section.distanceKm, 0);
  if (Math.abs(sectionDistance - routeDistanceKm) > MAX_COVERAGE_ERROR_KM + sections.length * 0.005) return unavailable("section-distance-reconciliation-failed");
  return { available: true, sections, labels, positionMode };
}

function smoothedProfileBetween(points: readonly ResampledRoutePoint[], startM: number, endM: number) {
  const start = interpolateSmoothedElevation(points, startM);
  const end = interpolateSmoothedElevation(points, endM);
  if (!start || !end) return null;
  return [start, ...points.filter((point) => point.distanceM > startM && point.distanceM < endM).map((point) => ({ distanceM: point.distanceM, elevationM: point.smoothedElevationM })), end];
}

function interpolateSmoothedElevation(points: readonly ResampledRoutePoint[], distanceM: number) {
  const exact = points.find((point) => Math.abs(point.distanceM - distanceM) < 0.001);
  if (exact) return { distanceM, elevationM: exact.smoothedElevationM };
  const rightIndex = points.findIndex((point) => point.distanceM > distanceM);
  if (rightIndex <= 0) return null;
  const left = points[rightIndex - 1];
  const right = points[rightIndex];
  const span = right.distanceM - left.distanceM;
  if (span <= 0 || span > MAX_INTERPOLATION_GAP_M || distanceM < left.distanceM || distanceM > right.distanceM) return null;
  const ratio = (distanceM - left.distanceM) / span;
  return { distanceM, elevationM: left.smoothedElevationM + (right.smoothedElevationM - left.smoothedElevationM) * ratio };
}

function round1(value: number) { return Number(value.toFixed(1)); }
function round2(value: number) { return Number(value.toFixed(2)); }
