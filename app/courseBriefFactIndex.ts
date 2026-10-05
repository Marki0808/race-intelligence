import type { CourseBriefInputV1 } from "./courseBriefInput.ts";
import { validateCourseBriefInput } from "./courseBriefInputValidation.ts";

export type CourseBriefFactKind =
  | "direct.distance"
  | "direct.rawGain"
  | "direct.rawLoss"
  | "direct.highest"
  | "direct.lowest"
  | "component"
  | "progression.early"
  | "progression.middle"
  | "progression.late"
  | "section"
  | "keyMoment"
  | "osmSurfaceSection";

export type CourseBriefFactIndexEntry = {
  factId: string;
  kind: CourseBriefFactKind;
  segmentIndex: number | null;
  sectionFactId: string | null;
  value: unknown;
};

export type CourseBriefFactIndex = ReadonlyMap<string, CourseBriefFactIndexEntry>;

/** Indexes validated typed facts once, retaining component and section evidence scope. */
export function buildCourseBriefFactIndex(input: CourseBriefInputV1): CourseBriefFactIndex | null {
  const validation = validateCourseBriefInput(input);
  if (!validation.ok) return null;
  input = validation.input;

  const entries: CourseBriefFactIndexEntry[] = [
    entry(input.directFacts.distance.factId, "direct.distance", null, null, input.directFacts.distance.value),
    entry(input.directFacts.rawGain.factId, "direct.rawGain", null, null, input.directFacts.rawGain.value),
    entry(input.directFacts.rawLoss.factId, "direct.rawLoss", null, null, input.directFacts.rawLoss.value),
    entry(input.directFacts.highest.factId, "direct.highest", input.directFacts.highest.value.segmentIndex, null, input.directFacts.highest.value),
    entry(input.directFacts.lowest.factId, "direct.lowest", input.directFacts.lowest.value.segmentIndex, null, input.directFacts.lowest.value),
    ...input.directFacts.components.map((fact) => entry(fact.factId, "component", fact.segmentIndex, null, fact)),
    ...input.derivedFacts.sections.map((fact) => entry(fact.factId, "section", fact.segmentIndex, fact.factId, fact)),
    ...input.derivedFacts.keyMoments.map((fact) => entry(fact.factId, "keyMoment", fact.segmentIndex, null, fact)),
    ...input.evidenceScopedFacts.osmSurface.sections.map((fact) => {
      const section = input.derivedFacts.sections.find(({ factId }) => factId === fact.sectionFactId);
      return entry(fact.factId, "osmSurfaceSection", section?.segmentIndex ?? null, fact.sectionFactId, fact);
    }),
  ];
  const progression = input.derivedFacts.verticalProgression;
  if (progression) {
    entries.push(
      entry(progression.early.factId, "progression.early", null, null, progression.early),
      entry(progression.middle.factId, "progression.middle", null, null, progression.middle),
      entry(progression.late.factId, "progression.late", null, null, progression.late),
    );
  }
  if (entries.some(({ segmentIndex, kind }) => kind === "osmSurfaceSection" && segmentIndex === null)) return null;
  const index = new Map<string, CourseBriefFactIndexEntry>();
  for (const fact of entries) {
    if (index.has(fact.factId)) return null;
    index.set(fact.factId, fact);
  }
  return index;
}

export function resolveCourseBriefFactIds(
  factIds: readonly string[],
  index: CourseBriefFactIndex,
): CourseBriefFactIndexEntry[] | null {
  const resolved: CourseBriefFactIndexEntry[] = [];
  const seen = new Set<string>();
  for (const factId of factIds) {
    if (seen.has(factId)) return null;
    const fact = index.get(factId);
    if (!fact) return null;
    seen.add(factId);
    resolved.push(fact);
  }
  return resolved;
}

function entry(
  factId: string,
  kind: CourseBriefFactKind,
  segmentIndex: number | null,
  sectionFactId: string | null,
  value: unknown,
): CourseBriefFactIndexEntry {
  return { factId, kind, segmentIndex, sectionFactId, value };
}
