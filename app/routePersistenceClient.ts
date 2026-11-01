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

export const OPTIONAL_ROUTE_LOOKUP_TIMEOUT_MS = 1500;

/** Runs optional shared-route work with a bounded lifetime and aborts any in-flight fetch on timeout. */
export async function runOptionalRouteLookup<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs = OPTIONAL_ROUTE_LOOKUP_TIMEOUT_MS,
): Promise<T | null> {
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timeoutId = setTimeout(() => {
      controller.abort();
      resolve(null);
    }, Math.max(0, timeoutMs));
  });

  try {
    return await Promise.race([
      Promise.resolve().then(() => operation(controller.signal)),
      timeout,
    ]);
  } catch {
    controller.abort();
    return null;
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

export async function lookupSharedRoute(
  fingerprint: RouteFingerprintResult,
  analysisInputFingerprint: string,
  options: { includeOsm?: boolean; signal?: AbortSignal } = {},
): Promise<SharedRouteLookup> {
  try {
    const response = await fetch("/api/route-persistence", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      ...(options.signal ? { signal: options.signal } : {}),
      body: JSON.stringify({
        operation: "lookup",
        persistenceScope: "shared",
        routeFingerprint: fingerprint.routeFingerprint,
        routeFingerprintVersion: fingerprint.routeFingerprintVersion,
        analysisInputFingerprint,
        ...(options.includeOsm === false ? { includeOsm: false } : {}),
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
