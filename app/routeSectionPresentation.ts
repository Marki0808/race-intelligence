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
      categories: Array<{ label: string; sharePercent: number; distanceLabel?: string }>;
      unknownLabel?: string;
    };

export type TerrainEvidenceState = "not-requested" | "loading" | "ready" | "unavailable";

export type TerrainFieldPresentation = {
  heading: string;
  coverageLabel: string;
  categories: Array<{ label: string; distanceLabel: string; sharePercent: number }>;
  unknownLabel: string;
  reasons: string[];
};

export type TerrainSectionPresentation =
  | { status: "not-requested" | "loading" | "unavailable" | "unsupported"; message: string }
  | { status: "available"; surface: TerrainFieldPresentation; highway: TerrainFieldPresentation | null; sourceNote: string };

/** Runner-facing view of the V1 contract. It never falls back to legacy category names. */
export function getTerrainSectionPresentation(section: RouteSection, state: TerrainEvidenceState): TerrainSectionPresentation {
  if (state === "not-requested") return { status: state, message: "Mapped terrain has not been checked for this route." };
  if (state === "loading") return { status: state, message: "Checking mapped terrain evidence…" };
  if (state === "unavailable") return { status: state, message: "OpenStreetMap evidence could not be retrieved right now. Route analysis is still available." };
  const terrain = section.terrainIntelligenceV1;
  const sectionLengthM = Math.abs(section.endPosition.distanceM - section.startPosition.distanceM);
  if (!terrain || terrain.schemaVersion !== 1 || terrain.algorithmVersion !== 1 || terrain.sectionId !== section.id || terrain.segmentIndex !== section.segmentIndex ||
    !Number.isFinite(terrain.sectionBounds.lengthM) || Math.abs(terrain.sectionBounds.lengthM - sectionLengthM) > 0.05) {
    return { status: "unsupported", message: "Distance-aware terrain evidence is not available for this analysis." };
  }
  const lengthM = terrain.sectionBounds.lengthM;
  return {
    status: "available",
    surface: presentTerrainField("Mapped surface tags", terrain.fields.surface, lengthM, surfaceLabel),
    highway: terrain.fields.highway.categories.length > 0
      ? presentTerrainField("Mapped way type · separate from surface", terrain.fields.highway, lengthM, highwayLabel)
      : null,
    sourceNote: "OpenStreetMap tags describe mapped records, not current ground conditions. © OpenStreetMap contributors.",
  };
}

function presentTerrainField(
  heading: string,
  field: NonNullable<RouteSection["terrainIntelligenceV1"]>["fields"]["surface"],
  lengthM: number,
  label: (value: string) => string,
): TerrainFieldPresentation {
  const supportedM = field.usableTagCoverage.distanceM ?? 0;
  const supportedPercent = lengthM > 0 ? Math.round(supportedM / lengthM * 1000) / 10 : 0;
  const categories = field.categories.map((item) => ({
    label: label(item.category),
    distanceLabel: `~${formatEvidenceDistance(item.supportedDistanceM)}`,
    sharePercent: lengthM > 0 ? Math.round(item.supportedDistanceM / lengthM * 1000) / 10 : 0,
  }));
  const unknownM = Math.max(0, field.unknownDistanceM);
  const unknownPercent = lengthM > 0 ? Math.round(unknownM / lengthM * 1000) / 10 : 0;
  return {
    heading,
    coverageLabel: `Mapped for approximately ${formatEvidenceDistance(supportedM)} of ${formatEvidenceDistance(lengthM)} section length · ${supportedPercent}%`,
    categories,
    unknownLabel: `Unknown: ~${formatEvidenceDistance(unknownM)} · ${unknownPercent}% of section`,
    reasons: [...new Set(field.unknownReasons.map(({ reason }) => terrainUnknownReasonLabel(reason)))],
  };
}

