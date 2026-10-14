import { GRADIENT_INTELLIGENCE_RULES, type GradientBand, type GradientDirection, type GradientIntelligenceV1 } from "./gradientIntelligence.ts";
import type { RouteSection } from "./routeSectionEngine.ts";

export const GRADIENT_INTELLIGENCE_PRESENTATION_VERSION = 1;

export type GradientExpectationHighlight = {
  intervalId: string;
  direction: "climb" | "descent";
  gradeBand: "steep" | "very-steep" | "extreme-grade";
  lengthClass: "short" | "sustained";
  sectionRelationship: "aligned" | "opposite-direction" | "not-directional";
  startDistanceM: number;
  endDistanceM: number;
  distanceM: number;
  smoothedAverageGradePct: number;
};

export type GradientExpectationV1 = {
  presentationVersion: 1;
  sectionId: string;
  segmentIndex: number;
  status: "available" | "unknown" | "missing-data" | "unsupported-version" | "invalid-data";
  facts: {
    sectionCharacter: "climbing" | "descending" | "rolling" | "low-vertical-movement" | "unknown";
    highlights: GradientExpectationHighlight[];
  };
  sentences: string[];
};

const supportedCharacters = new Set<GradientExpectationV1["facts"]["sectionCharacter"]>([
  "climbing", "descending", "rolling", "low-vertical-movement", "unknown",
]);
const steepBands = new Set<GradientBand>(["steep", "very-steep", "extreme-grade"]);
const directions = new Set<GradientDirection>(["climb", "descent", "rolling", "low-vertical-movement", "unknown"]);
const sectionCharacterByRhythm: Record<RouteSection["dominantRhythm"], GradientExpectationV1["facts"]["sectionCharacter"]> = {
  climb: "climbing",
  descent: "descending",
  rolling: "rolling",
  flat: "low-vertical-movement",
};

/**
 * Creates a traceable, deterministic summary for one Route Section. It accepts
 * only current V1.1 algorithm output and fails closed on stale/inconsistent data.
 */
export function presentGradientExpectationV1(
  gradient: GradientIntelligenceV1 | undefined,
  routeSections: readonly RouteSection[],
  target: RouteSection,
): GradientExpectationV1 {
  const base = { presentationVersion: GRADIENT_INTELLIGENCE_PRESENTATION_VERSION as 1, sectionId: target.id, segmentIndex: target.segmentIndex };
  if (!gradient) return result(base, "missing-data", "unknown", [], ["A gradient summary is not available for this analysis."]);
  if (gradient.schemaVersion !== 1 || gradient.algorithmVersion !== 2 || gradient.source !== "route-dynamics-smoothed-profile") {
    return result(base, "unsupported-version", "unknown", [], ["A gradient summary is not available for this analysis."]);
  }

  const canonical = routeSections.filter((section) => section.id === target.id && section.segmentIndex === target.segmentIndex);
  const matches = gradient.sections.filter((section) => section.sectionId === target.id && section.segmentIndex === target.segmentIndex);
  if (canonical.length !== 1 || matches.length !== 1 || !Number.isFinite(target.startPosition?.distanceM) ||
      !Number.isFinite(target.endPosition?.distanceM) || target.endPosition.distanceM <= target.startPosition.distanceM ||
      target.startPosition.segmentIndex !== target.segmentIndex || target.endPosition.segmentIndex !== target.segmentIndex ||
      canonical[0].startPosition.distanceM !== target.startPosition.distanceM || canonical[0].endPosition.distanceM !== target.endPosition.distanceM ||
      canonical[0].dominantRhythm !== target.dominantRhythm) {
    return result(base, "invalid-data", "unknown", [], ["A clear gradient summary is not available for this section."]);
  }
  const section = matches[0];
  const expectedCharacter = sectionCharacterByRhythm[target.dominantRhythm];
  if (!supportedCharacters.has(section.sectionCharacter) || section.sectionCharacter !== expectedCharacter) {
    return result(base, "invalid-data", "unknown", [], ["A clear gradient summary is not available for this section."]);
  }
  if (section.status === "unknown" || !Number.isFinite(section.startDistanceM) || !Number.isFinite(section.endDistanceM)) {
    return result(base, "unknown", section.sectionCharacter, [], ["The elevation profile does not support a clear gradient summary for this section."]);
  }
  const startM = target.startPosition.distanceM;
  const endM = target.endPosition.distanceM;
  if (section.status !== "available" || !Array.isArray(section.intervals) || !section.intervals.length ||
      Math.abs(section.startDistanceM! - startM) > 0.01 || Math.abs(section.endDistanceM! - endM) > 0.01 ||
      !hasCompleteValidIntervals(section.intervals, startM, endM, target.segmentIndex, target.dominantRhythm, section.sectionCharacter)) {
    return result(base, "invalid-data", "unknown", [], ["A clear gradient summary is not available for this section."]);
  }

  const facts = selectHighlights(section.intervals);
  const sentences = renderSentences(section.sectionCharacter, facts);
  return result(base, facts.length || section.sectionCharacter !== "unknown" ? "available" : "unknown", section.sectionCharacter, facts, sentences);
}

