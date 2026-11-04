import { isIP } from "node:net";
import { NEWSLETTER_MAX_EMAIL_CHARACTERS, NEWSLETTER_MAX_REQUEST_BYTES, normalizeNewsletterEmail } from "./newsletterContract.ts";

export type NewsletterSaveResult = "recorded" | "rate_limited";
export type NewsletterSaver = (email: string, clientAddress: string) => Promise<NewsletterSaveResult>;

export function createNewsletterPostHandler(saveNewsletter: NewsletterSaver) {
  return async function POST(request: Request): Promise<Response> {
    if (!(request.headers.get("content-type") ?? "").toLowerCase().includes("application/json")) {
      return errorResponse("unsupported_content_type", 415);
    }
    const body = await readBoundedJson(request);
    if (!body.ok) return errorResponse(body.error, body.status);
    if (typeof body.value !== "object" || body.value === null || Array.isArray(body.value)) return errorResponse("invalid_request", 400);
    const input = body.value as Record<string, unknown>;
    if (typeof input.email !== "string") return errorResponse("invalid_email", 400);
    if (input.email.length > NEWSLETTER_MAX_EMAIL_CHARACTERS) return errorResponse("email_too_long", 413);
    if (input.consent !== true) return errorResponse("consent_required", 400);
    const email = normalizeNewsletterEmail(input.email);
    if (!email) return errorResponse("invalid_email", 400);
    const clientAddress = getTrustedClientAddress(request);
    if (!clientAddress) return errorResponse("newsletter_unavailable", 503);
    try {
      const result = await saveNewsletter(email, clientAddress);
      if (result === "rate_limited") return errorResponse("rate_limited", 429);
      // Deliberately identical for new and existing addresses; never confirms address membership.
      return Response.json({ success: true }, { status: 201, headers: { "Cache-Control": "no-store" } });
    } catch {
      return errorResponse("newsletter_unavailable", 503);
    }
  };
}

/** Vercel overwrites x-vercel-forwarded-for at the edge. */
function getTrustedClientAddress(request: Request): string | null {
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
    if (Number.isFinite(parsedLength) && parsedLength > NEWSLETTER_MAX_REQUEST_BYTES) return { ok: false, status: 413, error: "request_too_large" };
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
      if (length > NEWSLETTER_MAX_REQUEST_BYTES) {
        void reader.cancel().catch(() => undefined);
        return { ok: false, status: 413, error: "request_too_large" };
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return { ok: true, value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown };
  } catch {
    return { ok: false, status: 400, error: "invalid_request" };
  } finally {
    reader.releaseLock();
  }
}

function errorResponse(error: string, status: number) {
  return Response.json({ error }, { status, headers: { "Cache-Control": "no-store" } });
}
