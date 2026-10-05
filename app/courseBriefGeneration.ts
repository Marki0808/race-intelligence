import { validateCourseBriefCandidate } from "./courseBriefClaimValidation.ts";
import { validateCourseBriefInput } from "./courseBriefInputValidation.ts";
import { buildCourseBriefPrompt } from "./courseBriefPrompt.ts";
import { renderCourseBrief } from "./courseBriefOutput.ts";
import type { CourseBriefTelemetry, CourseBriefProvider, CourseBriefProviderMetadata } from "./server/courseBriefProvider.ts";
import type { CourseBriefErrorCode } from "./server/courseBriefProvider.ts";

export type CourseBriefGenerationResult =
  | { ok: true; brief: import("./courseBriefOutput.ts").CourseBriefV1; rendered: import("./courseBriefOutput.ts").RenderedCourseBriefV1 }
  | { ok: false; error: CourseBriefErrorCode; retryable: boolean; retryAfterSeconds: number | null };

export type CourseBriefTelemetrySink = (event: CourseBriefTelemetry) => void;

/** Provider-independent generation flow; all claims are grounded and rendered locally. */
export async function generateCourseBrief(
  value: unknown,
  provider: CourseBriefProvider,
  telemetry?: CourseBriefTelemetrySink,
): Promise<CourseBriefGenerationResult> {
  const validation = validateCourseBriefInput(value);
  if (!validation.ok) {
    emitTelemetry(telemetry, emptyTelemetry("invalid_input", false));
    return { ok: false, error: "invalid_input", retryable: false, retryAfterSeconds: null };
  }
  const prompt = buildCourseBriefPrompt(validation.input);
  let providerResult;
  try {
    providerResult = await provider.generate({ systemInstructions: prompt.systemInstructions, userData: prompt.userData });
  } catch {
    const event = emptyTelemetry("provider_unavailable", true);
    emitTelemetry(telemetry, event);
    return { ok: false, error: "provider_unavailable", retryable: true, retryAfterSeconds: null };
  }
  if (!providerResult.ok) {
    emitTelemetry(telemetry, telemetryFromMetadata(providerResult.metadata, providerResult.error, providerResult.retryable));
    return {
      ok: false,
      error: providerResult.error,
      retryable: providerResult.retryable,
      retryAfterSeconds: providerResult.retryAfterSeconds,
    };
  }

  const claims = validateCourseBriefCandidate(providerResult.candidate, validation.input);
  if (!claims.ok) {
    emitTelemetry(telemetry, telemetryFromMetadata(providerResult.metadata, claims.error, false));
    return { ok: false, error: claims.error, retryable: false, retryAfterSeconds: null };
  }
  const rendered = renderCourseBrief(claims.brief, validation.input);
  emitTelemetry(telemetry, telemetryFromMetadata(providerResult.metadata, null, false));
  return { ok: true, brief: claims.brief, rendered };
}

function telemetryFromMetadata(
  metadata: CourseBriefProviderMetadata,
  category: CourseBriefErrorCode | null,
  retryable: boolean,
): CourseBriefTelemetry {
  return {
    model: metadata.model,
    inputTokens: metadata.usage.inputTokens,
    outputTokens: metadata.usage.outputTokens,
    totalTokens: metadata.usage.totalTokens,
    cachedInputTokens: metadata.usage.cachedInputTokens,
    reasoningTokens: metadata.usage.reasoningTokens,
    providerRequestId: metadata.requestId,
    durationMs: metadata.durationMs,
    outcome: category === null ? "success" : "failure",
    category,
    retryable,
  };
}

function emptyTelemetry(category: CourseBriefErrorCode, retryable: boolean): CourseBriefTelemetry {
  return {
    model: "gpt-5.4-mini",
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
    cachedInputTokens: null,
    reasoningTokens: null,
    providerRequestId: null,
    durationMs: 0,
    outcome: "failure",
    category,
    retryable,
  };
}

function emitTelemetry(sink: CourseBriefTelemetrySink | undefined, event: CourseBriefTelemetry): void {
  try { sink?.(event); } catch { /* Telemetry must never affect route analysis or generation. */ }
}
