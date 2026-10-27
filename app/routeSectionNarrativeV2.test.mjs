import assert from "node:assert/strict";
import test from "node:test";
import { buildRouteNarrativePhasesV2 } from "./routeNarrativePhases.ts";
import { presentRouteSectionNarrativeV2 } from "./routeSectionNarrativeV2.ts";

function interval(index, direction, grade, { length = 500, segmentIndex = 0, confidence, startDistanceM = index * length } = {}) {
  const endDistanceM = startDistanceM + length;
  const signed = direction === "climb" ? Math.abs(grade) : direction === "descent" ? -Math.abs(grade) : 0;
  const netElevationChangeM = length * signed / 100;
  const ascentM = direction === "climb" ? netElevationChangeM : direction === "rolling" ? 10 : 0;
  const descentM = direction === "descent" ? -netElevationChangeM : direction === "rolling" ? 10 : 0;
  const unknown = direction === "unknown";
  const band = direction === "climb" || direction === "descent"
    ? Math.abs(grade) < 2 ? "near-level" : Math.abs(grade) < 5 ? "gentle" : Math.abs(grade) < 10 ? "moderate" : Math.abs(grade) < 15 ? "steep" : Math.abs(grade) < 20 ? "very-steep" : "extreme-grade"
    : null;
  return {
    intervalId: `s${segmentIndex}-i${index}`, segmentIndex, startDistanceM, endDistanceM, distanceM: length,
    metrics: { netElevationChangeM, netGradientPct: signed, ascentM, descentM, verticalIntensityMPerKm: (ascentM + descentM) / (length / 1000), cellNetGradientMinimumPct: signed, cellNetGradientMaximumPct: signed, cellNetGradientSpreadPercentagePoints: 0 },
    direction, gradientBand: band, character: unknown ? "unknown" : direction === "rolling" ? "rolling" : "steady-climb",
    confidence: confidence ?? (unknown ? "unknown" : "high"), intervalLengthClass: length < 1500 ? "short" : "sustained",
    sectionRelationship: unknown ? "unknown" : direction === "climb" || direction === "descent" ? "aligned" : "not-directional",
    measurementAvailability: "available", ...(unknown ? { unknownReasons: ["low-directional-strength"] } : {}),
  };
}

function setup(specs, { segmentIndex = 0, dominantRhythm: dominantRhythmOverride, startDistanceM = 0 } = {}) {
  let cursor = startDistanceM;
  const intervals = specs.map(([direction, grade, length], index) => {
    const result = interval(index, direction, grade, { length: length ?? 500, segmentIndex, startDistanceM: cursor });
    cursor = result.endDistanceM;
    return result;
  });
  const start = intervals[0]?.startDistanceM ?? 0;
  const end = intervals.at(-1)?.endDistanceM ?? start;
  const ascentM = intervals.reduce((sum, item) => sum + item.metrics.ascentM, 0);
  const descentM = intervals.reduce((sum, item) => sum + item.metrics.descentM, 0);
  const hasClimb = specs.some(([direction]) => direction === "climb");
  const hasDescent = specs.some(([direction]) => direction === "descent");
  const dominantRhythm = dominantRhythmOverride ?? (hasClimb && hasDescent ? "rolling" : hasDescent ? "descent" : hasClimb ? "climb" : "flat");
  const section = {
    id: `section-${segmentIndex}`, segmentIndex, startKm: start / 1000, endKm: end / 1000,
    startPosition: { distanceM: start, segmentIndex }, endPosition: { distanceM: end, segmentIndex }, distanceKm: (end - start) / 1000,
    dominantRhythm, elevationStartM: 100, elevationEndM: 100 + ascentM - descentM,
    elevationMinM: 0, elevationMaxM: 1000, ascentM, descentM,
  };
  const sectionCharacter = dominantRhythm === "climb" ? "climbing" : dominantRhythm === "descent" ? "descending" : dominantRhythm === "rolling" ? "rolling" : "low-vertical-movement";
  const validatedIntervals = intervals.map(item => ({ ...item, sectionRelationship: item.direction === "unknown" ? "unknown" : item.direction === "climb" || item.direction === "descent"
    ? dominantRhythm === "climb" || dominantRhythm === "descent" ? item.direction === dominantRhythm ? "aligned" : "opposite-direction" : "not-directional"
    : "not-directional" }));
  const gradient = { schemaVersion: 1, algorithmVersion: 2, source: "route-dynamics-smoothed-profile", assumptions: { resampleIntervalM: 100, medianFilterRadiusM: 150, movingAverageRadiusM: 250 }, sections: [{
    sectionId: section.id, segmentIndex, startDistanceM: start, endDistanceM: end, status: "available", sectionCharacter, progression: "unknown", multiScaleMetrics: [], intervals: validatedIntervals,
  }] };
  return { section, gradient };
}

