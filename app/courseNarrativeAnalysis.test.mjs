import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { analyzeGpxRoute, parseGpxText } from "./gpxAnalysis.ts";
import { analyzeCoursePhases } from "./coursePhaseAnalysis.ts";
import { analyzeCourseNarrative, COURSE_NARRATIVE_ALGORITHM_VERSION, MINIMUM_SUPPORTING_EVENT_PHASE_VERTICAL_SHARE } from "./courseNarrativeAnalysis.ts";
import { selectStructuredRouteKeyMomentEvents } from "./routeKeyMoments.ts";

function fixture(specs, { segmentIndexes = specs.map(() => 0), moments = [], extrema = [] } = {}) {
  const phases = [];
  const sections = [];
  const transitions = [];
  let kmBySegment = new Map();
  for (let index = 0; index < specs.length; index += 1) {
    const item = specs[index];
    const segmentIndex = segmentIndexes[index] ?? 0;
    const startKm = kmBySegment.get(segmentIndex) ?? 0;
    const endKm = startKm + item.distanceKm;
    kmBySegment.set(segmentIndex, endKm);
    const sectionId = `section-s${segmentIndex}-${index}`;
    const embeddedEvents = (item.events ?? []).map((event, eventIndex) => ({
      id: event.id ?? `event-s${segmentIndex}-${index}-${eventIndex}`,
      rhythm: event.kind,
      startKm: startKm + (event.startOffsetKm ?? item.distanceKm * 0.25),
      endKm: startKm + (event.endOffsetKm ?? item.distanceKm * 0.75),
      distanceKm: (event.endOffsetKm ?? item.distanceKm * 0.75) - (event.startOffsetKm ?? item.distanceKm * 0.25),
      ascentM: event.ascentM ?? 0,
      descentM: event.descentM ?? 0,
      significance: 0.2,
      segmentIndex,
      startPosition: { distanceM: (startKm + (event.startOffsetKm ?? item.distanceKm * 0.25)) * 1000, segmentIndex },
      endPosition: { distanceM: (startKm + (event.endOffsetKm ?? item.distanceKm * 0.75)) * 1000, segmentIndex },
    }));
    sections.push({ id: sectionId, segmentIndex, startKm, endKm, embeddedEvents });
    phases.push({
      id: `phase-s${segmentIndex}-${index}`,
      ordinal: phases.length + 1,
      segmentIndex,
      startKm,
      endKm,
      distanceKm: item.distanceKm,
      sourceSectionIds: item.sectionCount === undefined ? [sectionId] : Array.from({ length: item.sectionCount }, (_, n) => `${sectionId}-${n}`),
      character: item.character,
      ascentM: item.ascentM,
      descentM: item.descentM,
      ascentMPerKm: item.ascentM / item.distanceKm,
      descentMPerKm: item.descentM / item.distanceKm,
      verticalIntensityMPerKm: (item.ascentM + item.descentM) / item.distanceKm,
      directionBalance: item.ascentM + item.descentM === 0 ? 0 : (item.ascentM - item.descentM) / (item.ascentM + item.descentM),
      stability: 0.9,
      embeddedEventIds: embeddedEvents.map((event) => event.id),
      interruptions: [],
    });
  }
  // Build only adjacent, same-component transitions, matching Course Phase output semantics.
  for (let index = 1; index < phases.length; index += 1) {
    const before = phases[index - 1];
    const after = phases[index];
    if (before.segmentIndex !== after.segmentIndex || before.character === after.character) continue;
    transitions.push({
      id: `transition-${before.id}-${after.id}`,
      segmentIndex: before.segmentIndex,
      fromPhaseId: before.id,
      toPhaseId: after.id,
      fromCharacter: before.character,
      toCharacter: after.character,
      fromEndKm: before.endKm,
      toStartKm: after.startKm,
    });
  }
  const keyMoments = moments.map((moment) => {
    const phase = phases[moment.phaseIndex];
    const startKm = phase.startKm + phase.distanceKm * 0.25;
    const endKm = phase.startKm + phase.distanceKm * 0.75;
    const eventId = moment.eventId ?? `moment-${moment.phaseIndex}`;
    return {
      factId: `key-${eventId}`,
      eventId,
      kind: moment.kind,
      roles: moment.roles,
      segmentIndex: phase.segmentIndex,
      startKm,
      endKm,
      distanceKm: endKm - startKm,
      elevationChangeM: moment.elevationChangeM ?? 40,
    };
  });
  return { phases, transitions, routeSections: sections, keyMoments, extrema };
}

