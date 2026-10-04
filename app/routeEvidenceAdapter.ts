import type { GeoEnrichmentData } from "./geoEnrichment.ts";
import { aggregateTerrainEvidenceV3 } from "./terrainAggregationV3.ts";
import type { TerrainCategory } from "./terrainAggregation.ts";
import type { RouteSection, RouteSectionTerrainEvidence } from "./routeSectionEngine.ts";

type ClassifiableEvidenceBand = {
  startKm: number;
  endKm: number;
  coverage: number;
  matchConfidence: number;
  category: TerrainCategory;
  evidenceShare: number;
};

/** Attaches classified OSM evidence by clipped route-distance overlap; evidence never sets section boundaries. */
export function attachTerrainEvidenceToRouteSections(
  sections: readonly RouteSection[],
  data: GeoEnrichmentData,
): RouteSection[] {
  const aggregation = aggregateTerrainEvidenceV3(data);
  const evidenceBands = createClassifiableEvidenceBands(aggregation);
  return sections.map((section) => {
    const sectionLengthKm = Math.max(0, section.endKm - section.startKm);
    const boundaries = [...new Set([
      section.startKm,
      section.endKm,
      ...evidenceBands.flatMap((band) => [
        Math.max(section.startKm, band.startKm),
        Math.min(section.endKm, band.endKm),
      ]).filter((distanceKm) => distanceKm > section.startKm && distanceKm < section.endKm),
    ])].sort((left, right) => left - right);
    const categoryWeights = new Map<TerrainCategory, number>();
    let classifiableKm = 0;

    for (let index = 0; index < boundaries.length - 1; index += 1) {
      const startKm = boundaries[index];
      const endKm = boundaries[index + 1];
      const overlapKm = endKm - startKm;
      if (overlapKm <= 0) continue;
      const activeBands = evidenceBands.filter((band) => band.startKm < endKm && band.endKm > startKm);
      if (!activeBands.length) continue;

      // Distinct upstream ranges can overlap. Use the best mapped-distance coverage for each
      // atomic interval once, and combine overlapping categories by their relative support.
      const mappedCoverage = Math.max(...activeBands.map((band) => band.coverage));
      const uniqueClassifiableKm = overlapKm * mappedCoverage;
      classifiableKm += uniqueClassifiableKm;
      const categorySupport = new Map<TerrainCategory, number>();
      for (const band of activeBands) {
        const support = band.evidenceShare * band.matchConfidence;
        categorySupport.set(band.category, Math.max(categorySupport.get(band.category) ?? 0, support));
      }
      const totalSupport = [...categorySupport.values()].reduce((sum, value) => sum + value, 0);
      if (totalSupport <= 0) continue;
      for (const [category, support] of categorySupport) {
        categoryWeights.set(category, (categoryWeights.get(category) ?? 0) + uniqueClassifiableKm * support / totalSupport);
      }
    }

    const totalCategoryWeight = [...categoryWeights.values()].reduce((sum, value) => sum + value, 0);
    const terrainEvidence: RouteSectionTerrainEvidence[] = [...categoryWeights.entries()]
      .sort((left, right) => right[1] - left[1])
      .map(([terrain, weight]) => ({
        terrain,
        evidenceSharePercent: totalCategoryWeight > 0 ? Math.round(weight / totalCategoryWeight * 100) : 0,
        provenance: "osm",
      }));

    const terrainEvidenceExactCoveragePercent = sectionLengthKm > 0
      ? classifiableKm / sectionLengthKm * 100
      : 0;
    return {
      ...section,
      terrainEvidenceCoveragePercent: Math.round(terrainEvidenceExactCoveragePercent),
      terrainEvidenceExactCoveragePercent,
      terrainEvidence,
    };
  });
}

function createClassifiableEvidenceBands(aggregation: ReturnType<typeof aggregateTerrainEvidenceV3>): ClassifiableEvidenceBand[] {
  const classifiedIds = new Map<string, Map<TerrainCategory, number>>();
  for (const range of [...aggregation.sections, ...aggregation.insufficientEvidenceRanges]) {
    for (const evidence of range.supportingTerrainEvidence) {
      for (const id of evidence.rawEvidenceSegmentIds) {
        const categories = classifiedIds.get(id) ?? new Map<TerrainCategory, number>();
        categories.set(evidence.category, Math.max(categories.get(evidence.category) ?? 0, evidence.evidenceShare));
        classifiedIds.set(id, categories);
      }
    }
  }

  const segmentsById = new Map(aggregation.rawEvidence.segments.map((segment) => [segment.id, segment]));
  const bands: ClassifiableEvidenceBand[] = [];
  for (const [id, categories] of classifiedIds) {
    const segment = segmentsById.get(id);
    if (!segment || segment.surface.availability !== "available" || segment.endDistanceKm <= segment.startDistanceKm) continue;
    const coverage = clamp01(segment.evidenceCoverage);
    const matchConfidence = segment.matchQuality === "high" ? 1 : segment.matchQuality === "moderate" ? 0.65 : 0;
    if (coverage <= 0 || matchConfidence <= 0) continue;
    for (const [category, evidenceShare] of categories) {
      bands.push({
        startKm: segment.startDistanceKm,
        endKm: segment.endDistanceKm,
        coverage,
        matchConfidence,
        category,
        evidenceShare,
      });
    }
  }
  return bands;
}

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}
