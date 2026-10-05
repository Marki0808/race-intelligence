import { z } from "zod";
import type { CourseBriefInputV1 } from "./courseBriefInput.ts";

export const MAX_COURSE_BRIEF_REQUEST_BYTES = 64 * 1024;
export const MAX_COURSE_BRIEF_COMPONENTS = 128;
export const MAX_COURSE_BRIEF_SECTIONS = 128;
export const MAX_COURSE_BRIEF_KEY_MOMENTS = 12;

const nonnegative = (max: number) => z.number().finite().min(0).max(max);
const segmentIndex = z.number().int().min(0).max(MAX_COURSE_BRIEF_COMPONENTS - 1);
const factId = z.string().min(1).max(180).regex(/^[a-z0-9][a-z0-9._-]*$/);
const terrainCategorySchema = z.enum(["paved", "gravel", "dirt-ground", "rocky-rough", "natural-trail", "mixed-trail"]);

const progressionBinSchema = z.object({ factId: z.enum(["progression.early", "progression.middle", "progression.late"]), gainM: nonnegative(100_000), lossM: nonnegative(100_000) }).strict();
const componentSchema = z.object({
  factId: factId.regex(/^route\.component\.\d+$/),
  segmentIndex,
  startKm: nonnegative(10_000),
  endKm: nonnegative(10_000),
  traversedDistanceKm: nonnegative(10_000),
  hasTraversedDistance: z.boolean(),
}).strict();
const sectionSchema = z.object({
  factId: factId.regex(/^section\.s\d+\.m[0-9p]+-[0-9p]+\.(climb|descent|rolling|flat)$/),
  ordinal: z.number().int().min(1).max(MAX_COURSE_BRIEF_SECTIONS),
  segmentIndex,
  startKm: nonnegative(10_000),
  endKm: nonnegative(10_000),
  distanceKm: nonnegative(10_000),
  rhythm: z.enum(["climb", "descent", "rolling", "flat"]),
  ascentM: nonnegative(100_000),
  descentM: nonnegative(100_000),
}).strict();
const keyMomentSchema = z.object({
  factId: factId.regex(/^key\.(climb|descent)\.s\d+\.[a-zA-Z0-9._-]{1,120}$/),
  kind: z.enum(["climb", "descent"]),
  roles: z.array(z.enum(["longest", "largest"])).min(1).max(2),
  segmentIndex,
  startKm: nonnegative(10_000),
  endKm: nonnegative(10_000),
  distanceKm: nonnegative(10_000),
  elevationChangeM: nonnegative(100_000),
}).strict();
const surfaceSectionSchema = z.object({
  factId: factId.regex(/^surface\.section\./),
  sectionFactId: sectionSchema.shape.factId,
  status: z.enum(["not-requested", "unavailable", "missing", "partial", "mapped"]),
  classifiableCoveragePercent: nonnegative(100).nullable(),
  categories: z.array(z.object({
    category: terrainCategorySchema,
    shareOfClassifiableEvidencePercent: nonnegative(100),
  }).strict()).max(6),
}).strict();

const evidenceAvailabilitySchema = z.enum(["available", "not-found", "unknown", "not-applicable"]);

