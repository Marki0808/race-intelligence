import type { GeoDistanceRange, GeoEnrichmentData, GeoRetrievalFailureCounts, GeoSegmentEvidence } from "./geoEnrichment.ts";
import type { RouteAnalysisData } from "./gpxAnalysis.ts";
import type { MapillarySectionEvidence, MapillaryTerrainProofData } from "./mapillaryTerrainProof.ts";
import type { RouteSection } from "./routeSectionEngine.ts";
import type { RouteFingerprintResult } from "./routeFingerprint.ts";
import { ROUTE_FINGERPRINT_VERSION } from "./routeFingerprint.ts";

export const ROUTE_ANALYSIS_VERSION = 2;
export const OSM_ENRICHMENT_VERSION = 1;
export const MAPILLARY_ENRICHMENT_VERSION = 1;
// Bump analysis independently from route identity; OSM and Mapillary formats have separate lifecycles.
export const ROUTE_DATABASE_NAME = "race-intelligence-route-cache";
export const ROUTE_DATABASE_VERSION = 2;

export type RaceEditionRouteReference = {
  raceId: string;
  raceName: string;
  year: number;
  routeFingerprint: string;
  routeFingerprintVersion: number;
  createdAt: number;
};

export type PersistedRouteRecord = {
  routeFingerprint: string;
  routeFingerprintVersion: number;
  normalizedGeometry: RouteFingerprintResult["normalizedGeometrySegments"];
  normalizedDistanceKm: number;
  totalDistanceKm: number;
  representativePointCount: number;
  createdAt: number;
  updatedAt: number;
};

export type CachedRouteAnalysis = Omit<RouteAnalysisData, "name">;

export type PersistedAnalysisRecord = {
  routeFingerprint: string;
  routeFingerprintVersion: number;
  analysisVersion: number;
  analysisInputFingerprint: string;
  generatedAt: number;
  analysis: CachedRouteAnalysis;
};

/** Selects a registry analysis only when the browser's parsed input matches the server-derived registry input. */
export function selectAnalysisForMatchingInput<T>(analysis: T, authorizedInputFingerprint: string, requestedInputFingerprint: string): T | null {
  return authorizedInputFingerprint === requestedInputFingerprint ? analysis : null;
}

export type OsmEnrichmentSnapshot = {
  snapshotId: string;
  retrievedAt: number;
  provider: "overpass-api.de";
  data: GeoEnrichmentData;
  retrievedRanges: GeoDistanceRange[];
  unavailableRanges: GeoDistanceRange[];
  classifiableRanges: GeoDistanceRange[];
};

export type OsmEvidenceConflict = {
  segmentIndex: number;
  startDistanceKm: number;
  endDistanceKm: number;
  selectedSnapshotId: string;
  alternatives: Array<{ snapshotId: string; surface: string | null }>;
};

export type PersistedOsmEnrichmentRecord = {
  routeFingerprint: string;
  routeFingerprintVersion: number;
  schemaVersion: number;
  provider: "overpass-api.de";
  source: GeoEnrichmentData["source"];
  routeLengthKm: number;
  snapshots: OsmEnrichmentSnapshot[];
  retrievedRanges: GeoDistanceRange[];
  unavailableRanges: GeoDistanceRange[];
  classifiableRanges: GeoDistanceRange[];
  retrievalCoveragePercent: number;
  classifiableCoveragePercent: number;
  lastAttemptAt: number;
  conflicts: OsmEvidenceConflict[];
  mergedData: GeoEnrichmentData;
};

export type PersistedMapillaryEnrichmentRecord = {
  routeFingerprint: string;
  routeFingerprintVersion: number;
  schemaVersion: number;
  provider: "mapillary";
  retrievedAt: number;
  data: MapillaryTerrainProofData;
};

export interface RoutePersistenceStore {
  getRoute(routeFingerprint: string, routeFingerprintVersion: number): Promise<PersistedRouteRecord | null>;
  getAnalysis(routeFingerprint: string, routeFingerprintVersion: number, analysisVersion: number, analysisInputFingerprint: string): Promise<PersistedAnalysisRecord | null>;
  saveRouteAndAnalysis(route: PersistedRouteRecord, analysis: PersistedAnalysisRecord): Promise<void>;
  getOsm(routeFingerprint: string, routeFingerprintVersion: number, schemaVersion: number): Promise<PersistedOsmEnrichmentRecord | null>;
  putOsm(record: PersistedOsmEnrichmentRecord): Promise<void>;
  getMapillary(routeFingerprint: string, routeFingerprintVersion: number, schemaVersion: number): Promise<PersistedMapillaryEnrichmentRecord | null>;
  putMapillary(record: PersistedMapillaryEnrichmentRecord): Promise<void>;
  getRaceEditionReference(raceId: string, year: number): Promise<RaceEditionRouteReference | null>;
  putRaceEditionReference(reference: RaceEditionRouteReference): Promise<void>;
}

