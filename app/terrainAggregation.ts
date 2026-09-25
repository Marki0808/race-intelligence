import type {
  EvidenceAvailability,
  EvidenceProvenance,
  GeoEnrichmentData,
  GeoSegmentEvidence,
} from "./geoEnrichment";

export type TerrainCategory =
  | "paved"
  | "gravel"
  | "dirt-ground"
  | "rocky-rough"
  | "natural-trail"
  | "mixed-trail"
  | "unknown";

export type TerrainSupportingEvidence = {
  category: Exclude<TerrainCategory, "unknown">;
  evidenceShare: number;
  rawSurfaceValues: string[];
  rawEvidenceSegmentIds: string[];
  provenance: "osm";
};

export type TerrainSectionData = {
  id: string;
  startDistanceKm: number;
  endDistanceKm: number;
  lengthKm: number;
  dominantTerrain: TerrainCategory;
  supportingTerrainEvidence: TerrainSupportingEvidence[];
  evidenceCoverage: number;
  provenance: Extract<EvidenceProvenance, "osm-derived">;
  availability: EvidenceAvailability;
  matchQuality: "high" | "moderate" | "unknown";
  rawEvidenceSegmentIds: string[];
};

export type TerrainChangePoint = {
  distanceKm: number;
  before: TerrainCategory;
  after: TerrainCategory;
  support: number;
  confidence: "high" | "moderate" | "unknown";
  decision: "accepted" | "ignored-as-noise";
};

export type TerrainAggregationData = {
  source: GeoEnrichmentData["source"];
  availability: EvidenceAvailability;
  evidenceCoverage: number;
  dominantTerrain: TerrainCategory;
  supportingTerrainEvidence: TerrainSupportingEvidence[];
  localWindowKm: number;
  changePoints: TerrainChangePoint[];
  sections: TerrainSectionData[];
  rawEvidence: GeoEnrichmentData;
};

type EvidenceUnit = {
  segment: GeoSegmentEvidence;
  startKm: number;
  endKm: number;
  spanKm: number;
  category: TerrainCategory;
  coverage: number;
  confidence: number;
};

type LocalRegime = {
  category: TerrainCategory;
  startKm: number;
  endKm: number;
};

type EvidenceSummary = {
  categoryWeights: Map<Exclude<TerrainCategory, "unknown">, number>;
  categoryDetails: Map<Exclude<TerrainCategory, "unknown">, {
    rawSurfaceValues: Set<string>;
    rawIds: Set<string>;
  }>;
  coveredKm: number;
  confidenceWeightedKm: number;
  confidenceSum: number;
};

const LOCAL_DOMINANCE_SHARE = 0.6;
const SECTION_DOMINANCE_SHARE = 0.7;
const PERSISTENCE_SUPPORT_SHARE = 0.7;
const MIN_SECTION_EVIDENCE_COVERAGE = 0.2;

export function aggregateTerrainEvidence(data: GeoEnrichmentData): TerrainAggregationData {
  const units = createEvidenceUnits(data.segments);
  const routeStartKm = units[0]?.startKm ?? 0;
  const routeEndKm = units.at(-1)?.endKm ?? routeStartKm;
  const routeLengthKm = Math.max(0, routeEndKm - routeStartKm);
  const localWindowKm = deriveLocalWindowKm(units, routeLengthKm);
  const { boundaries, changePoints } = detectPersistentChanges(units, routeStartKm, routeEndKm, localWindowKm);
  const regimes = createRegimes(units, boundaries, routeStartKm, routeEndKm);
  const sections = mergeAdjacentSections(
    regimes.map((regime, index) => createTerrainSection(regime, index, units, data)),
  );
  const globalSummary = summarizeEvidence(units, routeStartKm, routeEndKm);
  const routeCoverage = routeLengthKm > 0 ? clamp01(globalSummary.coveredKm / routeLengthKm) : 0;
  const availability = sections.some((section) => section.availability === "available")
    ? "available"
    : sections.some((section) => section.availability === "not-found") || data.availability === "not-found"
      ? "not-found"
      : data.availability;

  return {
    source: data.source,
    availability,
    evidenceCoverage: routeCoverage,
    dominantTerrain: dominantCategory(globalSummary),
    supportingTerrainEvidence: toSupportingEvidence(globalSummary),
    localWindowKm: roundKm(localWindowKm),
    changePoints,
    sections,
    rawEvidence: data,
  };
}

