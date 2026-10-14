import type { GradientIntelligenceV1 } from "./gradientIntelligence.ts";
import type { RouteSection } from "./routeSectionEngine.ts";
import {
  buildRouteNarrativeFactsV1,
  type RouteNarrativeFactsV1,
  type RouteNarrativePortionV1,
  type RouteNarrativeRunV1,
} from "./routeNarrativeFacts.ts";

export const ROUTE_SECTION_NARRATIVE_VERSION = 1;
export const ROUTE_SECTION_NARRATIVE_ALGORITHM_VERSION = 1;

export type RouteSectionNarrativeV1 = {
  presentationVersion: 1;
  algorithmVersion: 1;
  sectionId: string;
  segmentIndex: number;
  status: RouteNarrativeFactsV1["status"];
  facts: RouteNarrativeFactsV1;
  sentences: string[];
  trace: Array<{ sentenceIndex: number; sectionId: string; intervalIds: string[]; measuredFields: string[] }>;
};

const bandName: Record<NonNullable<RouteNarrativePortionV1["gradeBand"]>, string> = {
  "near-level": "near-level", gentle: "gentle", moderate: "moderate", steep: "steep",
  "very-steep": "very steep", "extreme-grade": "very steep",
};

/** Deterministically renders a full-section story from validated V1.1 GPX measurements. */
export function presentRouteSectionNarrativeV1(
  gradient: GradientIntelligenceV1 | undefined,
  routeSections: readonly RouteSection[],
  target: RouteSection,
): RouteSectionNarrativeV1 {
  const facts = buildRouteNarrativeFactsV1(gradient, routeSections, target);
  const base = {
    presentationVersion: ROUTE_SECTION_NARRATIVE_VERSION as 1,
    algorithmVersion: ROUTE_SECTION_NARRATIVE_ALGORITHM_VERSION as 1,
    sectionId: target.id,
    segmentIndex: target.segmentIndex,
  };
  if ((facts.status !== "available" && facts.status !== "limited") || !facts.measurements) {
    return {
      ...base, status: facts.status, facts, sentences: fallback(facts.status),
      trace: [],
    };
  }
  const narrative = render(facts);
  return {
    ...base,
    status: facts.status,
    facts,
    sentences: narrative.map((item) => item.text),
    trace: narrative.map((item, sentenceIndex) => ({ sentenceIndex, sectionId: facts.sectionId, intervalIds: item.intervalIds, measuredFields: item.measuredFields })),
  };
}

type RenderedSentence = { text: string; intervalIds: string[]; measuredFields: string[] };