export async function getOrCreateRouteAnalysis(
  store: RoutePersistenceStore,
  fingerprint: RouteFingerprintResult,
  analysisInputFingerprint: string,
  routeName: string | null | undefined,
  compute: () => RouteAnalysisData,
  options: { now?: number; analysisVersion?: number } = {},
): Promise<{ analysis: RouteAnalysisData; cacheHit: boolean }> {
  const now = options.now ?? Date.now();
  const analysisVersion = options.analysisVersion ?? ROUTE_ANALYSIS_VERSION;
  const displayName = routeName?.trim() || "Uploaded route";
  let previousRoute: PersistedRouteRecord | null = null;
  let cached: PersistedAnalysisRecord | null = null;
  try {
    [previousRoute, cached] = await Promise.all([
      store.getRoute(fingerprint.routeFingerprint, fingerprint.routeFingerprintVersion),
      store.getAnalysis(fingerprint.routeFingerprint, fingerprint.routeFingerprintVersion, analysisVersion, analysisInputFingerprint),
    ]);
  } catch {
    // Local persistence is an optimization; analysis remains available if IndexedDB is unavailable.
  }

  if (cached?.routeFingerprintVersion === fingerprint.routeFingerprintVersion &&
    cached.analysisInputFingerprint === analysisInputFingerprint) {
    const analysis = { ...cached.analysis, name: displayName };
    const route = createRouteRecord(fingerprint, analysis.metrics.distanceKm, previousRoute, now);
    try { await store.saveRouteAndAnalysis(route, { ...cached, analysis: cached.analysis }); } catch { /* Continue with cached result. */ }
    return { analysis, cacheHit: true };
  }

  const analysis = compute();
  const { route, record } = createPersistedRouteAnalysis(fingerprint, analysis, previousRoute, now, analysisInputFingerprint, analysisVersion);
  try { await store.saveRouteAndAnalysis(route, record); } catch { /* Continue with freshly computed result. */ }
  return { analysis: { ...record.analysis, name: displayName }, cacheHit: false };
}

export async function cacheRouteAnalysis(
  store: RoutePersistenceStore,
  fingerprint: RouteFingerprintResult,
  analysis: RouteAnalysisData,
  analysisInputFingerprint: string,
  options: { now?: number; analysisVersion?: number } = {},
) {
  const now = options.now ?? Date.now();
  let previousRoute: PersistedRouteRecord | null = null;
  try { previousRoute = await store.getRoute(fingerprint.routeFingerprint, fingerprint.routeFingerprintVersion); } catch { /* Cache writes remain optional. */ }
  const persisted = createPersistedRouteAnalysis(fingerprint, analysis, previousRoute, now, analysisInputFingerprint, options.analysisVersion ?? ROUTE_ANALYSIS_VERSION);
  try { await store.saveRouteAndAnalysis(persisted.route, persisted.record); } catch { /* Keep the already computed result. */ }
}

export async function getCachedOsmEnrichment(
  store: RoutePersistenceStore,
  routeFingerprint: string,
  routeFingerprintVersion: number,
  routeLengthKm: number,
  schemaVersion = OSM_ENRICHMENT_VERSION,
) {
  // Partial ranges are retained and reused. A future gap-filler can consume unavailableRanges without changing this record format.
  const cached = await store.getOsm(routeFingerprint, routeFingerprintVersion, schemaVersion);
  if (!cached) return null;
  return { record: cached, hasClassifiableEvidence: cached.classifiableRanges.length > 0 };
}

export async function cacheOsmEnrichment(
  store: RoutePersistenceStore,
  routeFingerprint: string,
  data: GeoEnrichmentData,
  routeLengthKm: number,
  options: { now?: number; routeFingerprintVersion?: number; schemaVersion?: number } = {},
) {
  const now = options.now ?? Date.now();
  const routeFingerprintVersion = options.routeFingerprintVersion ?? ROUTE_FINGERPRINT_VERSION;
  const schemaVersion = options.schemaVersion ?? OSM_ENRICHMENT_VERSION;
  const existing = await store.getOsm(routeFingerprint, routeFingerprintVersion, schemaVersion);
  const incoming = createOsmSnapshot(data, routeLengthKm, now, (existing?.snapshots.length ?? 0) + 1);
  const merged = mergeOsmEnrichmentRecord(existing, incoming, routeFingerprint, routeFingerprintVersion, routeLengthKm, schemaVersion, now);
  await store.putOsm(merged);
  return merged;
}