export const courseBriefInputSchema = z.object({
  schemaVersion: z.literal(1),
  analysisVersion: z.number().int().min(1).max(10_000),
  directFacts: z.object({
    distance: z.object({ factId: z.literal("route.distance"), value: z.object({ km: nonnegative(10_000) }).strict() }).strict(),
    rawGain: z.object({ factId: z.literal("route.raw-gain"), value: z.object({ m: nonnegative(100_000) }).strict() }).strict(),
    rawLoss: z.object({ factId: z.literal("route.raw-loss"), value: z.object({ m: nonnegative(100_000) }).strict() }).strict(),
    highest: z.object({ factId: z.literal("route.highest"), value: z.object({ elevationM: z.number().finite().min(-1000).max(10_000), atKm: nonnegative(10_000), segmentIndex }).strict() }).strict(),
    lowest: z.object({ factId: z.literal("route.lowest"), value: z.object({ elevationM: z.number().finite().min(-1000).max(10_000), atKm: nonnegative(10_000), segmentIndex }).strict() }).strict(),
    components: z.array(componentSchema).max(MAX_COURSE_BRIEF_COMPONENTS),
  }).strict(),
  derivedFacts: z.object({
    verticalProgression: z.object({
      basis: z.literal("route-dynamics-smoothed-profile"), early: progressionBinSchema, middle: progressionBinSchema, late: progressionBinSchema,
    }).strict().nullable(),
    sections: z.array(sectionSchema).max(MAX_COURSE_BRIEF_SECTIONS),
    keyMoments: z.array(keyMomentSchema).max(MAX_COURSE_BRIEF_KEY_MOMENTS),
  }).strict(),
  evidenceScopedFacts: z.object({
    osmSurface: z.object({
      requestState: z.enum(["not-requested", "unavailable", "received"]),
      responseAvailability: evidenceAvailabilitySchema.nullable(),
      sections: z.array(surfaceSectionSchema).max(MAX_COURSE_BRIEF_SECTIONS),
    }).strict(),
  }).strict(),
}).strict();

export type CourseBriefInputValidationError =
  | "malformed_input"
  | "inconsistent_input"
  | "duplicate_fact_id";

export type CourseBriefInputValidationResult =
  | { ok: true; input: CourseBriefInputV1 }
  | { ok: false; error: CourseBriefInputValidationError };

/** Strictly validates untrusted route input and relationships before any provider call. */
export function validateCourseBriefInput(value: unknown): CourseBriefInputValidationResult {
  const parsed = courseBriefInputSchema.safeParse(value);
  if (!parsed.success) return { ok: false, error: "malformed_input" };
  const input: CourseBriefInputV1 = parsed.data;
  const ids = collectFactIds(input);
  if (new Set(ids).size !== ids.length) return { ok: false, error: "duplicate_fact_id" };
  if (!validateRelationships(input)) return { ok: false, error: "inconsistent_input" };
  return { ok: true, input };
}

function collectFactIds(input: CourseBriefInputV1): string[] {
  const ids = [
    input.directFacts.distance.factId,
    input.directFacts.rawGain.factId,
    input.directFacts.rawLoss.factId,
    input.directFacts.highest.factId,
    input.directFacts.lowest.factId,
    ...input.directFacts.components.map(({ factId: id }) => id),
    ...input.derivedFacts.sections.map(({ factId: id }) => id),
    ...input.derivedFacts.keyMoments.map(({ factId: id }) => id),
    ...input.evidenceScopedFacts.osmSurface.sections.map(({ factId: id }) => id),
  ];
  const progression = input.derivedFacts.verticalProgression;
  if (progression) ids.push(progression.early.factId, progression.middle.factId, progression.late.factId);
  return ids;
}

