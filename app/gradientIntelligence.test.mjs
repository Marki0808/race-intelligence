import assert from "node:assert/strict";
import test from "node:test";
import { buildGradientIntelligenceV1, GRADIENT_INTELLIGENCE_RULES } from "./gradientIntelligence.ts";

function section({ id = "route-section-1", segmentIndex = 0, start = 0, end, rhythm = "climb" }) {
  return {
    id, segmentIndex, startPosition: { distanceM: start, segmentIndex }, endPosition: { distanceM: end, segmentIndex },
    startKm: start / 1000, endKm: end / 1000, dominantRhythm: rhythm,
  };
}

function dynamics(profiles) {
  const resampledPoints = profiles.flatMap(({ segmentIndex = 0, start = 0, elevations }) => elevations.map((smoothedElevationM, index) => ({
    segmentIndex, distanceM: start + index * 100, smoothedElevationM, elevationM: smoothedElevationM,
  })));
  return { totalDistanceKm: 10, resampledPoints, samples: [], events: [] };
}

function constantProfile(start, end, gradePct, segmentIndex = 0) {
  const count = Math.round((end - start) / 100);
  return { segmentIndex, start, elevations: Array.from({ length: count + 1 }, (_, index) => 100 + index * 100 * gradePct / 100) };
}

test("classifies a steady climb and sustained steep climb from smoothed data", () => {
  const result = buildGradientIntelligenceV1(dynamics([constantProfile(0, 3000, 11)]), [section({ end: 3000 })]);
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.sections[0].sectionCharacter, "climbing");
  assert.equal(result.sections[0].intervals.length, 1);
  assert.equal(result.sections[0].intervals[0].gradientBand, "steep");
  assert.equal(result.sections[0].intervals[0].character, "sustained-steep-climb");
  assert.equal(result.sections[0].intervals[0].metrics.netGradientPct, 11);
});

test("distinguishes a short steep ramp from a sustained steep climb", () => {
  const ramp = buildGradientIntelligenceV1(dynamics([constantProfile(0, 500, 12)]), [section({ end: 500 })]).sections[0];
  assert.equal(ramp.intervals[0].character, "short-steep-ramp");
  assert.equal(ramp.intervals[0].confidence, "moderate");
  assert.equal(GRADIENT_INTELLIGENCE_RULES.minimumIntervalM, 500);
});

test("uses closed, explicit percent-grade band boundaries", () => {
  const cases = [[1.9, "near-level"], [2, "gentle"], [5, "moderate"], [10, "steep"]];
  for (const [grade, expected] of cases) {
    const result = buildGradientIntelligenceV1(dynamics([constantProfile(0, 1000, grade)]), [section({ end: 1000 })]).sections[0];
    assert.equal(result.intervals[0].gradientBand, expected, `${grade}% grade`);
  }
});

test("exposes a supported gradual start, steeper middle, and easing finish", () => {
  const profile = { segmentIndex: 0, start: 0, elevations: [100] };
  for (let i = 1; i <= 15; i += 1) {
    const grade = i <= 5 ? 2 : i <= 10 ? 11 : 2;
    profile.elevations.push(profile.elevations.at(-1) + grade);
  }
  const result = buildGradientIntelligenceV1(dynamics([profile]), [section({ end: 1500 })]).sections[0];
  assert.equal(result.progression, "gradual-start-steeper-middle-easing-finish");
  assert.deepEqual(result.intervals.map(({ character }) => character), ["directional-change", "short-steep-ramp", "directional-change"]);
});

test("descent intervals retain signed percent gradient and positive descent totals", () => {
  const result = buildGradientIntelligenceV1(dynamics([constantProfile(0, 2000, -6)]), [section({ end: 2000, rhythm: "descent" })]).sections[0];
  assert.equal(result.sectionCharacter, "descending");
  assert.equal(result.intervals[0].metrics.netGradientPct, -6);
  assert.ok(result.intervals[0].metrics.descentM > 0);
  assert.equal(result.intervals[0].character, "steady-descent");
});