export function classifyOsmSurface(surface: string | null | undefined): TerrainCategory {
  if (!surface?.trim()) return "unknown";
  const rawValues = surface.split(";").map((value) => value.trim().toLowerCase()).filter(Boolean);
  if (rawValues.length === 0) return "unknown";

  const categories = rawValues.map(classifySingleSurface);
  if (categories.some((category) => category === "unknown")) return "unknown";
  const uniqueCategories = [...new Set(categories)];
  return uniqueCategories.length === 1 ? uniqueCategories[0] : "mixed-trail";
}

function createEvidenceUnits(segments: GeoSegmentEvidence[]): EvidenceUnit[] {
  const ordered = [...segments].sort((a, b) => a.startDistanceKm - b.startDistanceKm);
  const routeStartKm = ordered[0]?.startDistanceKm ?? 0;
  const routeEndKm = ordered.at(-1)?.endDistanceKm ?? routeStartKm;

  return ordered.map((segment, index) => {
    const previous = ordered[index - 1];
    const next = ordered[index + 1];
    const startKm = previous
      ? Math.min(segment.startDistanceKm, (previous.endDistanceKm + segment.startDistanceKm) / 2)
      : routeStartKm;
    const endKm = next
      ? Math.max(segment.endDistanceKm, (segment.endDistanceKm + next.startDistanceKm) / 2)
      : routeEndKm;
    const category = segment.surface.availability === "available"
      ? classifyOsmSurface(segment.surface.value)
      : "unknown";
    return {
      segment,
      startKm,
      endKm,
      spanKm: Math.max(0, endKm - startKm),
      category,
      coverage: clamp01(segment.evidenceCoverage),
      confidence: matchConfidence(segment.matchQuality),
    };
  });
}

function deriveLocalWindowKm(units: EvidenceUnit[], routeLengthKm: number) {
  const positiveSpans = units.map((unit) => unit.spanKm).filter((span) => span > 0).sort((a, b) => a - b);
  if (positiveSpans.length === 0 || routeLengthKm <= 0) return 0;
  const medianSpan = positiveSpans[Math.floor(positiveSpans.length / 2)];
  // Use a dyadic evidence scale on each side of a transition. Logarithmic growth
  // adapts to evidence density without letting route length dominate local changes.
  return Math.min(routeLengthKm, 2 * medianSpan * Math.log2(positiveSpans.length + 1));
}