export async function cacheMapillaryEnrichment(
  store: RoutePersistenceStore,
  routeFingerprint: string,
  data: MapillaryTerrainProofData,
  options: { now?: number; routeFingerprintVersion?: number; schemaVersion?: number } = {},
) {
  const now = options.now ?? Date.now();
  const routeFingerprintVersion = options.routeFingerprintVersion ?? ROUTE_FINGERPRINT_VERSION;
  const schemaVersion = options.schemaVersion ?? MAPILLARY_ENRICHMENT_VERSION;
  const existing = await store.getMapillary(routeFingerprint, routeFingerprintVersion, schemaVersion);
  const record: PersistedMapillaryEnrichmentRecord = {
    routeFingerprint,
    routeFingerprintVersion,
    schemaVersion,
    provider: "mapillary",
    retrievedAt: now,
    data: existing ? mergeMapillaryData(existing.data, data) : data,
  };
  await store.putMapillary(record);
  return record;
}

export function hasReusableMapillaryEvidence(record: PersistedMapillaryEnrichmentRecord | null) {
  return Boolean(record && record.data.sections.some((section) => section.availability !== "unknown" || section.images.length > 0));
}

export function mergeMapillaryData(previous: MapillaryTerrainProofData, incoming: MapillaryTerrainProofData): MapillaryTerrainProofData {
  const previousById = new Map(previous.sections.map((section) => [section.id, section]));
  const incomingById = new Map(incoming.sections.map((section) => [section.id, section]));
  const sectionIds = [...new Set([...previousById.keys(), ...incomingById.keys()])];
  return {
    source: incoming.source,
    sections: sectionIds.map((id) => {
      const before = previousById.get(id);
      const after = incomingById.get(id);
      if (!after) return before!;
      const images = [...new Map([...(before?.images ?? []), ...after.images].map((image) => [image.id, image])).values()]
        .sort((left, right) => left.distanceAlongRouteKm - right.distanceAlongRouteKm || left.id.localeCompare(right.id));
      if (images.length) return { id, availability: "available", images, ...(after.note ? { note: after.note } : {}) };
      if (before && before.availability !== "unknown" && after.availability === "unknown") return before;
      return after;
    }),
  };
}

export function mapMapillaryEvidenceToSections(
  record: PersistedMapillaryEnrichmentRecord,
  sections: readonly RouteSection[],
): MapillaryTerrainProofData {
  const images = [...new Map(record.data.sections.flatMap((section) => section.images).map((image) => [image.id, image])).values()];
  return {
    source: record.data.source,
    sections: sections.map((section): MapillarySectionEvidence => {
      const sectionImages = images.filter((image) => (image.segmentIndex ?? 0) === (section.segmentIndex ?? 0) && image.distanceAlongRouteKm >= section.startKm && image.distanceAlongRouteKm <= section.endKm);
      return {
        id: section.id,
        availability: sectionImages.length ? "available" : "unknown",
        images: sectionImages,
        ...(sectionImages.length ? {} : { note: "No cached imagery reference is available for this section." }),
      };
    }),
  };
}

export function createOsmSnapshot(data: GeoEnrichmentData, routeLengthKm: number, retrievedAt: number, ordinal: number): OsmEnrichmentSnapshot {
  const retrievedRanges = mergeDistanceRanges(data.retrieval?.retrievedRanges ?? (data.availability === "available"
    ? data.segments.filter((segment) => segment.surface.availability === "available").map((segment) => rangeOfSegment(segment))
    : []));
  const classifiableRanges = mergeDistanceRanges(data.segments
    .filter((segment) => segment.surface.availability === "available" && segment.matchQuality !== "unknown" && segment.evidenceCoverage > 0)
    .map((segment) => rangeOfSegment(segment)));
  const unavailableRanges = mergeDistanceRanges(data.retrieval?.unavailableRanges ?? []);
  return {
    snapshotId: `osm-${retrievedAt}-${ordinal}`,
    retrievedAt,
    provider: "overpass-api.de",
    data,
    retrievedRanges: clipRanges(retrievedRanges, routeLengthKm),
    unavailableRanges: clipRanges(unavailableRanges, routeLengthKm),
    classifiableRanges: clipRanges(classifiableRanges, routeLengthKm),
  };
}

