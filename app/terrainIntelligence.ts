import { TERRAIN_SAMPLE_SUPPORT_RADIUS_M, type GeoEnrichmentData, type GeoMatchSampleEvidence, type GeoSegmentEvidence } from "./geoEnrichment.ts";

export const TERRAIN_INTELLIGENCE_SCHEMA_VERSION = 1;
export const TERRAIN_INTELLIGENCE_ALGORITHM_VERSION = 1;
export const TERRAIN_RECONCILIATION_TOLERANCE_M = 0.05;
export const TERRAIN_MAX_SAMPLE_SUPPORT_RADIUS_M = TERRAIN_SAMPLE_SUPPORT_RADIUS_M;

export type TerrainUnknownReasonV1 =
  | "not-requested"
  | "provider-unavailable"
  | "no-matching-way"
  | "matched-way-without-tag"
  | "ambiguous-or-conflicting-match"
  | "unsupported-tag-value"
  | "insufficient-sampling";

export type TerrainEvidenceIntervalV1 = {
  startDistanceM: number;
  endDistanceM: number;
  status: "supported" | "unknown";
  category: string | null;
  rawValues: string[];
  unknownReason: TerrainUnknownReasonV1 | null;
  matchQuality: "high" | "moderate" | "unknown";
  osmWayIds: string[];
  snapshotIds: string[];
  supportingSamples: Array<{ distanceM: number; nearestWayDistanceM: number | null; status: GeoMatchSampleEvidence["status"] }>;
  sourceEvidence: Array<{ osmWayId: string; rawTags: Record<string, string>; snapshotIds: string[] }>;
};

export type TerrainEvidenceFieldV1 = {
  field: "surface" | "highway";
  usableTagCoverage: TerrainCoverageMetricV1;
  categories: Array<{
    category: string;
    rawValues: string[];
    supportedDistanceM: number;
    sectionSharePercent: number;
    osmWayIds: string[];
    snapshotIds: string[];
    sourceEvidence: Array<{ osmWayId: string; rawTags: Record<string, string>; snapshotIds: string[] }>;
  }>;
  unknownDistanceM: number;
  unknownReasons: Array<{ reason: TerrainUnknownReasonV1; distanceM: number }>;
  intervals: TerrainEvidenceIntervalV1[];
};

export type TerrainCoverageMetricV1 = {
  distanceM: number | null;
  sectionSharePercent: number | null;
};

export type TerrainSectionIntelligenceV1 = {
  schemaVersion: 1;
  algorithmVersion: 1;
  sectionId: string;
  segmentIndex: number;
  componentBounds: { startDistanceM: number; endDistanceM: number };
  sectionBounds: { startDistanceM: number; endDistanceM: number; lengthM: number };
  attribution: {
    method: "bounded-gpx-sample-cells-v1";
    approximate: true;
    maximumSampleSupportRadiusM: 50;
    reconciliationToleranceM: 0.05;
    source: "OpenStreetMap";
    sourceAttribution: "© OpenStreetMap contributors";
  };
  retrievalCoverage: TerrainCoverageMetricV1;
  routeMatchCoverage: TerrainCoverageMetricV1;
  ambiguousMatchCoverage: TerrainCoverageMetricV1;
  fields: { surface: TerrainEvidenceFieldV1; highway: TerrainEvidenceFieldV1 };
};

type TerrainSectionInput = {
  id: string;
  segmentIndex: number;
  startPosition: { distanceM: number; segmentIndex: number };
  endPosition: { distanceM: number; segmentIndex: number };
};

type SampleCandidate = {
  sample: GeoMatchSampleEvidence;
  segment: GeoSegmentEvidence;
  startM: number;
  endM: number;
};

type AtomicInterval = {
  startM: number;
  endM: number;
  status: "supported" | "unknown";
  category: string | null;
  rawValues: string[];
  unknownReason: TerrainUnknownReasonV1 | null;
  matchQuality: "high" | "moderate" | "unknown";
  osmWayIds: string[];
  snapshotIds: string[];
  supportingSamples: Array<{ distanceM: number; nearestWayDistanceM: number | null; status: GeoMatchSampleEvidence["status"] }>;
  sourceEvidence: Array<{ osmWayId: string; rawTags: Record<string, string>; snapshotIds: string[] }>;
};

