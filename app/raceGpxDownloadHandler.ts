import { randomUUID } from "node:crypto";
import { downloadDiscoveredGpx, type OfficialGpxDownloadResult } from "./officialGpxDownload.ts";
import type { HtmlTableParserDiagnostics } from "./aidStationExtraction.ts";

const MAX_REQUEST_BYTES = 8_192;

function failureResponse(result: Exclude<OfficialGpxDownloadResult, { status: "success" }>) {
  const status = result.status === "invalid-url" || result.status === "unsafe-destination" ? 400
    : result.status === "candidate-not-found" || result.status === "archive-changed" ? 409
      : ["invalid-gpx", "invalid-archive", "unsafe-archive", "archive-too-large", "no-gpx-in-archive"].includes(result.status) ? 422
        : result.status === "provider-failure" && result.category === "busy" ? 429
          : result.status === "provider-failure" && result.category === "timeout" ? 504 : 502;
  return Response.json({ status: result.status, ...(result.status === "provider-failure" ? { category: result.category, ...(result.reason ? { reason: result.reason } : {}) } : {}) }, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

export function createRaceGpxDownloadPost(
  download = downloadDiscoveredGpx,
  logParserDiagnostic: (diagnostic: HtmlTableParserDiagnostics & { requestId: string }) => void = (diagnostic) => {
    console.info("[aid-station-discovery] HTML table parser", diagnostic);
  },
) {
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
    if (!body || typeof body !== "object" || !("sourcePageUrl" in body) ||
      typeof body.sourcePageUrl !== "string" || body.sourcePageUrl.length > 2_048) {
      return Response.json({ status: "invalid-request" }, { status: 400 });
    }

    const resourceType = "resourceType" in body ? body.resourceType : "gpx";
    const resourceUrl = (resourceType === "zip" || resourceType === "zip-entry") && "archiveUrl" in body ? body.archiveUrl
      : resourceType === "gpx" && "gpxUrl" in body ? body.gpxUrl : undefined;
    const archiveDigest = "archiveDigest" in body ? body.archiveDigest : undefined;
    const entryId = "entryId" in body ? body.entryId : undefined;
    if ((resourceType !== "gpx" && resourceType !== "zip" && resourceType !== "zip-entry") || typeof resourceUrl !== "string" || resourceUrl.length > 2_048 ||
      (resourceType === "zip-entry" && (typeof archiveDigest !== "string" || typeof entryId !== "string"))) {
      return Response.json({ status: "invalid-request" }, { status: 400 });
    }

    const requestId = randomUUID();
    const result = await download(
      body.sourcePageUrl,
      resourceUrl,
      resourceType,
      archiveDigest as string | undefined,
      entryId as string | undefined,
      (diagnostics) => {
        try { logParserDiagnostic({ requestId, ...diagnostics }); } catch { /* diagnostics cannot affect the download response */ }
      },
    );
    if (result.status === "archive-choices") {
      return Response.json({ status: result.status, archiveDigest: result.archiveDigest, files: result.files }, {
        status: 200,
        headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
      });
    }
    if (result.status !== "success") return failureResponse(result);
    const multipartBody = new FormData();
    multipartBody.set("gpxText", new Blob([result.text], { type: "application/gpx+xml; charset=utf-8" }), "selected-route.gpx");
    multipartBody.set("aidStationDiscoveryV1", JSON.stringify(result.aidStationDiscoveryV1 ?? null));
    return new Response(multipartBody, {
      status: 200,
      headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
    });
  };
}

export const POST = createRaceGpxDownloadPost();
