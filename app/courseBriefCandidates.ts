import { z } from "zod";
import {
  buildCourseBriefNarrativeFactIndex,
  validateCourseBriefInputV2,
  type CourseBriefInputV2,
  type NarrativeFact,
} from "./courseBriefNarrativeFacts.ts";

export const COURSE_BRIEF_CANDIDATE_ALGORITHM_VERSION = 1 as const;
export const COURSE_BRIEF_OUTPUT_V2_SCHEMA_VERSION = 2 as const;
export const COURSE_BRIEF_MAX_OBSERVATIONS_V2 = 5 as const;

export const COURSE_BRIEF_RENDER_PATTERNS = [
  "UNIT",
  "UNIT_WITH_ANCHOR",
  "TRANSITION_TO_UNIT",
  "EVOLVING_FINISH",
  "EVOLUTION",
  "STANDALONE_TRANSITION",
] as const;

export type CourseBriefRenderPattern = (typeof COURSE_BRIEF_RENDER_PATTERNS)[number];

export type CourseBriefCandidate = {
  candidateId: string;
  componentIndex: number;
  /** Unit ordinal (or boundary/phase order for standalone facts), never an array index. */
  displayOrderKey: number;
  narrativeGroupIds: string[];
  primaryFactId: string;
  supportingFactIds: string[];
  coverageAtomIds: string[];
  partialCoverageAtomIds: string[];
  redundancyKeys: string[];
  renderPatternId: CourseBriefRenderPattern;
};

export type CourseBriefCandidateBuildResult =
  | { ok: true; input: CourseBriefInputV2; candidates: CourseBriefCandidate[] }
  | { ok: false; error: "invalid_input" };

export type CourseBriefCandidatePoolValidationResult =
  | { ok: true; input: CourseBriefInputV2; candidates: CourseBriefCandidate[] }
  | { ok: false; error: "invalid_input" | "invalid_candidate_pool" };

export type CourseBriefSelectionResult =
  | {
      ok: true;
      selectedCandidates: CourseBriefCandidate[];
      omittedCandidateIds: string[];
      componentCoverageComplete: boolean;
      selectionReasons: Array<{ candidateId: string; codes: string[] }>;
      omissionReasons: Array<{ candidateId: string; code: "safety_ceiling" | "redundant_coverage" }>;
    }
  | { ok: false; error: "invalid_input" | "invalid_candidate_pool" | "insufficient_route_facts" };

export type CourseBriefObservationV2 = {
  candidateId: string;
  sourceFactIds: string[];
  componentIndex: number;
  startKm: number;
  endKm: number;
  displayOrderKey: number;
  text: string;
};

export type CourseBriefOutputV2 = {
  schemaVersion: typeof COURSE_BRIEF_OUTPUT_V2_SCHEMA_VERSION;
  observations: CourseBriefObservationV2[];
  diagnostics: {
    candidateCount: number;
    selectedCount: number;
    omittedCount: number;
    omittedCandidateIds: string[];
    componentCoverageComplete: boolean;
    selectionMode: "deterministic";
    selectionReasons: Array<{ candidateId: string; codes: string[] }>;
    omissionReasons: Array<{ candidateId: string; code: "safety_ceiling" | "redundant_coverage" }>;
  };
};

export type CourseBriefDeterministicV2Result =
  | { ok: true; output: CourseBriefOutputV2 }
  | { ok: false; error: "invalid_input" | "insufficient_route_facts" };

const factIdSchema = z.string().min(1).max(240);
const candidateSchema = z.object({
  candidateId: z.string().min(1).max(600),
  componentIndex: z.number().int().min(0).max(127),
  displayOrderKey: z.number().finite().min(0).max(100_000),
  narrativeGroupIds: z.array(factIdSchema).max(100),
  primaryFactId: factIdSchema,
  supportingFactIds: z.array(factIdSchema).max(100),
  coverageAtomIds: z.array(factIdSchema).max(300),
  partialCoverageAtomIds: z.array(factIdSchema).max(300),
  redundancyKeys: z.array(factIdSchema).max(300),
  renderPatternId: z.enum(COURSE_BRIEF_RENDER_PATTERNS),
}).strict();

const outputSchema = z.object({
  schemaVersion: z.literal(COURSE_BRIEF_OUTPUT_V2_SCHEMA_VERSION),
  observations: z.array(z.object({
    candidateId: z.string().min(1).max(600),
    sourceFactIds: z.array(factIdSchema).min(1).max(100),
    componentIndex: z.number().int().min(0).max(127),
    startKm: z.number().finite().min(0),
    endKm: z.number().finite().min(0),
    displayOrderKey: z.number().finite().min(0),
    text: z.string().min(1).max(4000),
  }).strict()).min(1).max(COURSE_BRIEF_MAX_OBSERVATIONS_V2),
  diagnostics: z.object({
    candidateCount: z.number().int().nonnegative(),
    selectedCount: z.number().int().min(1).max(COURSE_BRIEF_MAX_OBSERVATIONS_V2),
    omittedCount: z.number().int().nonnegative(),
    omittedCandidateIds: z.array(z.string().min(1).max(600)).max(10_000),
    componentCoverageComplete: z.boolean(),
    selectionMode: z.literal("deterministic"),
    selectionReasons: z.array(z.object({ candidateId: z.string().min(1).max(600), codes: z.array(z.string().min(1).max(80)).min(1).max(10) }).strict()).max(COURSE_BRIEF_MAX_OBSERVATIONS_V2),
    omissionReasons: z.array(z.object({ candidateId: z.string().min(1).max(600), code: z.enum(["safety_ceiling", "redundant_coverage"]) }).strict()).max(10_000),
  }).strict(),
}).strict();

