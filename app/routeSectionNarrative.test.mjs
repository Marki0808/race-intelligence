import assert from "node:assert/strict";
import test from "node:test";
import { presentRouteSectionNarrativeV1 } from "./routeSectionNarrative.ts";

const bandFor = (grade) => {
  const absolute = Math.abs(grade);
  return absolute < 2 ? "near-level" : absolute < 5 ? "gentle" : absolute < 10 ? "moderate" : absolute < 15 ? "steep" : absolute < 20 ? "very-steep" : "extreme-grade";
};

function makeSection(intervals, { id = "section-1", segmentIndex = 0, rhythm = "climb", elevationStartM = 100 } = {}) {
  const startM = intervals[0]?.startDistanceM ?? 0;
  const endM = intervals.at(-1)?.endDistanceM ?? 0;
  const ascentM = intervals.reduce((sum, item) => sum + item.metrics.ascentM, 0);
  const descentM = intervals.reduce((sum, item) => sum + item.metrics.descentM, 0);
  return {
    id, segmentIndex, startKm: startM / 1000, endKm: endM / 1000,
    startPosition: { distanceM: startM, segmentIndex }, endPosition: { distanceM: endM, segmentIndex },
    distanceKm: (endM - startM) / 1000, dominantRhythm: rhythm,
    elevationStartM, elevationEndM: elevationStartM + ascentM - descentM,
    elevationMinM: 0, elevationMaxM: 1000, ascentM, descentM,
  };
}

function interval(startDistanceM, endDistanceM, direction, grade, id) {
  const distanceM = endDistanceM - startDistanceM;
  const signed = direction === "descent" ? -Math.abs(grade) : direction === "climb" ? Math.abs(grade) : 0;
  const vertical = direction === "climb" ? Math.abs(distanceM * signed / 100) : 0;
  const loss = direction === "descent" ? Math.abs(distanceM * signed / 100) : 0;
  const ascentM = direction === "rolling" ? distanceM * 0.025 : vertical;
  const descentM = direction === "rolling" ? distanceM * 0.025 : loss;
  const netElevationChangeM = ascentM - descentM;
  const netGradientPct = direction === "rolling" ? 0 : signed;
  const unknown = direction === "unknown";
  return {
    intervalId: id, segmentIndex: 0, startDistanceM, endDistanceM, distanceM,
    metrics: {
      netElevationChangeM, netGradientPct, ascentM, descentM,
      verticalIntensityMPerKm: (ascentM + descentM) / (distanceM / 1000),
      cellNetGradientMinimumPct: netGradientPct, cellNetGradientMaximumPct: netGradientPct,
      cellNetGradientSpreadPercentagePoints: 0,
    },
    direction, gradientBand: direction === "climb" || direction === "descent" ? bandFor(netGradientPct) : null,
    character: unknown ? "unknown" : direction === "rolling" ? "rolling" : "steady-climb",
    confidence: unknown ? "unknown" : "high",
    intervalLengthClass: distanceM < 1500 ? "short" : "sustained",
    sectionRelationship: unknown ? "unknown" : direction === "climb" || direction === "descent" ? "aligned" : "not-directional",
    measurementAvailability: "available",
    ...(unknown ? { unknownReasons: ["low-directional-strength"] } : {}),
  };
}

function present(parts, { rhythm = "climb", ...options } = {}) {
  const section = makeSection(parts, { rhythm, ...options });
  const gradient = {
    schemaVersion: 1,
    algorithmVersion: 2,
    source: "route-dynamics-smoothed-profile",
    assumptions: { resampleIntervalM: 100, medianFilterRadiusM: 150, movingAverageRadiusM: 250 },
    sections: [{
      sectionId: section.id, segmentIndex: section.segmentIndex,
      startDistanceM: section.startPosition.distanceM, endDistanceM: section.endPosition.distanceM,
      status: "available",
      sectionCharacter: rhythm === "climb" ? "climbing" : rhythm === "descent" ? "descending" : rhythm === "rolling" ? "rolling" : "low-vertical-movement",
      progression: "unknown", multiScaleMetrics: [], intervals: parts.map((part) => ({
        ...part,
        sectionRelationship: part.direction === "unknown" ? "unknown" : part.direction === "climb" || part.direction === "descent"
          ? rhythm === "climb" || rhythm === "descent" ? part.direction === rhythm ? "aligned" : "opposite-direction" : "not-directional"
          : "not-directional",
      })),
    }],
  };
  return presentRouteSectionNarrativeV1(gradient, [section], section);
}

