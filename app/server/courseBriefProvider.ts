export type CourseBriefErrorCode =
  | "invalid_input"
  | "provider_not_configured"
  | "rate_limited"
  | "timeout"
  | "provider_unavailable"
  | "refusal_or_incomplete"
  | "invalid_provider_response"
  | "unsupported_generated_claim"
  | "insufficient_route_facts";

export type CourseBriefProviderMetadata = {
  provider: "openai";
  model: string;
  durationMs: number;
  requestId: string | null;
  usage: {
    inputTokens: number | null;
    outputTokens: number | null;
    totalTokens: number | null;
    cachedInputTokens: number | null;
    reasoningTokens: number | null;
  };
};

export type CourseBriefProviderRequest = {
  systemInstructions: string;
  userData: string;
};

export type CourseBriefProviderResult =
  | { ok: true; candidate: unknown; metadata: CourseBriefProviderMetadata }
  | { ok: false; error: Exclude<CourseBriefErrorCode, "invalid_input" | "unsupported_generated_claim" | "insufficient_route_facts">; retryable: boolean; retryAfterSeconds: number | null; metadata: CourseBriefProviderMetadata };

export interface CourseBriefProvider {
  generate(request: CourseBriefProviderRequest): Promise<CourseBriefProviderResult>;
}

export type CourseBriefTelemetry = {
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  cachedInputTokens: number | null;
  reasoningTokens: number | null;
  providerRequestId: string | null;
  durationMs: number;
  outcome: "success" | "failure";
  category: CourseBriefErrorCode | null;
  retryable: boolean;
};