/** Validate V2 and build a bounded story pool from canonical narrative facts. */
export function buildCourseBriefCandidates(value: unknown): CourseBriefCandidateBuildResult {
  const validation = validateCourseBriefInputV2(value);
  if (!validation.ok) return { ok: false, error: "invalid_input" };
  return { ok: true, input: validation.input, candidates: buildCanonicalCandidates(validation.input) };
}

/** Candidate pools are re-derived and compared, so callers cannot invent fact relationships. */
export function validateCourseBriefCandidatePool(
  inputValue: unknown,
  candidateValue: unknown,
): CourseBriefCandidatePoolValidationResult {
  const validation = validateCourseBriefInputV2(inputValue);
  if (!validation.ok || !Array.isArray(candidateValue)) return { ok: false, error: "invalid_input" };
  const parsed = z.array(candidateSchema).max(10_000).safeParse(candidateValue);
  if (!parsed.success) return { ok: false, error: "invalid_candidate_pool" };
  const canonical = buildCanonicalCandidates(validation.input);
  if (!sameJson([...parsed.data].sort(compareCandidates), canonical)) return { ok: false, error: "invalid_candidate_pool" };
  return { ok: true, input: validation.input, candidates: canonical };
}

/** Selects with explicit component, endpoint, structural-diversity, and spread rules. */
export function selectCourseBriefCandidates(
  inputValue: unknown,
  candidateValue: unknown,
): CourseBriefSelectionResult {
  const pool = validateCourseBriefCandidatePool(inputValue, candidateValue);
  if (!pool.ok) return pool;
  const ordered = [...pool.candidates].sort(compareCandidates);
  if (ordered.length === 0) return { ok: false, error: "insufficient_route_facts" };

  const target = Math.min(COURSE_BRIEF_MAX_OBSERVATIONS_V2, ordered.length);
  const selected: CourseBriefCandidate[] = [];
  const reasons = new Map<string, string[]>();
  const add = (candidate: CourseBriefCandidate, codes: string[]) => {
    if (selected.some((item) => item.candidateId === candidate.candidateId)) return;
    if (conflictsWithSelected(candidate, selected)) return;
    selected.push(candidate);
    reasons.set(candidate.candidateId, codes);
  };

  const componentIndexes = traversableComponents(pool.input);
  for (const componentIndex of componentIndexes) {
    if (selected.length >= target) break;
    const candidate = ordered.find((item) => item.componentIndex === componentIndex);
    if (candidate) add(candidate, ["component_coverage", "primary_structural_story"]);
  }

  // Preserve each useful component's opening and finish when there is room.
  for (const componentIndex of componentIndexes) {
    if (selected.length >= target) break;
    const inComponent = ordered.filter((item) => item.componentIndex === componentIndex);
    if (inComponent.length < 2) continue;
    const last = inComponent.at(-1)!;
    if (!selected.some((item) => item.componentIndex === componentIndex && item.candidateId === last.candidateId)) {
      add(last, ["finish_progression", "primary_structural_story"]);
    }
  }

  while (selected.length < target) {
    const remaining = ordered.filter((candidate) => !selected.some((item) => item.candidateId === candidate.candidateId) &&
      !conflictsWithSelected(candidate, selected) && hasNovelStoryCoverage(candidate, selected));
    if (remaining.length === 0) break;
    const ranked = remaining.map((candidate) => ({ candidate, rank: rankCandidate(candidate, selected, pool.input) }))
      .sort((left, right) => compareRanks(right.rank, left.rank) || compareCandidates(left.candidate, right.candidate));
    const best = ranked[0];
    const codes = ["new_structural_coverage"];
    if (best.rank.newCharacter) codes.push("character_diversity");
    if (best.rank.newTransition) codes.push("material_transition");
    if (best.rank.lateEvolution) codes.push("late_progression");
    if (best.rank.spread > 0) codes.push("course_spread");
    add(best.candidate, codes);
  }

  const chosen = selected.sort(compareCandidates);
  const omitted = ordered.filter((candidate) => !selected.some((item) => item.candidateId === candidate.candidateId));
  const omissionReasons = omitted.map((candidate) => ({
    candidateId: candidate.candidateId,
    code: selected.length >= target ? "safety_ceiling" as const : "redundant_coverage" as const,
  }));
  const requiredComponents = new Set(pool.input.route.components.filter((component) => component.traversedDistanceKm > 0)
    .map((component) => component.segmentIndex));
  const represented = new Set(chosen.map(({ componentIndex }) => componentIndex));
  return {
    ok: true,
    selectedCandidates: chosen,
    omittedCandidateIds: omitted.map(({ candidateId }) => candidateId),
    componentCoverageComplete: [...requiredComponents].every((componentIndex) => represented.has(componentIndex)),
    selectionReasons: chosen.map(({ candidateId }) => ({ candidateId, codes: reasons.get(candidateId) ?? ["new_structural_coverage"] })),
    omissionReasons,
  };
}

