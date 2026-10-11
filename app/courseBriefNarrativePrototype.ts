import { z } from "zod";
import { validateCourseBriefInputV2, type CourseBriefInputV2 } from "./courseBriefNarrativeFacts.ts";

export const COURSE_BRIEF_NARRATIVE_PROTOTYPE_SCHEMA_VERSION = 1 as const;

export type CourseBriefNarrativePrototypeInputV1 = {
  schemaVersion: typeof COURSE_BRIEF_NARRATIVE_PROTOTYPE_SCHEMA_VERSION;
  route: { distanceKm: number; components: Array<{ componentIndex: number; startKm: number; endKm: number }> };
  facts: Array<
    | { factId: string; componentIndex: number; courseOrder: number; type: "unit"; startKm: number; endKm: number; character: string }
    | { factId: string; componentIndex: number; courseOrder: number; type: "transition"; boundaryKm: number; from: string; to: string }
    | { factId: string; sourceFactId: string; componentIndex: number; courseOrder: number; type: "significant_event"; startKm: number; endKm: number; eventKind: "climb" | "descent"; roles: Array<"longest" | "largest">; distanceKm: number | null; verticalChangeM: number | null }
  >;
};

export type CourseBriefNarrativeParagraphV1 = { componentIndex: number; text: string; factIds: string[] };
export type CourseBriefNarrativeResponseV1 = { schemaVersion: 1; paragraphs: CourseBriefNarrativeParagraphV1[] };
export type CourseBriefNarrativePrototypeResult =
  | { ok: true; input: CourseBriefNarrativePrototypeInputV1; narrative: CourseBriefNarrativeResponseV1; renderedText: string;
      usage?: { inputTokens: number | null; outputTokens: number | null; totalTokens: number | null; cachedInputTokens: number | null; reasoningTokens: number | null }; durationMs?: number }
  | { ok: false; error: "invalid_input" | "insufficient_facts" | "provider_failure" | "invalid_narrative"; reason?: string;
      usage?: { inputTokens: number | null; outputTokens: number | null; totalTokens: number | null; cachedInputTokens: number | null; reasoningTokens: number | null }; durationMs?: number };

export interface CourseBriefNarrativeWriter {
  write(request: { systemInstructions: string; userData: string }): Promise<
    | { ok: true; response: unknown; usage?: { inputTokens: number | null; outputTokens: number | null; totalTokens: number | null; cachedInputTokens: number | null; reasoningTokens: number | null }; durationMs?: number }
    | { ok: false; error: string; usage?: { inputTokens: number | null; outputTokens: number | null; totalTokens: number | null; cachedInputTokens: number | null; reasoningTokens: number | null }; durationMs?: number }
  >;
}

const paragraphSchema = z.object({
  componentIndex: z.number().int().min(0).max(127),
  text: z.string().trim().min(1).max(1600),
  factIds: z.array(z.string().min(1).max(240)).min(1).max(24),
}).strict();

export const courseBriefNarrativeResponseSchema = z.object({
  schemaVersion: z.literal(1),
  paragraphs: z.array(paragraphSchema).min(1).max(32),
}).strict();

export type NarrativeValidationError = "malformed_output" | "unknown_fact_reference" | "mixed_components" | "out_of_order" | "unsupported_claim" | "incomplete_route_coverage";

export function buildCourseBriefNarrativePrototypeInput(value: unknown):
  | { ok: true; input: CourseBriefNarrativePrototypeInputV1 }
  | { ok: false; error: "invalid_input" | "insufficient_facts" } {
  const validation = validateCourseBriefInputV2(value);
  if (!validation.ok) return { ok: false, error: "invalid_input" };
  const input = validation.input;
  const facts = projectWriterFacts(input);
  if (facts.filter((fact) => fact.type === "unit").length === 0) return { ok: false, error: "insufficient_facts" };
  return {
    ok: true,
    input: {
      schemaVersion: COURSE_BRIEF_NARRATIVE_PROTOTYPE_SCHEMA_VERSION,
      route: {
        distanceKm: input.route.distanceKm,
        components: input.route.components.map(({ segmentIndex, startKm, endKm }) => ({ componentIndex: segmentIndex, startKm, endKm })),
      },
      facts,
    },
  };
}

