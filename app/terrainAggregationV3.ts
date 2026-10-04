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
  const grouped = new Map<number, typeof data.segments>();
  for (const segment of data.segments) {
    const index = segment.segmentIndex ?? 0;
    const items = grouped.get(index) ?? [];
    items.push(segment);
    grouped.set(index, items);
  }
  const v2s: TerrainAggregationData[] = [...grouped].map(([segmentIndex, segments]) =>
    aggregateTerrainEvidence({ ...data, segments: segments.map((segment) => ({ ...segment, segmentIndex })) }),
  );
  const v2 = v2s[0] ?? aggregateTerrainEvidence({ ...data, segments: [] });
  const sections: TerrainSectionData[] = [];
  const insufficientEvidenceRanges: TerrainEvidenceGap[] = [];

  for (const section of v2s.flatMap((result) => result.sections)) {
    const segmentIndex = section.segmentIndex ?? 0;
    const stableSection = {
      ...section,
      segmentIndex,
      id: segmentIndex === 0 ? section.id : `terrain-segment-${segmentIndex}-${section.id}`,
    };
    if (stableSection.dominantTerrain !== "unknown" && stableSection.availability === "available") {
      sections.push(stableSection);
      continue;
    }
    insufficientEvidenceRanges.push({
      ...stableSection,
      kind: "insufficient-evidence",
      dominantTerrain: "unknown",
      availability: section.availability === "not-found" ? "not-found" : "unknown",
    });
  }

  return {
    ...v2,
    version: 3,
    availability: v2s.some((result) => result.availability === "available") ? "available" : v2s.some((result) => result.availability === "unknown") ? "unknown" : v2.availability,
    evidenceCoverage: weightedCoverage(v2s),
    dominantTerrain: dominantTerrain(v2s),
    supportingTerrainEvidence: mergeSupportingEvidence(v2s),
    changePoints: v2s.flatMap((result, index) => result.changePoints.map((point) => ({ ...point, segmentIndex: [...grouped.keys()][index] ?? 0 }))),
    localWindowKm: v2s.length === 1 ? v2.localWindowKm : 0,
    sections,
    insufficientEvidenceRanges,
  };
}

function weightedCoverage(results: TerrainAggregationData[]) {
  const length = results.reduce((sum, result) => sum + result.sections.reduce((part, section) => part + section.lengthKm, 0), 0);
  return length > 0 ? results.reduce((sum, result) => sum + result.evidenceCoverage * result.sections.reduce((part, section) => part + section.lengthKm, 0), 0) / length : 0;
}

function mergeSupportingEvidence(results: TerrainAggregationData[]) {
  const values = new Map<string, { weight: number; sample: TerrainAggregationData["supportingTerrainEvidence"][number] }>();
  let totalWeight = 0;
  for (const result of results) {
    const evidenceKm = result.sections.reduce((sum, section) => sum + section.lengthKm * section.evidenceCoverage, 0);
    for (const evidence of result.supportingTerrainEvidence) {
      const weight = evidence.evidenceShare * evidenceKm;
      const current = values.get(evidence.category);
      values.set(evidence.category, { weight: (current?.weight ?? 0) + weight, sample: current?.sample ?? evidence });
      totalWeight += weight;
    }
  }
  return [...values.entries()].sort((left, right) => right[1].weight - left[1].weight).map(([category, value]) => ({
    ...value.sample,
    category: category as typeof value.sample.category,
    evidenceShare: totalWeight > 0 ? value.weight / totalWeight : 0,
    rawSurfaceValues: [...new Set(results.flatMap((result) => result.supportingTerrainEvidence.filter((evidence) => evidence.category === category).flatMap((evidence) => evidence.rawSurfaceValues)))].sort(),
    rawEvidenceSegmentIds: [...new Set(results.flatMap((result) => result.supportingTerrainEvidence.filter((evidence) => evidence.category === category).flatMap((evidence) => evidence.rawEvidenceSegmentIds)))],
  }));
}

function dominantTerrain(results: TerrainAggregationData[]): TerrainAggregationData["dominantTerrain"] {
  const supporting = mergeSupportingEvidence(results);
  const leading = supporting[0];
  if (!leading) return "unknown";
  return leading.evidenceShare >= 0.7 ? leading.category : "mixed-trail";
}
