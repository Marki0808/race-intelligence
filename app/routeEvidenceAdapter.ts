import type { GeoEnrichmentData } from "./geoEnrichment.ts";
import { aggregateTerrainEvidenceV3 } from "./terrainAggregationV3.ts";
import type { RouteSection, RouteSectionTerrainEvidence } from "./routeSectionEngine.ts";

/** Attaches existing OSM summaries by overlap; terrain boundaries never alter Route Sections. */
export function attachTerrainEvidenceToRouteSections(
  sections: readonly RouteSection[],
  data: GeoEnrichmentData,
): RouteSection[] {
  const aggregation = aggregateTerrainEvidenceV3(data);
  return sections.map((section) => {
    const sectionLength = Math.max(0.001, section.endKm - section.startKm);
    const weights = new Map<string, { weight: number; provenance: "osm" }>();
    let classifiableKm = 0;
    for (const terrain of aggregation.sections) {
      const overlapKm = Math.max(0, Math.min(section.endKm, terrain.endDistanceKm) - Math.max(section.startKm, terrain.startDistanceKm));
      if (!overlapKm) continue;
      const supportedKm = overlapKm * terrain.evidenceCoverage;
      classifiableKm += supportedKm;
      for (const item of terrain.supportingTerrainEvidence) {
        const weight = supportedKm * item.evidenceShare;
        const key = item.category;
        const current = weights.get(key) ?? { weight: 0, provenance: "osm" as const };
        current.weight += weight;
        weights.set(key, current);
      }
    }
    const terrainEvidence: RouteSectionTerrainEvidence[] = [...weights.entries()]
      .sort((a, b) => b[1].weight - a[1].weight)
      .map(([terrain, value]) => ({
        terrain,
        coveragePercent: Math.round((value.weight / sectionLength) * 100),
        provenance: value.provenance,
      }));
    if (!terrainEvidence.length && classifiableKm > 0) {
      const coveredTerrain = aggregation.sections.find((terrain) => terrain.endDistanceKm > section.startKm && terrain.startDistanceKm < section.endKm);
      if (coveredTerrain && coveredTerrain.dominantTerrain !== "unknown") {
        terrainEvidence.push({ terrain: coveredTerrain.dominantTerrain, coveragePercent: Math.round((classifiableKm / sectionLength) * 100), provenance: "osm" });
      }
    }
    return { ...section, terrainEvidence };
  });
}