/**
 * Creates a separate evidence contract for already-existing Route Sections.
 * It never influences section boundaries. Distance support is a conservative,
 * explicitly approximate Voronoi cell around each matched GPX sample, capped
 * to 50 m on either side; larger sampling gaps remain unknown.
 */
export function buildTerrainIntelligenceV1<T extends TerrainSectionInput>(
  sections: readonly T[],
  data: GeoEnrichmentData | null,
): Array<T & { terrainIntelligenceV1: TerrainSectionIntelligenceV1 }> {
  const componentOrigins = new Map<number, number>();
  const componentEnds = new Map<number, number>();
  const sectionKeys = new Set<string>();
  for (const section of sections) {
    if (!section.id || !Number.isInteger(section.segmentIndex) ||
      section.startPosition.segmentIndex !== section.segmentIndex || section.endPosition.segmentIndex !== section.segmentIndex ||
      !Number.isFinite(section.startPosition.distanceM) || !Number.isFinite(section.endPosition.distanceM)) {
      throw new Error("Terrain evidence requires finite Route Section bounds within one GPX component.");
    }
    const key = `${section.segmentIndex}:${section.id}`;
    if (sectionKeys.has(key)) throw new Error("Terrain evidence requires unique Route Section IDs within each GPX component.");
    sectionKeys.add(key);
    const current = componentOrigins.get(section.segmentIndex);
    const sectionStart = Math.min(section.startPosition.distanceM, section.endPosition.distanceM);
    const sectionEnd = Math.max(section.startPosition.distanceM, section.endPosition.distanceM);
    componentOrigins.set(section.segmentIndex, current === undefined ? sectionStart : Math.min(current, sectionStart));
    componentEnds.set(section.segmentIndex, Math.max(componentEnds.get(section.segmentIndex) ?? sectionEnd, sectionEnd));
  }

  return sections.map((section) => {
    const componentStartM = componentOrigins.get(section.segmentIndex) ?? section.startPosition.distanceM;
    const sectionStartM = Math.min(section.startPosition.distanceM, section.endPosition.distanceM);
    const sectionEndM = Math.max(section.startPosition.distanceM, section.endPosition.distanceM);
    const lengthM = sectionEndM - sectionStartM;
    const samples = collectCandidates(data, section.segmentIndex);
    const retrieval = calculateRetrievalCoverage(data, section.segmentIndex, sectionStartM, sectionEndM, lengthM);
    const routeMatch = calculateSampleCoverage(samples, sectionStartM, sectionEndM, lengthM, ["matched", "ambiguous"]);
    const ambiguousMatch = calculateSampleCoverage(samples, sectionStartM, sectionEndM, lengthM, ["ambiguous"]);
    const surface = buildField("surface", samples, data, section.segmentIndex, sectionStartM, sectionEndM, componentStartM, lengthM);
    const highway = buildField("highway", samples, data, section.segmentIndex, sectionStartM, sectionEndM, componentStartM, lengthM);
    return {
      ...section,
      terrainIntelligenceV1: {
        schemaVersion: 1,
        algorithmVersion: 1,
        sectionId: section.id,
        segmentIndex: section.segmentIndex,
        componentBounds: {
          startDistanceM: 0,
          endDistanceM: Math.max(0, (componentEnds.get(section.segmentIndex) ?? sectionEndM) - componentStartM),
        },
        sectionBounds: { startDistanceM: sectionStartM - componentStartM, endDistanceM: sectionEndM - componentStartM, lengthM },
        attribution: {
          method: "bounded-gpx-sample-cells-v1",
          approximate: true,
          maximumSampleSupportRadiusM: TERRAIN_MAX_SAMPLE_SUPPORT_RADIUS_M,
          reconciliationToleranceM: TERRAIN_RECONCILIATION_TOLERANCE_M,
          source: "OpenStreetMap",
          sourceAttribution: "© OpenStreetMap contributors",
        },
        retrievalCoverage: retrieval,
        routeMatchCoverage: routeMatch,
        ambiguousMatchCoverage: ambiguousMatch,
        fields: { surface, highway },
      },
    };
  });
}

