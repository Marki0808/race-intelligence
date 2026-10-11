import OpenAI, { APIError, OpenAIError } from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import {
  COURSE_BRIEF_MAX_RETRIES,
  COURSE_BRIEF_MODEL,
  COURSE_BRIEF_PROVIDER_TIMEOUT_MS,
} from "./openAiCourseBriefProvider.ts";
import { courseBriefNarrativeResponseSchema, type CourseBriefNarrativeWriter } from "../courseBriefNarrativePrototype.ts";

export const COURSE_BRIEF_NARRATIVE_PROTOTYPE_MAX_OUTPUT_TOKENS = 500;
type ResponsesClient = Pick<OpenAI["responses"], "parse">;

export class OpenAiCourseBriefNarrativePrototypeWriter implements CourseBriefNarrativeWriter {
  private readonly responses: ResponsesClient | null;
  constructor(options: { apiKey?: string; responses?: ResponsesClient } = {}) {
    if (options.responses) this.responses = options.responses;
    else if (options.apiKey?.trim()) {
      this.responses = new OpenAI({ apiKey: options.apiKey, maxRetries: COURSE_BRIEF_MAX_RETRIES,
        timeout: COURSE_BRIEF_PROVIDER_TIMEOUT_MS }).responses;
    } else this.responses = null;
  }

  async write(request: { systemInstructions: string; userData: string }) {
    if (!this.responses) return { ok: false as const, error: "provider_not_configured" };
    try {
      const response = await this.responses.parse({
        model: COURSE_BRIEF_MODEL,
        instructions: request.systemInstructions,
        input: request.userData,
        reasoning: { effort: "none" },
        text: { verbosity: "low", format: zodTextFormat(courseBriefNarrativeResponseSchema, "course_brief_narrative_prototype_v1") },
        max_output_tokens: COURSE_BRIEF_NARRATIVE_PROTOTYPE_MAX_OUTPUT_TOKENS,
        truncation: "disabled",
        store: false,
      });
      if (response.status !== "completed" || response.incomplete_details !== null || response.output_parsed === null ||
        response.output.some((item) => item.type === "message" && item.content.some((content) => content.type === "refusal"))) {
        return { ok: false as const, error: "refusal_or_incomplete", ...usageMetadata(response.usage) };
      }
      return { ok: true as const, response: response.output_parsed, ...usageMetadata(response.usage) };
    } catch (error) {
      // Never return SDK error messages: they may include request or configuration details.
      const name = error instanceof Error ? error.name : "";
      if (name.includes("Timeout") || name === "AbortError") return { ok: false as const, error: "timeout" };
      if (error instanceof APIError && error.status === 429) return { ok: false as const, error: "rate_limited" };
      if (error instanceof OpenAIError) return { ok: false as const, error: "provider_unavailable" };
      return { ok: false as const, error: "provider_unavailable" };
    }
  }
}

function usageMetadata(usage: { input_tokens?: number; output_tokens?: number; total_tokens?: number;
  input_tokens_details?: { cached_tokens?: number }; output_tokens_details?: { reasoning_tokens?: number } } | null | undefined) {
  const safe = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
  return { usage: {
    inputTokens: safe(usage?.input_tokens), outputTokens: safe(usage?.output_tokens), totalTokens: safe(usage?.total_tokens),
    cachedInputTokens: safe(usage?.input_tokens_details?.cached_tokens), reasoningTokens: safe(usage?.output_tokens_details?.reasoning_tokens),
  } };
}
