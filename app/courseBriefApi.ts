import { generateCourseBrief } from "./courseBriefGeneration.ts";
import { MAX_COURSE_BRIEF_REQUEST_BYTES } from "./courseBriefInputValidation.ts";
import type { CourseBriefErrorCode, CourseBriefProvider, CourseBriefTelemetry } from "./server/courseBriefProvider.ts";

type ProviderFactory = () => CourseBriefProvider;
type TelemetryLogger = (event: CourseBriefTelemetry) => void;

/** Injectable handler boundary keeps route tests deterministic and provider-free. */
export function createCourseBriefPostHandler(
  providerFactory: ProviderFactory,
  logTelemetry: TelemetryLogger = (event) => {
    const log = event.outcome === "success" ? console.info : console.warn;
    log("course_brief_generation", event);
  },
) {
  return async function POST(request: Request): Promise<Response> {
    const body = await readBoundedJson(request);
    if (!body.ok) return errorResponse("invalid_input", body.status, false);

    const lazyProvider: CourseBriefProvider = {
      generate: (providerRequest) => providerFactory().generate(providerRequest),
    };
    const result = await generateCourseBrief(body.value, lazyProvider, logTelemetry);
    if (!result.ok) {
      const status = statusFor(result.error);
      const headers = result.error === "rate_limited" && result.retryAfterSeconds !== null
        ? { "Retry-After": String(result.retryAfterSeconds) }
        : undefined;
      return Response.json({ error: result.error, retryable: result.retryable }, {
        status,
        headers: { "Cache-Control": "no-store", ...headers },
      });
    }
    return Response.json({ courseBrief: result.brief, rendered: result.rendered }, {
      status: 200,
      headers: { "Cache-Control": "no-store" },
    });
  };
}

async function readBoundedJson(request: Request): Promise<
  | { ok: true; value: unknown }
  | { ok: false; status: 400 | 413 }
> {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    const parsedLength = Number(contentLength);
    if (Number.isFinite(parsedLength) && parsedLength > MAX_COURSE_BRIEF_REQUEST_BYTES) return { ok: false, status: 413 };
  }
  if (!request.body) return { ok: false, status: 400 };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_COURSE_BRIEF_REQUEST_BYTES) {
        void reader.cancel().catch(() => undefined);
        return { ok: false, status: 413 };
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    return { ok: true, value: parsed };
  } catch {
    return { ok: false, status: 400 };
  } finally {
    reader.releaseLock();
  }
}

function statusFor(error: CourseBriefErrorCode): number {
  switch (error) {
    case "invalid_input": return 400;
    case "insufficient_route_facts": return 422;
    case "rate_limited": return 429;
    case "timeout": return 504;
    case "provider_not_configured":
    case "provider_unavailable": return 503;
    case "refusal_or_incomplete":
    case "invalid_provider_response":
    case "unsupported_generated_claim": return 502;
  }
}

function errorResponse(error: string, status: number, retryable: boolean): Response {
  return Response.json({ error, retryable }, { status, headers: { "Cache-Control": "no-store" } });
}
