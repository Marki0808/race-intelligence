import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyDatabaseDiagnosticError,
  EXPECTED_SHARED_ROUTE_TABLES,
} from "./server/sharedRouteStore.ts";
import { GET } from "./api/temporary-production-db-diagnostic/route.ts";

test("production database diagnostic probes exactly the expected shared tables", () => {
  assert.equal(EXPECTED_SHARED_ROUTE_TABLES.length, 8);
  assert.equal(new Set(EXPECTED_SHARED_ROUTE_TABLES).size, 8);
  assert.deepEqual([...EXPECTED_SHARED_ROUTE_TABLES], [
    "routes",
    "route_analyses",
    "route_osm_enrichments",
    "route_osm_snapshots",
    "route_mapillary_enrichments",
    "races",
    "race_editions",
    "race_edition_routes",
  ]);
});

test("diagnostic errors are reduced to safe categories without exposing messages", () => {
  assert.equal(classifyDatabaseDiagnosticError({ code: "28P01", message: "private connection details" }), "authentication_failed");
  assert.equal(classifyDatabaseDiagnosticError({ code: "ETIMEDOUT", message: "private connection details" }), "connection_failed");
  assert.equal(classifyDatabaseDiagnosticError({ code: "42P01", message: "private connection details" }), "schema_mismatch");
  assert.equal(classifyDatabaseDiagnosticError({ code: "42501", message: "private connection details" }), "permission_denied");
  assert.equal(classifyDatabaseDiagnosticError({ message: "private connection details" }), "diagnostic_failed");
});

test("temporary production diagnostic is unavailable outside Vercel Production", async () => {
  const originalEnvironment = process.env.VERCEL_ENV;
  process.env.VERCEL_ENV = "preview";
  try {
    const response = await GET();
    assert.equal(response.status, 404);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), {
      ok: false,
      databaseReachable: false,
      routesReachable: false,
      expectedTablesReachable: false,
      expectedTableCount: 0,
      errorCategory: "production_only",
    });
  } finally {
    if (originalEnvironment === undefined) delete process.env.VERCEL_ENV;
    else process.env.VERCEL_ENV = originalEnvironment;
  }
});