const analyze = (specs, options) => {
  const { section, gradient } = setup(specs, options);
  return { section, gradient, phases: buildRouteNarrativePhasesV2(gradient, [section], section), narrative: presentRouteSectionNarrativeV2(gradient, [section], section) };
};

test("phases cover the complete section in route order and preserve each source interval", () => {
  const { phases, gradient, section } = analyze([
    ["climb", 3, 1500], ["climb", 8, 1000], ["climb", 12, 1500], ["descent", -7, 500], ["unknown", 0, 500],
  ]);
  assert.equal(phases.coverage.complete, true);
  assert.equal(phases.coverage.coveredDistanceM, section.endPosition.distanceM - section.startPosition.distanceM);
  assert.equal(phases.phases[0].startDistanceM, 0);
  assert.equal(phases.phases.at(-1).endDistanceM, section.endPosition.distanceM);
  assert.deepEqual(phases.phases.flatMap(phase => phase.intervalIds), gradient.sections[0].intervals.map(item => item.intervalId));
  assert.equal(phases.phases.at(-1).direction, "unknown");
  assert.equal(phases.phases.at(-1).unknownReasonCodes[0], "low-directional-strength");
});

test("comparable short alternations merge into a rolling phase while preserving ordered direction evidence", () => {
  const result = analyze([["climb", 5], ["descent", -5], ["climb", 6], ["descent", -4], ["climb", 5], ["descent", -5]]);
  assert.equal(result.phases.phases.length, 1);
  assert.equal(result.phases.phases[0].direction, "rolling");
  assert.deepEqual(result.phases.phases[0].directionSequence, ["climb", "descent", "climb", "descent", "climb", "descent"]);
  assert.match(result.narrative.paragraphs.join(" "), /climbs and descents alternate/i);
});

test("a short known neutral bridge can join an alternating phase, but an unknown gap never can", () => {
  const known = analyze([["climb", 5], ["descent", -5], ["low-vertical-movement", 0], ["climb", 6], ["descent", -4]]);
  assert.equal(known.phases.phases.length, 1);
  assert.equal(known.phases.phases[0].direction, "rolling");
  assert.equal(known.phases.phases[0].coverage.measuredShare, 1);
  const uncertain = analyze([["climb", 5], ["descent", -5], ["unknown", 0], ["climb", 6], ["descent", -4]]);
  assert.notEqual(uncertain.phases.phases.length, 1);
  assert.ok(uncertain.phases.phases.some(phase => phase.direction === "unknown"));
  assert.ok(uncertain.phases.phases.every(phase => phase.direction !== "rolling"));
});

test("a steep member prevents rolling compression and retains its own phase and grade evidence", () => {
  const result = analyze([["climb", 5], ["descent", -5], ["climb", 22], ["descent", -5], ["climb", 5]]);
  assert.notEqual(result.phases.phases[0].direction, "rolling");
  assert.ok(result.phases.phases.some(phase => phase.direction === "climb" && phase.gradeSegments.some(segment => segment.gradeBand === "extreme-grade")));
  assert.match(result.narrative.paragraphs.join(" "), /short, steep climb/i);
});