function detectPersistentChanges(
  units: EvidenceUnit[],
  routeStartKm: number,
  routeEndKm: number,
  windowKm: number,
) {
  const candidates: TerrainChangePoint[] = [];
  if (units.length < 2 || windowKm <= 0) return { boundaries: [] as number[], changePoints: candidates };

  for (let index = 1; index < units.length; index += 1) {
    const beforeUnit = units[index - 1];
    const afterUnit = units[index];
    if (beforeUnit.category === afterUnit.category) continue;
    const boundaryKm = (beforeUnit.endKm + afterUnit.startKm) / 2;
    const beforeStart = Math.max(routeStartKm, boundaryKm - windowKm);
    const afterEnd = Math.min(routeEndKm, boundaryKm + windowKm);
    const before = summarizeEvidence(units, beforeStart, boundaryKm);
    const after = summarizeEvidence(units, boundaryKm, afterEnd);
    const beforeWindowKm = boundaryKm - beforeStart;
    const afterWindowKm = afterEnd - boundaryKm;
    const beforeCategory = dominantCategory(before, LOCAL_DOMINANCE_SHARE);
    const afterCategory = dominantCategory(after, LOCAL_DOMINANCE_SHARE);
    const beforeSupport = categoryShare(before, beforeCategory, beforeWindowKm);
    const afterSupport = categoryShare(after, afterCategory, afterWindowKm);
    const support = Math.min(beforeSupport, afterSupport);
    candidates.push({
      distanceKm: roundKm(boundaryKm),
      before: beforeCategory,
      after: afterCategory,
      support: roundShare(support),
      confidence: regimeConfidence(before, after),
      decision: beforeWindowKm >= windowKm * LOCAL_DOMINANCE_SHARE &&
        afterWindowKm >= windowKm * LOCAL_DOMINANCE_SHARE &&
        beforeCategory !== afterCategory && support >= PERSISTENCE_SUPPORT_SHARE
        ? "accepted"
        : "ignored-as-noise",
    });
  }

  const accepted = candidates.filter((candidate) => candidate.decision === "accepted");
  const chosen: TerrainChangePoint[] = [];
  for (const candidate of accepted) {
    const previous = chosen.at(-1);
    if (!previous || candidate.distanceKm - previous.distanceKm >= windowKm) {
      chosen.push(candidate);
      continue;
    }
    if (candidate.support > previous.support) chosen[chosen.length - 1] = candidate;
  }
  const boundaries = chosen.map((candidate) => candidate.distanceKm);
  const kept = candidates.map((candidate) =>
    candidate.decision === "accepted" && !chosen.includes(candidate)
      ? { ...candidate, decision: "ignored-as-noise" as const }
      : candidate,
  );
  return { boundaries, changePoints: kept };
}

function createRegimes(
  units: EvidenceUnit[],
  boundaries: number[],
  routeStartKm: number,
  routeEndKm: number,
): LocalRegime[] {
  if (units.length === 0 || routeEndKm <= routeStartKm) return [];
  const edges = [routeStartKm, ...boundaries, routeEndKm];
  return edges.slice(0, -1).map((startKm, index) => {
    const endKm = edges[index + 1];
    return {
      category: dominantCategory(summarizeEvidence(units, startKm, endKm)),
      startKm,
      endKm,
    };
  });
}

function createTerrainSection(
  regime: LocalRegime,
  index: number,
  units: EvidenceUnit[],
  data: GeoEnrichmentData,
): TerrainSectionData {
  const summary = summarizeEvidence(units, regime.startKm, regime.endKm);
  const terrain = dominantCategory(summary);
  const lengthKm = Math.max(0, regime.endKm - regime.startKm);
  const evidenceCoverage = lengthKm > 0 ? clamp01(summary.coveredKm / lengthKm) : 0;
  const availability: EvidenceAvailability = summary.coveredKm > 0
    ? "available"
    : units.some((unit) => unit.startKm < regime.endKm && unit.endKm > regime.startKm && unit.segment.surface.availability === "not-found") && data.availability !== "unknown"
      ? "not-found"
      : "unknown";
  const matchQuality = summary.coveredKm === 0
    ? "unknown"
    : summary.confidenceSum / summary.coveredKm >= 0.85
      ? "high"
      : "moderate";
  return {
    id: `terrain-section-${index + 1}`,
    startDistanceKm: roundKm(regime.startKm),
    endDistanceKm: roundKm(regime.endKm),
    lengthKm: roundKm(lengthKm),
    dominantTerrain: terrain === "unknown" || evidenceCoverage < MIN_SECTION_EVIDENCE_COVERAGE
      ? "unknown"
      : regime.category,
    supportingTerrainEvidence: toSupportingEvidence(summary),
    evidenceCoverage: roundShare(evidenceCoverage),
    provenance: "osm-derived",
    availability,
    matchQuality,
    rawEvidenceSegmentIds: overlappingUnits(units, regime.startKm, regime.endKm).map((unit) => unit.segment.id),
  };
}