export function buildCourseBriefNarrativePrototypePrompt(input: CourseBriefNarrativePrototypeInputV1): {
  systemInstructions: string;
  userData: string;
} {
  return {
    systemInstructions: [
      "Write a concise, connected English course narrative for a trail runner, following the supplied route facts in order.",
      "Use a natural number of paragraphs based on meaningful changes. Explain the route's shape and rhythm qualitatively; do not turn facts into a list or report.",
      "Use only supplied structural facts. Unknowns are unknown. Do not invent locations, landmarks, surfaces, weather, technicality, difficulty, effort, fatigue, pacing, or advice.",
      "Each paragraph must cite the supplied fact IDs that support it and must describe exactly one component. Never imply a transition or continuity between separate components.",
      "Avoid numeric reporting. Return only the required structured object. Fact references aid review but do not excuse unsupported wording.",
    ].join(" "),
    userData: JSON.stringify(input),
  };
}

export function validateCourseBriefNarrativeResponse(
  value: unknown,
  input: CourseBriefNarrativePrototypeInputV1,
): { ok: true; narrative: CourseBriefNarrativeResponseV1; renderedText: string } | { ok: false; error: NarrativeValidationError } {
  const parsed = courseBriefNarrativeResponseSchema.safeParse(value);
  if (!parsed.success) return { ok: false, error: "malformed_output" };
  const factById = new Map(input.facts.map((fact) => [fact.factId, fact]));
  const components = new Set(input.route.components.map(({ componentIndex }) => componentIndex));
  const usedIds = new Set<string>();
  let priorOrder = -1;
  let priorComponent = -1;
  const representedUnits = new Set<string>();

  for (const paragraph of parsed.data.paragraphs) {
    if (!components.has(paragraph.componentIndex)) return { ok: false, error: "mixed_components" };
    const refs = paragraph.factIds.map((id) => factById.get(id));
    if (refs.some((fact) => !fact)) return { ok: false, error: "unknown_fact_reference" };
    const concreteRefs = refs as NonNullable<(typeof refs)[number]>[];
    if (concreteRefs.some((fact) => fact.componentIndex !== paragraph.componentIndex) ||
      new Set(paragraph.factIds).size !== paragraph.factIds.length || paragraph.factIds.some((id) => usedIds.has(id))) {
      return { ok: false, error: "mixed_components" };
    }
    const ordered = [...concreteRefs].sort((a, b) => a.courseOrder - b.courseOrder);
    if (ordered.some((fact, index) => fact.factId !== concreteRefs[index].factId) ||
      ordered[0].courseOrder < priorOrder || paragraph.componentIndex < priorComponent) return { ok: false, error: "out_of_order" };
    if (hasUnsupportedClaim(paragraph.text) ||
      (paragraph.componentIndex > priorComponent && priorComponent >= 0 && startsWithComponentBridge(paragraph.text))) {
      return { ok: false, error: "unsupported_claim" };
    }
    concreteRefs.forEach((fact) => {
      usedIds.add(fact.factId);
      if (fact.type === "unit") representedUnits.add(fact.factId);
    });
    priorOrder = ordered.at(-1)!.courseOrder;
    priorComponent = paragraph.componentIndex;
  }

  const requiredBoundaryUnits = input.route.components.flatMap((component) => {
    const units = input.facts.filter((fact) => fact.type === "unit" && fact.componentIndex === component.componentIndex);
    if (units.length === 0) return [];
    return [units[0].factId, units.at(-1)!.factId];
  });
  if (requiredBoundaryUnits.some((factId) => !representedUnits.has(factId))) return { ok: false, error: "incomplete_route_coverage" };
  const narrative = parsed.data as CourseBriefNarrativeResponseV1;
  return { ok: true, narrative, renderedText: narrative.paragraphs.map(({ text }) => text).join("\n\n") };
}

