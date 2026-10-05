import type { MapillarySectionEvidence } from "./mapillaryTerrainProof.ts";
import type { RouteSection, RouteSectionMapPoint } from "./routeSectionEngine.ts";

export function numberRouteSectionsForDisplay<T>(sections: readonly T[]): Array<{ section: T; ordinal: number }> {
  return sections.map((section, index) => ({ section, ordinal: index + 1 }));
}

export function hasRenderableSectionMap(points: readonly Pick<RouteSectionMapPoint, "latitude" | "longitude">[]): boolean {
  return points.length >= 2 && points.every((point) => Number.isFinite(point.latitude) && Number.isFinite(point.longitude));
}

export type SurfaceEvidencePresentation =
  | { status: "not-requested"; message: string }
  | { status: "missing"; message: string }
  | {
      status: "mapped";
      coveragePercent: number;
      coverageLabel: string;
      distributionLabel: string;
      categories: Array<{ label: string; sharePercent: number }>;
    };

export function getSurfaceEvidencePresentation(section: RouteSection, requested: boolean): SurfaceEvidencePresentation {
  if (!requested) return { status: "not-requested", message: "Not checked yet." };
  const coveragePercent = section.terrainEvidenceCoveragePercent ?? 0;
  const evidence = section.terrainEvidence ?? [];
  const exactCoveragePercent = section.terrainEvidenceExactCoveragePercent ?? coveragePercent;
  if (exactCoveragePercent <= 0 || evidence.length === 0) {
    return { status: "missing", message: "No reliable mapped surface evidence for this section." };
  }
  const formattedCoverage = exactCoveragePercent < 1
    ? "<1%"
    : `${Math.round(coveragePercent)}%`;
  return {
    status: "mapped",
    coveragePercent,
    coverageLabel: `Mapped evidence · ${formattedCoverage} of section`,
    distributionLabel: "Surface distribution among mapped evidence",
    categories: evidence.map(({ terrain, evidenceSharePercent }) => ({
      label: terrainLabel(terrain),
      sharePercent: evidenceSharePercent,
    })),
  };
}

export type RouteImageryPresentation =
  | { status: "not-found"; message: string }
  | { status: "unavailable"; message: string }
  | { status: "available"; images: MapillarySectionEvidence["images"] }
  | null;

export function getRouteImageryPresentation(evidence: MapillarySectionEvidence | null): RouteImageryPresentation {
  if (!evidence) return null;
  if (evidence.availability === "available" && evidence.images.length > 0) {
    return { status: "available", images: evidence.images };
  }
  if (evidence.availability === "not-found") {
    return { status: "not-found", message: "No route imagery available for this section." };
  }
  return { status: "unavailable", message: "Route imagery is unavailable right now." };
}

function terrainLabel(value: string) {
  const labels: Record<string, string> = {
    paved: "Paved",
    gravel: "Gravel",
    "dirt-ground": "Dirt / ground",
    "rocky-rough": "Rocky / rough",
    "natural-trail": "Natural trail",
    "mixed-trail": "Mixed trail",
  };
  return labels[value] ?? value;
}