test("rolling and low-vertical profiles receive conservative section character labels", () => {
  const rolling = dynamics([{ segmentIndex: 0, start: 0, elevations: [100, 106, 112, 118, 124, 130, 124, 118, 112, 106, 100] }]);
  const rollingResult = buildGradientIntelligenceV1(rolling, [section({ end: 1000, rhythm: "rolling" })]).sections[0];
  assert.equal(rollingResult.sectionCharacter, "rolling");
  const noisy = dynamics([{ segmentIndex: 0, start: 0, elevations: [100, 100.2, 99.9, 100.1, 100, 100.2, 100.1] }]);
  const low = buildGradientIntelligenceV1(noisy, [section({ end: 600, rhythm: "flat" })]).sections[0];
  assert.equal(low.sectionCharacter, "low-vertical-movement");
  assert.equal(low.intervals[0].character, "low-vertical-movement");
  const longFlat = buildGradientIntelligenceV1(dynamics([constantProfile(0, 2000, 0)]), [section({ end: 2000, rhythm: "flat" })]).sections[0];
  assert.equal(longFlat.progression, "steady");
});

test("retains a short opposite-direction interruption inside a dominant climb", () => {
  const elevations = [100, 105, 110, 115, 120, 125, 120, 115, 110, 105, 100, 105, 110, 115, 120, 125];
  const result = buildGradientIntelligenceV1(dynamics([{ segmentIndex: 0, start: 0, elevations }]), [section({ end: 1500, rhythm: "climb" })]).sections[0];
  assert.ok(result.intervals.some(({ direction, character }) => direction === "descent" && character === "short-interruption"));
});

test("short sections, invalid bounds, and missing samples fail closed to unknown", () => {
  const tooShort = buildGradientIntelligenceV1(dynamics([constantProfile(0, 400, 20)]), [section({ end: 400 })]).sections[0];
  assert.equal(tooShort.status, "unknown");
  assert.equal(tooShort.unknownReason, "insufficient-distance");
  const noSamples = buildGradientIntelligenceV1(dynamics([]), [section({ end: 1000 })]).sections[0];
  assert.equal(noSamples.status, "unknown");
  assert.equal(noSamples.unknownReason, "insufficient-smoothed-samples");
  const invalid = buildGradientIntelligenceV1(dynamics([]), [section({ start: 1000, end: 500 })]).sections[0];
  assert.equal(invalid.unknownReason, "invalid-section-bounds");
  const missingBounds = buildGradientIntelligenceV1(dynamics([]), [{ ...section({ end: 1000 }), startPosition: undefined }]).sections[0];
  assert.equal(missingBounds.startDistanceM, null);
  assert.equal(missingBounds.status, "unknown");
  const sparse = buildGradientIntelligenceV1({ ...dynamics([]), resampledPoints: [0, 100, 200, 700, 800, 1000].map((distanceM) => ({ distanceM, segmentIndex: 0, elevationM: 100, smoothedElevationM: 100 })) }, [section({ end: 1000 })]).sections[0];
  assert.equal(sparse.unknownReason, "insufficient-smoothed-samples");
});

test("disconnected components are analyzed independently even at shared cumulative distance", () => {
  const input = dynamics([
    { segmentIndex: 0, start: 0, elevations: [100, 105, 110, 115, 120, 125, 130] },
    { segmentIndex: 1, start: 0, elevations: [200, 197, 194, 191, 188, 185, 182] },
  ]);
  const result = buildGradientIntelligenceV1(input, [
    section({ id: "first", segmentIndex: 0, end: 600, rhythm: "climb" }),
    section({ id: "second", segmentIndex: 1, end: 600, rhythm: "descent" }),
  ]);
  assert.deepEqual(result.sections.map(({ sectionId, segmentIndex }) => [sectionId, segmentIndex]), [["first", 0], ["second", 1]]);
  assert.ok(result.sections[0].intervals[0].metrics.netGradientPct > 0);
  assert.ok(result.sections[1].intervals[0].metrics.netGradientPct < 0);
});

test("characterization is deterministic and preserves precise section bounds", () => {
  const route = dynamics([constantProfile(0, 2000, 4)]);
  const selected = section({ start: 50, end: 1950 });
  const first = buildGradientIntelligenceV1(route, [selected]);
  assert.deepEqual(buildGradientIntelligenceV1(route, [selected]), first);
  assert.equal(first.sections[0].startDistanceM, 50);
  assert.equal(first.sections[0].endDistanceM, 1950);
});