export async function generateCourseBriefNarrativePrototype(
  value: unknown,
  writer: CourseBriefNarrativeWriter,
): Promise<CourseBriefNarrativePrototypeResult> {
  const built = buildCourseBriefNarrativePrototypeInput(value);
  if (!built.ok) return built;
  const prompt = buildCourseBriefNarrativePrototypePrompt(built.input);
  let result;
  try { result = await writer.write(prompt); }
  catch { return { ok: false, error: "provider_failure", reason: "provider_unavailable" }; }
  const metadata = { ...(result.usage ? { usage: result.usage } : {}), ...(result.durationMs === undefined ? {} : { durationMs: result.durationMs }) };
  if (!result.ok) return { ok: false, error: "provider_failure", reason: result.error, ...metadata };
  const validated = validateCourseBriefNarrativeResponse(result.response, built.input);
  if (!validated.ok) return { ok: false, error: "invalid_narrative", reason: validated.error, ...metadata };
  return { ok: true, input: built.input, narrative: validated.narrative, renderedText: validated.renderedText,
    ...metadata };
}

function projectWriterFacts(input: CourseBriefInputV2): CourseBriefNarrativePrototypeInputV1["facts"] {
  const unitById = new Map(input.units.map((unit) => [unit.unitId, unit]));
  const output: CourseBriefNarrativePrototypeInputV1["facts"] = [];
  for (const fact of input.facts) {
    if (fact.type === "UNIT_CHARACTER") {
      const unit = unitById.get(fact.unitId);
      if (unit) output.push({ factId: fact.factId, componentIndex: fact.segmentIndex, courseOrder: fact.courseOrder,
        type: "unit", startKm: fact.startKm, endKm: fact.endKm, character: fact.character });
    } else if (fact.type === "STRUCTURAL_TRANSITION") {
      output.push({ factId: fact.factId, componentIndex: fact.segmentIndex, courseOrder: fact.courseOrder,
        type: "transition", boundaryKm: fact.boundaryKm, from: fact.fromCharacter, to: fact.toCharacter });
    } else if (fact.type === "ANCHOR_WITHIN_UNIT" && fact.anchorKind === "key-moment" && fact.eventKind &&
      fact.roles.length > 0 && (fact.measurements.distanceKm !== null || fact.measurements.elevationChangeM !== null)) {
      output.push({ factId: fact.factId, sourceFactId: fact.sourceFactId, componentIndex: fact.segmentIndex,
        courseOrder: fact.courseOrder, type: "significant_event", startKm: fact.startKm, endKm: fact.endKm,
        eventKind: fact.eventKind, roles: fact.roles, distanceKm: fact.measurements.distanceKm,
        verticalChangeM: fact.measurements.elevationChangeM });
    }
  }
  return output;
}

function hasUnsupportedClaim(text: string): boolean {
  if (/\d/.test(text)) return true;
  return /\b(village|town|city|settlement|landmark|road|bridge|summit|ridge|valley|forest|coast|mountainous|paved|gravel|muddy|rocky|surface|weather|wind|temperature|technical|difficulty|harder|easier|fatigue|tired|pace|pacing|fuel|fueling|hydration|aid station|recommend|should|you will|runnable|effort|challenging|steep|gentle|gradual|steady|smooth|scenic|beautiful|rewarding|loop|out-and-back)\b/i.test(text);
}

function startsWithComponentBridge(text: string): boolean {
  return /^(?:then|after(?:wards)?|next|following(?: that)?|from there|continuing|continues|that leads into)\b/i.test(text.trim());
}