export function getSurfaceEvidencePresentation(section: RouteSection, requested: boolean): SurfaceEvidencePresentation {
  if (!requested) return { status: "not-requested", message: "Not checked yet." };
  const terrainV1 = section.terrainIntelligenceV1;
  if (terrainV1) {
    const surface = terrainV1.fields.surface;
    const lengthM = terrainV1.sectionBounds.lengthM;
    const supportedM = surface.usableTagCoverage.distanceM ?? 0;
    const unknownM = surface.unknownDistanceM;
    const categoryTotalM = surface.categories.reduce((sum, item) => sum + item.supportedDistanceM, 0);
    if (supportedM <= 0 || surface.categories.length === 0) {
      const reasons = surface.unknownReasons.map(({ reason }) => unknownReasonLabel(reason));
      return {
        status: "missing",
        message: reasons.length
          ? `No mapped surface tags could be assigned. ${[...new Set(reasons)].join("; ")}.`
          : "No mapped surface tags could be assigned to this section.",
      };
    }
    return {
      status: "mapped",
      coveragePercent: lengthM > 0 ? supportedM / lengthM * 100 : 0,
      coverageLabel: `Mapped OSM surface tags · approximately ${formatEvidenceDistance(supportedM)} of ${formatEvidenceDistance(lengthM)}`,
      distributionLabel: "Surface tags among supported distance · approximate",
      categories: surface.categories.map((item) => ({
        label: terrainV1SurfaceLabel(item.category),
        sharePercent: categoryTotalM > 0 ? Math.round(item.supportedDistanceM / categoryTotalM * 100) : 0,
        distanceLabel: `~${formatEvidenceDistance(item.supportedDistanceM)}`,
      })),
      ...(unknownM > 0 ? { unknownLabel: `Surface unknown for approximately ${formatEvidenceDistance(unknownM)} of the section.` } : {}),
    };
  }
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

function formatEvidenceDistance(distanceM: number) {
  return `${(distanceM / 1000).toFixed(2).replace(/0+$/, "").replace(/\.$/, "")} km`;
}

function terrainV1SurfaceLabel(category: string) {
  const labels: Record<string, string> = {
    paved: "Paved",
    gravel: "Gravel",
    "fine-gravel": "Fine gravel",
    dirt: "Dirt",
    earth: "Earth",
    ground: "Ground",
    rock: "Rock",
    stone: "Stone",
    unpaved: "Unpaved",
    grass: "Grass",
    mud: "Mud",
    sand: "Sand",
    woodchips: "Woodchips",
  };
  return labels[category] ?? category;
}

function surfaceLabel(category: string) {
  const labels: Record<string, string> = {
    paved: "Paved", gravel: "Gravel", "fine-gravel": "Fine gravel", dirt: "Dirt",
    earth: "Earth", ground: "Ground", rock: "Rock", stone: "Stone", unpaved: "Unpaved",
    grass: "Grass", mud: "Mud", sand: "Sand", woodchips: "Woodchips",
  };
  return labels[category] ?? "Other mapped surface tag";
}

function highwayLabel(category: string) {
  const labels: Record<string, string> = {
    path: "Path", footway: "Footway", track: "Track", bridleway: "Bridleway", steps: "Steps",
    cycleway: "Cycleway", unclassified: "Unclassified road", residential: "Residential road",
    service: "Service road", tertiary: "Tertiary road", secondary: "Secondary road",
    primary: "Primary road", "living-street": "Living street", pedestrian: "Pedestrian way",
  };
  return labels[category] ?? "Other mapped way type";
}

function terrainUnknownReasonLabel(reason: string) {
  const labels: Record<string, string> = {
    "not-requested": "Some distance was not checked",
    "provider-unavailable": "Map data was unavailable for some distance",
    "no-matching-way": "No nearby mapped way matched some route samples",
    "matched-way-without-tag": "Some matched ways have no surface tag",
    "ambiguous-or-conflicting-match": "Some nearby mapped records conflict",
    "unsupported-tag-value": "Some map tags could not be classified",
    "insufficient-sampling": "Route sampling was too sparse for some distance",
  };
  return labels[reason] ?? "Some distance remains unknown";
}

function unknownReasonLabel(reason: string) {
  const labels: Record<string, string> = {
    "not-requested": "Surface evidence was not requested",
    "provider-unavailable": "OpenStreetMap retrieval was unavailable",
    "no-matching-way": "No nearby OSM way matched the route sample",
    "matched-way-without-tag": "Matched OSM way has no surface tag",
    "ambiguous-or-conflicting-match": "Nearby or persisted OSM evidence conflicts",
    "unsupported-tag-value": "Surface tag value is not classified",
    "insufficient-sampling": "Route sampling does not support an interval estimate",
  };
  return labels[reason] ?? "Surface evidence is unknown";
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
