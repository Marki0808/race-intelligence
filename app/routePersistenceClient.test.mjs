import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { lookupSharedRoute, runOptionalRouteLookup } from "./routePersistenceClient.ts";

const fingerprint = {
  routeFingerprint: "route-v2-sha256-test",
  routeFingerprintVersion: 2,
  normalizedGeometry: [],
  normalizedGeometrySegments: [],
  normalizedDistanceKm: 1,
};

test("a stalled shared-route request is aborted at the optional lookup deadline", async (t) => {
  const originalFetch = globalThis.fetch;
  let requestSignal;
  globalThis.fetch = (_input, init) => new Promise((_resolve, reject) => {
    requestSignal = init.signal;
    init.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
  });
  t.after(() => { globalThis.fetch = originalFetch; });

  const result = await runOptionalRouteLookup(
    (signal) => lookupSharedRoute(fingerprint, "analysis-input", { signal }),
    10,
  );
  assert.equal(result, null);
  assert.equal(requestSignal.aborted, true);
});

test("a failed shared-route request returns the local-only result", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new TypeError("offline"); };
  t.after(() => { globalThis.fetch = originalFetch; });

  const result = await lookupSharedRoute(fingerprint, "analysis-input");
  assert.deepEqual(result, { persistenceScope: "local", sharedEligible: false, persistenceAvailable: false, cache: null });
});

test("a successful shared-route response retains the existing cache lookup behavior", async (t) => {
  const originalFetch = globalThis.fetch;
  let requestBody;
  globalThis.fetch = async (_input, init) => {
    requestBody = JSON.parse(init.body);
    return Response.json({
      persistenceScope: "shared",
      sharedEligible: true,
      persistenceAvailable: true,
      analysis: { name: "Registry route" },
      osm: null,
      mapillary: null,
    });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const result = await lookupSharedRoute(fingerprint, "analysis-input", { includeOsm: false });
  assert.equal(result.persistenceScope, "shared");
  assert.equal(result.cache.analysis.name, "Registry route");
  assert.deepEqual(requestBody, {
    operation: "lookup",
    persistenceScope: "shared",
    routeFingerprint: fingerprint.routeFingerprint,
    routeFingerprintVersion: 2,
    analysisInputFingerprint: "analysis-input",
    includeOsm: false,
  });
});

test("Route Mode falls back to local analysis when optional fingerprinting or lookup expires", async () => {
  const source = await readFile(new URL("./RouteMode.tsx", import.meta.url), "utf8");
  assert.match(source, /runOptionalRouteLookup\(async \(signal\)/);
  assert.match(source, /if \(!requestGate\.current\.isCurrent\(requestId\)\) return;\s*let routeAnalysis/);
  assert.match(source, /else \{\s*routeAnalysis = \{ \.\.\.analyzeGpxRoute\(parsed\), name: displayName \};/);
});