test("summarizes a long climb over its full length and traces an opposite-direction interruption", () => {
  const output = present([
    interval(0, 2500, "climb", 7, "climb-1"),
    interval(2500, 3000, "descent", -11, "brief-steep-descent"),
    interval(3000, 6000, "climb", 12, "climb-2"),
  ]);
  assert.match(output.sentences[0], /Climbing sets the overall direction/);
  assert.match(output.sentences[1], /short steep descent interrupts the longer climb/);
  assert.equal(output.facts.measurements.distanceM, 6000);
  assert.ok(output.trace[1].intervalIds.includes("brief-steep-descent"));
  assert.ok(output.trace[1].intervalIds.includes("climb-1"));
});

test("summarizes a long descent and identifies a sustained steeper subsection", () => {
  const output = present([
    interval(0, 2000, "descent", -4, "gentle-down"),
    interval(2000, 4500, "descent", -13, "steep-down"),
    interval(4500, 6000, "descent", -6, "moderate-down"),
  ], { rhythm: "descent", elevationStartM: 800 });
  assert.match(output.sentences[0], /sustained descent shapes most/);
  assert.match(output.sentences[1], /descent steepens from a sustained gentle grade into a sustained steep stretch/);
  assert.deepEqual(output.trace[1].intervalIds, ["gentle-down", "steep-down"]);
});

test("uses complete ordered profile to explain a substantial climb-to-descent transition", () => {
  const output = present([
    interval(0, 3000, "climb", 7, "long-climb"),
    interval(3000, 6000, "descent", -8, "long-descent"),
  ], { rhythm: "rolling" });
  assert.equal(output.sentences[1], "A sustained climb gives way to a sustained descent.");
});

test("keeps a known rolling interval explicit between sustained opposite directions", () => {
  const output = present([
    interval(0, 2500, "climb", 7, "uphill"),
    interval(2500, 3000, "rolling", 0, "rolling-bridge"),
    interval(3000, 6000, "descent", -8, "downhill"),
  ], { rhythm: "rolling" });
  assert.match(output.sentences.join(" "), /After a rolling stretch, a sustained descent follows the sustained climb/);
  assert.deepEqual(output.facts.directionChanges[0].viaDirections, ["rolling"]);
  assert.ok(output.trace.some((item) => item.intervalIds.includes("rolling-bridge")));
});

test("describes repeated rolling changes without adding a terrain claim", () => {
  const output = present([
    interval(0, 2000, "climb", 6, "up-a"), interval(2000, 4000, "descent", -6, "down-a"),
    interval(4000, 6000, "climb", 7, "up-b"), interval(6000, 8000, "descent", -5, "down-b"),
  ], { rhythm: "rolling", elevationStartM: 400 });
  assert.equal(output.facts.directionChanges.length, 3);
  assert.match(output.sentences[0], /Climbs and descents take turns/);
  assert.doesNotMatch(output.sentences.join(" "), /trail|surface|technical|weather|effort|fitness|pace|exposure/i);
});

test("keeps a short steep ramp distinct without describing the whole section as steep", () => {
  const output = present([
    interval(0, 2500, "climb", 6, "steady-up"),
    interval(2500, 3000, "climb", 22, "short-extreme-up"),
    interval(3000, 6000, "climb", 6, "steady-up-2"),
  ]);
  assert.match(output.sentences.join(" "), /short climb in the middle part averages about 22% grade over 0.5 km/);
  assert.doesNotMatch(output.sentences.join(" "), /entire section|uniformly steep/i);
});