/** Pure V2 pipeline. It has no provider, persistence, or network dependency. */
export function generateDeterministicCourseBriefV2(value: unknown): CourseBriefDeterministicV2Result {
  const built = buildCourseBriefCandidates(value);
  if (!built.ok) return built;
  const selection = selectCourseBriefCandidates(built.input, built.candidates);
  if (!selection.ok) {
    return { ok: false, error: selection.error === "insufficient_route_facts" ? "insufficient_route_facts" : "invalid_input" };
  }
  return { ok: true, output: renderCourseBriefV2(built.input, built.candidates, selection) };
}

/** Renders only canonical, validated candidates and facts. */
export function renderCourseBriefV2(
  input: CourseBriefInputV2,
  candidates: readonly CourseBriefCandidate[],
  selection: Extract<CourseBriefSelectionResult, { ok: true }>,
): CourseBriefOutputV2 {
  const pool = validateCourseBriefCandidatePool(input, candidates);
  if (!pool.ok) {
    throw new TypeError("CourseBriefOutputV2 requires a canonical candidate pool and selection.");
  }
  const expectedSelection = selectCourseBriefCandidates(pool.input, pool.candidates);
  if (!expectedSelection.ok || !sameJson(selection, expectedSelection)) {
    throw new TypeError("CourseBriefOutputV2 requires the deterministic selection for its candidate pool.");
  }
  const index = buildCourseBriefNarrativeFactIndex(pool.input);
  if (!index) throw new TypeError("CourseBriefOutputV2 requires validated narrative facts.");
  const observations = [...selection.selectedCandidates].sort(compareCandidates).map((candidate) => {
    const primary = index.byId.get(candidate.primaryFactId);
    if (!primary) throw new TypeError("CourseBriefOutputV2 candidate primary fact is missing.");
    const factIds = [candidate.primaryFactId, ...candidate.supportingFactIds];
    const facts = factIds.map((factId) => index.byId.get(factId));
    if (facts.some((fact) => !fact)) throw new TypeError("CourseBriefOutputV2 candidate support fact is missing.");
    return {
      candidateId: candidate.candidateId,
      sourceFactIds: factIds,
      componentIndex: candidate.componentIndex,
      startKm: candidateRange(candidate, index.byId).startKm,
      endKm: candidateRange(candidate, index.byId).endKm,
      displayOrderKey: candidate.displayOrderKey,
      text: renderCandidate(candidate, facts as NarrativeFact[], pool.input),
    };
  });
  const result: CourseBriefOutputV2 = {
    schemaVersion: COURSE_BRIEF_OUTPUT_V2_SCHEMA_VERSION,
    observations,
    diagnostics: {
      candidateCount: pool.candidates.length,
      selectedCount: observations.length,
      omittedCount: selection.omittedCandidateIds.length,
      omittedCandidateIds: [...selection.omittedCandidateIds],
      componentCoverageComplete: selection.componentCoverageComplete,
      selectionMode: "deterministic",
      selectionReasons: selection.selectionReasons.map(({ candidateId, codes }) => ({ candidateId, codes: [...codes] })),
      omissionReasons: selection.omissionReasons.map((reason) => ({ ...reason })),
    },
  };
  if (!outputSchema.safeParse(result).success) throw new TypeError("CourseBriefOutputV2 failed output validation.");
  return result;
}

