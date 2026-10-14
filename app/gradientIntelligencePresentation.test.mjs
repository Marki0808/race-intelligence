import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";

const require = createRequire(import.meta.url);
const sourceUrl = new URL("./gradientIntelligencePresentation.ts", import.meta.url);
const source = await readFile(sourceUrl, "utf8");
const compiled = ts.transpile(source, { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 });
const rules = {
  gentleMaximumGradePct: 2,
  moderateMaximumGradePct: 5,
  steepMinimumGradePct: 10,
  verySteepMinimumGradePct: 15,
  extremeGradeMinimumGradePct: 20,
  sustainedIntervalMinimumM: 1500,
};
const moduleObject = { exports: {} };
new Function("exports", "require", "module", "__filename", "__dirname", compiled)(
  moduleObject.exports,
  (specifier) => specifier === "./gradientIntelligence.ts" ? { GRADIENT_INTELLIGENCE_RULES: rules } : require(specifier),
  moduleObject,
  sourceUrl.pathname,
  new URL(".", sourceUrl).pathname,
);
const { presentGradientExpectationV1 } = moduleObject.exports;

function routeSection({ id = "section-1", segmentIndex = 0, startM = 0, endM = 2000, rhythm = "climb" } = {}) {
  return {
    id,
    segmentIndex,
    startPosition: { distanceM: startM, segmentIndex },
    endPosition: { distanceM: endM, segmentIndex },
    dominantRhythm: rhythm,
  };
}

function interval({ id = "interval-1", segmentIndex = 0, startM = 0, endM = 2000, direction = "climb", grade = 12, band = "steep", relationship = "aligned", lengthClass } = {}) {
  const distanceM = endM - startM;
  return {
    intervalId: id,
    segmentIndex,
    startDistanceM: startM,
    endDistanceM: endM,
    distanceM,
    metrics: {
      netElevationChangeM: distanceM * grade / 100,
      netGradientPct: grade,
      ascentM: direction === "climb" ? Math.abs(distanceM * grade / 100) : 0,
      descentM: direction === "descent" ? Math.abs(distanceM * grade / 100) : 0,
      verticalIntensityMPerKm: Math.abs(grade) * 10,
      cellNetGradientMinimumPct: grade,
      cellNetGradientMaximumPct: grade,
      cellNetGradientSpreadPercentagePoints: 0,
    },
    direction,
    gradientBand: band,
    character: band === "steep" || band === "very-steep" || band === "extreme-grade"
      ? distanceM < 1500 ? "short-steep-ramp" : direction === "climb" ? "sustained-steep-climb" : "sustained-steep-descent"
      : direction === "unknown" ? "unknown" : direction === "rolling" ? "rolling" : "steady-climb",
    confidence: direction === "unknown" ? "unknown" : "high",
    intervalLengthClass: lengthClass ?? (distanceM < 1500 ? "short" : "sustained"),
    sectionRelationship: relationship,
    measurementAvailability: "available",
    ...(direction === "unknown" ? { unknownReasons: ["low-directional-strength"] } : {}),
  };
}

function result(section, intervals, overrides = {}) {
  return {
    schemaVersion: 1,
    algorithmVersion: 2,
    source: "route-dynamics-smoothed-profile",
    assumptions: { resampleIntervalM: 100, medianFilterRadiusM: 150, movingAverageRadiusM: 250 },
    sections: [{
      sectionId: section.id,
      segmentIndex: section.segmentIndex,
      startDistanceM: section.startPosition.distanceM,
      endDistanceM: section.endPosition.distanceM,
      status: "available",
      sectionCharacter: ({ climb: "climbing", descent: "descending", rolling: "rolling", flat: "low-vertical-movement" })[section.dominantRhythm],
      progression: "unknown",
      multiScaleMetrics: [],
      intervals,
      ...overrides,
    }],
  };
}

function present(section, intervals, override) {
  return presentGradientExpectationV1(result(section, intervals, override), [section], section);
}

test("renders sustained climb and descent symmetrically with smoothed average grades", () => {
  const climb = routeSection({ rhythm: "climb" });
  const climbOutput = present(climb, [interval({})]);
  assert.deepEqual(climbOutput.sentences, [
    "This section is mainly an ascent.",
    "A sustained steep climb covers about 2.0 km, with the smoothed GPX profile averaging about 12% grade.",
  ]);

  const descent = routeSection({ rhythm: "descent" });
  const descentOutput = present(descent, [interval({ direction: "descent", grade: -12, relationship: "aligned" })]);
  assert.deepEqual(descentOutput.sentences, [
    "This section is mainly a descent.",
    "A sustained steep descent covers about 2.0 km, with the smoothed GPX profile averaging about 12% grade.",
  ]);
  assert.equal(descentOutput.facts.highlights[0].smoothedAverageGradePct, -12);
});

test("calls out very-steep and numeric extreme-grade intervals without extreme prose", () => {
  const section = routeSection();
  const verySteep = present(section, [interval({ grade: 18, band: "very-steep" })]);
  assert.match(verySteep.sentences[1], /very steep climb/);
  assert.match(verySteep.sentences[1], /18%/);

  const extreme = present(section, [interval({ grade: 22, band: "extreme-grade" })]);
  assert.match(extreme.sentences[1], /22%/);
  assert.doesNotMatch(extreme.sentences.join(" "), /extremely steep|extreme grade/i);
});

test("distinguishes a short steep ramp from sustained gradient by distance", () => {
  const section = routeSection({ endM: 1000 });
  const short = present(section, [interval({ endM: 1000, grade: 13 })]);
  assert.equal(short.facts.highlights[0].lengthClass, "short");
  assert.equal(short.sentences[1], "A short steep climb covers about 1.0 km, with the smoothed GPX profile averaging about 13% grade.");
});