function validateRelationships(input: CourseBriefInputV1): boolean {
  const progression = input.derivedFacts.verticalProgression;
  if (progression && (progression.early.factId !== "progression.early" || progression.middle.factId !== "progression.middle" || progression.late.factId !== "progression.late")) return false;

  const components = input.directFacts.components;
  if (components.some((component, index) => component.segmentIndex !== index ||
    component.factId !== `route.component.${component.segmentIndex}` ||
    component.endKm < component.startKm ||
      !closeEnough(component.traversedDistanceKm, component.endKm - component.startKm) ||
    component.hasTraversedDistance !== (component.traversedDistanceKm > 0))) return false;

  const totalDistance = input.directFacts.distance.value.km;
  if (components.length === 0 && totalDistance !== 0) return false;
  if (components.length > 0 && !closeEnough(components.at(-1)!.endKm, totalDistance, 0.01)) return false;
  for (let index = 1; index < components.length; index += 1) {
    if (!closeEnough(components[index].startKm, components[index - 1].endKm, 0.01)) return false;
  }

  const componentByIndex = new Map(components.map((component) => [component.segmentIndex, component]));
  const sections = input.derivedFacts.sections;
  if (sections.some((section, index) => {
    const component = componentByIndex.get(section.segmentIndex);
    return section.ordinal !== index + 1 || !section.factId.startsWith(`section.s${section.segmentIndex}.`) || !section.factId.endsWith(`.${section.rhythm}`) ||
      !component || section.endKm < section.startKm ||
      !closeEnough(section.distanceKm, section.endKm - section.startKm, 0.02) ||
      section.startKm < component.startKm - 0.01 || section.endKm > component.endKm + 0.01;
  })) return false;

  const highest = input.directFacts.highest.value;
  const lowest = input.directFacts.lowest.value;
  if (highest.elevationM < lowest.elevationM || !isWithinComponent(highest.segmentIndex, highest.atKm, componentByIndex) ||
    !isWithinComponent(lowest.segmentIndex, lowest.atKm, componentByIndex)) return false;

  const moments = input.derivedFacts.keyMoments;
  if (moments.some((moment) => {
    const component = componentByIndex.get(moment.segmentIndex);
    return !moment.factId.startsWith(`key.${moment.kind}.s${moment.segmentIndex}.`) || !component || moment.endKm < moment.startKm || !closeEnough(moment.distanceKm, moment.endKm - moment.startKm) ||
      moment.startKm < component.startKm - 0.01 || moment.endKm > component.endKm + 0.01 ||
      new Set(moment.roles).size !== moment.roles.length ||
      (moment.roles.length === 2 && (moment.roles[0] !== "longest" || moment.roles[1] !== "largest"));
  })) return false;

  const osm = input.evidenceScopedFacts.osmSurface;
  if ((osm.requestState === "received") !== (osm.responseAvailability !== null) || osm.sections.length !== sections.length) return false;
  if (osm.requestState !== "received") {
    const expectedStatus = osm.requestState;
    if (osm.sections.some((surface) => surface.status !== expectedStatus || surface.classifiableCoveragePercent !== null || surface.categories.length !== 0)) return false;
  }
  const globalEvidenceBlocked = osm.requestState === "received" &&
    (osm.responseAvailability === "not-found" || osm.responseAvailability === "not-applicable");
  const sectionById = new Map(sections.map((section) => [section.factId, section]));
  if (osm.sections.some((surface) => {
    const section = sectionById.get(surface.sectionFactId);
    if (!section || surface.factId !== `surface.${surface.sectionFactId}`) return true;
    const coverage = surface.classifiableCoveragePercent;
    if (surface.status === "not-requested" || surface.status === "unavailable") {
      return coverage !== null || surface.categories.length !== 0 || surface.status !== osm.requestState;
    }
    if (osm.requestState !== "received" || coverage === null) return true;
    if (surface.status === "missing") return coverage !== 0 || surface.categories.length !== 0;
    if (globalEvidenceBlocked) return true;
    const categories = surface.categories;
    const shares = categories.map(({ shareOfClassifiableEvidencePercent }) => shareOfClassifiableEvidencePercent);
    const duplicateCategories = new Set(categories.map(({ category }) => category)).size !== categories.length;
    if (duplicateCategories || shares.some((share) => share <= 0) || shares.reduce((sum, share) => sum + share, 0) > 100.5) return true;
    if (surface.status === "partial") return coverage <= 0 || coverage >= 100 || categories.length === 0;
    if (surface.status === "mapped") return coverage !== 100 || categories.length === 0;
    return true;
  })) return false;
  return true;
}

function isWithinComponent(segmentIndex: number, km: number, components: ReadonlyMap<number, CourseBriefInputV1["directFacts"]["components"][number]>): boolean {
  const component = components.get(segmentIndex);
  return Boolean(component && km >= component.startKm - 0.05 && km <= component.endKm + 0.05);
}

function closeEnough(left: number, right: number, tolerance = 0.001): boolean { return Math.abs(left - right) <= tolerance; }