function buildCanonicalCandidates(input: CourseBriefInputV2): CourseBriefCandidate[] {
  const index = buildCourseBriefNarrativeFactIndex(input);
  if (!index) return [];
  const facts = index.eligibleFacts;
  const unitFacts = facts.filter((fact): fact is Extract<NarrativeFact, { type: "UNIT_CHARACTER" }> => fact.type === "UNIT_CHARACTER");
  const units = [...input.units].sort((a, b) => a.segmentIndex - b.segmentIndex || a.ordinal - b.ordinal || a.unitId.localeCompare(b.unitId));
  const transitions = facts.filter((fact): fact is Extract<NarrativeFact, { type: "STRUCTURAL_TRANSITION" }> => fact.type === "STRUCTURAL_TRANSITION");
  const anchors = facts.filter((fact): fact is Extract<NarrativeFact, { type: "ANCHOR_WITHIN_UNIT" }> => fact.type === "ANCHOR_WITHIN_UNIT");
  const finishes = facts.filter((fact): fact is Extract<NarrativeFact, { type: "PERSISTENT_FINISH_CHARACTER" }> => fact.type === "PERSISTENT_FINISH_CHARACTER");
  const evolutions = facts.filter((fact): fact is Extract<NarrativeFact, { type: "VERTICAL_INTENSITY_EVOLUTION" }> => fact.type === "VERTICAL_INTENSITY_EVOLUTION");
  const candidates: CourseBriefCandidate[] = [];
  const representedTransitions = new Set<string>();
  const representedEvolutions = new Set<string>();
  const representedAnchors = new Set<string>();
  const unitCandidateById = new Map<string, CourseBriefCandidate>();
  const consumedUnits = new Set<string>();

  for (const unit of units) {
    if (consumedUnits.has(unit.unitId)) continue;
    const component = input.route.components.find((item) => item.segmentIndex === unit.segmentIndex);
    if (!component || component.traversedDistanceKm <= 0) continue;
    const primary = unitFacts.find((fact) => fact.unitId === unit.unitId && fact.segmentIndex === unit.segmentIndex);
    if (!primary) continue;
    const unitGroup = [unit];
    if (unit.character !== "evolving") {
      let cursor = units.indexOf(unit) + 1;
      while (cursor < units.length) {
        const next = units[cursor];
        const nextPrimary = unitFacts.find((fact) => fact.unitId === next.unitId && fact.segmentIndex === next.segmentIndex);
        const boundaryTransition = transitions.some((fact) => fact.segmentIndex === unit.segmentIndex &&
          fact.fromUnitId === unitGroup.at(-1)!.unitId && fact.toUnitId === next.unitId);
        if (!nextPrimary || next.segmentIndex !== unit.segmentIndex || next.character !== unit.character || boundaryTransition ||
          Math.abs(unitGroup.at(-1)!.endKm - next.startKm) > 0.01) break;
        unitGroup.push(next);
        cursor += 1;
      }
    }
    unitGroup.forEach((item) => consumedUnits.add(item.unitId));
    const unitIds = new Set(unitGroup.map(({ unitId }) => unitId));
    const unitTransitions = transitions.filter((fact) => fact.segmentIndex === unit.segmentIndex &&
      ((fact.toUnitId === unit.unitId && fact.fromUnitId !== unit.unitId) ||
        (unit.character === "evolving" && fact.fromUnitId === unit.unitId && fact.toUnitId === unit.unitId)))
      .sort((a, b) => a.boundaryKm - b.boundaryKm || a.factId.localeCompare(b.factId));
    const finish = finishes.find((fact) => unitIds.has(fact.unitId) && fact.segmentIndex === unit.segmentIndex);
    const evolution = evolutions.filter((fact) => fact.segmentIndex === unit.segmentIndex && fact.unitIds.includes(unit.unitId))
      .filter((fact) => latestUnitId(fact.unitIds, units) === unitGroup.at(-1)!.unitId)
      .sort((a, b) => a.startKm - b.startKm || a.factId.localeCompare(b.factId))[0];
    const anchor = chooseAnchor(anchors.filter((fact) => unitIds.has(fact.unitId) && fact.segmentIndex === unit.segmentIndex));

    let pattern: CourseBriefRenderPattern;
    if (finish) pattern = "EVOLVING_FINISH";
    else if (unitTransitions.some((fact) => fact.toUnitId === unit.unitId && fact.fromUnitId !== unit.unitId)) pattern = "TRANSITION_TO_UNIT";
    else if (anchor) pattern = "UNIT_WITH_ANCHOR";
    else pattern = "UNIT";

    const supporting: NarrativeFact[] = [];
    if (pattern === "EVOLVING_FINISH") {
      supporting.push(...unitTransitions);
      if (finish) supporting.push(finish);
      if (evolution) supporting.push(evolution);
      if (anchor) supporting.push(anchor);
    } else {
      const incoming = unitTransitions.find((fact) => fact.toUnitId === unit.unitId && fact.fromUnitId !== unit.unitId);
      if (incoming) supporting.push(incoming);
      if (anchor) supporting.push(anchor);
    }
    for (const groupedUnit of unitGroup.slice(1)) {
      const groupedFact = unitFacts.find((fact) => fact.unitId === groupedUnit.unitId && fact.segmentIndex === groupedUnit.segmentIndex);
      if (groupedFact) supporting.push(groupedFact);
    }

    for (const fact of supporting) {
      if (fact.type === "STRUCTURAL_TRANSITION") representedTransitions.add(fact.factId);
      if (fact.type === "VERTICAL_INTENSITY_EVOLUTION") representedEvolutions.add(fact.factId);
      if (fact.type === "ANCHOR_WITHIN_UNIT") representedAnchors.add(fact.factId);
    }
    const candidate = createCandidate(primary, supporting, pattern, unit.ordinal, unit.unitId, unit.segmentIndex, unitGroup.map(({ unitId }) => unitId));
    candidates.push(candidate);
    unitGroup.forEach(({ unitId }) => unitCandidateById.set(unitId, candidate));
  }

  // A transition is standalone only when neither neighboring unit has a usable candidate.
  for (const transition of transitions) {
    if (representedTransitions.has(transition.factId)) continue;
    const toUnit = units.find((unit) => unit.unitId === transition.toUnitId && unit.segmentIndex === transition.segmentIndex);
    const fromUnit = units.find((unit) => unit.unitId === transition.fromUnitId && unit.segmentIndex === transition.segmentIndex);
    if (toUnit && unitCandidateById.has(toUnit.unitId)) continue;
    if (fromUnit) {
      const previousCandidate = unitCandidateById.get(fromUnit.unitId);
      if (previousCandidate) {
        previousCandidate.supportingFactIds.push(transition.factId);
        previousCandidate.narrativeGroupIds = unique([...previousCandidate.narrativeGroupIds, transition.narrativeGroupId]);
        previousCandidate.coverageAtomIds = unique([...previousCandidate.coverageAtomIds, `transition:${transition.transitionId}`]);
        previousCandidate.redundancyKeys = unique([...previousCandidate.redundancyKeys, `transition:${transition.transitionId}`]);
        previousCandidate.renderPatternId = "STANDALONE_TRANSITION";
        previousCandidate.candidateId = `candidate:standalone_transition:${previousCandidate.primaryFactId}`;
        representedTransitions.add(transition.factId);
        continue;
      }
    }
    candidates.push(createCandidate(transition, [], "STANDALONE_TRANSITION", transition.courseOrder, null, transition.segmentIndex));
    representedTransitions.add(transition.factId);
  }

  // Keep evolution attached to its latest represented unit; otherwise expose it as a standalone arc.
  for (const evolution of evolutions) {
    if (representedEvolutions.has(evolution.factId)) continue;
    const lastUnitId = latestUnitId(evolution.unitIds, units);
    const lastUnit = units.find((unit) => unit.unitId === lastUnitId && unit.segmentIndex === evolution.segmentIndex);
    const component = input.route.components.find((item) => item.segmentIndex === evolution.segmentIndex);
    if (lastUnit && component && component.traversedDistanceKm > 0) {
      candidates.push(createCandidate(evolution, [], "EVOLUTION", lastUnit.ordinal, null, evolution.segmentIndex));
    }
  }

  // Mark unused anchors as available facts, but never expand a unit into an anchor list.
  // They intentionally do not become candidates on their own.
  void representedAnchors;
  return candidates.sort(compareCandidates);
}

