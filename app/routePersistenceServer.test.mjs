import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createRouteFingerprint } from "./routeFingerprint.ts";
import { createAnalysisInputFingerprint } from "./analysisInputFingerprint.ts";
import { analyzeGpxRoute, parseGpxText } from "./gpxAnalysis.ts";
import { lookupSharedRoute } from "./api/route-persistence/route.ts";
import { getOrCreateRouteAnalysis } from "./routePersistence.ts";
import { getSharedRouteEligibility } from "./sharedRouteEligibility.ts";
import { validatePersistenceRequest } from "./routePersistenceValidation.ts";

const validFingerprint = `route-v2-sha256-${"a".repeat(64)}`;
const validAnalysisInputFingerprint = `analysis-input-v2-sha256-${"b".repeat(64)}`;
let registeredIstriaPromise;

function getRegisteredIstria() {
  registeredIstriaPromise ??= (async () => {
    const source = await readFile(new URL("../public/ISTRIA_110K_2027.gpx", import.meta.url), "utf8");
    const parsed = parseGpxText(source);
    const fingerprint = await createRouteFingerprint(parsed.points);
    const eligible = await getSharedRouteEligibility(fingerprint.routeFingerprint, fingerprint.routeFingerprintVersion);
    assert.ok(eligible);
    return { parsed, eligible };
  })();
  return registeredIstriaPromise;
}

function createLookupDependencies() {
  const calls = { analysisReads: 0, analysisWrites: 0, routeReads: 0, raceReferenceWrites: 0 };
  const analyses = new Map();
  let route = null;
  const store = {
    getAnalysis: async (_fingerprint, _fingerprintVersion, version, inputFingerprint) => {
      calls.analysisReads += 1;
      return analyses.get(`${version}:${inputFingerprint}`) ?? null;
    },
    getRoute: async () => { calls.routeReads += 1; return route; },
    saveRouteAndAnalysis: async (storedRoute, record) => {
      calls.analysisWrites += 1;
      route = storedRoute;
      analyses.set(`${record.analysisVersion}:${record.analysisInputFingerprint}`, record);
    },
    putRaceEditionReference: async () => { calls.raceReferenceWrites += 1; },
    getOsm: async () => null,
    getMapillary: async () => null,
  };
  return { calls, store, dependencies: { isDatabaseConfigured: () => true, store } };
}

test("server persistence API accepts only supported, version-matched request shapes", () => {
  assert.deepEqual(validatePersistenceRequest({
    operation: "lookup", persistenceScope: "shared", routeFingerprint: validFingerprint, routeFingerprintVersion: 2,
    analysisInputFingerprint: validAnalysisInputFingerprint,
  }), { operation: "lookup", persistenceScope: "shared", routeFingerprint: validFingerprint, routeFingerprintVersion: 2, analysisInputFingerprint: validAnalysisInputFingerprint });
  assert.deepEqual(validatePersistenceRequest({
    operation: "enrich", persistenceScope: "shared", routeFingerprint: validFingerprint,
    routeFingerprintVersion: 2, needs: { osm: true, mapillary: false },
  })?.operation, "enrich");
  for (const input of [
    null,
    [],
    { operation: "lookup", persistenceScope: "local", routeFingerprint: validFingerprint, routeFingerprintVersion: 2 },
    { operation: "query", persistenceScope: "shared", routeFingerprint: validFingerprint, routeFingerprintVersion: 2 },
    { operation: "lookup", persistenceScope: "shared", routeFingerprint: validFingerprint, routeFingerprintVersion: 2 },
    { operation: "lookup", persistenceScope: "shared", routeFingerprint: validFingerprint, routeFingerprintVersion: 2 },
    { operation: "lookup", persistenceScope: "shared", routeFingerprint: validFingerprint, routeFingerprintVersion: 2, analysisInputFingerprint: "not-a-hash" },
    { operation: "enrich", persistenceScope: "shared", routeFingerprint: validFingerprint, routeFingerprintVersion: 2, needs: { osm: false, mapillary: false } },
    { operation: "lookup", persistenceScope: "shared", routeFingerprint: validFingerprint, routeFingerprintVersion: 2, sql: "select *" },
  ]) assert.equal(validatePersistenceRequest(input), null);
});

test("an arbitrary uploaded route fingerprint is not eligible for shared persistence", async () => {
  const privateRoute = await createRouteFingerprint([
    { latitude: 46.1, longitude: 14.1 },
    { latitude: 46.11, longitude: 14.11 },
  ]);
  assert.equal(await getSharedRouteEligibility(privateRoute.routeFingerprint, privateRoute.routeFingerprintVersion), null);
});

test("registry eligibility remains physical-route based when uploaded elevation differs", async () => {
  const source = await readFile(new URL("../public/ISTRIA_110K_2027.gpx", import.meta.url), "utf8");
  const parsed = parseGpxText(source);
  const changedElevation = parsed.points.map((point, index) => ({
    ...point,
    elevationM: point.elevationM + (index === Math.floor(parsed.points.length / 2) ? 25 : 0),
  }));
  const [physical, changedPhysical, input, changedInput] = await Promise.all([
    createRouteFingerprint(parsed.points), createRouteFingerprint(changedElevation),
    createAnalysisInputFingerprint(parsed.points), createAnalysisInputFingerprint(changedElevation),
  ]);
  assert.equal(physical.routeFingerprint, changedPhysical.routeFingerprint);
  assert.notEqual(input, changedInput);
  const eligible = await getSharedRouteEligibility(changedPhysical.routeFingerprint, changedPhysical.routeFingerprintVersion);
  assert.ok(eligible);
  assert.equal(eligible.analysisInputFingerprint, input);
  assert.notEqual(eligible.analysisInputFingerprint, changedInput);
});

