import type { CourseBriefInputV1 } from "./courseBriefInput.ts";
import { buildCourseBriefFactIndex, resolveCourseBriefFactIds, type CourseBriefFactIndex, type CourseBriefFactIndexEntry } from "./courseBriefFactIndex.ts";
import { courseBriefCandidateSchema, type CourseBriefObservationCandidate, type CourseBriefV1 } from "./courseBriefOutput.ts";
import type { CourseBriefErrorCode } from "./server/courseBriefProvider.ts";

export type CourseBriefClaimValidationResult =
  | { ok: true; brief: CourseBriefV1; factIndex: CourseBriefFactIndex }
  | { ok: false; error: Extract<CourseBriefErrorCode, "invalid_provider_response" | "unsupported_generated_claim" | "insufficient_route_facts"> };

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
  for (const observation of parsed.data.observations) {
    const facts = resolveCourseBriefFactIds(observation.supportingFactIds, factIndex);
    if (!facts) return { ok: false, error: "invalid_provider_response" };
    const semanticResult = validateObservation(observation, facts, input, factIndex);
    if (semanticResult !== "valid") return { ok: false, error: semanticResult };
    observations.push(observation);
  }

  if (hasRedundancy(observations)) return { ok: false, error: "unsupported_generated_claim" };
  if (observations.length === 0) return { ok: false, error: "insufficient_route_facts" };
  const brief: CourseBriefV1 = {
    schemaVersion: 1,
    headlineObservationIndex: parsed.data.headlineObservationIndex,
    observations,
  };
  return { ok: true, brief, factIndex };
}

function validateObservation(
  observation: CourseBriefObservationCandidate,
  facts: CourseBriefFactIndexEntry[],
  input: CourseBriefInputV1,
  index: CourseBriefFactIndex,
): "valid" | "unsupported_generated_claim" | "insufficient_route_facts" {
  const kinds = facts.map((fact) => fact.kind);
  const progressionKinds = ["progression.early", "progression.middle", "progression.late"];
  switch (observation.claimType) {
    case "vertical_concentration": {
      if (observation.phase === null || observation.direction === null || observation.transition !== null || observation.role !== null || observation.terrainCategory !== null ||
        facts.length !== 3 || !sameMembers(kinds, progressionKinds)) return "unsupported_generated_claim";
      const progression = input.derivedFacts.verticalProgression;
      if (!progression) return "insufficient_route_facts";
      const amounts = [progression.early, progression.middle, progression.late].map((bin) => observation.direction === "climb" ? bin.gainM : bin.lossM);
      const selectedIndex = observation.phase === "early" ? 0 : observation.phase === "middle" ? 1 : 2;
      return amounts[selectedIndex] > 0 && amounts[selectedIndex] > amounts.reduce((sum, amount, itemIndex) => sum + (itemIndex === selectedIndex ? 0 : amount), 0)
        ? "valid" : "unsupported_generated_claim";
    }
    case "vertical_transition": {
      if (observation.phase !== null || observation.direction !== null || observation.transition === null || observation.role !== null || observation.terrainCategory !== null ||
        facts.length !== 3 || !sameMembers(kinds, progressionKinds)) return "unsupported_generated_claim";
      const progression = input.derivedFacts.verticalProgression;
      if (!progression) return "insufficient_route_facts";
      const earlyClimb = progression.early.gainM > progression.early.lossM;
      const earlyDescent = progression.early.lossM > progression.early.gainM;
      const lateClimb = progression.late.gainM > progression.late.lossM;
      const lateDescent = progression.late.lossM > progression.late.gainM;
      const valid = observation.transition === "climb-to-descent"
        ? earlyClimb && lateDescent && progression.early.gainM > 0 && progression.late.lossM > 0
        : earlyDescent && lateClimb && progression.early.lossM > 0 && progression.late.gainM > 0;
      return valid ? "valid" : "unsupported_generated_claim";
    }
    case "key_moment": {
      if (observation.phase !== null || observation.transition !== null || observation.terrainCategory !== null || observation.direction === null || observation.role === null ||
        facts.length !== 1 || facts[0].kind !== "keyMoment") return "unsupported_generated_claim";
      const moment = input.derivedFacts.keyMoments.find(({ factId }) => factId === observation.supportingFactIds[0]);
      return moment && moment.kind === observation.direction && moment.roles.includes(observation.role) ? "valid" : "unsupported_generated_claim";
    }
    case "highest_point":
      return observation.phase === null && observation.direction === null && observation.transition === null && observation.role === null && observation.terrainCategory === null &&
        facts.length === 1 && facts[0].kind === "direct.highest" && observation.supportingFactIds[0] === input.directFacts.highest.factId
        ? "valid" : "unsupported_generated_claim";
    case "lowest_point":
      return observation.phase === null && observation.direction === null && observation.transition === null && observation.role === null && observation.terrainCategory === null &&
        facts.length === 1 && facts[0].kind === "direct.lowest" && observation.supportingFactIds[0] === input.directFacts.lowest.factId
        ? "valid" : "unsupported_generated_claim";
    case "osm_surface_category": {
      if (observation.phase !== null || observation.direction !== null || observation.transition !== null || observation.role !== null || observation.terrainCategory === null ||
        facts.length !== 1 || facts[0].kind !== "osmSurfaceSection") return "unsupported_generated_claim";
      const surface = input.evidenceScopedFacts.osmSurface.sections.find(({ factId }) => factId === observation.supportingFactIds[0]);
      const sectionEntry = surface ? index.get(surface.sectionFactId) : null;
      const category = surface?.categories.find(({ category: value }) => value === observation.terrainCategory);
      const osm = input.evidenceScopedFacts.osmSurface;
      const compatibleGlobalEvidence = osm.requestState === "received" &&
        (osm.responseAvailability === "available" || osm.responseAvailability === "unknown");
      return compatibleGlobalEvidence && surface && (surface.status === "partial" || surface.status === "mapped") &&
        sectionEntry?.kind === "section" && surface.classifiableCoveragePercent !== null &&
        surface.classifiableCoveragePercent > 0 && category && category.shareOfClassifiableEvidencePercent > 0
        ? "valid" : "insufficient_route_facts";
    }
  }
}

function hasRedundancy(observations: readonly CourseBriefObservationCandidate[]): boolean {
  const signatures = new Set<string>();
  const eventIds = new Set<string>();
  const surfacePairs = new Set<string>();
  let verticalTransitionUsed = false;
  for (const observation of observations) {
    const signature = [observation.claimType, [...observation.supportingFactIds].sort().join(","), observation.phase, observation.direction,
      observation.transition, observation.role, observation.terrainCategory].join("|");
    if (signatures.has(signature)) return true;
    signatures.add(signature);
    if (observation.claimType === "key_moment") {
      const eventId = observation.supportingFactIds[0];
      if (eventIds.has(eventId)) return true;
      eventIds.add(eventId);
    }
    if (observation.claimType === "osm_surface_category") {
      const surfaceCategory = `${observation.supportingFactIds[0]}:${observation.terrainCategory}`;
      if (surfacePairs.has(surfaceCategory)) return true;
      surfacePairs.add(surfaceCategory);
    }
    if (observation.claimType === "vertical_transition") {
      if (verticalTransitionUsed) return true;
      verticalTransitionUsed = true;
    }
  }
  return false;
}

function sameMembers(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && new Set(left).size === right.length && left.every((item) => right.includes(item));
}
