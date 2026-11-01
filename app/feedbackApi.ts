import { isIP } from "node:net";
import { MAX_FEEDBACK_CHARACTERS, MAX_FEEDBACK_REQUEST_BYTES } from "./feedbackContract.ts";

export type FeedbackSaveResult = "stored" | "rate_limited";
export type FeedbackSaver = (feedback: string, clientAddress: string) => Promise<FeedbackSaveResult>;
export type ClientAddressResolver = (request: Request) => string | null;

export function createFeedbackPostHandler(
  saveFeedback: FeedbackSaver,
  resolveClientAddress: ClientAddressResolver = getTrustedClientAddress,
) {
  return async function POST(request: Request): Promise<Response> {
    if (!(request.headers.get("content-type") ?? "").toLowerCase().includes("application/json")) {
      return errorResponse("unsupported_content_type", 415);
    }
    const body = await readBoundedJson(request);
    if (!body.ok) return errorResponse(body.error, body.status);
    if (typeof body.value !== "object" || body.value === null || Array.isArray(body.value)) {
      return errorResponse("invalid_feedback", 400);
    }
    const feedbackValue = (body.value as Record<string, unknown>).feedback;
    if (typeof feedbackValue !== "string") return errorResponse("invalid_feedback", 400);
    const feedback = feedbackValue.trim();
    if (!feedback) return errorResponse("empty_feedback", 400);
    if (Array.from(feedback).length > MAX_FEEDBACK_CHARACTERS) return errorResponse("feedback_too_long", 413);

    const clientAddress = resolveClientAddress(request);
    if (!clientAddress) return errorResponse("feedback_unavailable", 503);
    try {
      const result = await saveFeedback(feedback, clientAddress);
      if (result === "rate_limited") return errorResponse("rate_limited", 429);
      return Response.json({ success: true }, { status: 201, headers: { "Cache-Control": "no-store" } });
    } catch {
      return errorResponse("feedback_unavailable", 503);
    }
  };
}

/** Vercel overwrites this header at the edge; local development falls back to its forwarded address. */
export function getTrustedClientAddress(request: Request): string | null {
  const forwarded = process.env.NODE_ENV === "production"
    ? request.headers.get("x-vercel-forwarded-for")
    : request.headers.get("x-vercel-forwarded-for") ?? request.headers.get("x-forwarded-for");
  const address = forwarded?.trim() ?? "";
  return address && isIP(address) ? address : null;
}

async function readBoundedJson(request: Request): Promise<
  | { ok: true; value: unknown }
  | { ok: false; status: 400 | 413; error: string }
> {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    const parsedLength = Number(contentLength);
    if (Number.isFinite(parsedLength) && parsedLength > MAX_FEEDBACK_REQUEST_BYTES) return { ok: false, status: 413, error: "request_too_large" };
  }
  if (!request.body) return { ok: false, status: 400, error: "invalid_request" };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_FEEDBACK_REQUEST_BYTES) {
        void reader.cancel().catch(() => undefined);
        return { ok: false, status: 413, error: "request_too_large" };
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    return { ok: true, value };
  } catch {
    return { ok: false, status: 400, error: "invalid_request" };
  } finally {
    reader.releaseLock();
  }
}

function errorResponse(error: string, status: number) {
  return Response.json({ error }, { status, headers: { "Cache-Control": "no-store" } });
}