function createCandidate(
  primary: NarrativeFact,
  supporting: readonly NarrativeFact[],
  pattern: CourseBriefRenderPattern,
  order: number,
  unitId: string | null,
  componentIndex: number,
  groupedUnitIds: readonly string[] = unitId ? [unitId] : [],
): CourseBriefCandidate {
  const candidateId = `candidate:${pattern.toLowerCase()}:${primary.factId}`;
  const factGroupIds = unique([primary, ...supporting].map(({ narrativeGroupId }) => narrativeGroupId));
  const unitAtoms = groupedUnitIds.map((id) => `unit:${id}`);
  const transitionAtoms = supporting.filter((fact) => fact.type === "STRUCTURAL_TRANSITION").map((fact) => `transition:${fact.transitionId}`);
  const evolutionAtoms = [primary, ...supporting].filter((fact) => fact.type === "VERTICAL_INTENSITY_EVOLUTION").map((fact) => `evolution:${fact.factId}`);
  const anchorAtoms = supporting.filter((fact) => fact.type === "ANCHOR_WITHIN_UNIT").map((fact) => `anchor:${fact.sourceId}`);
  const finishAtoms = supporting.filter((fact) => fact.type === "PERSISTENT_FINISH_CHARACTER").map((fact) => `finish:${fact.unitId}`);
  const transitionPrimary = primary.type === "STRUCTURAL_TRANSITION" ? [`transition:${primary.transitionId}`] : [];
  const coverageAtomIds = unique([`component:${componentIndex}`, ...unitAtoms, ...transitionAtoms, ...evolutionAtoms, ...anchorAtoms, ...finishAtoms, ...transitionPrimary]);
  const partialCoverageAtomIds = unique([primary, ...supporting].flatMap((fact) =>
    fact.type === "VERTICAL_INTENSITY_EVOLUTION" ? fact.unitIds.map((id) => `partial-unit:${id}`) : []));
  const redundancyKeys = unique([
    ...groupedUnitIds.map((id) => `unit:${id}`),
    ...transitionAtoms,
    ...transitionPrimary,
    ...anchorAtoms,
    ...evolutionAtoms,
    ...finishAtoms,
  ]);
  return {
    candidateId,
    componentIndex,
    displayOrderKey: order,
    narrativeGroupIds: factGroupIds,
    primaryFactId: primary.factId,
    supportingFactIds: supporting.map(({ factId }) => factId),
    coverageAtomIds,
    partialCoverageAtomIds,
    redundancyKeys,
    renderPatternId: pattern,
  };
}

