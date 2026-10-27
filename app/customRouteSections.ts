import type { RouteAnalysisData } from "./gpxAnalysis.ts";
import type { RouteSectionIntervalDefinition } from "./routeSectionIntervals.ts";
import { buildRouteSectionsFromIntervals } from "./routeSectionIntervals.ts";
import type { RouteSection } from "./routeSectionEngine.ts";

export const MAX_CUSTOM_SECTION_BOUNDARIES = 20;
const MAX_BOUNDARY_NAME_LENGTH = 60;

export type CustomSectionBoundary = { id: string; distanceKm: string; name: string };
export type CustomSectionPlan = { startName: string; finishName: string; boundaries: CustomSectionBoundary[] };
export type CustomSectionValidation = { valid: true; errors: [] } | { valid: false; errors: string[] };
type SectionBoundaryLabels = { from: string; to: string };
export type CustomRouteSectionsResult =
  | { available: true; sections: RouteSection[]; labels: ReadonlyMap<string, SectionBoundaryLabels> }
  | { available: false; sections: []; labels: ReadonlyMap<string, SectionBoundaryLabels>; errors: string[] };

export function createCustomSectionPlan(): CustomSectionPlan {
  return { startName: "Start", finishName: "Finish", boundaries: [] };
}

export function appendCustomSectionBoundary(plan: CustomSectionPlan, routeDistanceM: number): CustomSectionPlan {
  if (plan.boundaries.length >= MAX_CUSTOM_SECTION_BOUNDARIES || !Number.isFinite(routeDistanceM) || routeDistanceM <= 0) return plan;
  const distances = [0, ...plan.boundaries.map((boundary) => Number(boundary.distanceKm) * 1000)
    .filter((distance) => Number.isFinite(distance) && distance > 0 && distance < routeDistanceM), routeDistanceM]
    .sort((left, right) => left - right);
  let widestStart = 0;
  let widestEnd = 0;
  let widestGap = -1;
  for (let index = 1; index < distances.length; index += 1) {
    if (distances[index] - distances[index - 1] > widestGap) {
      widestStart = distances[index - 1];
      widestEnd = distances[index];
      widestGap = distances[index] - distances[index - 1];
    }
  }
  const midpointKm = Math.round(((widestStart + widestEnd) / 2) / 10) / 100;
  const midpointM = midpointKm * 1000;
  if (!(midpointM > widestStart && midpointM < widestEnd)) return plan;
  const nextId = plan.boundaries.reduce((max, boundary) => Math.max(max, Number(boundary.id.match(/(\d+)$/)?.[1] ?? 0)), 0) + 1;
  return { ...plan, boundaries: [...plan.boundaries, { id: `custom-point-${nextId}`, distanceKm: midpointKm.toFixed(2), name: "" }] };
}

export function validateCustomSectionPlan(plan: CustomSectionPlan, routeDistanceM: number): CustomSectionValidation {
  const errors: string[] = [];
  if (!Number.isFinite(routeDistanceM) || routeDistanceM <= 0) return { valid: false, errors: ["The route distance is unavailable, so custom sections cannot be created."] };
  if (plan.boundaries.length > MAX_CUSTOM_SECTION_BOUNDARIES) errors.push(`Use no more than ${MAX_CUSTOM_SECTION_BOUNDARIES} custom boundaries.`);
  if (plan.startName.trim().length > MAX_BOUNDARY_NAME_LENGTH || plan.finishName.trim().length > MAX_BOUNDARY_NAME_LENGTH ||
      plan.boundaries.some((boundary) => boundary.name.trim().length > MAX_BOUNDARY_NAME_LENGTH)) {
    errors.push(`Names must be ${MAX_BOUNDARY_NAME_LENGTH} characters or fewer.`);
  }
  let previousM = 0;
  for (let index = 0; index < plan.boundaries.length; index += 1) {
    const boundary = plan.boundaries[index];
    const km = boundary.distanceKm.trim() === "" ? Number.NaN : Number(boundary.distanceKm);
    const distanceM = km * 1000;
    if (!Number.isFinite(distanceM)) {
      errors.push(`Boundary ${index + 1} needs a valid distance in kilometers.`);
      continue;
    }
    if (distanceM <= 0 || distanceM >= routeDistanceM) errors.push(`Boundary ${index + 1} must be between 0 and ${(routeDistanceM / 1000).toFixed(2)} km.`);
    if (distanceM <= previousM) errors.push("Custom boundaries must be in strictly increasing order with no duplicate distances.");
    previousM = distanceM;
  }
  return errors.length ? { valid: false, errors: [...new Set(errors)] } : { valid: true, errors: [] };
}