test("long climb and descent descriptions cover the full extent without applying a subsection grade to the whole phase", () => {
  const up = analyze([["climb", 4, 2000], ["climb", 12, 2000], ["climb", 6, 2000]]);
  assert.match(up.narrative.paragraphs.join(" "), /km 0\.0–6\.0/);
  assert.doesNotMatch(up.narrative.paragraphs.join(" "), /smoothed-profile average of \+7\.3%/);
  assert.match(up.narrative.paragraphs.join(" "), /A long climb runs from km 0\.0–6\.0/);
  assert.match(up.narrative.paragraphs.join(" "), /including a steeper stretch from km 2\.0–4\.0 averaging \+12\.0%/);
  const down = analyze([["descent", -3, 2000], ["descent", -13, 2000], ["descent", -6, 2000]]);
  assert.match(down.narrative.paragraphs.join(" "), /km 0\.0–6\.0/);
  assert.doesNotMatch(down.narrative.paragraphs.join(" "), /smoothed-profile average of −7\.3%/);
  assert.match(down.narrative.paragraphs.join(" "), /A long descent runs from km 0\.0–6\.0/);
  assert.match(down.narrative.paragraphs.join(" "), /including a steeper stretch from km 2\.0–4\.0 averaging −13\.0%/);
});

test("short steep opposite-direction interruption remains chronological and independently traceable", () => {
  const result = analyze([["climb", 6, 2500], ["descent", -12, 500], ["climb", 7, 3000]]);
  const text = result.narrative.paragraphs.join(" ");
  assert.match(text, /short, steep descent/i);
  const interruption = result.narrative.trace.find(item => item.intervalIds.includes("s0-i1"));
  assert.ok(interruption.intervalIds.includes("s0-i0"));
  assert.ok(interruption.intervalIds.includes("s0-i2"));
});

test("unknown intervals remain explicit and break rather than bridge narrative progression", () => {
  const result = analyze([["climb", 8, 2000], ["unknown", 0, 1500], ["descent", -6, 2000]]);
  const text = result.narrative.paragraphs.join(" ");
  assert.equal(result.narrative.status, "limited");
  assert.doesNotMatch(text, /Local interval direction|unknownReasonCodes|uncertain across/);
  assert.doesNotMatch(text, /gives way|interrupts|followed by/);
});

test("neutral sections and low-vertical movement stay distinct from unknown", () => {
  const result = analyze([["low-vertical-movement", 0], ["low-vertical-movement", 0], ["low-vertical-movement", 0], ["low-vertical-movement", 0]]);
  assert.equal(result.phases.phases[0].direction, "low-vertical-movement");
  assert.match(result.narrative.paragraphs[0], /elevation changes stay limited/i);
  assert.doesNotMatch(result.narrative.paragraphs.join(" "), /uncertain interval direction/);
});

test("visible section overview explains the dominant pattern and a supported sustained direction change", () => {
  const result = analyze([["climb", 7, 2500], ["descent", -6, 2000]]);
  assert.match(result.narrative.paragraphs[0], /sustained climb runs.*sustained descent runs/i);
  assert.equal(result.narrative.paragraphs.length, 1);
  assert.ok(result.narrative.trace[0].intervalIds.length > 0);
  assert.ok(result.narrative.trace[0].measuredFields.includes("phase.direction"));
});

test("section overview does not synthesize a transition across an unknown interval", () => {
  const result = analyze([["climb", 8, 2000], ["unknown", 0, 1000], ["descent", -7, 2000]]);
  assert.doesNotMatch(result.narrative.paragraphs[0], /followed by|gives way|resumes/);
  assert.match(result.narrative.paragraphs[0], /climb/i);
  assert.match(result.narrative.paragraphs[0], /descent/i);
});