function chooseAnchor(anchors: readonly Extract<NarrativeFact, { type: "ANCHOR_WITHIN_UNIT" }>[]) {
  const ordered = [...anchors].sort((a, b) => a.startKm - b.startKm || a.factId.localeCompare(b.factId));
  return ordered.find((fact) => fact.anchorKind === "key-moment" && fact.roles.includes("longest") && fact.roles.includes("largest")) ??
    ordered.find((fact) => fact.anchorKind === "key-moment") ?? ordered.find((fact) => fact.anchorKind === "highest" || fact.anchorKind === "lowest");
}

function latestUnitId(unitIds: readonly string[], units: readonly CourseBriefInputV2["units"][number][]): string | null {
  return [...unitIds].map((id) => units.find((unit) => unit.unitId === id)).filter((unit) => unit !== undefined)
    .sort((a, b) => b.segmentIndex - a.segmentIndex || b.ordinal - a.ordinal || b.unitId.localeCompare(a.unitId))[0]?.unitId ?? null;
}

function conflictsWithSelected(candidate: CourseBriefCandidate, selected: readonly CourseBriefCandidate[]): boolean {
  const hard = new Set(candidate.redundancyKeys);
  for (const item of selected) if (item.redundancyKeys.some((key) => hard.has(key))) return true;
  return false;
}

function hasNovelStoryCoverage(candidate: CourseBriefCandidate, selected: readonly CourseBriefCandidate[]): boolean {
  const covered = new Set(selected.flatMap(({ coverageAtomIds }) => coverageAtomIds));
  return candidate.coverageAtomIds.some((atom) => atom.startsWith("unit:") || atom.startsWith("transition:") || atom.startsWith("evolution:")
    ? !covered.has(atom) : false);
}

type CandidateRank = { newCharacter: boolean; newTransition: boolean; lateEvolution: boolean; spread: number };
function rankCandidate(candidate: CourseBriefCandidate, selected: readonly CourseBriefCandidate[], input: CourseBriefInputV2): CandidateRank {
  const primary = input.facts.find((fact) => fact.factId === candidate.primaryFactId);
  const character = primary?.type === "UNIT_CHARACTER" ? primary.character : null;
  const selectedCharacters = new Set(selected.flatMap((item) => {
    const fact = input.facts.find((value) => value.factId === item.primaryFactId);
    return fact?.type === "UNIT_CHARACTER" ? [fact.character] : [];
  }));
  const selectedCoverage = new Set(selected.flatMap(({ coverageAtomIds }) => coverageAtomIds));
  const newTransition = candidate.coverageAtomIds.some((atom) => atom.startsWith("transition:") && !selectedCoverage.has(atom));
  const lateEvolution = candidate.renderPatternId === "EVOLVING_FINISH" || candidate.renderPatternId === "EVOLUTION";
  const peers = selected.filter((item) => item.componentIndex === candidate.componentIndex);
  const spread = peers.length === 0 ? 0 : Math.min(...peers.map((item) => Math.abs(item.displayOrderKey - candidate.displayOrderKey)));
  return { newCharacter: character !== null && !selectedCharacters.has(character), newTransition, lateEvolution, spread };
}

function compareRanks(a: CandidateRank, b: CandidateRank): number {
  return Number(a.newCharacter) - Number(b.newCharacter) || Number(a.newTransition) - Number(b.newTransition) ||
    Number(a.lateEvolution) - Number(b.lateEvolution) || a.spread - b.spread;
}

function traversableComponents(input: CourseBriefInputV2): number[] {
  return input.route.components.filter((component) => component.traversedDistanceKm > 0).map(({ segmentIndex }) => segmentIndex);
}

function compareCandidates(a: CourseBriefCandidate, b: CourseBriefCandidate): number {
  return a.componentIndex - b.componentIndex || a.displayOrderKey - b.displayOrderKey || a.candidateId.localeCompare(b.candidateId);
}

function unique(values: readonly string[]): string[] { return [...new Set(values)]; }
function sameJson(left: unknown, right: unknown): boolean { return JSON.stringify(left) === JSON.stringify(right); }

function candidateRange(candidate: CourseBriefCandidate, facts: ReadonlyMap<string, NarrativeFact>): { startKm: number; endKm: number } {
  const members = [candidate.primaryFactId, ...candidate.supportingFactIds].map((id) => facts.get(id))
    .filter((fact): fact is Extract<NarrativeFact, { type: "UNIT_CHARACTER" }> => fact?.type === "UNIT_CHARACTER");
  if (members.length === 0) {
    const primary = facts.get(candidate.primaryFactId);
    if (!primary) throw new TypeError("CourseBrief candidate primary fact is missing.");
    return { startKm: primary.startKm, endKm: primary.endKm };
  }
  return { startKm: Math.min(...members.map(({ startKm }) => startKm)), endKm: Math.max(...members.map(({ endKm }) => endKm)) };
}