function mergeAdjacentSections(input: TerrainSectionData[]) {
  const merged: TerrainSectionData[] = [];
  for (const section of input) {
    const previous = merged.at(-1);
    if (!previous || previous.dominantTerrain !== section.dominantTerrain) {
      merged.push({ ...section, id: `terrain-section-${merged.length + 1}` });
      continue;
    }
    const combinedLength = previous.lengthKm + section.lengthKm;
    const weightedEvidenceKm = previous.lengthKm * previous.evidenceCoverage + section.lengthKm * section.evidenceCoverage;
    const weights = new Map<TerrainSupportingEvidence["category"], {
      weight: number;
      rawSurfaceValues: Set<string>;
      rawIds: Set<string>;
    }>();
    for (const item of [...previous.supportingTerrainEvidence, ...section.supportingTerrainEvidence]) {
      const baseLength = item.rawEvidenceSegmentIds.every((id) => previous.rawEvidenceSegmentIds.includes(id))
        ? previous.lengthKm * previous.evidenceCoverage
        : section.lengthKm * section.evidenceCoverage;
      const entry = weights.get(item.category) ?? {
        weight: 0,
        rawSurfaceValues: new Set<string>(),
        rawIds: new Set<string>(),
      };
      entry.weight += item.evidenceShare * baseLength;
      item.rawSurfaceValues.forEach((value) => entry.rawSurfaceValues.add(value));
      item.rawEvidenceSegmentIds.forEach((id) => entry.rawIds.add(id));
      weights.set(item.category, entry);
    }
    const totalWeight = [...weights.values()].reduce((sum, item) => sum + item.weight, 0);
    previous.endDistanceKm = section.endDistanceKm;
    previous.lengthKm = roundKm(combinedLength);
    previous.evidenceCoverage = combinedLength > 0 ? roundShare(weightedEvidenceKm / combinedLength) : 0;
    previous.supportingTerrainEvidence = [...weights.entries()]
      .sort((a, b) => b[1].weight - a[1].weight)
      .map(([category, item]) => ({
        category,
        evidenceShare: totalWeight > 0 ? roundShare(item.weight / totalWeight) : 0,
        rawSurfaceValues: [...item.rawSurfaceValues].sort(),
        rawEvidenceSegmentIds: [...item.rawIds],
        provenance: "osm",
      }));
    previous.availability = previous.availability === "available" || section.availability === "available"
      ? "available"
      : previous.availability === "not-found" || section.availability === "not-found"
        ? "not-found"
        : "unknown";
    previous.matchQuality = previous.matchQuality === "unknown"
      ? section.matchQuality
      : section.matchQuality === "unknown"
        ? previous.matchQuality
        : previous.matchQuality === "high" && section.matchQuality === "high"
          ? "high"
          : "moderate";
    previous.rawEvidenceSegmentIds = [...new Set([...previous.rawEvidenceSegmentIds, ...section.rawEvidenceSegmentIds])];
  }
  return merged;
}

function summarizeEvidence(units: EvidenceUnit[], startKm: number, endKm: number): EvidenceSummary {
  const categoryWeights = new Map<Exclude<TerrainCategory, "unknown">, number>();
  const categoryDetails = new Map<Exclude<TerrainCategory, "unknown">, {
    rawSurfaceValues: Set<string>;
    rawIds: Set<string>;
  }>();
  let coveredKm = 0;
  let confidenceWeightedKm = 0;
  let confidenceSum = 0;
  for (const unit of overlappingUnits(units, startKm, endKm)) {
    if (unit.category === "unknown") continue;
    const overlapKm = Math.max(0, Math.min(endKm, unit.endKm) - Math.max(startKm, unit.startKm));
    const supportedKm = overlapKm * unit.coverage;
    if (supportedKm <= 0) continue;
    coveredKm += supportedKm;
    confidenceSum += supportedKm * unit.confidence;
    const weight = supportedKm * unit.confidence;
    confidenceWeightedKm += weight;
    if (weight <= 0) continue;
    categoryWeights.set(unit.category, (categoryWeights.get(unit.category) ?? 0) + weight);
    const details = categoryDetails.get(unit.category) ?? {
      rawSurfaceValues: new Set<string>(),
      rawIds: new Set<string>(),
    };
    for (const value of (unit.segment.surface.value ?? "").split(";").map((item) => item.trim()).filter(Boolean)) {
      details.rawSurfaceValues.add(value);
    }
    details.rawIds.add(unit.segment.id);
    categoryDetails.set(unit.category, details);
  }
  return { categoryWeights, categoryDetails, coveredKm, confidenceWeightedKm, confidenceSum };
}

