import {
  validateCourseBriefInputV2,
  type CourseBriefInputV2,
  type NarrativeFact,
} from "./courseBriefNarrativeFacts.ts";
import type { CourseBriefOutputV2 } from "./courseBriefCandidates.ts";
import type { CourseBriefCandidate } from "./courseBriefCandidates.ts";
import { formatNarrativeDistance, KILOMETERS_PER_MILE, METERS_PER_FOOT, type RouteUnitSystem } from "./routeUnits.ts";

export const COURSE_BRIEF_WHOLE_ROUTE_NARRATIVE_VERSION = 1 as const;

export type CourseBriefNarrativeParagraph = {
  componentIndex: number;
  paragraphIndex: number;
  text: string;
  sourceFactIds: string[];
};

export type CourseBriefWholeRouteNarrativeV1 = {
  schemaVersion: typeof COURSE_BRIEF_WHOLE_ROUTE_NARRATIVE_VERSION;
  paragraphs: CourseBriefNarrativeParagraph[];
};

type NarrativeInput = Pick<CourseBriefInputV2, "route" | "units" | "phases" | "facts">;

/** Composes a connected route-level story from the already validated deterministic V2 facts. */
export function composeCourseBriefWholeRouteNarrative(
  inputValue: unknown,
  structuralOutputValue: unknown,
  selectedCandidates: readonly CourseBriefCandidate[] = [],
  units: RouteUnitSystem = "metric",
): CourseBriefWholeRouteNarrativeV1 | null {
  const validation = validateCourseBriefInputV2(inputValue);
  if (!validation.ok || !isValidStructuralOutput(structuralOutputValue, validation.input)) return null;
  const input = validation.input;
  const factById = new Map(input.facts.map((fact) => [fact.factId, fact]));
  const rhythmUnitIds = new Set(selectedCandidates.filter(({ renderPatternId }) => renderPatternId === "RHYTHM_SEQUENCE")
    .flatMap((candidate) => [candidate.primaryFactId, ...candidate.supportingFactIds])
    .map((factId) => factById.get(factId))
    .flatMap((fact) => fact?.type === "UNIT_CHARACTER" ? [fact.unitId] : []));
  const paragraphs = input.route.components.flatMap((component) => {
    if (component.traversedDistanceKm <= 0) return [];
    const componentUnits = input.units.filter((unit) => unit.segmentIndex === component.segmentIndex)
      .sort((a, b) => a.startKm - b.startKm || a.ordinal - b.ordinal);
    if (componentUnits.length === 0) return [];
    const timeline = buildTimeline(componentUnits, input, rhythmUnitIds);
    if (timeline.length === 0) return [];
    const componentFacts = input.facts.filter((fact) => fact.segmentIndex === component.segmentIndex);
    const anchors = componentFacts.filter(isUsefulAnchor).sort((a, b) => a.startKm - b.startKm || a.factId.localeCompare(b.factId));
    const texts = renderComponentStory(timeline, anchors, component.segmentIndex, input.route.components.length > 1, units);
    const transitionFactIds = componentFacts.filter((fact): fact is Extract<NarrativeFact, { type: "STRUCTURAL_TRANSITION" }> =>
      fact.type === "STRUCTURAL_TRANSITION" && fact.eligibility.selectable).map(({ factId }) => factId);
    const sourceFactIds = [...new Set([
      ...timeline.flatMap((part) => part.sourceFactIds),
      ...transitionFactIds,
      ...anchors.filter((anchor) => texts.some((text) => text.includes(anchorPhrase(anchor, units)))).map(({ factId }) => factId),
    ])];
    return texts.map((text, paragraphIndex) => ({ componentIndex: component.segmentIndex, paragraphIndex, text, sourceFactIds }));
  });
  return paragraphs.length > 0 ? { schemaVersion: COURSE_BRIEF_WHOLE_ROUTE_NARRATIVE_VERSION, paragraphs } : null;
}

function isValidStructuralOutput(value: unknown, input: CourseBriefInputV2): value is CourseBriefOutputV2 {
  if (!value || typeof value !== "object") return false;
  const output = value as Partial<CourseBriefOutputV2>;
  if (output.schemaVersion !== 2 || !Array.isArray(output.observations) || output.observations.length === 0) return false;
  const factIds = new Set(input.facts.map(({ factId }) => factId));
  return output.observations.every((observation) => Number.isInteger(observation.componentIndex) &&
    input.route.components.some(({ segmentIndex }) => segmentIndex === observation.componentIndex) &&
    Array.isArray(observation.sourceFactIds) && observation.sourceFactIds.length > 0 &&
    observation.sourceFactIds.every((factId) => factIds.has(factId)) && typeof observation.text === "string");
}

