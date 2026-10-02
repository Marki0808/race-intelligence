import { checkSharedRouteDatabaseConnectivity } from "../../server/sharedRouteStore.ts";

// TEMPORARY PRODUCTION DIAGNOSTIC. Remove this route after the deployed runtime is verified.
export const runtime = "nodejs";

export async function GET() {
  if (process.env.VERCEL_ENV !== "production") {
    return Response.json({
      ok: false,
      databaseReachable: false,
      routesReachable: false,
      expectedTablesReachable: false,
      expectedTableCount: 0,
      errorCategory: "production_only",
    }, {
      status: 404,
      headers: { "Cache-Control": "no-store" },
    });
  }

  const result = await checkSharedRouteDatabaseConnectivity();
  return Response.json(result, {
    status: result.ok ? 200 : 503,
    headers: { "Cache-Control": "no-store" },
  });
}