const p = (character, distanceKm, ascentM, descentM = 0, extra = {}) => ({ character, distanceKm, ascentM, descentM, ...extra });
const model = (specs, options) => analyzeCourseNarrative(fixture(specs, options));

test("Course Narrative exposes a versioned closed structural model", () => {
  const result = model([p("low-vertical", 10, 20, 20)]);
  assert.equal(COURSE_NARRATIVE_ALGORITHM_VERSION, 1);
  assert.equal(result.algorithmVersion, 1);
  assert.equal(result.units.length, 1);
  assert.equal(result.units[0].structuralPattern, "low-vertical");
  assert.ok(!["mountain", "technical", "runnable", "easy", "hard", "recovery", "fast", "slow", "controlled", "demanding"].includes(result.units[0].structuralPattern));
});

test("A sustained climb remains one climb-dominant unit", () => {
  const result = model([p("climb-dominant", 12, 900)]);
  assert.equal(result.units.length, 1);
  assert.deepEqual(result.units[0].phaseIds, ["phase-s0-0"]);
});

test("climb to descent remains two units with a significant directional-reversal transition", () => {
  const result = model([p("climb-dominant", 10, 800), p("descent-dominant", 8, 100, 700)]);
  assert.equal(result.units.length, 2);
  assert.equal(result.transitions.length, 1);
  assert.equal(result.transitions[0].significance, "significant");
  assert.ok(result.transitions[0].reasonCodes.includes("directional-reversal"));
});

test("one repeated-vertical phase remains one unit", () => {
  const result = model([p("repeated-vertical", 24, 900, 850)]);
  assert.equal(result.units.length, 1);
  assert.equal(result.units[0].structuralPattern, "repeated-vertical");
});

test("a weak bridge attaches without replacing surrounding meaningful phases", () => {
  const result = model([
    p("climb-dominant", 10, 800, 50),
    p("mixed", 0.5, 3, 2),
    p("repeated-vertical", 10, 450, 400),
  ]);
  assert.equal(result.units.length, 2);
  assert.deepEqual(result.units[0].phaseIds, ["phase-s0-0", "phase-s0-1"]);
  assert.ok(result.units[0].reasonCodes.includes("weak-bridge-attached"));
  assert.deepEqual(result.units[1].phaseIds, ["phase-s0-2"]);
});

test("substantial climb, descent and repeated-vertical phases remain distinct", () => {
  const result = model([
    p("climb-dominant", 12, 1100),
    p("descent-dominant", 10, 100, 900),
    p("repeated-vertical", 18, 700, 650),
  ]);
  assert.equal(result.units.length, 3);
  assert.deepEqual(result.units.map((unit) => unit.phaseIds.length), [1, 1, 1]);
});

test("descent evolving into a lower-intensity low-vertical finish combines but retains its transition", () => {
  const result = model([
    p("descent-dominant", 12, 100, 600),
    p("low-vertical", 8, 40, 50),
  ]);
  assert.equal(result.units.length, 1);
  assert.equal(result.units[0].structuralPattern, "evolving");
  assert.deepEqual(result.units[0].phaseIds, ["phase-s0-0", "phase-s0-1"]);
  assert.ok(result.units[0].reasonCodes.includes("coherent-finish-evolution"));
  assert.equal(result.transitions[0].isInternalToUnit, true);
  assert.equal(result.transitions[0].significance, "significant");
  assert.ok(result.evolutionFacts.some((fact) => fact.type === "low-vertical-to-component-finish"));
});

test("relative event materiality distinguishes meaningful and noise-level climb interruptions", () => {
  const significant = model([p("low-vertical", 40, 100, 0, { events: [{ kind: "climb", ascentM: 25 }] })]);
  const noise = model([p("low-vertical", 40, 100, 0, { events: [{ kind: "climb", ascentM: 5 }] })]);
  assert.equal(significant.events[0].tier, "supporting-interruption");
  assert.equal(noise.events[0].tier, "context-only");
  assert.ok(significant.units[0].significantEventIds.includes(significant.events[0].id));
  assert.ok(!noise.units[0].significantEventIds.includes(noise.events[0].id));
});