function hasCompleteValidIntervals(
  intervals: GradientIntelligenceV1["sections"][number]["intervals"],
  startM: number,
  endM: number,
  segmentIndex: number,
  rhythm: RouteSection["dominantRhythm"],
  character: GradientExpectationV1["facts"]["sectionCharacter"],
): boolean {
  let nextStartM = startM;
  for (const interval of intervals) {
    const { distanceM, startDistanceM, endDistanceM, metrics } = interval;
    if (interval.segmentIndex !== segmentIndex || !Number.isFinite(startDistanceM) || !Number.isFinite(endDistanceM) ||
        !Number.isFinite(distanceM) || distanceM <= 0 || Math.abs(distanceM - (endDistanceM - startDistanceM)) > 0.02 ||
        Math.abs(startDistanceM - nextStartM) > 0.02 || endDistanceM <= startDistanceM || endDistanceM > endM + 0.02 ||
        !Number.isFinite(metrics.netGradientPct) || !Number.isFinite(metrics.ascentM) || !Number.isFinite(metrics.descentM) ||
        metrics.ascentM < 0 || metrics.descentM < 0 || !Number.isFinite(metrics.verticalIntensityMPerKm)) return false;
    const expectedLengthClass = distanceM < GRADIENT_INTELLIGENCE_RULES.sustainedIntervalMinimumM ? "short" : "sustained";
    if (interval.intervalLengthClass !== expectedLengthClass || interval.measurementAvailability !== "available") return false;
    if (!directions.has(interval.direction) || !["high", "moderate", "unknown"].includes(interval.confidence)) return false;
    const directional = interval.direction === "climb" || interval.direction === "descent";
    const expectedBand = directional ? bandFor(Math.abs(metrics.netGradientPct)) : null;
    if (!bandMatchesRoundedMeasurement(interval.gradientBand, expectedBand, Math.abs(metrics.netGradientPct))) return false;
    const signedDirectionValid = interval.direction === "climb" ? metrics.netGradientPct > 0 : interval.direction === "descent" ? metrics.netGradientPct < 0 : true;
    if (!signedDirectionValid) return false;
    const expectedRelationship = directional
      ? rhythm === "climb" || rhythm === "descent"
        ? interval.direction === rhythm ? "aligned" : "opposite-direction"
        : "not-directional"
      : interval.direction === "unknown" ? "unknown" : "not-directional";
    if (interval.sectionRelationship !== expectedRelationship) return false;
    if (interval.direction === "unknown") {
      if (interval.confidence !== "unknown" || interval.character !== "unknown" || !Array.isArray(interval.unknownReasons) || !interval.unknownReasons.length) return false;
      if (interval.unknownReasons.some((reason) => reason !== "below-directional-intensity-threshold" && reason !== "low-directional-strength")) return false;
    } else if (interval.confidence === "unknown") return false;
    nextStartM = endDistanceM;
  }
  return character !== "unknown" && Math.abs(nextStartM - endM) <= 0.02;
}

function bandFor(absoluteGradePct: number): GradientBand {
  if (absoluteGradePct < GRADIENT_INTELLIGENCE_RULES.gentleMaximumGradePct) return "near-level";
  if (absoluteGradePct < GRADIENT_INTELLIGENCE_RULES.moderateMaximumGradePct) return "gentle";
  if (absoluteGradePct < GRADIENT_INTELLIGENCE_RULES.steepMinimumGradePct) return "moderate";
  if (absoluteGradePct < GRADIENT_INTELLIGENCE_RULES.verySteepMinimumGradePct) return "steep";
  if (absoluteGradePct < GRADIENT_INTELLIGENCE_RULES.extremeGradeMinimumGradePct) return "very-steep";
  return "extreme-grade";
}

