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

function setup(specs, { segmentIndex = 0 } = {}) {
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
  const dominantRhythm = hasClimb && hasDescent ? "rolling" : hasDescent ? "descent" : hasClimb ? "climb" : "flat";
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
  assert.match(result.narrative.paragraphs.join(" "), /climbs and descents alternate/);
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
  assert.match(result.narrative.paragraphs.join(" "), /short 0\.5 km climb averaging \+22% smoothed net grade interrupts the descending sequence/);
});

test("long climb and descent descriptions cover the full extent without applying a subsection grade to the whole phase", () => {
  const up = analyze([["climb", 4, 2000], ["climb", 12, 2000], ["climb", 6, 2000]]);
  assert.match(up.narrative.paragraphs.join(" "), /6\.0 km climb/);
  assert.match(up.narrative.paragraphs.join(" "), /2\.0 km sustained climb at \+12% smoothed net grade/);
  const down = analyze([["descent", -3, 2000], ["descent", -13, 2000], ["descent", -6, 2000]]);
  assert.match(down.narrative.paragraphs.join(" "), /6\.0 km descent/);
  assert.match(down.narrative.paragraphs.join(" "), /2\.0 km sustained descent at −13% smoothed net grade/);
});

test("short steep opposite-direction interruption remains chronological and independently traceable", () => {
  const result = analyze([["climb", 6, 2500], ["descent", -12, 500], ["climb", 7, 3000]]);
  const text = result.narrative.paragraphs.join(" ");
  assert.match(text, /short 0\.5 km descent averaging −12% smoothed net grade interrupts the climbing sequence/);
  const interruption = result.narrative.trace.find(item => item.intervalIds.includes("s0-i1"));
  assert.ok(interruption.intervalIds.includes("s0-i0"));
  assert.ok(interruption.intervalIds.includes("s0-i2"));
});

test("unknown intervals remain explicit and break rather than bridge narrative progression", () => {
  const result = analyze([["climb", 8, 2000], ["unknown", 0, 1500], ["descent", -6, 2000]]);
  const text = result.narrative.paragraphs.join(" ");
  assert.equal(result.narrative.status, "limited");
  assert.match(text, /ends .* higher than it starts/);
  assert.match(text, /uncertain across 1\.5 km in 1 stretch/);
  assert.doesNotMatch(text, /gives way|interrupts|followed by/);
});

test("neutral sections and low-vertical movement stay distinct from unknown", () => {
  const result = analyze([["low-vertical-movement", 0], ["low-vertical-movement", 0], ["low-vertical-movement", 0], ["low-vertical-movement", 0]]);
  assert.equal(result.phases.phases[0].direction, "low-vertical-movement");
  assert.match(result.narrative.paragraphs.join(" "), /elevation changes stay limited/);
  assert.doesNotMatch(result.narrative.paragraphs.join(" "), /uncertain interval direction/);
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
  assert.equal(result.narrative.algorithmVersion, 3);
  assert.deepEqual(result.narrative.phases.phases.flatMap(phase => phase.intervalIds), result.gradient.sections[0].intervals.map(item => item.intervalId));
  assert.match(text, /5\.0 km climb/);
  assert.match(text, /3\.0 km climb, averaging \+9%.*then a 3\.0 km descent/);
  assert.match(text, /uncertain across 1\.0 km in 2 separate stretches/);
  assert.doesNotMatch(text, /uncertain stretch.*uncertain stretch/i);
  assert.doesNotMatch(text, /gives way|followed by/);
  for (const trace of result.narrative.trace) {
    assert.ok(trace.intervalIds.length > 0);
    assert.ok(trace.measuredFields.length > 0);
  }
  const reversal = result.narrative.trace.find(trace => trace.intervalIds.includes("s0-i7"));
  assert.ok(reversal?.intervalIds.includes("s0-i8"), "the retained climb-to-descent sequence traces both phases");
});

test("uncertainty is summarized once without bridging known phases or changing the whole-section direction", () => {
  const result = analyze([["climb", 8, 2000], ["unknown", 0, 500], ["descent", -7, 1500], ["unknown", 0, 1000], ["climb", 9, 2000]]);
  const uncertainty = result.narrative.paragraphs.filter(text => /Local interval direction is uncertain/.test(text));
  assert.equal(uncertainty.length, 1);
  assert.match(uncertainty[0], /1\.5 km in 2 separate stretches/);
  assert.doesNotMatch(result.narrative.paragraphs.join(" "), /the climb gives way to.*descent/i);
  const uncertaintyIndex = result.narrative.paragraphs.findIndex(text => /Local interval direction is uncertain/.test(text));
  const uncertaintyTrace = result.narrative.trace.find(trace => trace.paragraphIndex === uncertaintyIndex);
  assert.ok(uncertaintyTrace.intervalIds.includes("s0-i1"));
  assert.ok(uncertaintyTrace.intervalIds.includes("s0-i3"));
  assert.equal(uncertaintyTrace.measuredFields.includes("phase.unknownReasonCodes"), true);
});

test("short simple sections stay concise and retain climb-to-descent order", () => {
  const result = analyze([["climb", 8, 2500], ["descent", -8, 2500]]);
  assert.equal(result.narrative.paragraphs.length, 2);
  assert.match(result.narrative.paragraphs[1], /2\.5 km climb.*then a 2\.5 km descent/);
});

test("a short directional feature is retained when it contributes a defining share of that direction's elevation change", () => {
  const result = analyze([["descent", -9, 4000], ["climb", 4, 500]]);
  const text = result.narrative.paragraphs.join(" ");
  assert.match(text, /0\.5 km climb/);
  assert.match(text, /then a 0\.5 km climb/);
  const feature = result.narrative.trace.find(trace => trace.paragraphIndex > 0 && trace.intervalIds.includes("s0-i1"));
  assert.ok(feature?.intervalIds.includes("s0-i0"), "the adjacent reversal sentence traces the full measured sequence");
});

test("a near-duplicate subphase grade stays in structured data but is not repeated in the prose", () => {
  const result = analyze([["climb", 13, 1500], ["climb", 9, 500]]);
  const phase = result.narrative.phases.phases[0];
  assert.equal(phase.gradeSegments.some(segment => segment.distanceM === 1500 && segment.averageNetGradePct === 13), true);
  const text = result.narrative.paragraphs.join(" ");
  assert.match(text, /2\.0 km climb/);
  assert.doesNotMatch(text, /including 1\.5 km sustained climb/);
});