type TimelinePart = {
  startKm: number;
  endKm: number;
  character: string;
  sourceFactIds: string[];
  unitIds: string[];
};

function buildTimeline(
  units: NarrativeInput["units"],
  input: NarrativeInput,
  rhythmUnitIds: ReadonlySet<string>,
): TimelinePart[] {
  const parts: TimelinePart[] = [];
  for (const unit of units) {
    const unitFact = input.facts.find((fact): fact is Extract<NarrativeFact, { type: "UNIT_CHARACTER" }> =>
      fact.type === "UNIT_CHARACTER" && fact.unitId === unit.unitId && fact.segmentIndex === unit.segmentIndex);
    if (!unitFact) continue;
    if (unit.character !== "evolving") {
      parts.push({ startKm: unit.startKm, endKm: unit.endKm, character: unit.character, sourceFactIds: [unitFact.factId], unitIds: [unit.unitId] });
      continue;
    }
    const phases = unit.phaseIds.map((phaseId) => input.phases.find((phase) => phase.phaseId === phaseId)).filter((phase) => phase !== undefined);
    if (phases.length === 0) continue;
    const internalTransitions = input.facts.filter((fact): fact is Extract<NarrativeFact, { type: "STRUCTURAL_TRANSITION" }> =>
      fact.type === "STRUCTURAL_TRANSITION" && fact.segmentIndex === unit.segmentIndex &&
      fact.fromUnitId === unit.unitId && fact.toUnitId === unit.unitId);
    let current = phases[0].character;
    let startKm = unit.startKm;
    let sourceFactIds = [unitFact.factId];
    for (const transition of internalTransitions.sort((a, b) => a.boundaryKm - b.boundaryKm)) {
      if (transition.boundaryKm <= startKm || transition.boundaryKm >= unit.endKm || transition.toCharacter === current) continue;
      sourceFactIds.push(transition.factId);
      parts.push({ startKm, endKm: transition.boundaryKm, character: current, sourceFactIds, unitIds: [unit.unitId] });
      startKm = transition.boundaryKm;
      current = transition.toCharacter;
      sourceFactIds = [unitFact.factId, transition.factId];
    }
    parts.push({ startKm, endKm: unit.endKm, character: current, sourceFactIds, unitIds: [unit.unitId] });
  }
  return coalesceAndGroupRhythm(parts, rhythmUnitIds);
}

function coalesceAndGroupRhythm(parts: TimelinePart[], rhythmUnitIds: ReadonlySet<string>): TimelinePart[] {
  const coalesced: TimelinePart[] = [];
  for (const part of parts) {
    const previous = coalesced.at(-1);
    if (previous && previous.character === part.character && Math.abs(previous.endKm - part.startKm) <= 0.01) {
      previous.endKm = part.endKm;
      previous.sourceFactIds = [...new Set([...previous.sourceFactIds, ...part.sourceFactIds])];
      previous.unitIds = [...new Set([...previous.unitIds, ...part.unitIds])];
    } else coalesced.push({ ...part, sourceFactIds: [...part.sourceFactIds], unitIds: [...part.unitIds] });
  }

  const result: TimelinePart[] = [];
  for (let index = 0; index < coalesced.length;) {
    const first = coalesced[index];
    if (!isDirectional(first.character) || !first.unitIds.every((unitId) => rhythmUnitIds.has(unitId))) {
      result.push(first);
      index += 1;
      continue;
    }
    let end = index + 1;
    while (end < coalesced.length && isDirectional(coalesced[end].character) &&
      coalesced[end].character !== coalesced[end - 1].character &&
      Math.abs(coalesced[end - 1].endKm - coalesced[end].startKm) <= 0.01 &&
      coalesced[end].unitIds.every((unitId) => rhythmUnitIds.has(unitId))) end += 1;
    const run = coalesced.slice(index, end);
    if (end - index >= 3 && run.every((part) => part.unitIds.every((unitId) => rhythmUnitIds.has(unitId)))) {
      result.push({ startKm: run[0].startKm, endKm: run.at(-1)!.endKm, character: "repeated-vertical",
        sourceFactIds: [...new Set(run.flatMap(({ sourceFactIds }) => sourceFactIds))],
        unitIds: [...new Set(run.flatMap(({ unitIds }) => unitIds))] });
    } else result.push(...run);
    index = end;
  }
  return result;
}