test("event threshold has below/exact/above coverage on both short and long phases", () => {
  assert.equal(MINIMUM_SUPPORTING_EVENT_PHASE_VERTICAL_SHARE, 0.2);
  for (const { distanceKm, phaseVertical, below, exact, above } of [
    { distanceKm: 2, phaseVertical: 100, below: 19, exact: 20, above: 21 },
    { distanceKm: 80, phaseVertical: 1000, below: 199, exact: 200, above: 201 },
  ]) {
    const classify = (eventVertical) => model([
      p("climb-dominant", distanceKm, phaseVertical, 0, { events: [{ kind: "descent", descentM: eventVertical }] }),
    ]).events[0].tier;
    assert.equal(classify(below), "context-only");
    assert.equal(classify(exact), "supporting-interruption");
    assert.equal(classify(above), "supporting-interruption");
  }
});

test("inherited component-distance support boundary stays below/exact/above on short and long routes", () => {
  for (const totalKm of [10, 100]) {
    const classify = (share) => model([
      p("low-vertical", totalKm * share, 0, 0),
      p("descent-dominant", totalKm * (1 - share), 20, 980),
    ]);
    assert.equal(classify(0.079).units.length, 1);
    assert.equal(classify(0.08).units.length, 2);
    assert.equal(classify(0.081).units.length, 2);
  }
});

test("inherited component-vertical support boundary stays below/exact/above on short and long routes", () => {
  for (const totalKm of [10, 100]) {
    const classify = (share) => model([
      p("climb-dominant", totalKm * 0.05, 100 * share),
      p("descent-dominant", totalKm * 0.95, 25, 100 * (1 - share) - 25),
    ]);
    assert.equal(classify(0.19).units.length, 1);
    assert.equal(classify(0.2).units.length, 2);
    assert.equal(classify(0.21).units.length, 2);
  }
});

test("a short vertically material phase is kept using component-relative vertical support", () => {
  const result = model([
    p("climb-dominant", 0.4, 80),
    p("descent-dominant", 1.6, 30, 120),
  ]);
  assert.ok(result.units.some((unit) => unit.phaseIds.includes("phase-s0-0")));
  assert.equal(result.units.length, 2);
});

test("complex long routes retain structurally supported phases without a unit-count cap", () => {
  const specs = Array.from({ length: 12 }, (_, index) => {
    const character = index % 3 === 0 ? "climb-dominant" : index % 3 === 1 ? "descent-dominant" : "repeated-vertical";
    return p(character, 14, 900, character === "climb-dominant" ? 40 : 700);
  });
  const result = model(specs);
  assert.equal(result.units.length, 12);
  assert.ok(result.units.every((unit, index) => unit.ordinal === index + 1));
});

test("disconnected components remain separate and never receive a cross-component transition", () => {
  const result = model([
    p("climb-dominant", 5, 400),
    p("descent-dominant", 5, 30, 350),
  ], { segmentIndexes: [0, 1] });
  assert.deepEqual(result.units.map((unit) => unit.segmentIndex), [0, 1]);
  assert.equal(result.transitions.length, 0);
});

test("narrative composition depends on ordered phase evidence, not loop proximity", () => {
  // The input contract contains no coordinates or loop-distance heuristic. Repeated location cannot join phases.
  const result = model([
    p("climb-dominant", 6, 500),
    p("descent-dominant", 6, 450, 20),
    p("climb-dominant", 6, 480),
  ]);
  assert.equal(result.units.length, 3);
  assert.deepEqual(result.units.flatMap((unit) => unit.phaseIds), ["phase-s0-0", "phase-s0-1", "phase-s0-2"]);
});

test("a selected Key Moment event is an anchor even when it is not in embedded-event inventory", () => {
  const result = model([p("climb-dominant", 10, 500)], {
    moments: [{ phaseIndex: 0, kind: "climb", roles: ["longest", "largest"], eventId: "canonical-climb" }],
  });
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].tier, "anchor");
  assert.deepEqual(result.events[0].keyMomentRoles, ["longest", "largest"]);
  assert.ok(result.units[0].significantEventIds.includes(result.events[0].id));
});

