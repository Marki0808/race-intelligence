import { enrichRouteWithOsm, GEO_ENRICHMENT_REQUEST_BUDGET_MS } from "../../geoEnrichmentService.ts";
import type { GeoRoutePoint } from "../../geoEnrichment.ts";
import { createGeoEnrichmentDiagnostics } from "../../geoEnrichmentDiagnostics.ts";

export const runtime = "nodejs";
export const maxDuration = 30;
const MAX_REQUEST_BYTES = 2_000_000;

export async function POST(request: Request) {
  const deadlineSignal = AbortSignal.timeout(GEO_ENRICHMENT_REQUEST_BUDGET_MS);
  const budgetSignal = AbortSignal.any([request.signal, deadlineSignal]);
  const diagnostics = createGeoEnrichmentDiagnostics({ clientSignal: request.signal, deadlineSignal });
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > MAX_REQUEST_BYTES) {
    diagnostics.finish({ outcome: "input_rejected" });
    return Response.json({ error: "Route geometry is too large." }, { status: 413 });
  }
  let body: unknown;
  try {
    if (!request.body) {
      diagnostics.finish({ outcome: "input_rejected" });
      return Response.json({ error: "Invalid route geometry." }, { status: 400 });
    }
    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let byteLength = 0;
    while (true) {
      const { done, value } = await readWithAbort(reader, budgetSignal);
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > MAX_REQUEST_BYTES) {
        void reader.cancel();
        diagnostics.finish({ outcome: "input_rejected" });
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
    if (budgetSignal.aborted) {
      diagnostics.finish({ outcome: deadlineSignal.aborted ? "deadline" : "client_cancelled" });
      return Response.json({ error: "Geo enrichment request timed out." }, { status: 504 });
    }
    diagnostics.finish({ outcome: "input_rejected" });
    return Response.json({ error: "Invalid route geometry." }, { status: 400 });
  }

  if (!body || typeof body !== "object" || !("points" in body) || !Array.isArray(body.points)) {
    diagnostics.finish({ outcome: "input_rejected" });
    return Response.json({ error: "Invalid route geometry." }, { status: 400 });
  }
  const points: GeoRoutePoint[] = [];
  for (const item of body.points) {
    if (!item || typeof item !== "object") {
      diagnostics.finish({ outcome: "input_rejected", routePointCount: points.length });
      return Response.json({ error: "Invalid route geometry." }, { status: 400 });
    }
    const point = item as Record<string, unknown>;
    if (
      typeof point.latitude !== "number" || !Number.isFinite(point.latitude) || Math.abs(point.latitude) > 90 ||
      typeof point.longitude !== "number" || !Number.isFinite(point.longitude) || Math.abs(point.longitude) > 180 ||
      typeof point.distanceM !== "number" || !Number.isFinite(point.distanceM) || point.distanceM < 0 ||
      (point.segmentIndex !== undefined && (typeof point.segmentIndex !== "number" || !Number.isInteger(point.segmentIndex) || point.segmentIndex < 0))
    ) {
      diagnostics.finish({ outcome: "input_rejected", routePointCount: points.length });
      return Response.json({ error: "Invalid route geometry." }, { status: 400 });
    }
    points.push({ latitude: point.latitude, longitude: point.longitude, distanceM: point.distanceM, segmentIndex: typeof point.segmentIndex === "number" ? point.segmentIndex : 0 });
  }

  try {
    return Response.json(await enrichRouteWithOsm(points, { signal: budgetSignal, diagnostics }), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    diagnostics.finish({
      outcome: deadlineSignal.aborted ? "deadline" : request.signal.aborted ? "client_cancelled" : "query_unavailable",
      routePointCount: points.length,
      componentCount: new Set(points.map((point) => point.segmentIndex ?? 0)).size,
    });
    throw error;
  }
}

async function readWithAbort(reader: ReadableStreamDefaultReader<Uint8Array>, signal: AbortSignal) {
  if (signal.aborted) throw signal.reason;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_resolve, reject) => {
        onAbort = () => {
          void reader.cancel(signal.reason);
          reject(signal.reason);
        };
        signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}