function collectCandidates(data: GeoEnrichmentData | null, segmentIndex: number): SampleCandidate[] {
  if (!data) return [];
  return data.segments.flatMap((segment) => (segment.sampleEvidence ?? [])
    .filter((sample) => sample.segmentIndex === segmentIndex)
    .map((sample) => ({
      sample,
      segment,
      // Point cells are the bounded attribution evidence. Legacy segment bounds
      // describe sampled point centers and must not truncate a cell to zero width.
      startM: sample.supportStartDistanceM,
      endM: sample.supportEndDistanceM,
    }))
    .filter((candidate) => candidate.endM > candidate.startM));
}

function buildField(
  field: "surface" | "highway",
  samples: SampleCandidate[],
  data: GeoEnrichmentData | null,
  segmentIndex: number,
  startM: number,
  endM: number,
  componentStartM: number,
  lengthM: number,
): TerrainEvidenceFieldV1 {
  const relevant = samples.filter((candidate) => candidate.sample.segmentIndex === segmentIndex && candidate.startM < endM && candidate.endM > startM);
  const conflictRanges = (data?.conflicts ?? []).filter((conflict) => conflict.segmentIndex === segmentIndex && (conflict.field ?? "surface") === field)
    .map((conflict) => ({ startM: conflict.startDistanceKm * 1000, endM: conflict.endDistanceKm * 1000,
      snapshotIds: [...new Set([conflict.selectedSnapshotId, ...conflict.alternatives.map((item) => item.snapshotId)])].sort(),
      rawValues: [...new Set(conflict.alternatives.map((item) => item.value).filter((value): value is string => Boolean(value)))].sort(),
      sourceEvidence: mergeSourceEvidence([], conflict.alternatives.flatMap((item) => item.sourceWays.map((way) => ({
        osmWayId: way.osmWayId, rawTags: { ...way.rawTags }, snapshotIds: [item.snapshotId],
      })))) }));
  const retrieval = data?.retrieval;
  const boundaries = new Set([startM, endM]);
  for (const candidate of relevant) {
    boundaries.add(Math.max(startM, candidate.startM));
    boundaries.add(Math.min(endM, candidate.endM));
  }
  const retrievalRanges = [...(retrieval?.retrievedRanges ?? []), ...(retrieval?.unavailableRanges ?? [])]
    .filter((range) => (range.segmentIndex ?? 0) === segmentIndex)
    .map((range) => ({ startM: range.startDistanceKm * 1000, endM: range.endDistanceKm * 1000 }));
  for (const range of [...retrievalRanges, ...conflictRanges]) {
    const left = Math.max(startM, range.startM);
    const right = Math.min(endM, range.endM);
    if (right > left) { boundaries.add(left); boundaries.add(right); }
  }
  const ordered = [...boundaries].sort((a, b) => a - b);
  const intervals: AtomicInterval[] = [];
  for (let index = 0; index < ordered.length - 1; index += 1) {
    const left = ordered[index];
    const right = ordered[index + 1];
    if (right <= left) continue;
    const active = relevant.filter((candidate) => candidate.startM < right && candidate.endM > left);
    const activeConflicts = conflictRanges.filter((range) => range.startM < right && range.endM > left);
    const conflict = activeConflicts.length > 0;
    const values = active.map((candidate) => classifySample(field, candidate)).filter(Boolean) as AtomicInterval[];
    const interval = resolveAtomicInterval(field, left, right, active, values, conflict, data, segmentIndex,
      unique([...active.flatMap((candidate) => candidate.segment.sourceSnapshotIds ?? []), ...activeConflicts.flatMap((range) => range.snapshotIds)]).sort(),
      unique([...values.flatMap((value) => value.rawValues), ...activeConflicts.flatMap((range) => range.rawValues)]).sort(),
      mergeSourceEvidence([], activeConflicts.flatMap((range) => range.sourceEvidence)));
    const previous = intervals.at(-1);
    if (previous && previous.endM === interval.startM && sameIntervalMeaning(previous, interval)) {
      previous.endM = interval.endM;
      previous.osmWayIds = unique([...previous.osmWayIds, ...interval.osmWayIds]);
      previous.snapshotIds = unique([...previous.snapshotIds, ...interval.snapshotIds]);
      previous.supportingSamples = [...new Map([...previous.supportingSamples, ...interval.supportingSamples].map((sample) => [sample.distanceM, sample])).values()]
        .sort((left, right) => left.distanceM - right.distanceM);
      previous.sourceEvidence = mergeSourceEvidence(previous.sourceEvidence, interval.sourceEvidence);
    } else intervals.push(interval);
  }

  const categoryMap = new Map<string, { distanceM: number; rawValues: Set<string>; wayIds: Set<string>; snapshotIds: Set<string>; sourceEvidence: Array<{ osmWayId: string; rawTags: Record<string, string>; snapshotIds: string[] }> }>();
  const reasonMap = new Map<TerrainUnknownReasonV1, number>();
  let usableM = 0;
  let unknownM = 0;
  for (const interval of intervals) {
    const distanceM = interval.endM - interval.startM;
    if (interval.status === "supported" && interval.category) {
      usableM += distanceM;
      const current = categoryMap.get(interval.category) ?? { distanceM: 0, rawValues: new Set<string>(), wayIds: new Set<string>(), snapshotIds: new Set<string>(), sourceEvidence: [] };
      current.distanceM += distanceM;
      interval.rawValues.forEach((value) => current.rawValues.add(value));
      interval.osmWayIds.forEach((value) => current.wayIds.add(value));
      interval.snapshotIds.forEach((value) => current.snapshotIds.add(value));
      current.sourceEvidence = mergeSourceEvidence(current.sourceEvidence, interval.sourceEvidence);
      categoryMap.set(interval.category, current);
    } else {
      unknownM += distanceM;
      const reason = interval.unknownReason ?? "insufficient-sampling";
      reasonMap.set(reason, (reasonMap.get(reason) ?? 0) + distanceM);
    }
  }
  const categories = [...categoryMap.entries()].sort((a, b) => b[1].distanceM - a[1].distanceM || a[0].localeCompare(b[0])).map(([category, item]) => ({
    category,
    rawValues: [...item.rawValues].sort(),
    supportedDistanceM: item.distanceM,
    sectionSharePercent: lengthM > 0 ? item.distanceM / lengthM * 100 : 0,
    osmWayIds: [...item.wayIds].sort(),
    snapshotIds: [...item.snapshotIds].sort(),
    sourceEvidence: item.sourceEvidence,
  }));
  const reconciledUnknown = Math.max(0, lengthM - usableM);
  if (Math.abs(reconciledUnknown - unknownM) > TERRAIN_RECONCILIATION_TOLERANCE_M && intervals.length > 0) {
    throw new Error(`Terrain ${field} evidence did not reconcile to its Route Section bounds.`);
  }
  if (!data) {
    unknownM = lengthM;
    reasonMap.clear();
    if (lengthM > 0) reasonMap.set("not-requested", lengthM);
  }
  return {
    field,
    usableTagCoverage: { distanceM: usableM, sectionSharePercent: lengthM > 0 ? usableM / lengthM * 100 : 0 },
    categories,
    unknownDistanceM: unknownM,
    unknownReasons: [...reasonMap.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([reason, distanceM]) => ({ reason, distanceM })),
    intervals: (!data && lengthM > 0 ? [unknownInterval(startM, endM, "not-requested", [], [])] : intervals).map((interval) => ({
      startDistanceM: interval.startM - componentStartM,
      endDistanceM: interval.endM - componentStartM,
      status: interval.status,
      category: interval.category,
      rawValues: interval.rawValues,
      unknownReason: interval.unknownReason,
      matchQuality: interval.matchQuality,
      osmWayIds: interval.osmWayIds,
      snapshotIds: interval.snapshotIds,
      supportingSamples: interval.supportingSamples.map((sample) => ({ ...sample, distanceM: sample.distanceM - componentStartM })),
      sourceEvidence: interval.sourceEvidence,
    })),
  };
}