function render(facts: RouteNarrativeFactsV1): RenderedSentence[] {
  const measurements = facts.measurements!;
  const sentences: RenderedSentence[] = [];
  const mainRun = longestRun(facts.orderedRuns, facts.overallCharacter === "climbing" ? "climb" : "descent");
  const hasOpposite = facts.overallCharacter === "climbing" ? facts.directionShare!.descent > 0.08 : facts.directionShare!.climb > 0.08;
  const hasTurn = facts.directionChanges.length > 0;

  if (facts.status === "limited") {
    const netGradePct = measurements.netElevationChangeM / measurements.distanceM * 100;
    const direction = netGradePct >= 2 ? "gains" : netGradePct <= -2 ? "loses" : null;
    sentences.push(sentence(
      direction ? `The profile ${direction} elevation overall, but direction is unclear over some intervals.` : "The net elevation change is modest, and direction is unclear over some intervals.",
      [], ["measurements.netElevationChangeM", "coverage.unknownDirectionShare"],
    ));
  } else {
  const overview = overallSentence(facts, mainRun, hasOpposite, hasTurn);
  if (overview) sentences.push(overview);
  else switch (facts.overallCharacter) {
    case "climbing":
      sentences.push(sentence(
        mainRun && mainRun.distanceM / measurements.distanceM >= 0.6 && !hasTurn
          ? "A sustained climb shapes most of this section."
          : hasOpposite
            ? "Climbing sets the overall direction, with descents breaking up the ascent."
            : "The section gains height through a largely continuous climb.",
        mainRun?.intervalIds ?? [], ["measurements.distanceM", "directionShare.climb", "directionChanges"],
      ));
      break;
    case "descending":
      sentences.push(sentence(
        mainRun && mainRun.distanceM / measurements.distanceM >= 0.6 && !hasTurn
          ? "A sustained descent shapes most of this section."
          : hasOpposite
            ? "The route loses height overall, with climbs interrupting the descent."
            : "The section descends through a largely continuous fall in elevation.",
        mainRun?.intervalIds ?? [], ["measurements.distanceM", "directionShare.descent", "directionChanges"],
      ));
      break;
    case "rolling":
      sentences.push(sentence(
        facts.directionChanges.length >= 2 ? "Climbs and descents take turns across this section."
          : facts.directionChanges.length === 1 ? "The profile shifts between a climb and a descent."
            : "Climbing and descending both shape this section.",
        facts.orderedRuns.filter((run) => run.direction === "climb" || run.direction === "descent").flatMap((run) => run.intervalIds),
        ["directionShare.climb", "directionShare.descent", "directionChanges"],
      ));
      break;
    case "low-vertical-movement":
      sentences.push(sentence("Elevation changes remain limited across most of this section.", [], ["overallCharacter", "measurements.ascentM", "measurements.descentM"]));
      break;
    case "mixed":
      sentences.push(sentence("Climbing and descending both shape this section.", [], ["directionShare.climb", "directionShare.descent"]));
      break;
    default:
      sentences.push(sentence("The available elevation measurements do not show a clear direction for this section.", [], ["coverage.unknownDirectionShare"]));
  }
  }

  const transition = transitionSentence(facts);
  const transitionAdded = Boolean(transition && !sentences.some((existing) =>
    existing.measuredFields.includes("orderedRuns.startDistanceM") && transition.measuredFields.includes("directionChanges") &&
    transition.intervalIds.every((intervalId) => existing.intervalIds.includes(intervalId))));
  if (transitionAdded && transition) sentences.push(transition);

  const selected = selectNotablePortions(facts.gradientPortions);
  for (const portion of selected) {
    if (sentences.length >= 4) break;
    // A progression sentence may already describe this same defining portion.
    if (transitionAdded && transition?.intervalIds.includes(portion.intervalId)) continue;
    sentences.push(portionSentence(portion, facts));
  }
  return sentences.slice(0, 4);
}

function overallSentence(
  facts: RouteNarrativeFactsV1,
  mainRun: RouteNarrativeRunV1 | null,
  hasOpposite: boolean,
  hasTurn: boolean,
): RenderedSentence | null {
  const distance = facts.measurements!.distanceM;
  const primary: "climb" | "descent" | null = facts.overallCharacter === "climbing" ? "climb" : facts.overallCharacter === "descending" ? "descent" : null;
  if (!primary) return null;
  const runs = facts.orderedRuns;
  const directional = runs.filter((run) => run.direction === "climb" || run.direction === "descent");
  const lastDirection = directional.at(-1);
  const previousRun = lastDirection ? runs[runs.indexOf(lastDirection) - 1] : null;
  const trailingUnknown = runs.at(-1)?.direction === "unknown";
  const unknownBetweenMainAndEnd = Boolean(mainRun && lastDirection && runs.some((run) => run.direction === "unknown" &&
    run.startDistanceM >= mainRun.endDistanceM - 0.02 && run.endDistanceM <= lastDirection.startDistanceM + 0.02));
  if (mainRun && lastDirection && lastDirection.direction !== primary && lastDirection.distanceM <= 1500 &&
      lastDirection.endDistanceM >= facts.bounds!.endDistanceM - 0.02 && !trailingUnknown && !unknownBetweenMainAndEnd) {
    const ending = lastDirection.direction === "climb" ? "climb" : "descent";
    const bridge = previousRun && (previousRun.direction === "rolling" || previousRun.direction === "low-vertical-movement")
      ? previousRun.direction === "rolling" ? " after a brief rolling stretch" : " after a quieter stretch in the elevation profile"
      : "";
    const mainVerb = primary === "climb" ? "climbs" : "descends";
    const text = bridge
      ? `Most of this section ${mainVerb};${bridge}, a short ${ending} closes it.`
      : `Most of this section ${mainVerb} before a short ${ending} closes it.`;
    return sentence(text,
      [...(mainRun.intervalIds), ...(previousRun?.intervalIds ?? []), ...lastDirection.intervalIds],
      ["directionShare.climb", "directionShare.descent", "directionChanges", "orderedRuns.distanceM", "orderedRuns.startDistanceM"]);
  }
  if (mainRun && mainRun.distanceM / distance >= 0.6 && !hasTurn && !hasOpposite) {
    return sentence(primary === "climb" ? "A sustained climb shapes most of this section." : "A sustained descent shapes most of this section.",
      mainRun.intervalIds, ["orderedRuns.distanceM", "measurements.distanceM"]);
  }
  if (hasOpposite || hasTurn) {
    return sentence(primary === "climb"
      ? "Climbing sets the overall direction, with descents breaking up the ascent."
      : "The route loses height overall, with climbs interrupting the descent.",
    directional.flatMap((run) => run.intervalIds), ["directionShare.climb", "directionShare.descent", "directionChanges"]);
  }
  return sentence(primary === "climb"
    ? "The section gains elevation overall."
    : "The section loses elevation overall.",
  mainRun?.intervalIds ?? [], ["measurements.netElevationChangeM", "directionShare.climb", "directionShare.descent"]);
}

