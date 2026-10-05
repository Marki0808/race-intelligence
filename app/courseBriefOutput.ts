import { z } from "zod";
import { validateCourseBriefCandidate } from "./courseBriefClaimValidation.ts";
import type { CourseBriefInputV1 } from "./courseBriefInput.ts";
import type { TerrainCategory } from "./terrainAggregation.ts";

export const COURSE_BRIEF_OUTPUT_SCHEMA_VERSION = 1 as const;

export const COURSE_BRIEF_CLAIM_TYPES = [
  "vertical_concentration",
  "vertical_transition",
  "key_moment",
  "highest_point",
  "lowest_point",
  "osm_surface_category",
] as const;

export type CourseBriefClaimType = (typeof COURSE_BRIEF_CLAIM_TYPES)[number];
export type CourseBriefDirection = "climb" | "descent";
export type CourseBriefPhase = "early" | "middle" | "late";
export type CourseBriefTransition = "climb-to-descent" | "descent-to-climb";
export type CourseBriefRole = "longest" | "largest";
export type CourseBriefTerrainCategory = Exclude<TerrainCategory, "unknown">;

const factIdSchema = z.string().min(1).max(180).regex(/^[a-z0-9][a-z0-9._-]*$/);

export const courseBriefObservationSchema = z.object({
  claimType: z.enum(COURSE_BRIEF_CLAIM_TYPES),
  supportingFactIds: z.array(factIdSchema).min(1).max(3),
  phase: z.enum(["early", "middle", "late"]).nullable(),
  direction: z.enum(["climb", "descent"]).nullable(),
  transition: z.enum(["climb-to-descent", "descent-to-climb"]).nullable(),
  role: z.enum(["longest", "largest"]).nullable(),
  terrainCategory: z.enum(["paved", "gravel", "dirt-ground", "rocky-rough", "natural-trail", "mixed-trail"]).nullable(),
}).strict();

export const courseBriefCandidateSchema = z.object({
  // Min/max express the fixed version without emitting JSON Schema `const`.
  schemaVersion: z.number().int().min(COURSE_BRIEF_OUTPUT_SCHEMA_VERSION).max(COURSE_BRIEF_OUTPUT_SCHEMA_VERSION),
  headlineObservationIndex: z.number().int().min(0).max(2),
  observations: z.array(courseBriefObservationSchema).min(1).max(3),
}).strict();

export type CourseBriefObservationCandidate = z.infer<typeof courseBriefObservationSchema>;
export type CourseBriefCandidateV1 = z.infer<typeof courseBriefCandidateSchema>;

export type CourseBriefV1 = {
  schemaVersion: typeof COURSE_BRIEF_OUTPUT_SCHEMA_VERSION;
  headlineObservationIndex: number;
  observations: CourseBriefObservationCandidate[];
};

export type RenderedCourseBriefObservation = {
  claimType: CourseBriefClaimType;
  text: string;
  supportingFactIds: string[];
};

export type RenderedCourseBriefV1 = {
  schemaVersion: typeof COURSE_BRIEF_OUTPUT_SCHEMA_VERSION;
  headline: RenderedCourseBriefObservation;
  observations: RenderedCourseBriefObservation[];
};

/** Renders only validated claims from their referenced CourseBriefInput facts. */
export function renderCourseBrief(
  brief: CourseBriefV1,
  input: CourseBriefInputV1,
): RenderedCourseBriefV1 {
  const validated = validateCourseBriefCandidate(brief, input);
  if (!validated.ok) throw new TypeError("CourseBrief cannot render claims that fail semantic validation.");

  const observations = validated.brief.observations.map((observation) => ({
    claimType: observation.claimType,
    supportingFactIds: [...observation.supportingFactIds],
    text: renderObservation(observation, input),
  }));
  return {
    schemaVersion: COURSE_BRIEF_OUTPUT_SCHEMA_VERSION,
    headline: observations[validated.brief.headlineObservationIndex],
    observations,
  };
}

