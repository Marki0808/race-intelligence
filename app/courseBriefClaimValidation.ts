import type { CourseBriefInputV1 } from "./courseBriefInput.ts";
import { buildCourseBriefFactIndex, resolveCourseBriefFactIds, type CourseBriefFactIndex, type CourseBriefFactIndexEntry } from "./courseBriefFactIndex.ts";
import { courseBriefCandidateSchema, type CourseBriefObservationCandidate, type CourseBriefV1 } from "./courseBriefOutput.ts";
import type {
  CourseBriefSemanticRejectionCode,
  CourseBriefSemanticRejectionDiagnostic,
} from "./server/courseBriefProvider.ts";

export type CourseBriefClaimValidationResult =
  | { ok: true; brief: CourseBriefV1; factIndex: CourseBriefFactIndex }
  | { ok: false; error: "invalid_provider_response" | "insufficient_route_facts" }
  | { ok: false; error: "unsupported_generated_claim"; rejection: CourseBriefSemanticRejectionDiagnostic };

export type EligibleCourseBriefClaimOption = CourseBriefObservationCandidate & {
  optionId: string;
};

/** Validates output structure, references, claim semantics, then redundancy in that order. */
export function validateCourseBriefCandidate(
  value: unknown,
  input: CourseBriefInputV1,
): CourseBriefClaimValidationResult {
  const parsed = courseBriefCandidateSchema.safeParse(value);
  if (!parsed.success || parsed.data.schemaVersion !== 1 || parsed.data.headlineObservationIndex >= parsed.data.observations.length) {
    return { ok: false, error: "invalid_provider_response" };
  }
  const factIndex = buildCourseBriefFactIndex(input);
  if (!factIndex) return { ok: false, error: "invalid_provider_response" };

  const observations: CourseBriefObservationCandidate[] = [];
  for (const [observationIndex, observation] of parsed.data.observations.entries()) {
    const facts = resolveCourseBriefFactIds(observation.supportingFactIds, factIndex);
    if (!facts) return { ok: false, error: "invalid_provider_response" };
    const semanticResult = evaluateClaimObservation(observation, facts, input, factIndex);
    if (semanticResult !== "valid") {
      if (semanticResult === "insufficient_route_facts") return { ok: false, error: semanticResult };
      return {
        ok: false,
        error: "unsupported_generated_claim",
        rejection: rejectionDiagnostic(observationIndex, observation, semanticResult),
      };
    }
    observations.push(observation);
  }

  const redundancy = findRedundancy(observations);
  if (redundancy) {
    const observation = observations[redundancy.observationIndex];
    return {
      ok: false,
      error: "unsupported_generated_claim",
      rejection: rejectionDiagnostic(redundancy.observationIndex, observation, redundancy.code),
    };
  }
  if (observations.length === 0) return { ok: false, error: "insufficient_route_facts" };
  const brief: CourseBriefV1 = {
    schemaVersion: 1,
    headlineObservationIndex: parsed.data.headlineObservationIndex,
    observations,
  };
  return { ok: true, brief, factIndex };
}

/** Enumerates options using the same semantic evaluator used for final validation. */
export function enumerateEligibleCourseBriefClaimOptions(
  input: CourseBriefInputV1,
): EligibleCourseBriefClaimOption[] {
  const factIndex = buildCourseBriefFactIndex(input);
  if (!factIndex) return [];

  const candidates: CourseBriefObservationCandidate[] = [];
  const emptyParameters = {
    phase: null,
    direction: null,
    transition: null,
    role: null,
    terrainCategory: null,
  } as const;
  const progressionFactIds = ["progression.early", "progression.middle", "progression.late"];

  for (const phase of ["early", "middle", "late"] as const) {
    for (const direction of ["climb", "descent"] as const) {
      candidates.push({
        claimType: "vertical_concentration",
        supportingFactIds: [...progressionFactIds],
        ...emptyParameters,
        phase,
        direction,
      });
    }
  }

  for (const transition of ["climb-to-descent", "descent-to-climb"] as const) {
    candidates.push({
      claimType: "vertical_transition",
      supportingFactIds: [...progressionFactIds],
      ...emptyParameters,
      transition,
    });
  }

  for (const moment of input.derivedFacts.keyMoments) {
    for (const role of moment.roles) {
      candidates.push({
        claimType: "key_moment",
        supportingFactIds: [moment.factId],
        ...emptyParameters,
        direction: moment.kind,
        role,
      });
    }
  }

  candidates.push(
    {
      claimType: "highest_point",
      supportingFactIds: [input.directFacts.highest.factId],
      ...emptyParameters,
    },
    {
      claimType: "lowest_point",
      supportingFactIds: [input.directFacts.lowest.factId],
      ...emptyParameters,
    },
  );

  for (const surface of input.evidenceScopedFacts.osmSurface.sections) {
    for (const { category } of surface.categories) {
      candidates.push({
        claimType: "osm_surface_category",
        supportingFactIds: [surface.factId],
        ...emptyParameters,
        terrainCategory: category,
      });
    }
  }

  const options: EligibleCourseBriefClaimOption[] = [];
  for (const candidate of candidates) {
    const facts = resolveCourseBriefFactIds(candidate.supportingFactIds, factIndex);
    if (!facts || evaluateClaimObservation(candidate, facts, input, factIndex) !== "valid") continue;
    options.push({ optionId: `option-${options.length}`, ...candidate });
  }
  return options;
}

