import { createHash } from "node:crypto";
import postgres from "postgres";
import {
  mergeMapillaryData,
  mergeOsmEnrichmentRecord,
  type PersistedAnalysisRecord,
  type PersistedMapillaryEnrichmentRecord,
  type PersistedOsmEnrichmentRecord,
  type PersistedRouteRecord,
  type RaceEditionRouteReference,
  type RoutePersistenceStore,
} from "../routePersistence.ts";

type PostgresClient = ReturnType<typeof postgres>;
type JsonRecord = Record<string, unknown>;

let client: PostgresClient | null = null;

function getClient(): PostgresClient {
  const connectionString = process.env.POSTGRES_URL;
  if (!connectionString) throw new Error("Shared route database is not configured.");
  if (!client) client = postgres(connectionString, { max: 1, idle_timeout: 20, connect_timeout: 10, prepare: false, ssl: "require" });
  return client;
}

export function isSharedRouteDatabaseConfigured() {
  return Boolean(process.env.POSTGRES_URL);
}
export const sharedRouteStore: RoutePersistenceStore = {
  getRoute: async (fingerprint, fingerprintVersion) => {
    const [row] = await getClient()`
      select fingerprint, fingerprint_version, normalized_geometry, normalized_distance_km,
             total_distance_km, representative_point_count,
             extract(epoch from created_at) * 1000 as created_at_ms,
             extract(epoch from updated_at) * 1000 as updated_at_ms
      from public.routes where fingerprint = ${fingerprint} and fingerprint_version = ${fingerprintVersion}
      limit 1`;
    if (!row) return null;
    return {
      routeFingerprint: row.fingerprint,
      routeFingerprintVersion: Number(row.fingerprint_version),
      normalizedGeometry: parseJson(row.normalized_geometry),
      normalizedDistanceKm: Number(row.normalized_distance_km),
      totalDistanceKm: Number(row.total_distance_km),
      representativePointCount: Number(row.representative_point_count),
      createdAt: Number(row.created_at_ms),
      updatedAt: Number(row.updated_at_ms),
    } satisfies PersistedRouteRecord;
  },

  getAnalysis: async (fingerprint, fingerprintVersion, analysisVersion) => {
    const [row] = await getClient()`
      select r.fingerprint, r.fingerprint_version, a.analysis_version, a.analysis_data,
             extract(epoch from a.generated_at) * 1000 as generated_at_ms
      from public.route_analyses a join public.routes r on r.id = a.route_id
      where r.fingerprint = ${fingerprint} and r.fingerprint_version = ${fingerprintVersion}
        and a.analysis_version = ${analysisVersion}
      limit 1`;
    if (!row) return null;
    return {
      routeFingerprint: row.fingerprint,
      routeFingerprintVersion: Number(row.fingerprint_version),
      analysisVersion: Number(row.analysis_version),
      generatedAt: Number(row.generated_at_ms),
      analysis: parseJson(row.analysis_data),
    } satisfies PersistedAnalysisRecord;
  },

  saveRouteAndAnalysis: async (route, analysis) => {
    const sql = getClient();
    await sql.begin(async (transaction) => {
      const [storedRoute] = await transaction`
        insert into public.routes (
          fingerprint, fingerprint_version, persistence_scope, normalized_geometry,
          normalized_distance_km, total_distance_km, representative_point_count
        ) values (
          ${route.routeFingerprint}, ${route.routeFingerprintVersion}, 'shared',
          ${asJson(transaction, route.normalizedGeometry)}, ${route.normalizedDistanceKm},
          ${route.totalDistanceKm}, ${route.representativePointCount}
        ) on conflict (fingerprint, fingerprint_version) do update
          set updated_at = greatest(routes.updated_at, excluded.updated_at)
        returning id`;
      if (!storedRoute) throw new Error("Shared route upsert returned no row.");
      await transaction`
        insert into public.route_analyses (route_id, analysis_version, analysis_data, generated_at)
        values (${storedRoute.id}, ${analysis.analysisVersion}, ${asJson(transaction, analysis.analysis)}, ${new Date(analysis.generatedAt)})
        on conflict (route_id, analysis_version) do nothing`;
    });
  },

  getOsm: async (fingerprint, fingerprintVersion, schemaVersion) => {
    const [row] = await getClient()`
      select r.fingerprint, r.fingerprint_version, e.schema_version, e.provider, e.route_length_km,
             e.retrieval_coverage_percent, e.classifiable_coverage_percent,
             e.retrieved_ranges, e.unavailable_ranges, e.classifiable_ranges, e.conflicts,
             e.current_merged_data, e.current_snapshots,
             extract(epoch from e.retrieved_at) * 1000 as retrieved_at_ms,
             extract(epoch from e.updated_at) * 1000 as updated_at_ms
      from public.route_osm_enrichments e join public.routes r on r.id = e.route_id
      where r.fingerprint = ${fingerprint} and r.fingerprint_version = ${fingerprintVersion}
        and e.schema_version = ${schemaVersion} and e.provider = 'overpass-api.de'
      limit 1`;
    if (!row) return null;
    const mergedData = parseJson<PersistedOsmEnrichmentRecord["mergedData"]>(row.current_merged_data);
    return {
      routeFingerprint: row.fingerprint,
      routeFingerprintVersion: Number(row.fingerprint_version),
      schemaVersion: Number(row.schema_version),
      provider: row.provider,
      source: mergedData.source,
      routeLengthKm: Number(row.route_length_km),
      snapshots: parseJson(row.current_snapshots),
      retrievedRanges: parseJson(row.retrieved_ranges),
      unavailableRanges: parseJson(row.unavailable_ranges),
      classifiableRanges: parseJson(row.classifiable_ranges),
      retrievalCoveragePercent: Number(row.retrieval_coverage_percent),
      classifiableCoveragePercent: Number(row.classifiable_coverage_percent),
      lastAttemptAt: Number(row.updated_at_ms),
      conflicts: parseJson(row.conflicts),
      mergedData,
    } satisfies PersistedOsmEnrichmentRecord;
  },

  putOsm: async (record) => {
    const sql = getClient();
    await sql.begin(async (transaction) => {
      const [route] = await transaction`
        select id from public.routes
        where fingerprint = ${record.routeFingerprint} and fingerprint_version = ${record.routeFingerprintVersion}
        for update`;
      if (!route) throw new Error("Shared route must exist before OSM enrichment can be saved.");
      await transaction`
        insert into public.route_osm_enrichments (
          route_id, schema_version, provider, route_length_km, current_merged_data, retrieved_at
        ) values (
          ${route.id}, ${record.schemaVersion}, ${record.provider}, ${record.routeLengthKm},
          ${asJson(transaction, record.mergedData)}, ${new Date(record.lastAttemptAt)}
        )
        on conflict (route_id, schema_version, provider) do nothing`;
      const [stored] = await transaction`
        select id, current_snapshots from public.route_osm_enrichments
        where route_id = ${route.id} and schema_version = ${record.schemaVersion} and provider = ${record.provider}
        for update`;
      if (!stored) throw new Error("Shared OSM enrichment lock returned no row.");
      const previousSnapshots = parseJson<PersistedOsmEnrichmentRecord["snapshots"]>(stored.current_snapshots ?? []);
      let merged: PersistedOsmEnrichmentRecord | null = null;
      const allSnapshots = [...previousSnapshots, ...record.snapshots]
        .sort((left, right) => left.retrievedAt - right.retrievedAt || left.snapshotId.localeCompare(right.snapshotId));
      for (const snapshot of allSnapshots) {
        merged = mergeOsmEnrichmentRecord(merged, snapshot, record.routeFingerprint, record.routeFingerprintVersion,
          record.routeLengthKm, record.schemaVersion, record.lastAttemptAt);
      }
      if (!merged) throw new Error("Shared OSM enrichment has no retrieval snapshot.");
      for (const snapshot of merged.snapshots) {
        const contentHash = createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
        await transaction`
          insert into public.route_osm_snapshots (
            enrichment_id, provider, content_hash, successful_ranges, unavailable_ranges,
            classifiable_ranges, diagnostics, provenance, snapshot_data, retrieved_at
          ) values (
            ${stored.id}, ${snapshot.provider}, ${contentHash}, ${asJson(transaction, snapshot.retrievedRanges)},
            ${asJson(transaction, snapshot.unavailableRanges)}, ${asJson(transaction, snapshot.classifiableRanges)},
            ${asJson(transaction, snapshot.data.retrieval ?? {})},
            ${asJson(transaction, { source: snapshot.data.source, attribution: snapshot.data.attribution })},
            ${asJson(transaction, snapshot)}, ${new Date(snapshot.retrievedAt)}
          ) on conflict (enrichment_id, content_hash) do nothing`;
      }
      await transaction`
        update public.route_osm_enrichments set
          route_length_km = ${merged.routeLengthKm},
          retrieval_coverage_percent = ${merged.retrievalCoveragePercent},
          classifiable_coverage_percent = ${merged.classifiableCoveragePercent},
          retrieved_ranges = ${asJson(transaction, merged.retrievedRanges)},
          unavailable_ranges = ${asJson(transaction, merged.unavailableRanges)},
          classifiable_ranges = ${asJson(transaction, merged.classifiableRanges)},
          conflicts = ${asJson(transaction, merged.conflicts)},
          current_merged_data = ${asJson(transaction, merged.mergedData)},
          current_snapshots = ${asJson(transaction, merged.snapshots)},
          retrieved_at = ${new Date(merged.lastAttemptAt)}, updated_at = now()
        where id = ${stored.id}`;
    });
  },

  getMapillary: async (fingerprint, fingerprintVersion, schemaVersion) => {
    const [row] = await getClient()`
      select r.fingerprint, r.fingerprint_version, m.schema_version,
             m.provider, m.enrichment_data,
             extract(epoch from m.retrieved_at) * 1000 as retrieved_at_ms
      from public.route_mapillary_enrichments m join public.routes r on r.id = m.route_id
      where r.fingerprint = ${fingerprint} and r.fingerprint_version = ${fingerprintVersion}
        and m.schema_version = ${schemaVersion} and m.provider = 'mapillary'
      limit 1`;
    if (!row) return null;
    return {
      routeFingerprint: row.fingerprint,
      routeFingerprintVersion: Number(row.fingerprint_version),
      schemaVersion: Number(row.schema_version),
      provider: row.provider,
      retrievedAt: Number(row.retrieved_at_ms),
      data: parseJson(row.enrichment_data),
    } satisfies PersistedMapillaryEnrichmentRecord;
  },

  putMapillary: async (record) => {
    const sql = getClient();
    await sql.begin(async (transaction) => {
      const [route] = await transaction`
        select id from public.routes
        where fingerprint = ${record.routeFingerprint} and fingerprint_version = ${record.routeFingerprintVersion}
        for update`;
      if (!route) throw new Error("Shared route must exist before Mapillary enrichment can be saved.");
      await transaction`
        insert into public.route_mapillary_enrichments (
          route_id, schema_version, provider, enrichment_data, retrieved_at
        ) values (
          ${route.id}, ${record.schemaVersion}, ${record.provider},
          ${asJson(transaction, record.data)}, ${new Date(record.retrievedAt)}
        ) on conflict (route_id, schema_version, provider) do nothing`;
      const [stored] = await transaction`
        select id, enrichment_data, retrieved_at from public.route_mapillary_enrichments
        where route_id = ${route.id} and schema_version = ${record.schemaVersion} and provider = ${record.provider}
        for update`;
      const mergedData = mergeMapillaryData(parseJson(stored.enrichment_data), record.data);
      await transaction`
        update public.route_mapillary_enrichments set
          enrichment_data = ${asJson(transaction, mergedData)},
          retrieved_at = greatest(retrieved_at, ${new Date(record.retrievedAt)}), updated_at = now()
        where id = ${stored.id}`;
    });
  },

  getRaceEditionReference: async (raceId, year) => {
    const [row] = await getClient()`
      select r.id as race_id, r.name as race_name, e.year, route.fingerprint,
             route.fingerprint_version, extract(epoch from rel.created_at) * 1000 as created_at_ms
      from public.race_edition_routes rel
      join public.race_editions e on e.id = rel.race_edition_id
      join public.races r on r.id = e.race_id
      join public.routes route on route.id = rel.route_id
      where r.id = ${raceId} and e.year = ${year} limit 1`;
    if (!row) return null;
    return {
      raceId: row.race_id, raceName: row.race_name, year: Number(row.year),
      routeFingerprint: row.fingerprint, routeFingerprintVersion: Number(row.fingerprint_version),
      createdAt: Number(row.created_at_ms),
    } satisfies RaceEditionRouteReference;
  },

  putRaceEditionReference: async (reference) => {
    const sql = getClient();
    await sql.begin(async (transaction) => {
      await transaction`
        insert into public.races (id, name) values (${reference.raceId}, ${reference.raceName})
        on conflict (id) do update set name = excluded.name, updated_at = now()`;
      const [edition] = await transaction`
        insert into public.race_editions (race_id, year) values (${reference.raceId}, ${reference.year})
        on conflict (race_id, year) do update set updated_at = now()
        returning id`;
      const [route] = await transaction`
        select id from public.routes
        where fingerprint = ${reference.routeFingerprint} and fingerprint_version = ${reference.routeFingerprintVersion}`;
      if (!route) throw new Error("Shared route must exist before race edition linkage.");
      await transaction`
        insert into public.race_edition_routes (race_edition_id, route_id)
        values (${edition.id}, ${route.id})
        on conflict (race_edition_id, route_id) do nothing`;
    });
  },
};

function asJson(sql: Pick<postgres.Sql, "json">, value: unknown) {
  return sql.json(JSON.parse(JSON.stringify(value)) as postgres.JSONValue);
}

function parseJson<T = JsonRecord>(value: unknown): T {
  if (typeof value === "string") return JSON.parse(value) as T;
  return value as T;
}