test("phase and prose identities preserve disconnected component identity and deterministic output", () => {
  const first = analyze([["climb", 7, 1000], ["descent", -7, 1000], ["climb", 8, 1000]], { segmentIndex: 1 });
  const again = analyze([["climb", 7, 1000], ["descent", -7, 1000], ["climb", 8, 1000]], { segmentIndex: 1 });
  assert.equal(first.phases.segmentIndex, 1);
  assert.ok(first.phases.phases.every(phase => phase.intervalIds.every(id => id.startsWith("s1-"))));
  assert.deepEqual(first, again);
  const otherComponent = { ...first.section, id: "section-0", segmentIndex: 0,
    startPosition: { ...first.section.startPosition, segmentIndex: 0 }, endPosition: { ...first.section.endPosition, segmentIndex: 0 } };
  const result = buildRouteNarrativePhasesV2(first.gradient, [otherComponent, first.section], first.section);
  assert.equal(result.segmentIndex, 1);
  assert.ok(result.phases.every(phase => phase.intervalIds.every(id => id.startsWith("s1-"))));
});

test("incomplete interval coverage fails closed and narrative avoids unsupported terrain or effort claims", () => {
  const { section, gradient } = setup([["climb", 7, 1000], ["descent", -7, 1000]]);
  const incomplete = structuredClone(gradient);
  incomplete.sections[0].intervals.pop();
  const invalid = buildRouteNarrativePhasesV2(incomplete, [section], section);
  assert.equal(invalid.status, "invalid-data");
  const output = presentRouteSectionNarrativeV2(gradient, [section], section);
  assert.doesNotMatch(output.paragraphs.join(" "), /trail|surface|technical|exposure|weather|speed|effort|fitness|pace|difficult/i);
});

test("short direction sequences remain distinct and route section bounds are unchanged", () => {
  const { section, phases } = analyze([["climb", 7, 500], ["descent", -8, 500]]);
  assert.deepEqual(phases.phases.map(phase => phase.direction), ["climb", "descent"]);
  assert.equal(phases.bounds.startDistanceM, section.startPosition.distanceM);
  assert.equal(phases.bounds.endDistanceM, section.endPosition.distanceM);
});

test("adaptive prose summarizes a long phase sequence while retaining major chronological movements and exact phase data", () => {
  const result = analyze([
    ["climb", 8, 5000], ["unknown", 0, 500], ["descent", -7, 500], ["climb", 7, 500],
    ["descent", -8, 500], ["climb", 8, 500], ["unknown", 0, 500], ["climb", 9, 3000], ["descent", -12, 3000],
  ]);
  const text = result.narrative.paragraphs.join(" ");
  assert.ok(result.narrative.phases.phases.length > 5);
  assert.ok(result.narrative.paragraphs.length < result.narrative.phases.phases.length);
  assert.equal(result.narrative.algorithmVersion, 8);
  assert.deepEqual(result.narrative.phases.phases.flatMap(phase => phase.intervalIds), result.gradient.sections[0].intervals.map(item => item.intervalId));
  assert.match(text, /km 0\.0–5\.0/);
  assert.match(text, /climb|ascent/i);
  assert.match(text, /descent/i);
  assert.doesNotMatch(text, /uncertain stretch.*uncertain stretch|Local interval direction/);
  assert.ok(text.split(/(?<=[.!?])\s+/).length <= 5, "complex sections remain concise");
  for (const trace of result.narrative.trace) {
    assert.ok(trace.intervalIds.length > 0);
    assert.ok(trace.measuredFields.length > 0);
  }
  const reversal = result.narrative.trace.find(trace => trace.intervalIds.includes("s0-i7"));
  assert.ok(reversal?.intervalIds.includes("s0-i8"), "the retained climb-to-descent sequence traces both phases");
});