/** Projects custom distance intervals onto each GPX component without adding a link across component breaks. */
export function buildCustomRouteSections(
  analysis: Pick<RouteAnalysisData, "points" | "routeDynamics">,
  plan: CustomSectionPlan,
): CustomRouteSectionsResult {
  const routeDistanceM = analysis.points.at(-1)?.distanceM ?? Number.NaN;
  const validation = validateCustomSectionPlan(plan, routeDistanceM);
  if (!validation.valid) return { available: false, sections: [], labels: new Map(), errors: validation.errors };

  const userBoundaries = plan.boundaries.map((boundary, index) => ({
    id: boundary.id,
    distanceM: Number(boundary.distanceKm) * 1000,
    name: boundary.name.trim() || `Point ${index + 1}`,
  }));
  const boundaries = [
    { id: "start", distanceM: 0, name: plan.startName.trim() || "Start" },
    ...userBoundaries,
    { id: "finish", distanceM: routeDistanceM, name: plan.finishName.trim() || "Finish" },
  ];
  const componentBounds = [...new Set(analysis.points.map((point) => point.segmentIndex))].map((segmentIndex) => {
    const points = analysis.points.filter((point) => point.segmentIndex === segmentIndex);
    return { segmentIndex, startDistanceM: points[0]?.distanceM, endDistanceM: points.at(-1)?.distanceM };
  }).filter((component) => Number.isFinite(component.startDistanceM) && Number.isFinite(component.endDistanceM) && component.endDistanceM! > component.startDistanceM!);
  if (!componentBounds.length || Math.abs(componentBounds.reduce((sum, component) => sum + component.endDistanceM! - component.startDistanceM!, 0) - routeDistanceM) > 0.02) {
    return { available: false, sections: [], labels: new Map(), errors: ["The GPX track segments do not provide continuous measurable route distance."] };
  }

  const definitions: RouteSectionIntervalDefinition[] = [];
  for (let index = 0; index < boundaries.length - 1; index += 1) {
    const from = boundaries[index];
    const to = boundaries[index + 1];
    for (const component of componentBounds) {
      const startDistanceM = Math.max(from.distanceM, component.startDistanceM!);
      const endDistanceM = Math.min(to.distanceM, component.endDistanceM!);
      if (endDistanceM - startDistanceM <= 0.001) continue;
      definitions.push({
        id: `custom-section-${from.id}-${to.id}-component-${component.segmentIndex}`,
        segmentIndex: component.segmentIndex,
        startDistanceM,
        endDistanceM,
        fromLabel: from.name,
        toLabel: to.name,
      });
    }
  }
  const built = buildRouteSectionsFromIntervals(analysis, definitions);
  if (!built || built.sections.length !== definitions.length) {
    return { available: false, sections: [], labels: new Map(), errors: ["Some custom boundaries cannot be placed safely on the smoothed GPX profile."] };
  }
  const sectionDistanceM = built.sections.reduce((sum, section) => sum + section.endPosition.distanceM - section.startPosition.distanceM, 0);
  if (Math.abs(sectionDistanceM - routeDistanceM) > 0.02) {
    return { available: false, sections: [], labels: new Map(), errors: ["Custom sections do not cover the full measured GPX distance."] };
  }
  return { available: true, ...built };
}