function evaluateClaimObservation(
  observation: CourseBriefObservationCandidate,
  facts: CourseBriefFactIndexEntry[],
  input: CourseBriefInputV1,
  index: CourseBriefFactIndex,
): "valid" | "insufficient_route_facts" | CourseBriefSemanticRejectionCode {
  const kinds = facts.map((fact) => fact.kind);
  const progressionKinds = ["progression.early", "progression.middle", "progression.late"];
  switch (observation.claimType) {
    case "vertical_concentration": {
      if (observation.phase === null || observation.direction === null || observation.transition !== null || observation.role !== null || observation.terrainCategory !== null) {
        return "vertical_concentration_invalid_parameters";
      }
      if (facts.length !== 3 || !sameMembers(kinds, progressionKinds)) return "vertical_concentration_invalid_facts";
      const progression = input.derivedFacts.verticalProgression;
      if (!progression) return "insufficient_route_facts";
      const amounts = [progression.early, progression.middle, progression.late].map((bin) => observation.direction === "climb" ? bin.gainM : bin.lossM);
      const selectedIndex = observation.phase === "early" ? 0 : observation.phase === "middle" ? 1 : 2;
      return amounts[selectedIndex] > 0 && amounts[selectedIndex] > amounts.reduce((sum, amount, itemIndex) => sum + (itemIndex === selectedIndex ? 0 : amount), 0)
        ? "valid" : "vertical_concentration_threshold_failed";
    }
    case "vertical_transition": {
      if (observation.phase !== null || observation.direction !== null || observation.transition === null || observation.role !== null || observation.terrainCategory !== null) {
        return "vertical_transition_invalid_parameters";
      }
      if (facts.length !== 3 || !sameMembers(kinds, progressionKinds)) return "vertical_transition_invalid_facts";
      const progression = input.derivedFacts.verticalProgression;
      if (!progression) return "insufficient_route_facts";
      const earlyClimb = progression.early.gainM > progression.early.lossM;
      const earlyDescent = progression.early.lossM > progression.early.gainM;
      const lateClimb = progression.late.gainM > progression.late.lossM;
      const lateDescent = progression.late.lossM > progression.late.gainM;
      const valid = observation.transition === "climb-to-descent"
        ? earlyClimb && lateDescent && progression.early.gainM > 0 && progression.late.lossM > 0
        : earlyDescent && lateClimb && progression.early.lossM > 0 && progression.late.gainM > 0;
      return valid ? "valid" : "vertical_transition_direction_failed";
    }
    case "key_moment": {
      if (observation.phase !== null || observation.transition !== null || observation.terrainCategory !== null || observation.direction === null || observation.role === null) {
        return "key_moment_invalid_parameters";
      }
      if (facts.length !== 1 || facts[0].kind !== "keyMoment") return "key_moment_invalid_fact";
      const moment = input.derivedFacts.keyMoments.find(({ factId }) => factId === observation.supportingFactIds[0]);
      if (!moment) return "key_moment_invalid_fact";
      if (moment.kind !== observation.direction) return "key_moment_direction_mismatch";
      return moment.roles.includes(observation.role) ? "valid" : "key_moment_role_mismatch";
    }
    case "highest_point": {
      if (observation.phase !== null || observation.direction !== null || observation.transition !== null || observation.role !== null || observation.terrainCategory !== null) {
        return "highest_point_invalid_parameters";
      }
      return facts.length === 1 && facts[0].kind === "direct.highest" && observation.supportingFactIds[0] === input.directFacts.highest.factId
        ? "valid" : "highest_point_invalid_fact";
    }
    case "lowest_point": {
      if (observation.phase !== null || observation.direction !== null || observation.transition !== null || observation.role !== null || observation.terrainCategory !== null) {
        return "lowest_point_invalid_parameters";
      }
      return facts.length === 1 && facts[0].kind === "direct.lowest" && observation.supportingFactIds[0] === input.directFacts.lowest.factId
        ? "valid" : "lowest_point_invalid_fact";
    }
    case "osm_surface_category": {
      if (observation.phase !== null || observation.direction !== null || observation.transition !== null || observation.role !== null || observation.terrainCategory === null) {
        return "osm_surface_invalid_parameters";
      }
      if (facts.length !== 1 || facts[0].kind !== "osmSurfaceSection") return "osm_surface_invalid_fact";
      const surface = input.evidenceScopedFacts.osmSurface.sections.find(({ factId }) => factId === observation.supportingFactIds[0]);
      const sectionEntry = surface ? index.get(surface.sectionFactId) : null;
      const category = surface?.categories.find(({ category: value }) => value === observation.terrainCategory);
      const osm = input.evidenceScopedFacts.osmSurface;
      const compatibleGlobalEvidence = osm.requestState === "received" &&
        (osm.responseAvailability === "available" || osm.responseAvailability === "unknown");
      if (!surface || sectionEntry?.kind !== "section") return "insufficient_route_facts";
      if (!compatibleGlobalEvidence || (surface.status !== "partial" && surface.status !== "mapped") ||
        surface.classifiableCoveragePercent === null || surface.classifiableCoveragePercent <= 0) {
        return "insufficient_route_facts";
      }
      return category && category.shareOfClassifiableEvidencePercent > 0 ? "valid" : "insufficient_route_facts";
    }
  }
}