test("a predominantly uphill section names its repeated climbs and brief easing without repeating itself", () => {
  const result = analyze([
    ["climb", 14, 3000], ["low-vertical-movement", 0, 500], ["climb", 12, 5000], ["descent", -4, 550],
  ], { dominantRhythm: "climb" });
  const text = result.narrative.paragraphs.join(" ");
  assert.match(text, /^Mostly climbing, with descents breaking up the ascent\./);
  assert.match(text, /A sustained climb runs from km 0\.0–3\.0/);
  assert.match(text, /A long climb runs from km 3\.5–8\.5/);
  assert.equal(result.narrative.paragraphs.length, 1);
  assert.doesNotMatch(text, /uphill.*climb.*climb|ascent.*ascent/i);
  assert.ok(result.narrative.trace[0].intervalIds.length > 0);
  assert.ok(result.narrative.trace[0].measuredFields.includes("section.dominantRhythm"));
});

test("a predominantly downhill section uses the same evidence rule and direction-specific wording", () => {
  const result = analyze([
    ["descent", -13, 3000], ["low-vertical-movement", 0, 500], ["descent", -11, 5000], ["climb", 4, 550],
  ], { dominantRhythm: "descent" });
  assert.match(result.narrative.paragraphs[0], /^Mostly descending/);
  assert.match(result.narrative.paragraphs[0], /sustained descent runs/);
  assert.doesNotMatch(result.narrative.paragraphs.join(" "), /uphill/i);
  assert.match(result.narrative.paragraphs.join(" "), /descent/i);
});

test("brief easing wording follows the phase builder's existing 1 km bridge boundary", () => {
  const atBoundary = analyze([
    ["climb", 12, 3000], ["low-vertical-movement", 0, 1000], ["climb", 12, 5000], ["descent", -4, 550],
  ], { dominantRhythm: "climb" });
  assert.match(atBoundary.narrative.paragraphs[0], /sustained climb runs/);

  const longer = analyze([
    ["climb", 12, 3000], ["low-vertical-movement", 0, 1500], ["climb", 12, 5000], ["descent", -4, 550],
  ], { dominantRhythm: "climb" });
  assert.match(longer.narrative.paragraphs[0], /sustained climb runs/);
});

test("dominant wording is withheld when direction is not a strict measured majority or coverage is uncertain", () => {
  const balanced = analyze([
    ["climb", 8, 2500], ["low-vertical-movement", 0, 500], ["climb", 8, 2000], ["descent", -8, 4500],
  ], { dominantRhythm: "climb" });
  assert.doesNotMatch(balanced.narrative.paragraphs.join(" "), /predominantly uphill/i);

  const uncertain = analyze([
    ["climb", 12, 3000], ["low-vertical-movement", 0, 500], ["climb", 12, 5000], ["unknown", 0, 500],
  ], { dominantRhythm: "climb" });
  assert.doesNotMatch(uncertain.narrative.paragraphs.join(" "), /predominantly uphill/i);
});

test("uncertainty is summarized once without bridging known phases or changing the whole-section direction", () => {
  const result = analyze([["climb", 8, 2000], ["unknown", 0, 500], ["descent", -7, 1500], ["unknown", 0, 1000], ["climb", 9, 2000]]);
  const uncertainty = result.narrative.paragraphs.filter(text => /Direction is unclear/.test(text));
  assert.equal(uncertainty.length, 1);
  assert.match(uncertainty[0], /km 4\.0–5\.0/);
  assert.doesNotMatch(uncertainty[0], /km 2\.0–2\.5/);
  assert.doesNotMatch(result.narrative.paragraphs.join(" "), /the climb gives way to.*descent/i);
  const uncertaintyIndex = result.narrative.paragraphs.findIndex(text => /Direction is unclear/.test(text));
  const uncertaintyTrace = result.narrative.trace.find(trace => trace.paragraphIndex === uncertaintyIndex);
  assert.ok(uncertaintyTrace.intervalIds.includes("s0-i3"));
  assert.equal(uncertaintyTrace.measuredFields.includes("phase.unknownReasonCodes"), true);
});

test("short simple sections stay concise and retain climb-to-descent order", () => {
  const result = analyze([["climb", 8, 2500], ["descent", -8, 2500]]);
  assert.equal(result.narrative.paragraphs.length, 1);
  assert.match(result.narrative.paragraphs[0], /climb runs from km 0\.0–2\.5.*descent runs from km 2\.5–5\.0/);
});