function transitionSentence(facts: RouteNarrativeFactsV1): RenderedSentence | null {
  for (const change of facts.directionChanges) {
    if (change.viaDirections.length === 1) {
      const from = facts.orderedRuns.find((run) => run.intervalIds.includes(change.fromIntervalIds[0]));
      const to = facts.orderedRuns.find((run) => run.intervalIds.includes(change.toIntervalIds[0]));
      if (!from || !to) continue;
      const via = change.viaDirections[0] === "rolling" ? "After a rolling stretch" : "After a stretch with little vertical movement";
      if (from.distanceM >= 1500 && to.distanceM >= 1500) {
        return sentence(`${via}, a sustained ${to.direction} follows the sustained ${from.direction}.`, change.intervalIds, ["directionChanges", "orderedRuns.distanceM"]);
      }
      const short = from.distanceM < 1500 ? from : to.distanceM < 1500 ? to : null;
      const long = short === from ? to : short === to ? from : null;
      if (short && long && long.distanceM >= 2000) {
        return sentence(`${via}, a short ${short.direction} follows the longer ${long.direction}.`, change.intervalIds, ["directionChanges", "orderedRuns.distanceM"]);
      }
      continue;
    }
    const from = adjacentRun(facts.orderedRuns, change.atDistanceM, "left");
    const to = adjacentRun(facts.orderedRuns, change.atDistanceM, "right");
    if (!from || !to) continue;
    const aligned = [from, to].filter((run) => run.distanceM >= 1500);
    if (aligned.length === 2) {
      const fromName = from.direction === "climb" ? "climb" : "descent";
      const toName = to.direction === "climb" ? "climb" : "descent";
      return sentence(`A sustained ${fromName} gives way to a sustained ${toName}.`, change.intervalIds, ["directionChanges", "orderedRuns.distanceM"]);
    }
    const short = from.distanceM < 1500 ? from : to.distanceM < 1500 ? to : null;
    const long = short === from ? to : short === to ? from : null;
    if (short && long && long.distanceM >= 2000 && steepPortionWithin(facts.gradientPortions, short)) {
      const direction = short.direction === "climb" ? "climb" : "descent";
      const band = steepPortionWithin(facts.gradientPortions, short)!;
      return sentence(`A short ${bandName[band.gradeBand]} ${direction} interrupts the longer ${long.direction === "climb" ? "climb" : "descent"}.`, [...short.intervalIds, ...long.intervalIds], ["directionChanges", "orderedRuns.distanceM", "gradientPortions.gradeBand"]);
    }
  }

  // Explain an intensity change only when adjoining same-direction portions are both substantial.
  for (const [index, portion] of facts.gradientPortions.entries()) {
    const next = facts.gradientPortions[index + 1];
    if (!next || portion.direction !== next.direction || Math.abs(portion.endDistanceM - next.startDistanceM) > 0.02 ||
        portion.distanceM < 1500 || next.distanceM < 1500 || portion.gradeBand === next.gradeBand ||
        bandName[portion.gradeBand] === bandName[next.gradeBand]) continue;
    const firstBand = bandName[portion.gradeBand];
    const nextBand = bandName[next.gradeBand];
    const dir = portion.direction === "climb" ? "climb" : "descent";
    const verb = Math.abs(next.averageGradePct) > Math.abs(portion.averageGradePct) ? "steepens" : "eases";
    const where = positionWord(next, facts.bounds!.startDistanceM, facts.measurements!.distanceM);
    const text = where
      ? `The ${dir} ${verb} from a sustained ${firstBand} grade into a sustained ${nextBand} stretch in the ${where} part of the section.`
      : `The ${dir} ${verb} from sustained ${firstBand} to sustained ${nextBand} gradient.`;
    return sentence(text, [portion.intervalId, next.intervalId], ["gradientPortions.gradeBand", "gradientPortions.startDistanceM", "gradientPortions.distanceM"]);
  }
  return null;
}

