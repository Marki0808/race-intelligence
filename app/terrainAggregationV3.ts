import { aggregateTerrainEvidence } from "./terrainAggregation.ts";
import type { TerrainAggregationData, TerrainSectionData } from "./terrainAggregation.ts";
import type { GeoEnrichmentData } from "./geoEnrichment.ts";

export type TerrainEvidenceGap = Omit<TerrainSectionData, "dominantTerrain"> & {
  kind: "insufficient-evidence";
  dominantTerrain: "unknown";
  availability: "unknown" | "not-found";
};

export type TerrainAggregationV3Data = Omit<TerrainAggregationData, "sections"> & {
  version: 3;
  /** Sections whose terrain is supported by persistent, classifiable OSM surface evidence. */
  sections: TerrainSectionData[];
  /** Unsupported route ranges kept separate from user-facing terrain classifications. */
  insufficientEvidenceRanges: TerrainEvidenceGap[];
};

/**
 * Keeps V2's evidence-driven persistence and smoothing, while separating its unknown regimes
 * from Terrain Sections so sparse retrieval does not look like one continuous terrain type.
 */
export function aggregateTerrainEvidenceV3(data: GeoEnrichmentData): TerrainAggregationV3Data {
  const v2: TerrainAggregationData = aggregateTerrainEvidence(data);
  const sections: TerrainSectionData[] = [];
  const insufficientEvidenceRanges: TerrainEvidenceGap[] = [];

  for (const section of v2.sections) {
    if (section.dominantTerrain !== "unknown" && section.availability === "available") {
      sections.push(section);
      continue;
    }
    insufficientEvidenceRanges.push({
      ...section,
      kind: "insufficient-evidence",
      dominantTerrain: "unknown",
      availability: section.availability === "not-found" ? "not-found" : "unknown",
    });
  }

  return {
    ...v2,
    version: 3,
    sections,
    insufficientEvidenceRanges,
  };
}