function renderCandidate(candidate: CourseBriefCandidate, facts: NarrativeFact[], input: CourseBriefInputV2): string {
  const primary = facts.find((fact) => fact.factId === candidate.primaryFactId)!;
  const unit = primary.type === "UNIT_CHARACTER" ? primary : null;
  const support = facts.filter((fact) => fact.factId !== primary.factId);
  const unitRecord = unit ? input.units.find((item) => item.unitId === unit.unitId)! : null;
  const groupedUnits = [unit, ...support.filter((fact): fact is Extract<NarrativeFact, { type: "UNIT_CHARACTER" }> => fact.type === "UNIT_CHARACTER")]
    .filter((fact): fact is Extract<NarrativeFact, { type: "UNIT_CHARACTER" }> => fact !== null);
  const unitStartKm = groupedUnits.length ? Math.min(...groupedUnits.map(({ startKm }) => startKm)) : primary.startKm;
  const unitEndKm = groupedUnits.length ? Math.max(...groupedUnits.map(({ endKm }) => endKm)) : primary.endKm;
  const segmentPrefix = input.route.components.filter((component) => component.traversedDistanceKm > 0).length > 1
    ? `On track segment ${candidate.componentIndex + 1}, ` : "";
  switch (candidate.renderPatternId) {
    case "UNIT":
      if (!unit || !unitRecord) throw new TypeError("UNIT candidate facts do not match its render pattern.");
      return `${segmentPrefix}${renderUnitProgression(unit.character, unitStartKm, unitEndKm)}.`;
    case "UNIT_WITH_ANCHOR": {
      const anchor = support.find((fact): fact is Extract<NarrativeFact, { type: "ANCHOR_WITHIN_UNIT" }> => fact.type === "ANCHOR_WITHIN_UNIT");
      if (!unit || !unitRecord || !anchor) throw new TypeError("UNIT_WITH_ANCHOR candidate facts do not match its render pattern.");
      return `${segmentPrefix}${renderUnitProgression(unit.character, unitStartKm, unitEndKm)}. It includes ${renderAnchor(anchor)}.`;
    }
    case "TRANSITION_TO_UNIT": {
      const transition = support.find((fact): fact is Extract<NarrativeFact, { type: "STRUCTURAL_TRANSITION" }> =>
        fact.type === "STRUCTURAL_TRANSITION" && fact.toUnitId === unit?.unitId && fact.fromUnitId !== fact.toUnitId);
      const anchor = support.find((fact): fact is Extract<NarrativeFact, { type: "ANCHOR_WITHIN_UNIT" }> => fact.type === "ANCHOR_WITHIN_UNIT");
      if (!unit || !unitRecord || !transition) throw new TypeError("TRANSITION_TO_UNIT candidate facts do not match its render pattern.");
      const anchorText = anchor ? ` It includes ${renderAnchor(anchor)}.` : "";
      return `${segmentPrefix}${renderTransition(transition.fromCharacter, transition.toCharacter, transition.boundaryKm, unitEndKm)}.${anchorText}`;
    }
    case "EVOLVING_FINISH": {
      if (!unit || !unitRecord || !support.some((fact) => fact.type === "PERSISTENT_FINISH_CHARACTER")) {
        throw new TypeError("EVOLVING_FINISH candidate facts do not match its render pattern.");
      }
      const transitions = support.filter((fact): fact is Extract<NarrativeFact, { type: "STRUCTURAL_TRANSITION" }> => fact.type === "STRUCTURAL_TRANSITION")
        .sort((a, b) => a.boundaryKm - b.boundaryKm || a.factId.localeCompare(b.factId));
      const transitionText = transitions.map((fact) =>
        `${renderTransition(fact.fromCharacter, fact.toCharacter, fact.boundaryKm)}.`).join(" ");
      const finish = support.find((fact): fact is Extract<NarrativeFact, { type: "PERSISTENT_FINISH_CHARACTER" }> => fact.type === "PERSISTENT_FINISH_CHARACTER")!;
      const evolution = support.find((fact): fact is Extract<NarrativeFact, { type: "VERTICAL_INTENSITY_EVOLUTION" }> => fact.type === "VERTICAL_INTENSITY_EVOLUTION");
      const anchor = support.find((fact): fact is Extract<NarrativeFact, { type: "ANCHOR_WITHIN_UNIT" }> => fact.type === "ANCHOR_WITHIN_UNIT");
      const evolutionText = evolution
        ? ` ${renderIntensityEvolution(evolution.startKm, evolution.endKm, evolution.valuesMPerKm)}.`
        : "";
      const anchorText = anchor ? ` The segment's ${anchor.anchorKind} point is ${formatMeters(anchor.measurements.elevationM!)} m near ${formatKm(anchor.startKm)} km.` : "";
      if (transitionText) {
        return `${segmentPrefix}${transitionText} The closing stretch remains ${phaseDescription(finish.character)} through the ${formatKm(finish.componentEndKm)} km component finish.${evolutionText}${anchorText}`;
      }
      return `${segmentPrefix}From ${formatKm(unitStartKm)} to ${formatKm(unitEndKm)} km, the route remains ${phaseDescription(finish.character)} through the ${formatKm(finish.componentEndKm)} km component finish.${evolutionText}${anchorText}`;
    }
    case "EVOLUTION": {
      if (primary.type !== "VERTICAL_INTENSITY_EVOLUTION") throw new TypeError("EVOLUTION candidate facts do not match its render pattern.");
      return `${segmentPrefix}${renderIntensityEvolution(primary.startKm, primary.endKm, primary.valuesMPerKm)}.`;
    }
    case "STANDALONE_TRANSITION": {
      if (primary.type === "STRUCTURAL_TRANSITION") {
        return `${segmentPrefix}${renderTransition(primary.fromCharacter, primary.toCharacter, primary.boundaryKm)}.`;
      }
      const transition = support.find((fact): fact is Extract<NarrativeFact, { type: "STRUCTURAL_TRANSITION" }> => fact.type === "STRUCTURAL_TRANSITION");
      if (primary.type !== "UNIT_CHARACTER" || !unitRecord || !transition) throw new TypeError("STANDALONE_TRANSITION candidate facts do not match its render pattern.");
      return `${segmentPrefix}${renderUnitProgression(primary.character, unitStartKm, unitEndKm)}. ${renderTransition(transition.fromCharacter, transition.toCharacter, transition.boundaryKm)}.`;
    }
  }
}

