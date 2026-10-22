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

function setup(specs, { segmentIndex = 0, dominantRhythm: dominantRhythmOverride } = {}) {
  let cursor = 0;
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
  assert.match(result.narrative.paragraphs.join(" "), /moves between climbs and descents/i);
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
  assert.match(result.narrative.paragraphs.join(" "), /brief but steep climb/i);
});

test("long climb and descent descriptions cover the full extent without applying a subsection grade to the whole phase", () => {
  const up = analyze([["climb", 4, 2000], ["climb", 12, 2000], ["climb", 6, 2000]]);
  assert.match(up.narrative.paragraphs.join(" "), /6\.0 km/);
  assert.match(up.narrative.paragraphs.join(" "), /notably steep stretch/);
  assert.doesNotMatch(up.narrative.paragraphs.join(" "), /smoothed net grade|\+12%/);
  const down = analyze([["descent", -3, 2000], ["descent", -13, 2000], ["descent", -6, 2000]]);
  assert.match(down.narrative.paragraphs.join(" "), /6\.0 km/);
  assert.match(down.narrative.paragraphs.join(" "), /notably steep stretch/);
  assert.doesNotMatch(down.narrative.paragraphs.join(" "), /smoothed net grade|−13%/);
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
  assert.match(result.narrative.paragraphs[0], /climb.*followed by.*descent/i);
  assert.equal(result.narrative.paragraphs.length, 1);
  assert.ok(result.narrative.trace[0].intervalIds.length > 0);
  assert.ok(result.narrative.trace[0].measuredFields.includes("phase.direction"));
});

test("section overview does not synthesize a transition across an unknown interval", () => {
  const result = analyze([["climb", 8, 2000], ["unknown", 0, 1000], ["descent", -7, 2000]]);
  assert.doesNotMatch(result.narrative.paragraphs[0], /followed by|gives way|resumes/);
  assert.match(result.narrative.paragraphs[0], /climb/i);
  assert.match(result.narrative.paragraphs[0], /descend/i);
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
  assert.equal(result.narrative.algorithmVersion, 5);
  assert.deepEqual(result.narrative.phases.phases.flatMap(phase => phase.intervalIds), result.gradient.sections[0].intervals.map(item => item.intervalId));
  assert.match(text, /5\.0 km/);
  assert.match(text, /climb|ascent/i);
  assert.match(text, /descent/i);
  assert.doesNotMatch(text, /uncertain stretch.*uncertain stretch|Local interval direction/);
  assert.ok((text.match(/\./g) ?? []).length <= 5, "complex sections remain concise");
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
  assert.equal(text, "The section is predominantly uphill, with two sustained climbs and a brief easing between them; the second lasts about 5.0 km.");
  assert.equal(result.narrative.paragraphs.length, 1);
  assert.match(text, /predominantly uphill.*two sustained climbs.*brief easing/i);
  assert.doesNotMatch(text, /uphill.*climb.*climb|ascent.*ascent/i);
  assert.deepEqual(result.narrative.trace[0].intervalIds, result.phases.phases.flatMap(phase => phase.intervalIds));
  assert.ok(result.narrative.trace[0].measuredFields.includes("section.dominantRhythm"));
});

test("a predominantly downhill section uses the same evidence rule and direction-specific wording", () => {
  const result = analyze([
    ["descent", -13, 3000], ["low-vertical-movement", 0, 500], ["descent", -11, 5000], ["climb", 4, 550],
  ], { dominantRhythm: "descent" });
  assert.equal(result.narrative.paragraphs[0], "The section is predominantly downhill, with two sustained descents and a brief easing between them; the second lasts about 5.0 km.");
  assert.doesNotMatch(result.narrative.paragraphs.join(" "), /uphill|climb/i);
});

test("brief easing wording follows the phase builder's existing 1 km bridge boundary", () => {
  const atBoundary = analyze([
    ["climb", 12, 3000], ["low-vertical-movement", 0, 1000], ["climb", 12, 5000], ["descent", -4, 550],
  ], { dominantRhythm: "climb" });
  assert.match(atBoundary.narrative.paragraphs[0], /brief easing between them/i);

  const longer = analyze([
    ["climb", 12, 3000], ["low-vertical-movement", 0, 1500], ["climb", 12, 5000], ["descent", -4, 550],
  ], { dominantRhythm: "climb" });
  assert.match(longer.narrative.paragraphs[0], /stretch of limited elevation change between them/i);
  assert.doesNotMatch(longer.narrative.paragraphs[0], /brief easing/i);
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
  const uncertainty = result.narrative.paragraphs.filter(text => /Some local elevation changes are unclear/.test(text));
  assert.equal(uncertainty.length, 1);
  assert.match(uncertainty[0], /smaller transitions/);
  assert.doesNotMatch(result.narrative.paragraphs.join(" "), /the climb gives way to.*descent/i);
  const uncertaintyIndex = result.narrative.paragraphs.findIndex(text => /Some local elevation changes are unclear/.test(text));
  const uncertaintyTrace = result.narrative.trace.find(trace => trace.paragraphIndex === uncertaintyIndex);
  assert.ok(uncertaintyTrace.intervalIds.includes("s0-i1"));
  assert.ok(uncertaintyTrace.intervalIds.includes("s0-i3"));
  assert.equal(uncertaintyTrace.measuredFields.includes("phase.unknownReasonCodes"), true);
});

test("short simple sections stay concise and retain climb-to-descent order", () => {
  const result = analyze([["climb", 8, 2500], ["descent", -8, 2500]]);
  assert.equal(result.narrative.paragraphs.length, 1);
  assert.match(result.narrative.paragraphs[0], /2\.5 km.*followed by.*2\.5 km/);
});

test("a defining climb near the section finish remains in chronological prose", () => {
  const result = analyze([["descent", -8, 4000], ["climb", 12, 2000]]);
  const text = result.narrative.paragraphs.join(" ");
  assert.match(text, /descent of about 4\.0 km/);
  assert.match(text, /climb of about 2\.0 km/);
  assert.ok(text.indexOf("descent of about 4.0 km") < text.indexOf("climb of about 2.0 km"));
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
  assert.match(text, /2\.0 km/);
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
  assert.doesNotMatch(text, /averaging|smoothed net grade|\+\d+%|−\d+%/);
  assert.doesNotMatch(text, /Early on, a .*\. Around the middle, a .*\. Later, a/);
  assert.ok(result.narrative.trace[0].intervalIds.length > 0);
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