test("a defining climb near the section finish remains in chronological prose", () => {
  const result = analyze([["descent", -8, 4000], ["climb", 12, 2000]]);
  const text = result.narrative.paragraphs.join(" ");
  assert.match(text, /long descent runs from km 0\.0–4\.0/);
  assert.match(text, /climb runs from km 4\.0–6\.0/);
  assert.ok(text.indexOf("long descent runs") < text.indexOf("climb runs"));
});

test("a short non-steep feature remains in structured facts without being overstated in prose", () => {
  const result = analyze([["descent", -9, 4000], ["climb", 4, 500]]);
  const text = result.narrative.paragraphs.join(" ");
  assert.ok(result.narrative.phases.phases.some(phase => phase.intervalIds.includes("s0-i1")));
  assert.doesNotMatch(text, /0\.5 km climb/);
});

test("a near-duplicate subphase grade stays in structured data but is not repeated in the prose", () => {
  const result = analyze([["climb", 13, 1500], ["climb", 9, 500]]);
  const phase = result.narrative.phases.phases[0];
  assert.equal(phase.gradeSegments.some(segment => segment.distanceM === 1500 && segment.averageNetGradePct === 13), true);
  const text = result.narrative.paragraphs.join(" ");
  assert.match(text, /km 0\.0–2\.0/);
  assert.doesNotMatch(text, /including 1\.5 km sustained climb|smoothed net grade/);
});

test("runner-facing composition is a grammatical progression, not a phase-by-phase metric list", () => {
  const result = analyze([
    ["climb", 7, 3000], ["descent", -6, 1000], ["climb", 9, 2500],
    ["descent", -8, 2500], ["climb", 6, 2000],
  ]);
  const text = result.narrative.paragraphs.join(" ");
  assert.equal(result.narrative.paragraphs.length, 1);
  assert.ok(text.endsWith("."));
  assert.doesNotMatch(text, /smoothed net grade/);
  assert.doesNotMatch(text, /Early on, a .*\. Around the middle, a .*\. Later, a/);
  assert.ok(result.narrative.trace[0].intervalIds.length > 0);
});

test("section narratives localize km ranges and use signed smoothed-profile grade only for steep movement", () => {
  const result = analyze([["climb", 7, 1500], ["climb", 16, 1000], ["descent", -4, 1000]]);
  const text = result.narrative.paragraphs.join(" ");
  assert.match(text, /km 0\.0–2\.5/);
  assert.match(text, /averaging \+16\.0%/);
  assert.doesNotMatch(text, /on the smoothed GPX profile/);
  assert.doesNotMatch(text, /−4\.0%/);
  assert.doesNotMatch(text, /at the finish/i);
});

test("route-global climb continuity is described at a custom boundary without attributing the whole feature", () => {
  const full = setup([["climb", 12, 3000], ["climb", 13, 3000]], { dominantRhythm: "climb" });
  const local = setup([["climb", 13, 3000]], { dominantRhythm: "climb", startDistanceM: 3000 });
  const context = {
    componentSections: [full.section],
    gradientIntelligence: full.gradient,
  };
  const narrative = presentRouteSectionNarrativeV2(local.gradient, [local.section], local.section, context);
  const text = narrative.paragraphs.join(" ");
  assert.match(text, /climb that began before this section runs from km 3\.0–6\.0/i);
  assert.match(text, /km 3\.0–6\.0/);
  assert.doesNotMatch(text, /6\.0 km|began before.*full feature/i);
  assert.deepEqual(narrative.trace[0].routeContextIntervalIds, ["s0-i0", "s0-i1"]);
});