function findRedundancy(observations: readonly CourseBriefObservationCandidate[]):
  | { observationIndex: number; code: CourseBriefSemanticRejectionCode }
  | null {
  const signatures = new Set<string>();
  const eventIds = new Set<string>();
  const surfacePairs = new Set<string>();
  let verticalTransitionUsed = false;
  for (const [observationIndex, observation] of observations.entries()) {
    const signature = [observation.claimType, [...observation.supportingFactIds].sort().join(","), observation.phase, observation.direction,
      observation.transition, observation.role, observation.terrainCategory].join("|");
    if (observation.claimType === "key_moment") {
      const eventId = observation.supportingFactIds[0];
      if (eventIds.has(eventId)) return { observationIndex, code: "duplicate_key_moment" };
      eventIds.add(eventId);
    }
    if (observation.claimType === "osm_surface_category") {
      const surfaceCategory = `${observation.supportingFactIds[0]}:${observation.terrainCategory}`;
      if (surfacePairs.has(surfaceCategory)) return { observationIndex, code: "duplicate_osm_claim" };
      surfacePairs.add(surfaceCategory);
    }
    if (observation.claimType === "vertical_transition") {
      if (verticalTransitionUsed) return { observationIndex, code: "duplicate_vertical_transition" };
      verticalTransitionUsed = true;
    }
    if (signatures.has(signature)) return { observationIndex, code: "duplicate_claim" };
    signatures.add(signature);
  }
  return null;
}

function rejectionDiagnostic(
  observationIndex: number,
  observation: CourseBriefObservationCandidate,
  code: CourseBriefSemanticRejectionCode,
): CourseBriefSemanticRejectionDiagnostic {
  return {
    observationIndex,
    claimType: observation.claimType,
    supportingFactIds: [...observation.supportingFactIds],
    parameters: {
      phase: observation.phase,
      direction: observation.direction,
      transition: observation.transition,
      role: observation.role,
      terrainCategory: observation.terrainCategory,
    },
    code,
  };
}

function sameMembers(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && new Set(left).size === right.length && left.every((item) => right.includes(item));
}