function renderObservation(observation: CourseBriefObservationCandidate, input: CourseBriefInputV1): string {
  switch (observation.claimType) {
    case "vertical_concentration": {
      const progression = input.derivedFacts.verticalProgression!;
      const bin = progression[observation.phase!];
      const amount = observation.direction === "climb" ? bin.gainM : bin.lossM;
      const otherAmount = [progression.early, progression.middle, progression.late]
        .filter((otherBin) => otherBin.factId !== bin.factId)
        .reduce((sum, otherBin) => sum + (observation.direction === "climb" ? otherBin.gainM : otherBin.lossM), 0);
      return `${observation.direction === "climb" ? "Climbing" : "Descending"} is concentrated in the ${observation.phase} part of the route (${formatMeters(amount)} m in the smoothed profile versus ${formatMeters(otherAmount)} m across the other phases).`;
    }
    case "vertical_transition": {
      const progression = input.derivedFacts.verticalProgression!;
      const early = progression.early;
      const late = progression.late;
      return observation.transition === "climb-to-descent"
        ? `The smoothed profile shifts from climb-dominant early (${formatMeters(early.gainM)} m up, ${formatMeters(early.lossM)} m down) to descent-dominant late (${formatMeters(late.gainM)} m up, ${formatMeters(late.lossM)} m down).`
        : `The smoothed profile shifts from descent-dominant early (${formatMeters(early.lossM)} m down, ${formatMeters(early.gainM)} m up) to climb-dominant late (${formatMeters(late.gainM)} m up, ${formatMeters(late.lossM)} m down).`;
    }
    case "key_moment": {
      const fact = input.derivedFacts.keyMoments.find(({ factId }) => factId === observation.supportingFactIds[0])!;
      const role = fact.roles.length === 2 ? "longest and largest" : observation.role;
      return `The ${role} detected ${fact.kind} spans ${formatKm(fact.startKm)}–${formatKm(fact.endKm)} km and has ${formatMeters(fact.elevationChangeM)} m of ${fact.kind === "climb" ? "ascent" : "descent"}.`;
    }
    case "highest_point": {
      const fact = input.directFacts.highest.value;
      return `The GPX records its highest point at ${formatMeters(fact.elevationM)} m near ${formatKm(fact.atKm)} km on track segment ${fact.segmentIndex + 1}.`;
    }
    case "lowest_point": {
      const fact = input.directFacts.lowest.value;
      return `The GPX records its lowest point at ${formatMeters(fact.elevationM)} m near ${formatKm(fact.atKm)} km on track segment ${fact.segmentIndex + 1}.`;
    }
    case "osm_surface_category": {
      const fact = input.evidenceScopedFacts.osmSurface.sections.find(({ factId }) => factId === observation.supportingFactIds[0])!;
      const section = input.derivedFacts.sections.find(({ factId }) => factId === fact.sectionFactId)!;
      const category = fact.categories.find(({ category: value }) => value === observation.terrainCategory)!;
      const coverage = fact.classifiableCoveragePercent!;
      return `In mapped and classifiable OSM evidence for Route Section ${section.ordinal}, ${formatPercent(category.shareOfClassifiableEvidencePercent)} is ${terrainLabel(category.category)}; that evidence covers ${formatPercent(coverage)} of this section.`;
    }
  }
}

function formatMeters(value: number): string { return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value); }
function formatKm(value: number): string { return value.toFixed(1); }
function formatPercent(value: number): string { return value > 0 && value < 1 ? "<1%" : `${Number(value.toFixed(1))}%`; }
function terrainLabel(value: CourseBriefTerrainCategory): string {
  const labels: Record<CourseBriefTerrainCategory, string> = {
    paved: "paved surface",
    gravel: "gravel",
    "dirt-ground": "dirt or ground",
    "rocky-rough": "rocky or rough terrain",
    "natural-trail": "natural trail",
    "mixed-trail": "mixed trail surfaces",
  };
  return labels[value];
}

export const COURSE_BRIEF_CLAIM_CATALOG_V1 = {
  vertical_concentration: {
    requiredKinds: ["progression.early", "progression.middle", "progression.late"],
    allowedParameters: ["phase", "direction"],
    semanticRule: "The selected phase's gain or loss is positive and greater than the sum of the other two phases.",
    redundancy: "Do not repeat the same direction and phase.",
    rendering: "Compare the selected smoothed-profile phase amount with the rest of the route; identify the phase and direction.",
  },
  vertical_transition: {
    requiredKinds: ["progression.early", "progression.middle", "progression.late"],
    allowedParameters: ["transition"],
    semanticRule: "Early and late profile bins have opposite dominant directions, with nonzero gain/loss in each claimed direction.",
    redundancy: "At most one early-to-late transition claim.",
    rendering: "State the early and late dominant directions and their supplied gain/loss totals.",
  },
  key_moment: {
    requiredKinds: ["keyMoment"],
    allowedParameters: ["direction", "role"],
    semanticRule: "The referenced event kind matches direction and its roles include role.",
    redundancy: "The same event cannot be repeated as both longest and largest; a shared winner renders as both.",
    rendering: "State detected event kind, distance range, and ascent/descent from the selected Key Moment fact.",
  },
  highest_point: {
    requiredKinds: ["direct.highest"],
    allowedParameters: [],
    semanticRule: "References exactly route.highest.",
    redundancy: "At most one highest-point claim.",
    rendering: "State recorded elevation, cumulative route km, and track segment.",
  },
  lowest_point: {
    requiredKinds: ["direct.lowest"],
    allowedParameters: [],
    semanticRule: "References exactly route.lowest.",
    redundancy: "At most one lowest-point claim.",
    rendering: "State recorded elevation, cumulative route km, and track segment.",
  },
  osm_surface_category: {
    requiredKinds: ["osmSurfaceSection"],
    allowedParameters: ["terrainCategory"],
    semanticRule: "The referenced section has positive exact mapped coverage and contains the selected category share.",
    redundancy: "A repeated category claim for the same section is redundant.",
    rendering: "Always scope the category share to mapped/classifiable OSM evidence and state its coverage of the named section.",
  },
} as const satisfies Record<CourseBriefClaimType, {
  requiredKinds: readonly string[];
  allowedParameters: readonly string[];
  semanticRule: string;
  redundancy: string;
  rendering: string;
}>;