function selectNotablePortions(portions: readonly RouteNarrativePortionV1[]): RouteNarrativePortionV1[] {
  const notable = portions.filter((portion) => portion.notable);
  const rank = (portion: RouteNarrativePortionV1) =>
    (portion.gradeBand === "extreme-grade" ? 3 : portion.gradeBand === "very-steep" ? 2 : portion.gradeBand === "steep" ? 1 : 0) * 10000 + Math.min(portion.distanceM, 9999);
  const compare = (a: RouteNarrativePortionV1, b: RouteNarrativePortionV1) =>
    Number(b.distanceM >= 1500) - Number(a.distanceM >= 1500) || rank(b) - rank(a) ||
    a.startDistanceM - b.startDistanceM || a.intervalId.localeCompare(b.intervalId);
  const chosen: RouteNarrativePortionV1[] = [];
  for (const direction of ["climb", "descent"] as const) {
    const best = notable.filter((portion) => portion.direction === direction).sort(compare)[0];
    if (best) chosen.push(best);
  }
  return chosen.sort((a, b) => a.startDistanceM - b.startDistanceM || a.intervalId.localeCompare(b.intervalId));
}

function portionSentence(portion: RouteNarrativePortionV1, facts: RouteNarrativeFactsV1): RenderedSentence {
  const dir = portion.direction === "climb" ? "climb" : "descent";
  const grade = Math.abs(portion.averageGradePct);
  const lengthKm = (portion.distanceM / 1000).toFixed(1);
  const gradeText = `${Math.round(grade)}%`;
  const where = positionWord(portion, facts.bounds!.startDistanceM, facts.measurements!.distanceM);
  const lengthKind = portion.distanceM >= 1500 ? "sustained" : "short";
  const gradeDescription = bandName[portion.gradeBand];
  const position = where ? ` in the ${where} part` : "";
  const phrase = portion.gradeBand === "extreme-grade"
    ? `A ${lengthKind} ${dir}${position} averages about ${gradeText} grade over ${lengthKm} km.`
    : `A ${lengthKind} ${gradeDescription} ${dir}${position} averages ${gradeText} grade over ${lengthKm} km.`;
  return sentence(phrase, [portion.intervalId], ["gradientPortions.gradeBand", "gradientPortions.distanceM", "gradientPortions.averageGradePct", "gradientPortions.startDistanceM"]);
}

function positionWord(portion: Pick<RouteNarrativePortionV1, "startDistanceM" | "endDistanceM">, startM: number, length: number): string | null {
  if (length < 6000) return null;
  const center = (portion.startDistanceM + portion.endDistanceM) / 2 - startM;
  const ratio = center / length;
  return ratio < 0.3 ? "opening" : ratio > 0.7 ? "closing" : "middle";
}

function steepPortionWithin(portions: readonly RouteNarrativePortionV1[], run: RouteNarrativeRunV1) {
  return portions.filter((portion) => run.intervalIds.includes(portion.intervalId) && portion.gradeBand !== "gentle" && portion.gradeBand !== "near-level")
    .sort((a, b) => Math.abs(b.averageGradePct) - Math.abs(a.averageGradePct) || a.intervalId.localeCompare(b.intervalId))[0] ?? null;
}

function adjacentRun(runs: readonly RouteNarrativeRunV1[], distanceM: number, side: "left" | "right") {
  return runs.find((run) => side === "left" ? Math.abs(run.endDistanceM - distanceM) <= 0.02 : Math.abs(run.startDistanceM - distanceM) <= 0.02) ?? null;
}

function longestRun(runs: readonly RouteNarrativeRunV1[], direction: "climb" | "descent") {
  return runs.filter((run) => run.direction === direction).sort((a, b) => b.distanceM - a.distanceM || a.startDistanceM - b.startDistanceM)[0] ?? null;
}

function sentence(text: string, intervalIds: string[], measuredFields: string[]): RenderedSentence {
  return { text, intervalIds: [...new Set(intervalIds)], measuredFields };
}

function fallback(status: RouteSectionNarrativeV1["status"]): string[] {
  if (status === "missing-data") return ["A section narrative is not available for this analysis."];
  if (status === "unsupported-version") return ["A section narrative is not available for this version of the elevation analysis."];
  if (status === "invalid-data") return ["A reliable section narrative is not available for this elevation profile."];
  return ["The elevation profile does not support a clear section narrative."];
}
