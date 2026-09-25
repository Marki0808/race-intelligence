import { enrichRouteWithOsm } from "../../geoEnrichmentService.ts";
import type { GeoRoutePoint } from "../../geoEnrichment.ts";

export const runtime = "nodejs";
export const maxDuration = 30;
const MAX_REQUEST_BYTES = 2_000_000;

export async function POST(request: Request) {
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > MAX_REQUEST_BYTES) {
    return Response.json({ error: "Route geometry is too large." }, { status: 413 });
  }
  let body: unknown;
  try {
    if (!request.body) return Response.json({ error: "Invalid route geometry." }, { status: 400 });
    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let byteLength = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > MAX_REQUEST_BYTES) {
        void reader.cancel();
        return Response.json({ error: "Route geometry is too large." }, { status: 413 });
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(byteLength);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    body = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    return Response.json({ error: "Invalid route geometry." }, { status: 400 });
  }

  if (!body || typeof body !== "object" || !("points" in body) || !Array.isArray(body.points)) {
    return Response.json({ error: "Invalid route geometry." }, { status: 400 });
  }
  const points: GeoRoutePoint[] = [];
  for (const item of body.points) {
    if (!item || typeof item !== "object") return Response.json({ error: "Invalid route geometry." }, { status: 400 });
    const point = item as Record<string, unknown>;
    if (
      typeof point.latitude !== "number" || !Number.isFinite(point.latitude) || Math.abs(point.latitude) > 90 ||
      typeof point.longitude !== "number" || !Number.isFinite(point.longitude) || Math.abs(point.longitude) > 180 ||
      typeof point.distanceM !== "number" || !Number.isFinite(point.distanceM) || point.distanceM < 0
    ) {
      return Response.json({ error: "Invalid route geometry." }, { status: 400 });
    }
    points.push({ latitude: point.latitude, longitude: point.longitude, distanceM: point.distanceM });
  }

  return Response.json(await enrichRouteWithOsm(points), {
    headers: { "Cache-Control": "no-store" },
  });
}
