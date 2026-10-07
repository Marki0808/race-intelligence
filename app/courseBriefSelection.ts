import { z } from "zod";
import type { EligibleCourseBriefClaimOption } from "./courseBriefClaimValidation.ts";
import {
  COURSE_BRIEF_OUTPUT_SCHEMA_VERSION,
  type CourseBriefCandidateV1,
  type CourseBriefObservationCandidate,
} from "./courseBriefOutput.ts";

export const COURSE_BRIEF_SELECTION_SCHEMA_VERSION = 1 as const;

export type CourseBriefSelectionV1 = {
  selectionSchemaVersion: typeof COURSE_BRIEF_SELECTION_SCHEMA_VERSION;
  selectedOptionIds: string[];
  headlineSelectionIndex: number;
};

/** Builds a request-specific strict schema whose option enum is the exact eligible set. */
export function createCourseBriefSelectionSchema(optionIds: readonly string[]) {
  if (optionIds.length === 0 || new Set(optionIds).size !== optionIds.length) {
    throw new TypeError("Course Brief selection requires a non-empty set of unique option IDs.");
  }
  const optionIdEnum = z.enum([...optionIds] as [string, ...string[]]);
  return z.object({
    selectionSchemaVersion: z.number().int()
      .min(COURSE_BRIEF_SELECTION_SCHEMA_VERSION)
      .max(COURSE_BRIEF_SELECTION_SCHEMA_VERSION),
    selectedOptionIds: z.array(optionIdEnum).min(1).max(3),
    headlineSelectionIndex: z.number().int().min(0).max(2),
  }).strict();
}

export type CourseBriefSelectionMappingResult =
  | { ok: true; candidate: CourseBriefCandidateV1 }
  | { ok: false; error: "invalid_provider_response" };

/** Maps model references to canonical claims; it never repairs invalid selection output. */
export function mapCourseBriefSelectionToCandidate(
  value: unknown,
  options: readonly EligibleCourseBriefClaimOption[],
): CourseBriefSelectionMappingResult {
  if (options.length === 0) return { ok: false, error: "invalid_provider_response" };

  const optionIds = options.map(({ optionId }) => optionId);
  if (optionIds.some((optionId) => optionId.length === 0) || new Set(optionIds).size !== optionIds.length) {
    return { ok: false, error: "invalid_provider_response" };
  }
  const parsed = createCourseBriefSelectionSchema(optionIds).safeParse(value);
  if (!parsed.success || parsed.data.selectionSchemaVersion !== COURSE_BRIEF_SELECTION_SCHEMA_VERSION ||
    parsed.data.headlineSelectionIndex >= parsed.data.selectedOptionIds.length) {
    return { ok: false, error: "invalid_provider_response" };
  }

  const byId = new Map(options.map((option) => [option.optionId, option]));
  const observations: CourseBriefObservationCandidate[] = [];
  for (const optionId of parsed.data.selectedOptionIds) {
    const option = byId.get(optionId);
    if (!option) return { ok: false, error: "invalid_provider_response" };
    observations.push({
      claimType: option.claimType,
      supportingFactIds: [...option.supportingFactIds],
      phase: option.phase,
      direction: option.direction,
      transition: option.transition,
      role: option.role,
      terrainCategory: option.terrainCategory,
    });
  }

  return {
    ok: true,
    candidate: {
      schemaVersion: COURSE_BRIEF_OUTPUT_SCHEMA_VERSION,
      headlineObservationIndex: parsed.data.headlineSelectionIndex,
      observations,
    },
  };
}