export function mergeOsmEnrichmentRecord(
  existing: PersistedOsmEnrichmentRecord | null,
  incoming: OsmEnrichmentSnapshot,
  routeFingerprint: string,
  routeFingerprintVersion: number,
  routeLengthKm: number,
  schemaVersion: number,
  now: number,
): PersistedOsmEnrichmentRecord {
  const snapshots = (existing?.snapshots ?? []).map((snapshot) => ({ ...snapshot }));
  const duplicate = snapshots.find((snapshot) => snapshotContentKey(snapshot) === snapshotContentKey(incoming));
  if (duplicate) {
    duplicate.retrievedAt = Math.max(duplicate.retrievedAt, incoming.retrievedAt);
  } else snapshots.push(incoming);
  const retrievedRanges = mergeDistanceRanges(snapshots.flatMap((snapshot) => snapshot.retrievedRanges));
  const unavailableRanges = subtractDistanceRanges(
    mergeDistanceRanges(snapshots.flatMap((snapshot) => snapshot.unavailableRanges)), retrievedRanges,
  );
  const mergedData = mergeSnapshotGeoData(snapshots, routeLengthKm, retrievedRanges, unavailableRanges);
  const evidenceSegments = mergedData.segments.filter((segment) => segment.surface.availability === "available" && segment.matchQuality !== "unknown" && segment.evidenceCoverage > 0);
  const classifiableRanges = mergeDistanceRanges(evidenceSegments.map((segment) => rangeOfSegment(segment)));
  const classifiableDistanceKm = evidenceSegments.reduce((sum, segment) => sum + segment.lengthKm * clamp01(segment.evidenceCoverage), 0);
  const conflicts = findOsmEvidenceConflicts(snapshots, retrievedRanges);
  return {
    routeFingerprint,
    routeFingerprintVersion,
    schemaVersion,
    provider: "overpass-api.de",
    source: incoming.data.source,
    routeLengthKm,
    snapshots,
    retrievedRanges,
    unavailableRanges,
    classifiableRanges,
    retrievalCoveragePercent: routeLengthKm > 0 ? Math.round(rangeLength(retrievedRanges) / routeLengthKm * 100) : 0,
    classifiableCoveragePercent: routeLengthKm > 0 ? classifiableDistanceKm / routeLengthKm * 100 : 0,
    lastAttemptAt: Math.max(existing?.lastAttemptAt ?? 0, now),
    conflicts,
    mergedData,
  };
}