function classifySample(field: "surface" | "highway", candidate: SampleCandidate): AtomicInterval | null {
  const sample = candidate.sample;
  const wayIds = [...sample.wayIds];
  const snapshotIds = [...(candidate.segment.sourceSnapshotIds ?? [])];
  const base = {
    startM: candidate.startM, endM: candidate.endM, category: null as string | null,
    rawValues: [] as string[], unknownReason: null as TerrainUnknownReasonV1 | null,
    matchQuality: sample.nearestDistanceM !== null && sample.nearestDistanceM <= 20 ? "high" as const : "moderate" as const,
    osmWayIds: wayIds, snapshotIds,
    supportingSamples: [{ distanceM: sample.distanceM, nearestWayDistanceM: sample.nearestDistanceM, status: sample.status }],
    sourceEvidence: sample.sourceWays.map((way) => ({ osmWayId: way.sourceId, rawTags: { ...way.tags }, snapshotIds })),
  };
  if (sample.status === "ambiguous") return { ...base, status: "unknown", unknownReason: "ambiguous-or-conflicting-match", matchQuality: "unknown" };
  if (sample.status === "no-match") return { ...base, status: "unknown", unknownReason: "no-matching-way", matchQuality: "unknown" };
  const raw = sample.tags[field]?.trim().toLowerCase() ?? "";
  if (!raw) return { ...base, status: "unknown", unknownReason: "matched-way-without-tag" };
  const category = field === "surface" ? surfaceCategory(raw) : highwayCategory(raw);
  if (!category) return { ...base, status: "unknown", unknownReason: "unsupported-tag-value", rawValues: [raw] };
  return { ...base, status: "supported", category, rawValues: [raw] };
}