function renderAnchor(anchor: Extract<NarrativeFact, { type: "ANCHOR_WITHIN_UNIT" }>): string {
  if (anchor.anchorKind === "key-moment") {
    const roles = anchor.roles.length === 2 ? "longest and largest" : anchor.roles[0];
    const magnitude = anchor.measurements.elevationChangeM;
    const unit = anchor.eventKind === "climb" ? "ascent" : "descent";
    return `the ${roles} detected ${anchor.eventKind} (${formatKm(anchor.startKm)}–${formatKm(anchor.endKm)} km, ${formatMeters(magnitude!)} m ${unit})`;
  }
  return `the ${anchor.anchorKind} point at ${formatMeters(anchor.measurements.elevationM!)} m near ${formatKm(anchor.startKm)} km`;
}

type CourseCharacter = Extract<NarrativeFact, { type: "UNIT_CHARACTER" }>['character'];

function phaseDescription(character: CourseCharacter): string {
  switch (character) {
    case "climb-dominant": return "climb-led";
    case "descent-dominant": return "descent-led";
    case "repeated-vertical": return "defined by repeated climbs and descents";
    case "low-vertical": return "marked by relatively little climbing and descending per kilometre";
    case "mixed": return "characterized by a mix of climbing and descending";
    case "evolving": return "marked by a changing pattern of climbing and descending";
  }
}

function transitionDestination(character: CourseCharacter): string {
  switch (character) {
    case "climb-dominant": return "a climb-led stretch";
    case "descent-dominant": return "a descent-led stretch";
    case "repeated-vertical": return "a stretch of repeated climbs and descents";
    case "low-vertical": return "a stretch with relatively little climbing and descending per kilometre";
    case "mixed": return "a stretch with a mix of climbing and descending";
    case "evolving": return "a stretch with a changing elevation pattern";
  }
}

function transitionSource(character: CourseCharacter): string {
  switch (character) {
    case "climb-dominant": return "climbing";
    case "descent-dominant": return "descending";
    case "repeated-vertical": return "the pattern of repeated climbs and descents";
    case "low-vertical": return "a stretch with relatively little climbing and descending per kilometre";
    case "mixed": return "a mix of climbing and descending";
    case "evolving": return "a changing pattern of climbing and descending";
  }
}

function renderUnitProgression(character: CourseCharacter, startKm: number, endKm: number): string {
  const range = `From ${formatKm(startKm)} to ${formatKm(endKm)} km`;
  switch (character) {
    case "climb-dominant": return `${range}, climbing leads the course`;
    case "descent-dominant": return `${range}, descending leads the course`;
    case "repeated-vertical": return `${range}, the route features repeated climbs and descents`;
    case "low-vertical": return `${range}, there is relatively little climbing and descending per kilometre`;
    case "mixed": return `${range}, climbing and descending are mixed`;
    case "evolving": return `${range}, the pattern of climbing and descending evolves`;
  }
}

function renderTransition(from: CourseCharacter, to: CourseCharacter, boundaryKm: number, continuesToKm?: number): string {
  const continuation = continuesToKm === undefined ? "" : `, which continues to ${formatKm(continuesToKm)} km`;
  return `At ${formatKm(boundaryKm)} km, ${transitionSource(from)} gives way to ${transitionDestination(to)}${continuation}`;
}

function renderIntensityEvolution(startKm: number, endKm: number, valuesMPerKm: number[]): string {
  const values = valuesMPerKm.map(formatIntensity);
  const series = values.length === 2
    ? `${values[0]} then ${values[1]}`
    : `${values.slice(0, -1).join(", ")}, then ${values.at(-1)}`;
  return `Across ${formatKm(startKm)}–${formatKm(endKm)} km, combined ascent and descent per kilometre falls across successive phases: ${series} m/km`;
}
function formatKm(value: number): string { return (Math.round((value + Number.EPSILON) * 10) / 10).toFixed(1); }
function formatMeters(value: number): string { return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value); }
function formatIntensity(value: number): string { return new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(value); }
