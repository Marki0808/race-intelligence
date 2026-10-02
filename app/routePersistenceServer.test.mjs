import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createRouteFingerprint } from "./routeFingerprint.ts";
import { getSharedRouteEligibility } from "./sharedRouteEligibility.ts";
import { validatePersistenceRequest } from "./routePersistenceValidation.ts";

const validFingerprint = `route-v1-sha256-${"a".repeat(64)}`;

test("server persistence API accepts only supported, version-matched request shapes", () => {
  assert.deepEqual(validatePersistenceRequest({
    operation: "lookup", persistenceScope: "shared", routeFingerprint: validFingerprint, routeFingerprintVersion: 1,
  }), { operation: "lookup", persistenceScope: "shared", routeFingerprint: validFingerprint, routeFingerprintVersion: 1 });
  assert.deepEqual(validatePersistenceRequest({
    operation: "enrich", persistenceScope: "shared", routeFingerprint: validFingerprint,
    routeFingerprintVersion: 1, needs: { osm: true, mapillary: false },
  })?.operation, "enrich");
  for (const input of [
    null,
    [],
    { operation: "lookup", persistenceScope: "local", routeFingerprint: validFingerprint, routeFingerprintVersion: 1 },
    { operation: "query", persistenceScope: "shared", routeFingerprint: validFingerprint, routeFingerprintVersion: 1 },
    { operation: "lookup", persistenceScope: "shared", routeFingerprint: validFingerprint, routeFingerprintVersion: 2 },
    { operation: "enrich", persistenceScope: "shared", routeFingerprint: validFingerprint, routeFingerprintVersion: 1, needs: { osm: false, mapillary: false } },
    { operation: "lookup", persistenceScope: "shared", routeFingerprint: validFingerprint, routeFingerprintVersion: 1, sql: "select *" },
  ]) assert.equal(validatePersistenceRequest(input), null);
});

test("an arbitrary uploaded route fingerprint is not eligible for shared persistence", async () => {
  const privateRoute = await createRouteFingerprint([
    { latitude: 46.1, longitude: 14.1 },
    { latitude: 46.11, longitude: 14.11 },
  ]);
  assert.equal(await getSharedRouteEligibility(privateRoute.routeFingerprint, privateRoute.routeFingerprintVersion), null);
});

test("client persistence entry points do not reference privileged database variables", async () => {
  const clientFiles = ["RouteMode.tsx", "RouteAnalysisView.tsx", "routePersistenceClient.ts"];
  for (const file of clientFiles) {
    const source = await readFile(new URL(`./${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /POSTGRES_URL|SUPABASE_SERVICE_ROLE_KEY|SUPABASE_SECRET_KEY|POSTGRES_PASSWORD/);
  }
});

test("shared-route migration requires explicit sharing and keeps normalized, restrictive relationships", async () => {
  const migration = await readFile(new URL("../supabase/migrations/202610020001_route_persistence.sql", import.meta.url), "utf8");
  const routes = migration.match(/create table if not exists public\.routes \(([\s\S]*?)\n\);/i)?.[1] ?? "";
  assert.match(routes, /persistence_scope text not null check \(persistence_scope = 'shared'\)/i);
  assert.doesNotMatch(routes, /persistence_scope[^,\n]*default/i);

  const mapillary = migration.match(/create table if not exists public\.route_mapillary_enrichments \(([\s\S]*?)\n\);/i)?.[1] ?? "";
  assert.doesNotMatch(mapillary, /analysis_version/i);
  assert.match(mapillary, /unique \(route_id, schema_version, provider\)/i);

  const editionRoutes = migration.match(/create table if not exists public\.race_edition_routes \(([\s\S]*?)\n\);/i)?.[1] ?? "";
  assert.match(editionRoutes, /route_id uuid not null references public\.routes\(id\) on delete restrict/i);
  assert.doesNotMatch(editionRoutes, /route_fingerprint/);
  assert.equal((migration.match(/on delete restrict/gi) ?? []).length, 7);

  for (const table of ["routes", "route_analyses", "route_osm_enrichments", "route_osm_snapshots", "route_mapillary_enrichments", "races", "race_editions", "race_edition_routes"]) {
    assert.match(migration, new RegExp(`alter table public\\.${table} enable row level security`, "i"));
  }
  assert.doesNotMatch(migration, /^\s*(?:drop|truncate|delete|replace)\b/im);
  assert.doesNotMatch(migration, /create policy/i);

  const store = await readFile(new URL("./server/sharedRouteStore.ts", import.meta.url), "utf8");
  assert.match(store, /fingerprint, fingerprint_version, persistence_scope, normalized_geometry/i);
  assert.match(store, /values \([\s\S]*?'shared'/i);
  assert.match(store, /insert into public\.race_edition_routes \(race_edition_id, route_id\)/i);
});