function resolveAtomicInterval(
  field: "surface" | "highway", left: number, right: number,
  active: SampleCandidate[], values: AtomicInterval[], conflict: boolean,
  data: GeoEnrichmentData | null, segmentIndex: number, conflictSnapshotIds: string[],
  conflictRawValues: string[],
  conflictSourceEvidence: AtomicInterval["sourceEvidence"],
): AtomicInterval {
  const wayIds = unique(active.flatMap((candidate) => candidate.sample.wayIds)).sort();
  const snapshotIds = unique(active.flatMap((candidate) => candidate.segment.sourceSnapshotIds ?? [])).sort();
  const sourceEvidence = mergeSourceEvidence(active.flatMap((candidate) => candidate.sample.sourceWays.map((way) => ({
    osmWayId: way.sourceId, rawTags: { ...way.tags }, snapshotIds: candidate.segment.sourceSnapshotIds ?? [],
  }))), conflictSourceEvidence);
  const supportingSamples = [...new Map(active.map((candidate) => [candidate.sample.distanceM, {
    distanceM: candidate.sample.distanceM,
    nearestWayDistanceM: candidate.sample.nearestDistanceM,
    status: candidate.sample.status,
  }])).values()].sort((left, right) => left.distanceM - right.distanceM);
  if (!data) return unknownInterval(left, right, "not-requested", [], [], []);
  if (!data.retrieval && data.availability === "unknown" && data.segments.length === 0) {
    return unknownInterval(left, right, "provider-unavailable", [], [], []);
  }
  if (data.retrieval) {
    const unavailable = data.retrieval.unavailableRanges.some((range) => (range.segmentIndex ?? 0) === segmentIndex &&
      range.startDistanceKm * 1000 < right && range.endDistanceKm * 1000 > left);
    if (unavailable) return unknownInterval(left, right, "provider-unavailable", [], [], []);
    const wasRetrieved = data.retrieval.retrievedRanges.some((range) => (range.segmentIndex ?? 0) === segmentIndex &&
      range.startDistanceKm * 1000 <= left && range.endDistanceKm * 1000 >= right);
    if (!wasRetrieved) return unknownInterval(left, right, "not-requested", [], [], []);
  }
  if (conflict) return { ...unknownInterval(left, right, "ambiguous-or-conflicting-match", unique([...wayIds, ...conflictSourceEvidence.map((item) => item.osmWayId)]).sort(), unique([...snapshotIds, ...conflictSnapshotIds]).sort(), sourceEvidence, conflictRawValues), supportingSamples };
  const distinct = new Map(values.map((value) => [`${value.status}|${value.category ?? ""}|${value.unknownReason ?? ""}|${value.rawValues.join(";")}`, value]));
  if (distinct.size > 1) return { ...unknownInterval(left, right, "ambiguous-or-conflicting-match", wayIds, snapshotIds, sourceEvidence,
    unique(values.flatMap((value) => value.rawValues)).sort()), supportingSamples };
  const chosen = [...distinct.values()][0];
  if (chosen) return {
    ...chosen,
    startM: left,
    endM: right,
    rawValues: unique(values.flatMap((value) => value.rawValues)).sort(),
    osmWayIds: wayIds,
    snapshotIds: unique([...snapshotIds, ...conflictSnapshotIds]).sort(),
    supportingSamples,
    sourceEvidence,
  };
  return { ...unknownInterval(left, right, "insufficient-sampling", wayIds, snapshotIds, sourceEvidence), supportingSamples };
}

