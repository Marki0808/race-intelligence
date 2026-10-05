import OpenAI, { APIError, OpenAIError } from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { ZodError } from "zod";
import { courseBriefCandidateSchema } from "../courseBriefOutput.ts";
import type {
  CourseBriefProvider,
  CourseBriefProviderMetadata,
  CourseBriefProviderRequest,
  CourseBriefProviderResult,
} from "./courseBriefProvider.ts";

export const COURSE_BRIEF_MODEL = "gpt-5.4-mini";
export const COURSE_BRIEF_PROVIDER_TIMEOUT_MS = 13_500;
export const COURSE_BRIEF_MAX_OUTPUT_TOKENS = 700;
export const COURSE_BRIEF_MAX_RETRIES = 0;

type OpenAiResponsesClient = Pick<OpenAI["responses"], "parse">;

export type OpenAiCourseBriefProviderOptions = {
  apiKey?: string;
  responses?: OpenAiResponsesClient;
  now?: () => number;
};

/** Server-only adapter around the Responses API; it never logs or returns raw SDK errors. */
export class OpenAiCourseBriefProvider implements CourseBriefProvider {
  private readonly responses: OpenAiResponsesClient | null;
  private readonly now: () => number;

  constructor(options: OpenAiCourseBriefProviderOptions = {}) {
    this.now = options.now ?? Date.now;
    if (options.responses) {
      this.responses = options.responses;
    } else if (options.apiKey) {
      const client = new OpenAI({
        apiKey: options.apiKey,
        maxRetries: COURSE_BRIEF_MAX_RETRIES,
        timeout: COURSE_BRIEF_PROVIDER_TIMEOUT_MS,
      });
      this.responses = client.responses;
    } else {
      this.responses = null;
    }
  }

  async generate(request: CourseBriefProviderRequest): Promise<CourseBriefProviderResult> {
    const startedAt = this.now();
    if (!this.responses) {
      return {
        ok: false,
        error: "provider_not_configured",
        retryable: false,
        retryAfterSeconds: null,
        metadata: emptyMetadata(Math.max(0, this.now() - startedAt)),
      };
    }

    try {
      const response = await this.responses.parse({
        model: COURSE_BRIEF_MODEL,
        instructions: request.systemInstructions,
        input: request.userData,
        reasoning: { effort: "none" },
        text: {
          verbosity: "low",
          format: zodTextFormat(courseBriefCandidateSchema, "course_brief_candidate_v1"),
        },
        max_output_tokens: COURSE_BRIEF_MAX_OUTPUT_TOKENS,
        truncation: "disabled",
        store: false,
      });
      const metadata = responseMetadata(response, Math.max(0, this.now() - startedAt));
      if (response.status !== "completed" || response.incomplete_details !== null) {
        return providerFailure("refusal_or_incomplete", true, null, metadata);
      }
      if (containsRefusal(response.output)) return providerFailure("refusal_or_incomplete", false, null, metadata);
      if (response.output_parsed === null) return providerFailure("invalid_provider_response", false, null, metadata);
      return { ok: true, candidate: response.output_parsed, metadata };
    } catch (error) {
      const durationMs = Math.max(0, this.now() - startedAt);
      if (isTimeoutError(error)) return providerFailure("timeout", true, null, emptyMetadata(durationMs));
      if (error instanceof OpenAI.APIError && error.status === 429) {
        return providerFailure("rate_limited", true, readRetryAfterSeconds(error), emptyMetadata(durationMs));
      }
      if (error instanceof APIError && error.status === 408) return providerFailure("timeout", true, null, emptyMetadata(durationMs));
      if (isRefusalOrIncompleteError(error)) return providerFailure("refusal_or_incomplete", false, null, emptyMetadata(durationMs));
      if (error instanceof ZodError) return providerFailure("invalid_provider_response", false, null, emptyMetadata(durationMs));
      if (error instanceof OpenAI.APIConnectionError) return providerFailure("provider_unavailable", true, null, emptyMetadata(durationMs));
      if (error instanceof APIError) {
        const retryable = error.status !== undefined && error.status !== null && error.status >= 500;
        return providerFailure("provider_unavailable", retryable, null, emptyMetadata(durationMs));
      }
      if (error instanceof OpenAIError) return providerFailure("invalid_provider_response", false, null, emptyMetadata(durationMs));
      return providerFailure("provider_unavailable", true, null, emptyMetadata(durationMs));
    }
  }
}

function responseMetadata(response: Awaited<ReturnType<OpenAiResponsesClient["parse"]>>, durationMs: number): CourseBriefProviderMetadata {
  const usage = response.usage;
  return {
    provider: "openai",
    model: COURSE_BRIEF_MODEL,
    durationMs,
    requestId: safeRequestId(response._request_id),
    usage: {
      inputTokens: finiteCount(usage?.input_tokens),
      outputTokens: finiteCount(usage?.output_tokens),
      totalTokens: finiteCount(usage?.total_tokens),
      cachedInputTokens: finiteCount(usage?.input_tokens_details.cached_tokens),
      reasoningTokens: finiteCount(usage?.output_tokens_details.reasoning_tokens),
    },
  };
}

function emptyMetadata(durationMs: number): CourseBriefProviderMetadata {
  return {
    provider: "openai",
    model: COURSE_BRIEF_MODEL,
    durationMs,
    requestId: null,
    usage: { inputTokens: null, outputTokens: null, totalTokens: null, cachedInputTokens: null, reasoningTokens: null },
  };
}

function providerFailure(
  error: Extract<CourseBriefProviderResult, { ok: false }>['error'],
  retryable: boolean,
  retryAfterSeconds: number | null,
  metadata: CourseBriefProviderMetadata,
): CourseBriefProviderResult {
  return { ok: false, error, retryable, retryAfterSeconds, metadata };
}

function finiteCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function safeRequestId(value: unknown): string | null {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value) ? value : null;
}

function readRetryAfterSeconds(error: APIError): number | null {
  const value = error.headers?.get("retry-after");
  if (!value) return null;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 && seconds <= 3600 ? Math.ceil(seconds) : null;
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof OpenAI.APIConnectionTimeoutError ||
    (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError"));
}

function isRefusalOrIncompleteError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const name = error.name.toLowerCase();
  return name.includes("refusal") || name === "lengthfinishreasonerror" || name === "contentfilterfinishreasonerror";
}

function containsRefusal(output: Awaited<ReturnType<OpenAiResponsesClient["parse"]>>["output"]): boolean {
  return output.some((item) => item.type === "message" && item.content.some((content) => content.type === "refusal"));
}