function mergeSnapshotGeoData(
  snapshots: OsmEnrichmentSnapshot[],
  routeLengthKm: number,
  retrievedRanges: GeoDistanceRange[],
  unavailableRanges: GeoDistanceRange[],
): GeoEnrichmentData {
  const pieces = snapshots.flatMap((snapshot) => snapshot.data.segments.flatMap((segment) => {
    const ranges = snapshot.retrievedRanges.map((range) => intersectRanges(rangeOfSegment(segment), range)).filter(isRange);
    return ranges.map((range) => ({ snapshot, segment, range }));
  }));
  const selected: Array<{ snapshot: OsmEnrichmentSnapshot; segment: GeoSegmentEvidence; startKm: number; endKm: number; segmentIndex: number }> = [];
  for (const routeRange of mergeDistanceRanges(retrievedRanges)) {
    const segmentIndex = routeRange.segmentIndex ?? 0;
    const relevantPieces = pieces.filter((piece) => (piece.segment.segmentIndex ?? 0) === segmentIndex);
    const boundaries = [routeRange.startDistanceKm, routeRange.endDistanceKm, ...relevantPieces.flatMap((piece) => [piece.range.startDistanceKm, piece.range.endDistanceKm])]
      .sort((left, right) => left - right).filter((value, index, values) => index === 0 || value !== values[index - 1]);
    for (let index = 0; index < boundaries.length - 1; index += 1) {
      const startKm = boundaries[index];
      const endKm = boundaries[index + 1];
      if (endKm <= startKm || startKm < routeRange.startDistanceKm || endKm > routeRange.endDistanceKm) continue;
      const candidates = relevantPieces.filter((piece) => piece.range.startDistanceKm < endKm && piece.range.endDistanceKm > startKm);
      if (!candidates.length) continue;
      candidates.sort(compareOsmEvidencePieces);
      const winner = candidates[0];
      const previous = selected.at(-1);
      if (previous && previous.segmentIndex === segmentIndex && previous.snapshot.snapshotId === winner.snapshot.snapshotId && previous.segment.id === winner.segment.id && Math.abs(previous.endKm - startKm) < 0.000001) previous.endKm = endKm;
      else selected.push({ snapshot: winner.snapshot, segment: winner.segment, startKm, endKm, segmentIndex });
    }
  }

  const segments = selected.map(({ snapshot, segment, startKm, endKm, segmentIndex }, index): GeoSegmentEvidence => ({
    ...segment,
    segmentIndex,
    id: `cache-${snapshot.snapshotId}-${segment.id}-${index}`,
    startDistanceKm: startKm,
    endDistanceKm: endKm,
    lengthKm: endKm - startKm,
    osmWays: segment.osmWays.map((way) => ({ ...way, segmentIndex, startDistanceKm: startKm, endDistanceKm: endKm })),
  }));
  const matchedKm = segments.reduce((sum, segment) => sum + segment.lengthKm * clamp01(segment.evidenceCoverage), 0);
  const matchedRoutePercent = routeLengthKm > 0 ? Math.round(matchedKm / routeLengthKm * 100) : 0;
  const failureCounts = sumFailureCounts(snapshots.map((snapshot) => snapshot.data.retrieval?.failureCounts));
  const retrieval = {
    queryAttempts: sumRetrievalField(snapshots, "queryAttempts"),
    requestsSent: sumRetrievalField(snapshots, "requestsSent"),
    requestsSucceeded: sumRetrievalField(snapshots, "requestsSucceeded"),
    requestsFailed: sumRetrievalField(snapshots, "requestsFailed"),
    cacheHits: sumRetrievalField(snapshots, "cacheHits"),
    retrievalCoveragePercent: routeLengthKm > 0 ? Math.round(rangeLength(retrievedRanges) / routeLengthKm * 100) : 0,
    retrievedRanges,
    unavailableRanges,
    failureCounts,
  };
  const hasFailures = unavailableRanges.length > 0;
  const availability = matchedRoutePercent >= 15 ? "available" : matchedRoutePercent > 0 || hasFailures ? "unknown" : "not-found";
  return {
    source: snapshots.at(-1)?.data.source ?? { type: "osm", name: "OpenStreetMap", attribution: "© OpenStreetMap contributors" },
    availability,
    segments,
    matchedRoutePercent,
    ...(hasFailures ? { note: "OpenStreetMap retrieval includes unavailable route ranges." } : {}),
    retrieval,
    attribution: snapshots.at(-1)?.data.attribution ?? "© OpenStreetMap contributors",
  };
}

function compareOsmEvidencePieces(
  left: { snapshot: OsmEnrichmentSnapshot; segment: GeoSegmentEvidence },
  right: { snapshot: OsmEnrichmentSnapshot; segment: GeoSegmentEvidence },
) {
  const score = (piece: { snapshot: OsmEnrichmentSnapshot; segment: GeoSegmentEvidence }) =>
    (piece.segment.surface.availability === "available" ? 100 : 0) +
    (piece.segment.matchQuality === "high" ? 30 : piece.segment.matchQuality === "moderate" ? 20 : 0) +
    clamp01(piece.segment.evidenceCoverage) * 10 +
    Object.values(piece.segment).filter((value) => value && typeof value === "object" && "availability" in value && value.availability === "available").length;
  const scoreDifference = score(right) - score(left);
  if (scoreDifference) return scoreDifference;
  if (left.snapshot.retrievedAt !== right.snapshot.retrievedAt) return right.snapshot.retrievedAt - left.snapshot.retrievedAt;
  return left.snapshot.snapshotId.localeCompare(right.snapshot.snapshotId);
}

