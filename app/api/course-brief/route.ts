export const runtime = "nodejs";

/** Course Brief is generated locally in V1; the former external API is disabled. */
export async function POST(): Promise<Response> {
  return Response.json(
    { error: "not_found" },
    { status: 404, headers: { "Cache-Control": "no-store" } },
  );
}
