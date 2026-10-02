import { enrichRouteWithOsm } from "../../geoEnrichmentService.ts";
import type { GeoEnrichmentData } from "../../geoEnrichment.ts";
import { thinRouteForMatching } from "../../geoEnrichment.ts";
import { lookupMapillaryTerrainProof, type MapillaryTerrainProofData } from "../../mapillaryTerrainProof.ts";
import { buildMapillaryRequests } from "../../routeMapillaryRequests.ts";
import {
  cacheMapillaryEnrichment,
  cacheOsmEnrichment,
  createPersistedRouteAnalysis as createPersistedRouteAnalysisRecord,
  getCachedOsmEnrichment,
  MAPILLARY_ENRICHMENT_VERSION,
  OSM_ENRICHMENT_VERSION,
  ROUTE_ANALYSIS_VERSION,
  type PersistedMapillaryEnrichmentRecord,
  type PersistedOsmEnrichmentRecord,
} from "../../routePersistence.ts";
import { getSharedRouteEligibility } from "../../sharedRouteEligibility.ts";
import { isSharedRouteDatabaseConfigured, sharedRouteStore } from "../../server/sharedRouteStore.ts";
import { validatePersistenceRequest } from "../../routePersistenceValidation.ts";

export const runtime = "nodejs";
export const maxDuration = 30;
const MAX_BODY_BYTES = 64_000;

export async function POST(request: Request) {
  const body = await readRequestBody(request);
  if (!body) return Response.json({ error: "Invalid route persistence request." }, { status: 400 });
  const parsed = validatePersistenceRequest(body);
  if (!parsed) return Response.json({ error: "Invalid route persistence request." }, { status: 400 });

  const eligible = await getSharedRouteEligibility(parsed.routeFingerprint, parsed.routeFingerprintVersion);
  if (!eligible) {
    return Response.json({ persistenceScope: "local", sharedEligible: false, persistenceAvailable: false }, { headers: { "Cache-Control": "no-store" } });
  }

  if (parsed.operation === "lookup") return lookupSharedRoute(eligible);
  return enrichSharedRoute(eligible, parsed.needs);
}