test("a tiny event with zero or negligible vertical work stays context-only", () => {
  const result = model([p("low-vertical", 20, 1000, 0, { events: [
    { kind: "climb", ascentM: 5, startOffsetKm: 2, endOffsetKm: 2.1 },
    { kind: "climb", ascentM: 0, startOffsetKm: 3, endOffsetKm: 3.1 },
  ] })]);
  assert.deepEqual(result.events.map((event) => event.tier), ["context-only", "context-only"]);
  assert.ok(result.events[0].reasonCodes.includes("event-below-relative-materiality"));
  assert.ok(result.events[1].reasonCodes.includes("event-zero-vertical-work"));
});

test("vertical-intensity evolution is emitted as measured structural data", () => {
  const result = model([
    p("climb-dominant", 10, 900),
    p("descent-dominant", 10, 100, 700),
    p("low-vertical", 10, 20, 30),
  ]);
  const fact = result.evolutionFacts.find((item) => item.type === "vertical-intensity-decreases");
  assert.deepEqual(fact.valuesMPerKm, [90, 80, 5]);
  assert.deepEqual(fact.phaseIds, ["phase-s0-0", "phase-s0-1", "phase-s0-2"]);
});

test("raw route extrema are linked to a phase and unit using component identity", () => {
  const input = fixture([
    p("climb-dominant", 5, 500),
    p("descent-dominant", 5, 50, 450),
  ], {
    segmentIndexes: [0, 1],
    extrema: [
      { kind: "highest", segmentIndex: 0, atKm: 2, elevationM: 800 },
      { kind: "lowest", segmentIndex: 1, atKm: 2, elevationM: 30 },
    ],
  });
  const result = analyzeCourseNarrative(input);
  assert.equal(result.routeExtrema[0].phaseId, "phase-s0-0");
  assert.equal(result.routeExtrema[0].unitId, "narrative-unit-s0-0-5");
  assert.equal(result.routeExtrema[1].phaseId, "phase-s1-1");
  assert.equal(result.routeExtrema[1].unitId, "narrative-unit-s1-0-5");
  assert.ok(result.units[0].supportingFactIds.includes("extreme:highest:0:2"));
  assert.ok(result.units[1].supportingFactIds.includes("extreme:lowest:1:2"));
});

test("checked-in Istria produces deterministic phases, units, events and closed evolution facts", async () => {
  const gpx = await readFile(new URL("../public/ISTRIA_110K_2027.gpx", import.meta.url), "utf8");
  const analysis = analyzeGpxRoute(parseGpxText(gpx));
  const phaseAnalysis = analyzeCoursePhases(analysis.routeSections);
  const highPoint = analysis.points.reduce((best, point) => point.elevationM > best.elevationM ? point : best);
  const lowPoint = analysis.points.reduce((best, point) => point.elevationM < best.elevationM ? point : best);
  const extrema = [
    { kind: "highest", segmentIndex: highPoint.segmentIndex, atKm: highPoint.distanceM / 1000, elevationM: highPoint.elevationM },
    { kind: "lowest", segmentIndex: lowPoint.segmentIndex, atKm: lowPoint.distanceM / 1000, elevationM: lowPoint.elevationM },
  ];
  const narrative = analyzeCourseNarrative({
    phases: phaseAnalysis.phases,
    transitions: phaseAnalysis.transitions,
    routeSections: analysis.routeSections,
    keyMoments: selectStructuredRouteKeyMomentEvents(analysis.routeDynamics),
    extrema,
  });
  assert.equal(phaseAnalysis.phases.length, 5);
  assert.ok(narrative.units.length > 0);
  assert.ok(narrative.units.every((unit) => unit.phaseIds.length > 0 && unit.segmentIndex === 0));
  assert.ok(narrative.events.some((event) => event.tier === "anchor"));
  const tinyLateClimb = narrative.events.find((event) => event.kind === "climb" && event.startKm === 89.1);
  const moderateLateClimb = narrative.events.find((event) => event.kind === "climb" && event.startKm === 96.1);
  assert.equal(tinyLateClimb.tier, "context-only");
  assert.equal(moderateLateClimb.tier, "context-only");
  assert.ok(narrative.events.some((event) => event.tier === "supporting-interruption"));
  assert.ok(narrative.units.every((unit) => unit.sourceSectionIds.length > 0));
  assert.deepEqual(analyzeCourseNarrative({
    phases: phaseAnalysis.phases,
    transitions: phaseAnalysis.transitions,
    routeSections: analysis.routeSections,
    keyMoments: selectStructuredRouteKeyMomentEvents(analysis.routeDynamics),
    extrema,
  }), narrative);
});