function findOsmEvidenceConflicts(snapshots: OsmEnrichmentSnapshot[], retrievedRanges: GeoDistanceRange[]): OsmEvidenceConflict[] {
  const conflicts: OsmEvidenceConflict[] = [];
  for (const range of retrievedRanges) {
    const segmentIndex = range.segmentIndex ?? 0;
    const boundaries = [...new Set([
      range.startDistanceKm,
      range.endDistanceKm,
      ...snapshots.flatMap((snapshot) => snapshot.data.segments.filter((segment) => (segment.segmentIndex ?? 0) === segmentIndex).flatMap((segment) => [
        Math.max(range.startDistanceKm, segment.startDistanceKm),
        Math.min(range.endDistanceKm, segment.endDistanceKm),
      ]).filter((distance) => distance > range.startDistanceKm && distance < range.endDistanceKm)),
    ])].sort((left, right) => left - right);
    for (let index = 0; index < boundaries.length - 1; index += 1) {
      const startDistanceKm = boundaries[index];
      const endDistanceKm = boundaries[index + 1];
      const active = snapshots.flatMap((snapshot) => snapshot.data.segments
        .filter((segment) => (segment.segmentIndex ?? 0) === segmentIndex && segment.startDistanceKm < endDistanceKm && segment.endDistanceKm > startDistanceKm && segment.surface.availability === "available")
        .map((segment) => ({ snapshot, segment })));
      const alternatives = [...new Map(active.map(({ snapshot, segment }) => [
        snapshot.snapshotId,
        { snapshotId: snapshot.snapshotId, surface: segment.surface.value },
      ])).values()];
      const surfaceValues = new Set(alternatives.map((alternative) => alternative.surface));
      if (surfaceValues.size < 2) continue;
      const candidates = active.sort(compareOsmEvidencePieces);
      conflicts.push({ segmentIndex, startDistanceKm, endDistanceKm, selectedSnapshotId: candidates[0].snapshot.snapshotId, alternatives });
    }
  }
  return conflicts;
}

export function createPersistedRouteAnalysis(
  fingerprint: RouteFingerprintResult,
  analysis: RouteAnalysisData,
  previousRoute: PersistedRouteRecord | null,
  now: number,
  analysisInputFingerprint: string,
  analysisVersion = ROUTE_ANALYSIS_VERSION,
): { route: PersistedRouteRecord; record: PersistedAnalysisRecord } {
  const storedAnalysis = { ...analysis };
  Reflect.deleteProperty(storedAnalysis, "name");
  return {
    route: createRouteRecord(fingerprint, analysis.metrics.distanceKm, previousRoute, now),
    record: {
      routeFingerprint: fingerprint.routeFingerprint,
      routeFingerprintVersion: fingerprint.routeFingerprintVersion,
      analysisVersion,
      analysisInputFingerprint,
      generatedAt: now,
      analysis: storedAnalysis,
    },
  };
}

function createRouteRecord(
  fingerprint: RouteFingerprintResult,
  totalDistanceKm: number,
  previous: PersistedRouteRecord | null,
  now: number,
): PersistedRouteRecord {
  return {
    routeFingerprint: fingerprint.routeFingerprint,
    routeFingerprintVersion: fingerprint.routeFingerprintVersion,
    normalizedGeometry: fingerprint.normalizedGeometrySegments,
    normalizedDistanceKm: fingerprint.normalizedDistanceKm,
    totalDistanceKm,
    representativePointCount: fingerprint.normalizedGeometrySegments.reduce((count, segment) => count + segment.length, 0),
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
  };
}

function snapshotContentKey(snapshot: OsmEnrichmentSnapshot) {
  return JSON.stringify({
    retrievedRanges: snapshot.retrievedRanges,
    unavailableRanges: snapshot.unavailableRanges,
    segments: snapshot.data.segments.map((segment) => ({
      segmentIndex: segment.segmentIndex ?? 0,
      startDistanceKm: segment.startDistanceKm,
      endDistanceKm: segment.endDistanceKm,
      surface: segment.surface,
      matchQuality: segment.matchQuality,
      evidenceCoverage: segment.evidenceCoverage,
      ways: segment.osmWays.map((way) => ({ sourceId: way.sourceId, tags: way.tags })),
    })),
    retrieval: snapshot.data.retrieval ? {
      queryAttempts: snapshot.data.retrieval.queryAttempts,
      requestsSent: snapshot.data.retrieval.requestsSent,
      requestsSucceeded: snapshot.data.retrieval.requestsSucceeded,
      requestsFailed: snapshot.data.retrieval.requestsFailed,
      cacheHits: snapshot.data.retrieval.cacheHits,
      failureCounts: snapshot.data.retrieval.failureCounts,
    } : null,
  });
}

function rangeOfSegment(segment: GeoSegmentEvidence): GeoDistanceRange {
  return { startDistanceKm: segment.startDistanceKm, endDistanceKm: segment.endDistanceKm, segmentIndex: segment.segmentIndex ?? 0 };
}