function unknownInterval(startM: number, endM: number, reason: TerrainUnknownReasonV1, osmWayIds: string[], snapshotIds: string[], sourceEvidence: AtomicInterval["sourceEvidence"] = [], rawValues: string[] = []): AtomicInterval {
  return { startM, endM, status: "unknown", category: null, rawValues, unknownReason: reason, matchQuality: "unknown", osmWayIds, snapshotIds, supportingSamples: [], sourceEvidence };
}

function calculateRetrievalCoverage(data: GeoEnrichmentData | null, segmentIndex: number, startM: number, endM: number, lengthM: number): TerrainCoverageMetricV1 {
  if (!data?.retrieval) return { distanceM: null, sectionSharePercent: null };
  const ranges = data.retrieval.retrievedRanges.filter((range) => (range.segmentIndex ?? 0) === segmentIndex);
  const distanceM = unionLength(ranges.map((range) => [Math.max(startM, range.startDistanceKm * 1000), Math.min(endM, range.endDistanceKm * 1000)] as const));
  return { distanceM, sectionSharePercent: lengthM > 0 ? distanceM / lengthM * 100 : 0 };
}

function calculateSampleCoverage(samples: SampleCandidate[], startM: number, endM: number, lengthM: number, statuses: Array<"matched" | "ambiguous" | "no-match">): TerrainCoverageMetricV1 {
  const ranges = samples.filter((candidate) => statuses.includes(candidate.sample.status)).map((candidate) => [Math.max(startM, candidate.startM), Math.min(endM, candidate.endM)] as const);
  const distanceM = unionLength(ranges);
  return { distanceM, sectionSharePercent: lengthM > 0 ? distanceM / lengthM * 100 : 0 };
}

function unionLength(ranges: ReadonlyArray<readonly [number, number]>) {
  const sorted = ranges.filter(([start, end]) => end > start).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let total = 0;
  let current: [number, number] | null = null;
  for (const [start, end] of sorted) {
    if (!current || start > current[1]) {
      if (current) total += current[1] - current[0];
      current = [start, end];
    } else current[1] = Math.max(current[1], end);
  }
  if (current) total += current[1] - current[0];
  return total;
}

function sameIntervalMeaning(left: AtomicInterval, right: AtomicInterval) {
  return left.status === right.status && left.category === right.category && left.unknownReason === right.unknownReason &&
    left.rawValues.join("|") === right.rawValues.join("|") && left.matchQuality === right.matchQuality;
}

function mergeSourceEvidence(
  left: AtomicInterval["sourceEvidence"],
  right: AtomicInterval["sourceEvidence"],
): AtomicInterval["sourceEvidence"] {
  const byId = new Map<string, AtomicInterval["sourceEvidence"][number]>();
  for (const item of [...left, ...right]) {
    const current = byId.get(item.osmWayId);
    byId.set(item.osmWayId, {
      osmWayId: item.osmWayId,
      rawTags: current && JSON.stringify(current.rawTags) !== JSON.stringify(item.rawTags)
        ? { ...current.rawTags, ...item.rawTags }
        : item.rawTags,
      snapshotIds: unique([...(current?.snapshotIds ?? []), ...item.snapshotIds]).sort(),
    });
  }
  return [...byId.values()].sort((a, b) => a.osmWayId.localeCompare(b.osmWayId));
}

function unique(values: string[]) { return [...new Set(values)]; }

function surfaceCategory(value: string): string | null {
  if (["asphalt", "concrete", "paved", "paving_stones", "sett", "cobblestone"].includes(value)) return "paved";
  if (value === "gravel") return "gravel";
  if (value === "fine_gravel") return "fine-gravel";
  if (["dirt", "earth", "ground", "rock", "stone", "unpaved", "grass", "mud", "sand", "woodchips"].includes(value)) return value.replaceAll("_", "-");
  return null;
}

const HIGHWAY_TYPES = new Set(["path", "footway", "track", "bridleway", "steps", "cycleway", "unclassified", "residential", "service", "tertiary", "secondary", "primary", "living_street", "pedestrian"]);
function highwayCategory(value: string) { return HIGHWAY_TYPES.has(value) ? value.replaceAll("_", "-") : null; }
