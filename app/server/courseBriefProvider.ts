import type { CourseBriefClaimType } from "../courseBriefOutput.ts";

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

export type CourseBriefSemanticRejectionCode =
  | "vertical_concentration_invalid_parameters"
  | "vertical_concentration_invalid_facts"
  | "vertical_concentration_threshold_failed"
  | "vertical_transition_invalid_parameters"
  | "vertical_transition_invalid_facts"
  | "vertical_transition_direction_failed"
  | "key_moment_invalid_parameters"
  | "key_moment_invalid_fact"
  | "key_moment_direction_mismatch"
  | "key_moment_role_mismatch"
  | "highest_point_invalid_parameters"
  | "highest_point_invalid_fact"
  | "lowest_point_invalid_parameters"
  | "lowest_point_invalid_fact"
  | "osm_surface_invalid_parameters"
  | "osm_surface_invalid_fact"
  | "duplicate_claim"
  | "duplicate_key_moment"
  | "duplicate_osm_claim"
  | "duplicate_vertical_transition";

export type CourseBriefSemanticRejectionDiagnostic = {
  observationIndex: number;
  claimType: CourseBriefClaimType;
  supportingFactIds: string[];
  parameters: {
    phase: "early" | "middle" | "late" | null;
    direction: "climb" | "descent" | null;
    transition: "climb-to-descent" | "descent-to-climb" | null;
    role: "longest" | "largest" | null;
    terrainCategory: "paved" | "gravel" | "dirt-ground" | "rocky-rough" | "natural-trail" | "mixed-trail" | null;
  };
  code: CourseBriefSemanticRejectionCode;
};

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
  semanticRejection?: CourseBriefSemanticRejectionDiagnostic;
};