function renderComponentStory(parts: TimelinePart[], anchors: NarrativeFact[], segmentIndex: number, disconnected: boolean, units: RouteUnitSystem): string[] {
  const anchorByPart = new Map<number, NarrativeFact[]>();
  for (const anchor of anchors) {
    if (!isUsefulAnchor(anchor)) continue;
    const partIndex = parts.findIndex((part) => anchor.startKm >= part.startKm - 0.01 && anchor.startKm <= part.endKm + 0.01);
    if (partIndex < 0) continue;
    const existing = anchorByPart.get(partIndex) ?? [];
    existing.push(anchor);
    anchorByPart.set(partIndex, existing);
  }
  const componentLabel = disconnected ? `Track segment ${segmentIndex + 1}: ` : "";
  const first = parts[0];
  const sentences: string[] = [];
  if (parts.length === 1) {
      sentences.push(`${componentLabel}${describeCharacter(first.character)}${disconnected ? " across this track segment" : " across the route"}.`);
  } else {
    sentences.push(`${componentLabel}${openingPhrase(first.character, disconnected, first.endKm, units)}${anchorPhraseForPart(anchorByPart.get(0) ?? [], units)}.`);
    const rhythmIndexes = parts.flatMap((part, index) => part.character === "repeated-vertical" ? [index] : []);
    for (let index = 1; index < parts.length; index += 1) {
      const part = parts[index];
      if (parts.length === 4 && index === 1 && parts.every((item) => isDirectional(item.character)) &&
        parts.every((item, itemIndex) => itemIndex === 0 || item.character !== parts[itemIndex - 1].character)) {
        const following = parts[index + 1];
        sentences.push(`The opening ${characterNoun(parts[0].character)} is followed by a ${characterNoun(part.character)} to around ${formatCoursePosition(part.endKm, units)}; from there, the route ${following.character === "climb-dominant" ? "climbs" : "descends"} again until around ${formatCoursePosition(following.endKm, units)}${anchorPhraseForPart(anchorByPart.get(index + 1) ?? [], units)}.`);
        index += 1;
        continue;
      }
      if (index === parts.length - 2 && part.character === "descent-dominant" && parts[index + 1].character === "low-vertical") {
        const endPhrase = disconnected ? "the end of this track segment" : "the finish";
        sentences.push(`The route turns downhill again near ${formatCoursePosition(part.startKm, units)} and continues to around ${formatCoursePosition(part.endKm, units)}. After that, there is little elevation change to ${endPhrase}.`);
        index += 1;
        continue;
      }
      if (rhythmIndexes.includes(index)) {
        const lead = index === parts.length - 1
          ? disconnected ? "Near the end of this track segment" : "Toward the finish"
          : `From around ${formatCoursePosition(part.startKm, units)}`;
        const phrase = `${lead}, the route moves through repeated climbs and descents until around ${formatCoursePosition(part.endKm, units)}${anchorPhraseForPart(anchorByPart.get(index) ?? [], units)}.`;
        sentences.push(phrase);
      } else {
        const isLast = index === parts.length - 1;
        const lead = isLast
          ? disconnected ? "Near the end of this track segment" : "Toward the finish"
          : `Around ${formatCoursePosition(part.startKm, units)}`;
        sentences.push(`${lead}, ${transitionPhrase(parts[index - 1].character, part.character, part, units)}${anchorPhraseForPart(anchorByPart.get(index) ?? [], units)}.`);
      }
    }
  }
  if (sentences.length <= 3) return [sentences.join(" ")];
  const paragraphs: string[] = [];
  for (let index = 0; index < sentences.length; index += 2) paragraphs.push(sentences.slice(index, index + 2).join(" "));
  return paragraphs;
}

