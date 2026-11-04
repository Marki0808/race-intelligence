import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { lookupSharedRoute, runOptionalRouteLookup } from "./routePersistenceClient.ts";
import { SHARED_ROUTE_PERSISTENCE_V1_ENABLED } from "./featureFlags.ts";

const fingerprint = {
  routeFingerprint: "route-v2-sha256-test",
  routeFingerprintVersion: 2,
  normalizedGeometry: [],
  normalizedGeometrySegments: [],
  normalizedDistanceKm: 1,
};

test("optional V2 route lookup work is aborted at its deadline", async () => {
  let requestSignal;
  const result = await runOptionalRouteLookup(
    (signal) => new Promise((_resolve, reject) => {
      requestSignal = signal;
      signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    }),
    10,
  );
  assert.equal(result, null);
  assert.equal(requestSignal.aborted, true);
});

test("V1 route lookup stays local and never sends fingerprints to the server", async (t) => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => { requests += 1; throw new TypeError("must not be called"); };
  t.after(() => { globalThis.fetch = originalFetch; });

  const result = await lookupSharedRoute(fingerprint, "analysis-input");
  assert.equal(SHARED_ROUTE_PERSISTENCE_V1_ENABLED, false);
  assert.deepEqual(result, { persistenceScope: "local", sharedEligible: false, persistenceAvailable: false, cache: null });
  assert.equal(requests, 0);
});

test("disabled shared-route enrichment never sends a request", async (t) => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => { requests += 1; return Response.json({}); };
  t.after(() => { globalThis.fetch = originalFetch; });

  const { enrichSharedRoute } = await import("./routePersistenceClient.ts");
  await assert.rejects(enrichSharedRoute(fingerprint, { osm: true, mapillary: true }), /disabled/);
  assert.equal(requests, 0);
});

test("Route Mode retains local IndexedDB analysis and keeps remote lookup behind the V1 gate", async () => {
  const source = await readFile(new URL("./RouteMode.tsx", import.meta.url), "utf8");
  assert.match(source, /No route fingerprint or route geometry is sent to Endurset servers or checked against shared-route records/);
  assert.doesNotMatch(source, /route fingerprints are sent for shared-route eligibility checks/);
  assert.match(source, /runOptionalRouteLookup\(\(signal\) => lookupSharedRoute/);
  assert.match(source, /if \(SHARED_ROUTE_PERSISTENCE_V1_ENABLED\)/);
  assert.match(source, /getOrCreateRouteAnalysis\(/);
  assert.match(source, /getOrCreateRouteAnalysis\(\s*browserRoutePersistence/);
  assert.match(source, /setPersistenceScope\(shared\?\.persistenceScope \?\? "local"\)/);
  assert.match(source, /if \(!requestGate\.current\.isCurrent\(requestId\)\) return;\s*let shared/);
  assert.doesNotMatch(source, /fetch\(/);
});