function intersectRanges(left: GeoDistanceRange, right: GeoDistanceRange): GeoDistanceRange | null {
  if ((left.segmentIndex ?? 0) !== (right.segmentIndex ?? 0)) return null;
  const startDistanceKm = Math.max(left.startDistanceKm, right.startDistanceKm);
  const endDistanceKm = Math.min(left.endDistanceKm, right.endDistanceKm);
  return endDistanceKm > startDistanceKm ? { startDistanceKm, endDistanceKm, segmentIndex: left.segmentIndex ?? 0 } : null;
}

function isRange(value: GeoDistanceRange | null): value is GeoDistanceRange { return value !== null; }

function clipRanges(ranges: GeoDistanceRange[], routeLengthKm: number) {
  return mergeDistanceRanges(ranges.flatMap((range) => {
    const startDistanceKm = Math.max(0, range.startDistanceKm);
    const endDistanceKm = Math.min(routeLengthKm, range.endDistanceKm);
    return endDistanceKm > startDistanceKm ? [{ startDistanceKm, endDistanceKm, segmentIndex: range.segmentIndex ?? 0 }] : [];
  }));
}

function mergeDistanceRanges(ranges: GeoDistanceRange[]): GeoDistanceRange[] {
  const sorted = ranges.filter((range) => Number.isFinite(range.startDistanceKm) && Number.isFinite(range.endDistanceKm) && range.endDistanceKm > range.startDistanceKm)
    .map((range) => ({ ...range })).sort((left, right) => left.startDistanceKm - right.startDistanceKm);
  const merged: GeoDistanceRange[] = [];
  for (const range of sorted) {
    const previous = merged.at(-1);
    if (previous && (previous.segmentIndex ?? 0) === (range.segmentIndex ?? 0) && range.startDistanceKm <= previous.endDistanceKm + 0.001) previous.endDistanceKm = Math.max(previous.endDistanceKm, range.endDistanceKm);
    else merged.push(range);
  }
  return merged;
}

function subtractDistanceRanges(ranges: GeoDistanceRange[], covered: GeoDistanceRange[]): GeoDistanceRange[] {
  let remaining = mergeDistanceRanges(ranges);
  for (const coverage of mergeDistanceRanges(covered)) {
    remaining = remaining.flatMap((range) => {
      if ((coverage.segmentIndex ?? 0) !== (range.segmentIndex ?? 0) || coverage.endDistanceKm <= range.startDistanceKm || coverage.startDistanceKm >= range.endDistanceKm) return [range];
      return [
        ...(coverage.startDistanceKm > range.startDistanceKm ? [{ startDistanceKm: range.startDistanceKm, endDistanceKm: coverage.startDistanceKm, segmentIndex: range.segmentIndex ?? 0 }] : []),
        ...(coverage.endDistanceKm < range.endDistanceKm ? [{ startDistanceKm: coverage.endDistanceKm, endDistanceKm: range.endDistanceKm, segmentIndex: range.segmentIndex ?? 0 }] : []),
      ];
    });
  }
  return mergeDistanceRanges(remaining);
}

function rangeLength(ranges: GeoDistanceRange[]) { return mergeDistanceRanges(ranges).reduce((sum, range) => sum + range.endDistanceKm - range.startDistanceKm, 0); }
function clamp01(value: number) { return Math.max(0, Math.min(1, value)); }

function sumRetrievalField(snapshots: OsmEnrichmentSnapshot[], key: "queryAttempts" | "requestsSent" | "requestsSucceeded" | "requestsFailed" | "cacheHits") {
  return snapshots.reduce((sum, snapshot) => sum + (snapshot.data.retrieval?.[key] ?? 0), 0);
}

function sumFailureCounts(counts: Array<GeoRetrievalFailureCounts | undefined>) {
  return {
    http429: counts.reduce((sum, count) => sum + (count?.http429 ?? 0), 0),
    http504: counts.reduce((sum, count) => sum + (count?.http504 ?? 0), 0),
    timeout: counts.reduce((sum, count) => sum + (count?.timeout ?? 0), 0),
    otherTransient: counts.reduce((sum, count) => sum + (count?.otherTransient ?? 0), 0),
    permanent: counts.reduce((sum, count) => sum + (count?.permanent ?? 0), 0),
    budgetExhausted: counts.reduce((sum, count) => sum + (count?.budgetExhausted ?? 0), 0),
  };
}

const STORE_ROUTES = "routes";
const STORE_ANALYSIS_VARIANTS = "analysis-variants";
const STORE_OSM = "osm-enrichment";
const STORE_MAPILLARY = "mapillary-enrichment";
const STORE_RACE_REFERENCES = "race-edition-route-references";
let databasePromise: Promise<IDBDatabase> | null = null;