function openingPhrase(character: string, componentLocal: boolean, endKm: number, units: RouteUnitSystem): string {
  const endpoint = `until around ${formatCoursePosition(endKm, units)}`;
  if (componentLocal) {
    switch (character) {
      case "climb-dominant": return `It begins with a climb that continues to around ${formatCoursePosition(endKm, units)}`;
      case "descent-dominant": return `It begins with a descent that continues to around ${formatCoursePosition(endKm, units)}`;
      case "repeated-vertical": return `Climbs and descents repeat from the start ${endpoint}`;
      case "low-vertical": return `It starts with little elevation change ${endpoint}`;
      default: return `It starts with a mix of climbing and descending ${endpoint}`;
    }
  }
  switch (character) {
    case "climb-dominant": return `The route opens with a climb that continues to around ${formatCoursePosition(endKm, units)}`;
    case "descent-dominant": return `The route opens with a descent that continues to around ${formatCoursePosition(endKm, units)}`;
    case "repeated-vertical": return `Climbs and descents repeat from the start ${endpoint}`;
    case "low-vertical": return `The route starts with little elevation change ${endpoint}`;
    default: return `The route opens with a mix of climbing and descending ${endpoint}`;
  }
}

function describeCharacter(character: string): string {
  switch (character) {
    case "climb-dominant": return "Climbing dominates";
    case "descent-dominant": return "Descending dominates";
    case "repeated-vertical": return "Climbs and descents repeat";
    case "low-vertical": return "There is little elevation change";
    default: return "Climbing and descending are mixed";
  }
}

function transitionPhrase(previous: string, next: string, part: TimelinePart, units: RouteUnitSystem): string {
  const endpoint = `around ${formatCoursePosition(part.endKm, units)}`;
  if (previous === "climb-dominant" && next === "descent-dominant") return `the route turns downhill and continues to ${endpoint}`;
  if (previous === "descent-dominant" && next === "climb-dominant") return `the route begins climbing again and continues to ${endpoint}`;
  if (next === "low-vertical") return `the climbs and descents become smaller until ${endpoint}`;
  if (next === "repeated-vertical") return `the route settles into repeated climbs and descents until ${endpoint}`;
  if (previous === "repeated-vertical" && next === "descent-dominant") return `after repeated climbs and descents, the route settles into a longer descent that continues to ${endpoint}`;
  if (next === "mixed") return `the profile becomes more varied until ${endpoint}`;
  return `climbing and descending remain mixed until ${endpoint}`;
}

function characterNoun(character: string): string {
  return character === "climb-dominant" ? "climb" : "descent";
}

function isUsefulAnchor(fact: NarrativeFact): fact is Extract<NarrativeFact, { type: "ANCHOR_WITHIN_UNIT" }> {
  return fact.type === "ANCHOR_WITHIN_UNIT" && fact.anchorKind === "key-moment" && fact.eventKind !== null &&
    (fact.roles.includes("longest") || fact.roles.includes("largest")) &&
    fact.measurements.distanceKm !== null && fact.measurements.elevationChangeM !== null;
}

function anchorPhrase(anchor: Extract<NarrativeFact, { type: "ANCHOR_WITHIN_UNIT" }>, units: RouteUnitSystem): string {
  const length = anchor.measurements.distanceKm!;
  const change = anchor.measurements.elevationChangeM!;
  const changeWord = anchor.eventKind === "climb" ? "ascent" : "descent";
  const changeVerb = changeWord === "ascent" ? "gaining" : "losing";
  const feature = anchor.eventKind === "climb" ? "climb" : "descent";
  const distinction = anchor.roles.includes("longest")
    ? `the route's longest ${feature}`
    : changeWord === "ascent" ? "the climb with the greatest ascent" : "the descent with the greatest elevation loss";
  return `, including ${distinction} (${units === "metric" ? `${formatKm(length)} km` : `${formatKm(length / KILOMETERS_PER_MILE)} mi`}, ${changeVerb} ${units === "metric" ? `${Math.round(change)} m` : `${Math.round(change / METERS_PER_FOOT)} ft`})`;
}

function anchorPhraseForPart(anchors: NarrativeFact[], units: RouteUnitSystem): string {
  const anchor = anchors.filter(isUsefulAnchor).sort((a, b) => anchorPriority(b) - anchorPriority(a))[0];
  return anchor ? anchorPhrase(anchor, units) : "";
}

function anchorPriority(fact: Extract<NarrativeFact, { type: "ANCHOR_WITHIN_UNIT" }>): number {
  return Number(fact.roles.includes("longest")) + Number(fact.roles.includes("largest"));
}

function isDirectional(character: string): boolean {
  return character === "climb-dominant" || character === "descent-dominant";
}

function formatCoursePosition(km: number, units: RouteUnitSystem): string {
  return units === "metric" ? `km ${formatKm(km)}` : formatNarrativeDistance(km * 1000, units);
}

function formatKm(value: number): string { return (Math.round(value * 10) / 10).toFixed(1); }