export async function lookupSharedRoute(eligible: NonNullable<Awaited<ReturnType<typeof getSharedRouteEligibility>>>) {
  if (!isSharedRouteDatabaseConfigured()) return sharedResponse(eligible, false);
  try {
    const existing = await sharedRouteStore.getAnalysis(
      eligible.routeFingerprint,
      eligible.routeFingerprintVersion,
      ROUTE_ANALYSIS_VERSION,
    );
    let analysisRecord = existing;
    if (!analysisRecord) {
      const route = await sharedRouteStore.getRoute(eligible.routeFingerprint, eligible.routeFingerprintVersion);
      const now = Date.now();
      const { route: routeRecord, record } = createPersistedRouteAnalysis(eligible, route, now);
      await sharedRouteStore.saveRouteAndAnalysis(routeRecord, record);
      analysisRecord = record;
    }
    await sharedRouteStore.putRaceEditionReference({
      raceId: eligible.raceId,
      raceName: eligible.raceName,
      year: eligible.editionYear,
      routeFingerprint: eligible.routeFingerprint,
      routeFingerprintVersion: eligible.routeFingerprintVersion,
      createdAt: Date.now(),
    });
    const [osm, mapillary] = await Promise.all([
      sharedRouteStore.getOsm(eligible.routeFingerprint, eligible.routeFingerprintVersion, OSM_ENRICHMENT_VERSION),
      sharedRouteStore.getMapillary(eligible.routeFingerprint, eligible.routeFingerprintVersion, MAPILLARY_ENRICHMENT_VERSION),
    ]);
    return Response.json({
      persistenceScope: "shared",
      sharedEligible: true,
      persistenceAvailable: true,
      analysis: { ...analysisRecord.analysis, name: eligible.raceName },
      osm,
      mapillary,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    logStorageFailure("lookup", error);
    return sharedResponse(eligible, false);
  }
}

async function enrichSharedRoute(
  eligible: NonNullable<Awaited<ReturnType<typeof getSharedRouteEligibility>>>,
  needs: { osm: boolean; mapillary: boolean },
) {
  const osmPoints = thinRouteForMatching(eligible.analysis.points);
  const mapillaryRequests = buildMapillaryRequests(eligible.analysis.routeSections, eligible.analysis.points);
  const [osmResult, mapillaryResult] = await Promise.all([
    needs.osm
      ? enrichRouteWithOsm(osmPoints).then((data) => ({ status: "fulfilled" as const, data })).catch(() => ({ status: "fulfilled" as const, data: unknownGeoEvidence() }))
      : Promise.resolve({ status: "omitted" as const }),
    needs.mapillary
      ? lookupMapillaryTerrainProof(mapillaryRequests, process.env.MAPILLARY_ACCESS_TOKEN)
        .then((data) => ({ status: "fulfilled" as const, data })).catch(() => ({ status: "fulfilled" as const, data: unknownMapillaryEvidence(mapillaryRequests) }))
      : Promise.resolve({ status: "omitted" as const }),
  ]);

  let persistenceAvailable = false;
  if (isSharedRouteDatabaseConfigured()) {
    try {
      await ensureSharedRouteAnalysis(eligible);
      const writes: Promise<unknown>[] = [];
      if (osmResult.status === "fulfilled") writes.push(cacheOsmEnrichment(
        sharedRouteStore,
        eligible.routeFingerprint,
        osmResult.data,
        eligible.analysis.metrics.distanceKm,
        { routeFingerprintVersion: eligible.routeFingerprintVersion },
      ));
      if (mapillaryResult.status === "fulfilled") writes.push(cacheMapillaryEnrichment(
        sharedRouteStore,
        eligible.routeFingerprint,
        mapillaryResult.data,
        { routeFingerprintVersion: eligible.routeFingerprintVersion },
      ));
      await Promise.all(writes);
      persistenceAvailable = true;
    } catch (error) {
      logStorageFailure("enrichment", error);
    }
  }

  const osm = osmResult.status === "fulfilled" ? await readOsmResult(eligible, osmResult.data, persistenceAvailable) : null;
  const mapillary = mapillaryResult.status === "fulfilled" ? await readMapillaryResult(eligible, mapillaryResult.data, persistenceAvailable) : null;
  return Response.json({
    persistenceScope: "shared",
    sharedEligible: true,
    persistenceAvailable,
    ...(osm ? { osm } : {}),
    ...(mapillary ? { mapillary } : {}),
  }, { headers: { "Cache-Control": "no-store" } });
}

async function readOsmResult(
  eligible: NonNullable<Awaited<ReturnType<typeof getSharedRouteEligibility>>>,
  fresh: GeoEnrichmentData,
  persistenceAvailable: boolean,
): Promise<PersistedOsmEnrichmentRecord | GeoEnrichmentData> {
  if (persistenceAvailable) {
    return (await getCachedOsmEnrichment(sharedRouteStore, eligible.routeFingerprint, eligible.routeFingerprintVersion, eligible.analysis.metrics.distanceKm, OSM_ENRICHMENT_VERSION))?.record ?? fresh;
  }
  return fresh;
}

async function readMapillaryResult(
  eligible: NonNullable<Awaited<ReturnType<typeof getSharedRouteEligibility>>>,
  fresh: MapillaryTerrainProofData,
  persistenceAvailable: boolean,
): Promise<PersistedMapillaryEnrichmentRecord | MapillaryTerrainProofData> {
  if (persistenceAvailable) {
    return await sharedRouteStore.getMapillary(eligible.routeFingerprint, eligible.routeFingerprintVersion, MAPILLARY_ENRICHMENT_VERSION) ?? fresh;
  }
  return fresh;
}

async function ensureSharedRouteAnalysis(eligible: NonNullable<Awaited<ReturnType<typeof getSharedRouteEligibility>>>) {
  const current = await sharedRouteStore.getAnalysis(eligible.routeFingerprint, eligible.routeFingerprintVersion, ROUTE_ANALYSIS_VERSION);
  if (current) return;
  const route = await sharedRouteStore.getRoute(eligible.routeFingerprint, eligible.routeFingerprintVersion);
  const now = Date.now();
  const { route: routeRecord, record } = createPersistedRouteAnalysis(eligible, route, now);
  await sharedRouteStore.saveRouteAndAnalysis(routeRecord, record);
  await sharedRouteStore.putRaceEditionReference({
    raceId: eligible.raceId, raceName: eligible.raceName, year: eligible.editionYear,
    routeFingerprint: eligible.routeFingerprint, routeFingerprintVersion: eligible.routeFingerprintVersion, createdAt: now,
  });
}

function createPersistedRouteAnalysis(
  eligible: NonNullable<Awaited<ReturnType<typeof getSharedRouteEligibility>>>,
  previousRoute: Awaited<ReturnType<typeof sharedRouteStore.getRoute>>,
  now: number,
) {
  const previous = previousRoute?.routeFingerprintVersion === eligible.routeFingerprintVersion ? previousRoute : null;
  const stored = createPersistedRouteAnalysisRecord(eligible.fingerprint, eligible.analysis, previous, now, ROUTE_ANALYSIS_VERSION);
  return stored;
}

function sharedResponse(eligible: NonNullable<Awaited<ReturnType<typeof getSharedRouteEligibility>>>, persistenceAvailable: boolean) {
  return Response.json({
    persistenceScope: "shared", sharedEligible: true, persistenceAvailable,
  }, { headers: { "Cache-Control": "no-store" } });
}

async function readRequestBody(request: Request): Promise<unknown | null> {
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > MAX_BODY_BYTES || !request.body) return null;
  try {
    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_BODY_BYTES) { void reader.cancel(); return null; }
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    return null;
  }
}

function unknownGeoEvidence(): GeoEnrichmentData {
  return {
    source: { type: "osm", name: "OpenStreetMap", attribution: "© OpenStreetMap contributors" },
    availability: "unknown", segments: [], matchedRoutePercent: 0,
    note: "OpenStreetMap terrain evidence is currently unavailable for this route.",
    attribution: "© OpenStreetMap contributors",
  };
}

function unknownMapillaryEvidence(sections: ReturnType<typeof buildMapillaryRequests>): MapillaryTerrainProofData {
  return {
    source: { type: "mapillary", name: "Mapillary", attribution: "© Mapillary" },
    sections: sections.map(({ id }) => ({ id, availability: "unknown", images: [], note: "Terrain imagery could not be loaded for this section." })),
  };
}

function logStorageFailure(operation: string, caught: unknown) {
  const code = caught && typeof caught === "object" && "code" in caught && typeof caught.code === "string" && /^[A-Z0-9_]{1,12}$/.test(caught.code)
    ? caught.code
    : "unavailable";
  console.error("[route-persistence] shared storage operation failed", { operation, code });
}
