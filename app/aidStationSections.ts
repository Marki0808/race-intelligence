import type { AidStationDiscoveryV1 } from "./aidStationDiscovery.ts";
import type { RouteAnalysisData } from "./gpxAnalysis";
import type { RouteSection } from "./routeSectionEngine.ts";
import { routeSectionSelectionKey } from "./routeSectionSelection.ts";
import { buildRouteSectionsFromIntervals } from "./routeSectionIntervals.ts";

export type AidStationSectionLabels = { from: string; to: string };
export type AidStationSectionsResult =
  | { available: true; sections: RouteSection[]; labels: ReadonlyMap<string, AidStationSectionLabels>; positionMode: "verified" | "official-kilometer-approximate" }
  | { available: false; reason: string; sections: []; labels: ReadonlyMap<string, AidStationSectionLabels> };

const ENDPOINT_TOLERANCE_M = 5;
const MAX_COVERAGE_ERROR_KM = 0.01;

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

  const sectionIntervals = buildRouteSectionsFromIntervals(analysis, boundaries.slice(0, -1).map((from, index) => ({
    id: `aid-station-section-${from.sourceOrder}-${boundaries[index + 1].sourceOrder}`,
    segmentIndex: componentIndex,
    startDistanceM: from.distanceM,
    endDistanceM: boundaries[index + 1].distanceM,
    fromLabel: from.name,
    toLabel: boundaries[index + 1].name,
  })));
  if (!sectionIntervals) return unavailable("smoothed-elevation-unavailable");
  const { sections } = sectionIntervals;
  const labels = new Map<string, AidStationSectionLabels>(sections.map((section) => [
    routeSectionSelectionKey(section), sectionIntervals.labels.get(routeSectionSelectionKey(section))!,
  ]));
  const sectionDistance = sections.reduce((sum, section) => sum + section.distanceKm, 0);
  if (Math.abs(sectionDistance - routeDistanceKm) > MAX_COVERAGE_ERROR_KM + sections.length * 0.005) return unavailable("section-distance-reconciliation-failed");
  return { available: true, sections, labels, positionMode };
}