function bandMatchesRoundedMeasurement(actual: GradientBand, expected: GradientBand, absoluteGradePct: number): boolean {
  if (actual === expected) return true;
  const boundaries = [
    [GRADIENT_INTELLIGENCE_RULES.gentleMaximumGradePct, "near-level", "gentle"],
    [GRADIENT_INTELLIGENCE_RULES.moderateMaximumGradePct, "gentle", "moderate"],
    [GRADIENT_INTELLIGENCE_RULES.steepMinimumGradePct, "moderate", "steep"],
    [GRADIENT_INTELLIGENCE_RULES.verySteepMinimumGradePct, "steep", "very-steep"],
    [GRADIENT_INTELLIGENCE_RULES.extremeGradeMinimumGradePct, "very-steep", "extreme-grade"],
  ] as const;
  return boundaries.some(([boundary, lower, upper]) => Math.abs(absoluteGradePct - boundary) <= 0.01 &&
    ((actual === lower && expected === upper) || (actual === upper && expected === lower)));
}

function selectHighlights(intervals: GradientIntelligenceV1["sections"][number]["intervals"]): GradientExpectationHighlight[] {
  const eligible = intervals.filter((interval) => interval.direction === "climb" || interval.direction === "descent")
    .filter((interval) => steepBands.has(interval.gradientBand) && interval.confidence !== "unknown" && interval.measurementAvailability === "available")
    .map((interval) => ({
      intervalId: interval.intervalId,
      direction: interval.direction as "climb" | "descent",
      gradeBand: interval.gradientBand as "steep" | "very-steep" | "extreme-grade",
      lengthClass: interval.intervalLengthClass!,
      sectionRelationship: interval.sectionRelationship as GradientExpectationHighlight["sectionRelationship"],
      startDistanceM: interval.startDistanceM,
      endDistanceM: interval.endDistanceM,
      distanceM: interval.distanceM,
      smoothedAverageGradePct: interval.metrics.netGradientPct,
    }));
  const rank = (band: GradientBand) => band === "extreme-grade" ? 3 : band === "very-steep" ? 2 : band === "steep" ? 1 : 0;
  const compare = (a: GradientExpectationHighlight, b: GradientExpectationHighlight) =>
    Number(b.lengthClass === "sustained") - Number(a.lengthClass === "sustained") ||
    rank(b.gradeBand) - rank(a.gradeBand) || b.distanceM - a.distanceM || a.intervalId.localeCompare(b.intervalId);
  const climb = eligible.filter(({ direction }) => direction === "climb").sort(compare)[0];
  const descent = eligible.filter(({ direction }) => direction === "descent").sort(compare)[0];
  return [climb, descent]
    .filter((item): item is GradientExpectationHighlight => Boolean(item))
    .sort((a, b) => a.startDistanceM - b.startDistanceM || a.intervalId.localeCompare(b.intervalId));
}

function renderSentences(
  character: GradientExpectationV1["facts"]["sectionCharacter"],
  highlights: GradientExpectationHighlight[],
): string[] {
  const characterSentence: Partial<Record<typeof character, string>> = {
    climbing: "This section is mainly an ascent.",
    descending: "This section is mainly a descent.",
    rolling: "This section alternates between climbing and descending.",
    "low-vertical-movement": "This section has relatively little elevation change.",
  };
  return [
    ...(characterSentence[character] ? [characterSentence[character]!] : []),
    ...highlights.map((highlight) => renderHighlight(highlight, character)),
  ].slice(0, 3);
}

function renderHighlight(highlight: GradientExpectationHighlight, sectionCharacter: GradientExpectationV1["facts"]["sectionCharacter"]): string {
  const direction = highlight.direction === "climb" ? "climb" : "descent";
  const bandDescription = highlight.gradeBand === "very-steep" ? "very steep " : highlight.gradeBand === "steep" || highlight.gradeBand === "extreme-grade" ? "steep " : "";
  const lengthDescription = highlight.lengthClass === "sustained" ? "sustained" : "short";
  const distanceKm = (highlight.distanceM / 1000).toFixed(1);
  const gradePct = Math.round(Math.abs(highlight.smoothedAverageGradePct));
  if (highlight.sectionRelationship === "opposite-direction") {
    const mainDirection = sectionCharacter === "climbing" ? "climb" : "descent";
    return `A ${lengthDescription} ${bandDescription}${direction} interrupts the main ${mainDirection}. It covers about ${distanceKm} km, with the smoothed GPX profile averaging about ${gradePct}% grade.`;
  }
  return `A ${lengthDescription} ${bandDescription}${direction} covers about ${distanceKm} km, with the smoothed GPX profile averaging about ${gradePct}% grade.`;
}

function result(
  base: Pick<GradientExpectationV1, "presentationVersion" | "sectionId" | "segmentIndex">,
  status: GradientExpectationV1["status"],
  sectionCharacter: GradientExpectationV1["facts"]["sectionCharacter"],
  highlights: GradientExpectationHighlight[],
  sentences: string[],
): GradientExpectationV1 {
  return { ...base, status, facts: { sectionCharacter, highlights }, sentences };
}
