import { discoverOfficialGpx } from "../../officialGpxDiscovery.ts";

export const runtime = "nodejs";
export const maxDuration = 10;
const MAX_REQUEST_BYTES = 8_192;

export async function POST(request: Request) {
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
  if (!body || typeof body !== "object" || !("url" in body) || typeof body.url !== "string" || body.url.length > 2_048) {
    return Response.json({ status: "invalid-request" }, { status: 400 });
  }
  const result = await discoverOfficialGpx(body.url);
  const status = result.status === "invalid-url" || result.status === "unsafe-destination" ? 400
    : result.status === "provider-failure" && result.category === "busy" ? 429
      : result.status === "provider-failure" ? 502 : 200;
  return Response.json(result, { status, headers: { "Cache-Control": "no-store" } });
}
