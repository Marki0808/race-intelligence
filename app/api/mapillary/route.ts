import { lookupMapillaryTerrainProof, validateMapillarySections } from "../../mapillaryTerrainProof.ts";

export const runtime = "nodejs";
export const maxDuration = 30;
const MAX_REQUEST_BYTES = 1_500_000;

export async function POST(request: Request) {
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > MAX_REQUEST_BYTES) return Response.json({ error: "Terrain section geometry is too large." }, { status: 413 });
  let body: unknown;
  try {
    if (!request.body) return Response.json({ error: "Invalid terrain section geometry." }, { status: 400 });
    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_REQUEST_BYTES) {
        void reader.cancel();
        return Response.json({ error: "Terrain section geometry is too large." }, { status: 413 });
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    body = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    return Response.json({ error: "Invalid terrain section geometry." }, { status: 400 });
  }
  const sections = validateMapillarySections(body);
  if (!sections) return Response.json({ error: "Invalid terrain section geometry." }, { status: 400 });
  const data = await lookupMapillaryTerrainProof(sections, process.env.MAPILLARY_ACCESS_TOKEN);
  return Response.json(data, { headers: { "Cache-Control": "no-store" } });
}