test("a boundary near the route start describes continuation at section scope, not as the route finish", () => {
  const full = setup([["descent", -12, 3000]], { dominantRhythm: "descent" });
  const local = setup([["descent", -12, 1000]], { dominantRhythm: "descent" });
  const following = { ...local.section, id: "following", startKm: 1, endKm: 3, distanceKm: 2,
    startPosition: { distanceM: 1000, segmentIndex: 0 }, endPosition: { distanceM: 3000, segmentIndex: 0 } };
  const context = { componentSections: [full.section], gradientIntelligence: full.gradient };
  const text = presentRouteSectionNarrativeV2(local.gradient, [local.section, following], local.section, context).paragraphs.join(" ");
  assert.match(text, /descent runs from km 0\.0–1\.0 and continues beyond this section/i);
  assert.doesNotMatch(text, /route finish/i);
});

test("route-global continuity does not bridge unknown gaps or disconnected components", () => {
  const full = setup([["climb", 12, 2000], ["unknown", 0, 500], ["climb", 12, 2000]], { dominantRhythm: "climb" });
  const local = setup([["climb", 12, 2000]], { dominantRhythm: "climb", startDistanceM: 2500 });
  const context = { componentSections: [full.section], gradientIntelligence: full.gradient };
  const acrossGap = presentRouteSectionNarrativeV2(local.gradient, [local.section], local.section, context).paragraphs.join(" ");
  assert.doesNotMatch(acrossGap, /began earlier|continues beyond/i);

  const other = { ...local.section, id: "section-1", segmentIndex: 1,
    startPosition: { ...local.section.startPosition, segmentIndex: 1 }, endPosition: { ...local.section.endPosition, segmentIndex: 1 } };
  const isolated = presentRouteSectionNarrativeV2(local.gradient, [other], other, context).paragraphs.join(" ");
  assert.doesNotMatch(isolated, /began earlier|continues beyond/i);
});

test("continuity is attached only to the matching feature at the exact section edge", () => {
  const full = setup([["climb", 12, 2000], ["descent", -8, 4000], ["climb", 12, 2000]], { dominantRhythm: "descent" });
  const local = setup([["descent", -8, 3000]], { dominantRhythm: "descent", startDistanceM: 2000 });
  const context = { componentSections: [full.section], gradientIntelligence: full.gradient };
  const target = { ...local.section, startPosition: { distanceM: 2000, segmentIndex: 0 }, endPosition: { distanceM: 5000, segmentIndex: 0 } };
  const text = presentRouteSectionNarrativeV2(local.gradient, [target], target, context).paragraphs.join(" ");
  assert.match(text, /mostly descending/i);
  assert.doesNotMatch(text, /climb that began|climb.*continues beyond/i);
  assert.match(text, /descent runs from km 2\.0–5\.0 and continues beyond this section/i);
});

test("narrative prose limits repeated numeric ranges and qualifies a grade once by interval", () => {
  const result = analyze([
    ["climb", 8, 5000], ["unknown", 0, 1500], ["descent", -7, 5000],
    ["unknown", 0, 1000], ["climb", 18, 3500], ["descent", -12, 3000],
  ]);
  const text = result.narrative.paragraphs.join(" ");
  assert.ok((text.match(/km \d+\.\d–\d+\.\d/g) ?? []).length <= 4);
  assert.ok((text.match(/Direction is unclear/g) ?? []).length <= 1);
  assert.doesNotMatch(text, /on the smoothed GPX profile/);
  assert.match(text, /averaging [−+].*over this interval/);
});

test("short steep climb and descent remain direction-specific without unsupported surface claims", () => {
  const climb = analyze([["climb", 22, 500]]);
  const descent = analyze([["descent", -22, 500]]);
  assert.match(climb.narrative.paragraphs.join(" "), /steep climb/i);
  assert.match(descent.narrative.paragraphs.join(" "), /steep descent/i);
  for (const text of [climb.narrative.paragraphs.join(" "), descent.narrative.paragraphs.join(" ")]) {
    assert.doesNotMatch(text, /rock|mud|root|surface|technical|weather|exposure|pace|fitness/i);
  }
});