test("shared analysis lookup persists only a matching registry input and mismatches remain local", async () => {
  const { parsed, eligible } = await getRegisteredIstria();

  const matching = createLookupDependencies();
  const firstResponse = await lookupSharedRoute(eligible, eligible.analysisInputFingerprint, matching.dependencies);
  const firstBody = await firstResponse.json();
  const repeatedResponse = await lookupSharedRoute(eligible, eligible.analysisInputFingerprint, matching.dependencies);
  const repeatedBody = await repeatedResponse.json();
  assert.equal(firstBody.analysis.metrics.distanceKm, eligible.analysis.metrics.distanceKm);
  assert.equal(repeatedBody.analysis.metrics.distanceKm, eligible.analysis.metrics.distanceKm);
  assert.equal(matching.calls.analysisReads, 2);
  assert.equal(matching.calls.analysisWrites, 1);
  assert.equal(matching.calls.raceReferenceWrites, 2);

  const changedPoints = parsed.points.map((point, index) => ({
    ...point,
    elevationM: point.elevationM + (index === Math.floor(parsed.points.length / 2) ? 25 : 0),
  }));
  const [changedPhysical, changedInput] = await Promise.all([
    createRouteFingerprint(changedPoints), createAnalysisInputFingerprint(changedPoints),
  ]);
  assert.equal(changedPhysical.routeFingerprint, eligible.routeFingerprint);
  assert.notEqual(changedInput, eligible.analysisInputFingerprint);
  const validatedRequest = validatePersistenceRequest({
    operation: "lookup", persistenceScope: "shared", routeFingerprint: changedPhysical.routeFingerprint,
    routeFingerprintVersion: changedPhysical.routeFingerprintVersion, analysisInputFingerprint: changedInput,
  });
  assert.ok(validatedRequest);

  const mismatch = createLookupDependencies();
  const mismatchResponse = await lookupSharedRoute(eligible, validatedRequest.analysisInputFingerprint, mismatch.dependencies);
  const mismatchBody = await mismatchResponse.json();
  assert.equal(mismatchBody.sharedEligible, true);
  assert.equal(mismatchBody.analysis, null);
  assert.equal(mismatch.calls.analysisReads, 0);
  assert.equal(mismatch.calls.analysisWrites, 0);
  assert.equal(mismatch.calls.routeReads, 0);
  assert.equal(mismatch.calls.raceReferenceWrites, 0);

  const localAnalyses = new Map();
  let localRoute = null;
  const localStore = {
    getRoute: async () => localRoute,
    getAnalysis: async (routeFingerprint, routeVersion, analysisVersion, inputFingerprint) =>
      localAnalyses.get(`${routeFingerprint}:${routeVersion}:${analysisVersion}:${inputFingerprint}`) ?? null,
    saveRouteAndAnalysis: async (route, analysis) => {
      localRoute = route;
      localAnalyses.set(`${analysis.routeFingerprint}:${analysis.routeFingerprintVersion}:${analysis.analysisVersion}:${analysis.analysisInputFingerprint}`, analysis);
    },
  };
  let localCalculations = 0;
  const calculateLocally = () => getOrCreateRouteAnalysis(
    localStore,
    changedPhysical,
    changedInput,
    "elevation variant",
    () => { localCalculations += 1; return analyzeGpxRoute({ points: changedPoints }); },
  );
  const computed = await calculateLocally();
  const cached = await calculateLocally();
  assert.equal(computed.cacheHit, false);
  assert.equal(cached.cacheHit, true);
  assert.equal(localCalculations, 1);
  assert.equal(localAnalyses.size, 1);
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

test("analysis-input migration preserves legacy rows and enforces variant-aware non-null uniqueness", async () => {
  const migration = await readFile(new URL("../supabase/migrations/202610040001_route_analysis_input_identity.sql", import.meta.url), "utf8");
  assert.match(migration, /add column if not exists analysis_input_fingerprint text/i);
  assert.match(migration, /drop constraint if exists route_analyses_route_version_unique/i);
  assert.match(migration, /unique index if not exists route_analyses_input_identity_unique_idx/i);
  assert.match(migration, /route_id, analysis_version, analysis_input_fingerprint/i);
  assert.match(migration, /where analysis_input_fingerprint is not null/i);
  assert.doesNotMatch(migration, /delete\s+from|truncate|drop\s+table|alter\s+table\s+public\.(?!route_analyses)/i);

  const store = await readFile(new URL("./server/sharedRouteStore.ts", import.meta.url), "utf8");
  assert.match(store, /a\.analysis_input_fingerprint = \$\{analysisInputFingerprint\}/i);
  assert.match(store, /route_id, analysis_version, analysis_input_fingerprint, analysis_data/i);
  assert.match(store, /values \(\$\{storedRoute\.id\}, \$\{analysis\.analysisVersion\}, \$\{analysis\.analysisInputFingerprint\}/i);
  assert.match(store, /on conflict do nothing/i);
});