function overlappingUnits(units: EvidenceUnit[], startKm: number, endKm: number) {
  return units.filter((unit) => unit.startKm < endKm && unit.endKm > startKm);
}

function dominantCategory(
  summary: EvidenceSummary,
  dominanceThreshold = SECTION_DOMINANCE_SHARE,
): TerrainCategory {
  if (summary.confidenceWeightedKm <= 0) return "unknown";
  const sorted = [...summary.categoryWeights.entries()].sort((a, b) => b[1] - a[1]);
  const [category, weight] = sorted[0] ?? [];
  return category && weight / summary.confidenceWeightedKm >= dominanceThreshold
    ? category
    : "mixed-trail";
}

function categoryShare(summary: EvidenceSummary, category: TerrainCategory, windowKm: number) {
  if (category === "unknown") {
    return windowKm > 0 ? clamp01((windowKm - summary.coveredKm) / windowKm) : 0;
  }
  if (category === "mixed-trail") {
    return windowKm > 0 ? clamp01(summary.confidenceWeightedKm / windowKm) : 0;
  }
  return summary.confidenceWeightedKm > 0
    ? (summary.categoryWeights.get(category) ?? 0) / summary.confidenceWeightedKm
    : 0;
}

function toSupportingEvidence(summary: EvidenceSummary): TerrainSupportingEvidence[] {
  return [...summary.categoryWeights.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([category, weight]) => {
      const details = summary.categoryDetails.get(category)!;
      return {
        category,
        evidenceShare: summary.confidenceWeightedKm > 0 ? weight / summary.confidenceWeightedKm : 0,
        rawSurfaceValues: [...details.rawSurfaceValues].sort(),
        rawEvidenceSegmentIds: [...details.rawIds],
        provenance: "osm",
      };
    });
}

function regimeConfidence(before: EvidenceSummary, after: EvidenceSummary): TerrainChangePoint["confidence"] {
  if (before.coveredKm <= 0 || after.coveredKm <= 0) return "unknown";
  return before.confidenceSum / before.coveredKm >= 0.85 && after.confidenceSum / after.coveredKm >= 0.85
    ? "high"
    : "moderate";
}

function classifySingleSurface(surface: string): TerrainCategory {
  if (["asphalt", "concrete", "paved", "paving_stones", "sett", "cobblestone"].includes(surface)) return "paved";
  if (["gravel", "fine_gravel"].includes(surface)) return "gravel";
  if (["dirt", "earth", "ground"].includes(surface)) return "dirt-ground";
  if (["rock", "stone"].includes(surface)) return "rocky-rough";
  if (["unpaved", "grass", "mud", "sand", "woodchips"].includes(surface)) return "natural-trail";
  return "unknown";
}

function matchConfidence(quality: GeoSegmentEvidence["matchQuality"]) {
  if (quality === "high") return 1;
  if (quality === "moderate") return 0.65;
  return 0;
}

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}

function roundKm(value: number) {
  return Number(value.toFixed(2));
}

function roundShare(value: number) {
  return Number(clamp01(value).toFixed(4));
}
