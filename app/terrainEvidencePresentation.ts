import type { TerrainAggregationData, TerrainCategory, TerrainSupportingEvidence } from "./terrainAggregation";

/** Below 20% route coverage, summarize the mapped subset explicitly. This threshold only affects UI wording, not terrain classification. */
export const LOW_TERRAIN_EVIDENCE_COVERAGE = 0.2;

type TerrainSummaryInput = Pick<TerrainAggregationData, "dominantTerrain" | "evidenceCoverage" | "supportingTerrainEvidence">;

export type TerrainSummaryPresentation = {
  limited: boolean;
  heading: string;
  evidenceItems: string[];
  mappedEvidenceText: string | null;
  coverageText: string | null;
};

export function getTerrainSummaryPresentation(summary: TerrainSummaryInput): TerrainSummaryPresentation {
  const limited = summary.evidenceCoverage < LOW_TERRAIN_EVIDENCE_COVERAGE;
  const evidenceItems = summary.supportingTerrainEvidence.map(
    (item) => `${terrainCategoryLabel(item.category)} ${Math.round(item.evidenceShare * 100)}%`,
  );

  return {
    limited,
    heading: limited ? "Limited mapped surface evidence" : terrainCategoryLabel(summary.dominantTerrain),
    evidenceItems,
    mappedEvidenceText: limited && summary.supportingTerrainEvidence.length > 0
      ? `Mapped evidence: ${summary.supportingTerrainEvidence.map(
        (item) => `${terrainCategoryLabel(item.category)} · ${Math.round(item.evidenceShare * 100)}%`,
      ).join(" · ")}`
      : null,
    coverageText: limited ? `Coverage: ${Math.round(summary.evidenceCoverage * 100)}% of route` : null,
  };
}

export function terrainCategoryLabel(category: TerrainCategory | TerrainSupportingEvidence["category"]) {
  const labels: Record<TerrainCategory, string> = {
    paved: "Paved",
    gravel: "Gravel",
    "dirt-ground": "Dirt / ground",
    "rocky-rough": "Rocky / rough",
    "natural-trail": "Unpaved / natural surface",
    "mixed-trail": "Mixed trail",
    unknown: "Unknown",
  };
  return labels[category];
}