test("prefers sustained section features over an isolated short extreme when both exist", () => {
  const output = present([
    interval(0, 500, "climb", 24, "short-extreme"),
    interval(500, 3000, "climb", 12, "sustained-steep"),
    interval(3000, 6000, "climb", 6, "longer-moderate"),
  ]);
  assert.ok(output.sentences.join(" ").includes("sustained steep grade"));
  assert.ok(output.sentences.join(" ").includes("climb eases"));
  assert.ok(!output.sentences.join(" ").includes("24%"));
  assert.equal(output.facts.gradientPortions.find((portion) => portion.intervalId === "short-extreme").notable, true);
});

test("unknown direction coverage limits claims while measured section gain remains explicit", () => {
  const output = present([
    interval(0, 2000, "climb", 7, "known-climb"),
    interval(2000, 5000, "unknown", 0, "uncertain"),
    interval(5000, 8000, "climb", 8, "known-climb-2"),
  ]);
  assert.equal(output.status, "limited");
  assert.match(output.sentences[0], /gains elevation overall, but direction is unclear over some intervals/);
  assert.doesNotMatch(output.sentences.join(" "), /continuous|takes turns/);
  assert.deepEqual(output.facts.unknownIntervals.map(({ intervalId, reasonCodes }) => [intervalId, reasonCodes]), [["uncertain", ["low-directional-strength"]]]);
  assert.equal(output.facts.directionChanges.length, 0, "unknown intervals must break inferred transitions");
});

test("does not narrate an ending transition across an unknown direction interval", () => {
  const output = present([
    interval(0, 2500, "climb", 7, "known-opening-climb"),
    interval(2500, 5000, "unknown", 0, "unknown-middle"),
    interval(5000, 5500, "descent", -12, "known-closing-descent"),
  ]);
  assert.equal(output.status, "limited");
  assert.doesNotMatch(output.sentences.join(" "), /followed by|closes it|gives way/i);
  assert.equal(output.facts.directionChanges.length, 0);
});

test("missing data and low-vertical sections remain restrained", () => {
  const section = makeSection([], { rhythm: "flat" });
  assert.equal(presentRouteSectionNarrativeV1(undefined, [section], section).status, "missing-data");
  const flatOutput = present([
    interval(0, 2000, "low-vertical-movement", 0, "low-a"), interval(2000, 4000, "low-vertical-movement", 0, "low-b"),
  ], { rhythm: "flat" });
  assert.match(flatOutput.sentences[0], /Elevation changes remain limited/);
});

test("narrative stays component-scoped and deterministic", () => {
  const first = present([interval(0, 3000, "climb", 8, "segment-0-climb")]);
  assert.deepEqual(present([interval(0, 3000, "climb", 8, "segment-0-climb")]), first);
  const other = makeSection([interval(0, 3000, "climb", 8, "segment-1-climb")], { segmentIndex: 1 });
  const segmentZero = makeSection([interval(0, 3000, "climb", 8, "segment-0-climb")]);
  const zeroGradient = {
    schemaVersion: 1, algorithmVersion: 2, source: "route-dynamics-smoothed-profile",
    assumptions: { resampleIntervalM: 100, medianFilterRadiusM: 150, movingAverageRadiusM: 250 },
    sections: [{
      sectionId: segmentZero.id, segmentIndex: 0, startDistanceM: 0, endDistanceM: 3000,
      status: "available", sectionCharacter: "climbing", progression: "unknown", multiScaleMetrics: [],
      intervals: [interval(0, 3000, "climb", 8, "segment-0-climb")],
    }],
  };
  assert.equal(presentRouteSectionNarrativeV1(zeroGradient, [other], other).status, "invalid-data");
});
