import { downloadDiscoveredGpx, type OfficialGpxDownloadResult } from "../../officialGpxDownload.ts";

export const runtime = "nodejs";
export const maxDuration = 30;
const MAX_REQUEST_BYTES = 8_192;

function failureResponse(result: Exclude<OfficialGpxDownloadResult, { status: "success" }>) {
  const status = result.status === "invalid-url" || result.status === "unsafe-destination" ? 400
    : result.status === "candidate-not-found" ? 409
      : result.status === "invalid-gpx" ? 422
        : result.status === "provider-failure" && result.category === "busy" ? 429
          : result.status === "provider-failure" && result.category === "timeout" ? 504 : 502;
  return Response.json({ status: result.status, ...(result.status === "provider-failure" ? { category: result.category } : {}) }, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

export function createRaceGpxDownloadPost(download = downloadDiscoveredGpx) {
  return async function POST(request: Request) {
    const contentLength = Number(request.headers.get("content-length") ?? 0);
    if (contentLength > MAX_REQUEST_BYTES) return Response.json({ status: "invalid-request" }, { status: 413 });
    let body: unknown;
    try {
      if (!request.body) return Response.json({ status: "invalid-request" }, { status: 400 });
      const reader = request.body.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > MAX_REQUEST_BYTES) {
          void reader.cancel();
          return Response.json({ status: "invalid-request" }, { status: 413 });
        }
        chunks.push(value);
      }
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      body = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    } catch {
      return Response.json({ status: "invalid-request" }, { status: 400 });
    }
    if (!body || typeof body !== "object" || !("sourcePageUrl" in body) || !("gpxUrl" in body) ||
      typeof body.sourcePageUrl !== "string" || typeof body.gpxUrl !== "string" ||
      body.sourcePageUrl.length > 2_048 || body.gpxUrl.length > 2_048) {
      return Response.json({ status: "invalid-request" }, { status: 400 });
    }

    const result = await download(body.sourcePageUrl, body.gpxUrl);
    if (result.status !== "success") return failureResponse(result);
    return new Response(result.text, {
      status: 200,
      headers: {
        "Content-Type": "application/gpx+xml; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  };
}

export const POST = createRaceGpxDownloadPost();
