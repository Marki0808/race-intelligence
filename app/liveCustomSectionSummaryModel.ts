import { calculateSectionGradeMetrics, formatSectionGradePercent } from "./sectionGradeMetrics.ts";
import type { RouteSection } from "./routeSectionEngine.ts";
import { routeSectionSelectionKey } from "./routeSectionSelection.ts";
import { formatDistanceMeters, formatElevationMeters, formatRouteDistanceKm, type RouteUnitSystem } from "./routeUnits.ts";

/** Find the custom interval immediately before a newly inserted boundary. */
export function findCustomSectionEndingAtBoundary(
  sections: readonly RouteSection[],
  boundaries: readonly { id: string; distanceKm: string }[],
  boundaryId: string,
): RouteSection | null {
  const ordered = [...boundaries].sort((left, right) => Number(left.distanceKm) - Number(right.distanceKm));
  const index = ordered.findIndex((boundary) => boundary.id === boundaryId);
  if (index < 0) return null;
  const fromId = index === 0 ? "start" : ordered[index - 1].id;
  const candidates = sections.filter((section) => section.id === `custom-section-${fromId}-${boundaryId}-component-${section.segmentIndex}`);
  return candidates.sort((left, right) => right.endPosition.distanceM - left.endPosition.distanceM)[0] ?? null;
}

export function resolveAutomaticSectionSelection(
  sections: readonly RouteSection[],
  previousSelectionKey: string | null,
): { segmentationMode: "terrain"; selectedSectionKey: string | null } {
  return {
    segmentationMode: "terrain",
    selectedSectionKey: previousSelectionKey && sections.some((section) => routeSectionSelectionKey(section) === previousSelectionKey)
      ? previousSelectionKey
      : null,
  };
}

export function shouldReturnToAutomaticAfterEditing(boundaries: readonly unknown[]): boolean {
  return boundaries.length === 0;
}

export type LiveCustomSectionMetric = { label: string; value: string; detail?: string };

/** Presentation uses the same RouteSection and grade model as the detailed section card. */
export function buildLiveCustomSectionMetrics(section: RouteSection, units: RouteUnitSystem): LiveCustomSectionMetric[] {
  const grades = calculateSectionGradeMetrics(section);
  const sectionLengthM = section.endPosition.distanceM - section.startPosition.distanceM;
  const incomplete = grades.status === "unavailable";
  const windowValue = (window: { gradePct: number; startDistanceM: number; endDistanceM: number } | null, direction: "uphill" | "downhill") => {
    if (incomplete) return "Unavailable · incomplete profile";
    if (!window) return sectionLengthM < 100 ? `Section shorter than ${formatDistanceMeters(100, units)}` : `No meaningful ${direction} window`;
    return formatSectionGradePercent(window.gradePct);
  };
  const windowDetail = (window: { startDistanceM: number; endDistanceM: number } | null) => window
    ? `${formatDistanceMeters(window.startDistanceM, units)}–${formatDistanceMeters(window.endDistanceM, units)}`
    : undefined;

  return [
    { label: "Start", value: formatRouteDistanceKm(section.startKm, units, 2) },
    { label: "End", value: formatRouteDistanceKm(section.endKm, units, 2) },
    { label: "Length", value: formatRouteDistanceKm(section.distanceKm, units, 2) },
    { label: "Total ascent", value: `+${formatElevationMeters(section.ascentM, units)}` },
    { label: "Total descent", value: `−${formatElevationMeters(section.descentM, units)}` },
    { label: "Average uphill grade", value: incomplete ? "Unavailable · incomplete profile" : grades.averageUphillGradePct === null ? "No meaningful ascent" : formatSectionGradePercent(grades.averageUphillGradePct) },
    { label: "Average downhill grade", value: incomplete ? "Unavailable · incomplete profile" : grades.averageDownhillGradePct === null ? "No meaningful descent" : formatSectionGradePercent(-grades.averageDownhillGradePct) },
    { label: "Steepest uphill 100 m", value: windowValue(incomplete ? null : grades.steepestUphill100m, "uphill"), detail: incomplete ? undefined : windowDetail(grades.steepestUphill100m) },
    { label: "Steepest downhill 100 m", value: windowValue(incomplete ? null : grades.steepestDownhill100m, "downhill"), detail: incomplete ? undefined : windowDetail(grades.steepestDownhill100m) },
  ];
}
