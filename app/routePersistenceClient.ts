import type { GeoEnrichmentData } from "./geoEnrichment.ts";
import type { RouteAnalysisData } from "./gpxAnalysis.ts";
import type { MapillaryTerrainProofData } from "./mapillaryTerrainProof.ts";
import type { RouteFingerprintResult } from "./routeFingerprint.ts";
import type { PersistedMapillaryEnrichmentRecord, PersistedOsmEnrichmentRecord } from "./routePersistence.ts";

export type SharedRouteCache = {
  analysis: RouteAnalysisData | null;
  osm: PersistedOsmEnrichmentRecord | null;
  mapillary: PersistedMapillaryEnrichmentRecord | null;
};

export type SharedRouteLookup = {
  persistenceScope: "local" | "shared";
  sharedEligible: boolean;
  persistenceAvailable: boolean;
  cache: SharedRouteCache | null;
};

export async function lookupSharedRoute(fingerprint: RouteFingerprintResult, analysisInputFingerprint: string): Promise<SharedRouteLookup> {
  try {
    const response = await fetch("/api/route-persistence", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        operation: "lookup",
        persistenceScope: "shared",
        routeFingerprint: fingerprint.routeFingerprint,
        routeFingerprintVersion: fingerprint.routeFingerprintVersion,
        analysisInputFingerprint,
      }),
    });
    if (!response.ok) return localOnlyResult();
    const value = await response.json() as unknown;
    if (!isRecord(value) || (value.persistenceScope !== "local" && value.persistenceScope !== "shared") ||
      typeof value.sharedEligible !== "boolean" || typeof value.persistenceAvailable !== "boolean") return localOnlyResult();
    if (value.persistenceScope === "local" || value.sharedEligible !== true) return localOnlyResult();
    const analysis = isRecord(value.analysis) ? value.analysis as unknown as RouteAnalysisData : null;
    return {
      persistenceScope: "shared",
      sharedEligible: true,
      persistenceAvailable: value.persistenceAvailable,
      cache: {
        analysis,
        osm: isRecord(value.osm) ? value.osm as unknown as PersistedOsmEnrichmentRecord : null,
        mapillary: isRecord(value.mapillary) ? value.mapillary as unknown as PersistedMapillaryEnrichmentRecord : null,
      },
    };
  } catch {
    return localOnlyResult();
  }
}

export async function enrichSharedRoute(
  fingerprint: RouteFingerprintResult,
  needs: { osm: boolean; mapillary: boolean },
): Promise<{
  persistenceAvailable: boolean;
  osm: PersistedOsmEnrichmentRecord | GeoEnrichmentData | null;
  mapillary: PersistedMapillaryEnrichmentRecord | MapillaryTerrainProofData | null;
}> {
  const response = await fetch("/api/route-persistence", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      operation: "enrich",
      persistenceScope: "shared",
      routeFingerprint: fingerprint.routeFingerprint,
      routeFingerprintVersion: fingerprint.routeFingerprintVersion,
      needs,
    }),
  });
  if (!response.ok) throw new Error("Shared route enrichment is unavailable.");
  const value = await response.json() as unknown;
  if (!isRecord(value) || value.persistenceScope !== "shared" || value.sharedEligible !== true || typeof value.persistenceAvailable !== "boolean") {
    throw new Error("Invalid shared route enrichment response.");
  }
  return {
    persistenceAvailable: value.persistenceAvailable,
    osm: isRecord(value.osm) ? value.osm as unknown as PersistedOsmEnrichmentRecord | GeoEnrichmentData : null,
    mapillary: isRecord(value.mapillary) ? value.mapillary as unknown as PersistedMapillaryEnrichmentRecord | MapillaryTerrainProofData : null,
  };
}

function localOnlyResult(): SharedRouteLookup {
  return { persistenceScope: "local", sharedEligible: false, persistenceAvailable: false, cache: null };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