test("keeps a steep opposite-direction interruption explicit and retains its grade", () => {
  const section = routeSection({ rhythm: "climb" });
  const output = present(section, [
    interval({ id: "climb", startM: 0, endM: 1000, grade: 12 }),
    interval({ id: "descent", startM: 1000, endM: 2000, direction: "descent", grade: -17, band: "very-steep", relationship: "opposite-direction" }),
  ]);
  assert.deepEqual(output.sentences, [
    "This section is mainly an ascent.",
    "A short steep climb covers about 1.0 km, with the smoothed GPX profile averaging about 12% grade.",
    "A short very steep descent interrupts the main climb. It covers about 1.0 km, with the smoothed GPX profile averaging about 17% grade.",
  ]);
  assert.equal(output.facts.highlights[1].sectionRelationship, "opposite-direction");
});

test("rolling and low-vertical sections use restrained character-only descriptions", () => {
  const rolling = routeSection({ rhythm: "rolling" });
  const rollingOutput = present(rolling, [interval({ direction: "rolling", band: null, grade: 0, relationship: "not-directional" })]);
  assert.deepEqual(rollingOutput.sentences, ["This section alternates between climbing and descending."]);

  const flat = routeSection({ rhythm: "flat" });
  const low = present(flat, [interval({ direction: "low-vertical-movement", band: null, grade: 0, relationship: "not-directional" })]);
  assert.deepEqual(low.sentences, ["This section has relatively little elevation change."]);
});

test("unknown, missing, stale, and component-mismatched data fail closed", () => {
  const section = routeSection();
  const unknown = present(section, [], { status: "unknown", intervals: [] });
  assert.equal(unknown.status, "unknown");
  assert.deepEqual(unknown.sentences, ["The elevation profile does not support a clear gradient summary for this section."]);

  const missing = presentGradientExpectationV1(undefined, [section], section);
  assert.equal(missing.status, "missing-data");
  assert.deepEqual(missing.sentences, ["A gradient summary is not available for this analysis."]);

  const stale = result(section, [interval({})]);
  stale.algorithmVersion = 1;
  assert.equal(presentGradientExpectationV1(stale, [section], section).status, "unsupported-version");

  const otherComponent = routeSection({ id: section.id, segmentIndex: 1, startM: 0, endM: 2000 });
  assert.equal(presentGradientExpectationV1(result(section, [interval({})]), [otherComponent], otherComponent).status, "invalid-data");
});

test("rejects stale boundaries, contradictory direction/grade, and incomplete intervals", () => {
  const section = routeSection();
  const staleBounds = result(section, [interval({})]);
  staleBounds.sections[0].endDistanceM = 1999;
  assert.equal(presentGradientExpectationV1(staleBounds, [section], section).status, "invalid-data");

  const contradictory = interval({ direction: "descent", grade: 12, band: "steep", relationship: "opposite-direction" });
  assert.equal(present(section, [contradictory]).status, "invalid-data");

  const gap = [interval({ id: "first", endM: 1000 }), interval({ id: "second", startM: 1001, endM: 2000 })];
  assert.equal(present(section, gap).status, "invalid-data");
});

test("tolerates a band edge hidden by two-decimal measurement rounding only at the exact edge", () => {
  const section = routeSection();
  const roundedEdge = interval({ grade: 2, band: "near-level" });
  assert.equal(present(section, [roundedEdge]).status, "available");
  const contradictory = interval({ grade: 2.02, band: "near-level" });
  assert.equal(present(section, [contradictory]).status, "invalid-data");
});

test("presentation and fact selection are deterministic and bounded", () => {
  const section = routeSection({ rhythm: "rolling" });
  const intervals = [
    interval({ id: "climb-a", startM: 0, endM: 1000, grade: 12, relationship: "not-directional" }),
    interval({ id: "descent-a", startM: 1000, endM: 2000, direction: "descent", grade: -15, band: "very-steep", relationship: "not-directional" }),
  ];
  const first = present(section, intervals);
  assert.deepEqual(present(section, intervals), first);
  assert.equal(first.sentences.length, 3);
  assert.deepEqual(first.facts.highlights.map(({ intervalId }) => intervalId), ["climb-a", "descent-a"]);
});

test("keeps selected climb and descent details in route order and avoids unsupported claims", () => {
  const section = routeSection({ rhythm: "rolling" });
  const output = present(section, [
    interval({ id: "first-descent", startM: 0, endM: 1000, direction: "descent", grade: -12, relationship: "not-directional" }),
    interval({ id: "later-climb", startM: 1000, endM: 2000, grade: 12, relationship: "not-directional" }),
  ]);
  assert.deepEqual(output.facts.highlights.map(({ intervalId }) => intervalId), ["first-descent", "later-climb"]);
  const text = output.sentences.join(" ");
  assert.ok(text.indexOf("descent covers") < text.indexOf("climb covers"));
  assert.doesNotMatch(text, /surface|technical|weather|footing|speed|effort|fitness|pace|exposure|safe|advice|extremely steep/i);
});

test("prefers a sustained defining interval over a shorter, steeper cell group of the same direction", () => {
  const section = routeSection({ endM: 3000 });
  const output = present(section, [
    interval({ id: "short-extreme", startM: 0, endM: 1000, grade: 22, band: "extreme-grade" }),
    interval({ id: "sustained-steep", startM: 1000, endM: 3000, grade: 12, band: "steep" }),
  ]);
  assert.deepEqual(output.facts.highlights.map(({ intervalId }) => intervalId), ["sustained-steep"]);
  assert.match(output.sentences[1], /sustained steep climb covers about 2.0 km/);
});