export const browserRoutePersistence: RoutePersistenceStore = {
  getRoute: async (fingerprint, fingerprintVersion) => {
    const record = await getRecord<PersistedRouteRecord>(STORE_ROUTES, fingerprint);
    return record?.routeFingerprintVersion === fingerprintVersion ? record : null;
  },
  getAnalysis: async (fingerprint, fingerprintVersion, version, analysisInputFingerprint) => {
    const record = await getRecord<PersistedAnalysisRecord>(STORE_ANALYSIS_VARIANTS, [fingerprint, fingerprintVersion, version, analysisInputFingerprint]);
    return record?.routeFingerprintVersion === fingerprintVersion && record.analysisInputFingerprint === analysisInputFingerprint ? record : null;
  },
  saveRouteAndAnalysis: async (route, analysis) => {
    const database = await openDatabase();
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction([STORE_ROUTES, STORE_ANALYSIS_VARIANTS], "readwrite");
      transaction.objectStore(STORE_ROUTES).put(route);
      transaction.objectStore(STORE_ANALYSIS_VARIANTS).put(analysis);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("Could not save cached route analysis."));
      transaction.onabort = () => reject(transaction.error ?? new Error("Route analysis cache transaction was aborted."));
    });
  },
  getOsm: async (fingerprint, fingerprintVersion, version) => {
    const record = await getRecord<PersistedOsmEnrichmentRecord>(STORE_OSM, [fingerprint, version]);
    return record?.routeFingerprintVersion === fingerprintVersion ? record : null;
  },
  putOsm: (record) => putRecord(STORE_OSM, record),
  getMapillary: async (fingerprint, fingerprintVersion, version) => {
    const record = await getRecord<PersistedMapillaryEnrichmentRecord>(STORE_MAPILLARY, [fingerprint, version]);
    return record?.routeFingerprintVersion === fingerprintVersion ? record : null;
  },
  putMapillary: (record) => putRecord(STORE_MAPILLARY, record),
  getRaceEditionReference: (raceId, year) => getRecord<RaceEditionRouteReference>(STORE_RACE_REFERENCES, [raceId, year]),
  putRaceEditionReference: (reference) => putRecord(STORE_RACE_REFERENCES, reference),
};

async function getRecord<T>(storeName: string, key: IDBValidKey): Promise<T | null> {
  const database = await openDatabase();
  return new Promise<T | null>((resolve, reject) => {
    const request = database.transaction(storeName, "readonly").objectStore(storeName).get(key);
    request.onsuccess = () => resolve((request.result as T | undefined) ?? null);
    request.onerror = () => reject(request.error ?? new Error("Could not read local route cache."));
  });
}

async function putRecord(storeName: string, value: object): Promise<void> {
  const database = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(storeName, "readwrite");
    transaction.objectStore(storeName).put(value);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("Could not save local route cache."));
    transaction.onabort = () => reject(transaction.error ?? new Error("Local route cache transaction was aborted."));
  });
}

function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") return Promise.reject(new Error("IndexedDB is unavailable in this environment."));
  if (databasePromise) return databasePromise;
  databasePromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(ROUTE_DATABASE_NAME, ROUTE_DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_ROUTES)) database.createObjectStore(STORE_ROUTES, { keyPath: "routeFingerprint" });
      if (!database.objectStoreNames.contains(STORE_ANALYSIS_VARIANTS)) database.createObjectStore(STORE_ANALYSIS_VARIANTS, { keyPath: ["routeFingerprint", "routeFingerprintVersion", "analysisVersion", "analysisInputFingerprint"] });
      if (!database.objectStoreNames.contains(STORE_OSM)) database.createObjectStore(STORE_OSM, { keyPath: ["routeFingerprint", "schemaVersion"] });
      if (!database.objectStoreNames.contains(STORE_MAPILLARY)) database.createObjectStore(STORE_MAPILLARY, { keyPath: ["routeFingerprint", "schemaVersion"] });
      if (!database.objectStoreNames.contains(STORE_RACE_REFERENCES)) database.createObjectStore(STORE_RACE_REFERENCES, { keyPath: ["raceId", "year"] });
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () => {
      databasePromise = null;
      reject(request.error ?? new Error("Could not open local route cache."));
    };
    request.onblocked = () => {
      databasePromise = null;
      reject(new Error("Local route cache upgrade is blocked by another tab."));
    };
  });
  return databasePromise;
}
