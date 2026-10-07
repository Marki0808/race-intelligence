import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { analyzeGpxRoute, parseGpxText } from "./gpxAnalysis.ts";
import {
  buildCourseBriefInputV2,
  buildCourseBriefNarrativeFactIndex,
  findDecreasingIntensitySequences,
  projectCourseBriefInputV2,
  validateCourseBriefInputV2,
  MINIMUM_EVOLUTION_REDUCTION_RATIO,
} from "./courseBriefNarrativeFacts.ts";

function synthetic(specs, { groups = [], events = [], extrema = [] } = {}) {
  const phases = [];
  const units = [];
  const components = [];
  const phaseToUnit = new Map();
  const distanceBySegment = new Map();
  let totalDistance = 0;
  for (const [index, spec] of specs.entries()) {
    const segmentIndex = spec.segmentIndex ?? 0;
    const startKm = distanceBySegment.get(segmentIndex) ?? totalDistance;
    const endKm = startKm + spec.distanceKm;
    distanceBySegment.set(segmentIndex, endKm);
    totalDistance = Math.max(totalDistance, endKm);
    let component = components.find((item) => item.segmentIndex === segmentIndex);
    if (!component) {
      component = { segmentIndex, startKm, endKm, traversedDistanceKm: endKm - startKm };
      components.push(component);
    } else {
      component.endKm = endKm;
      component.traversedDistanceKm = endKm - component.startKm;
    }
    const phaseId = `phase-${segmentIndex}-${index}`;
    const phase = {
      id: phaseId, ordinal: phases.length + 1, segmentIndex, startKm, endKm, distanceKm: spec.distanceKm,
      sourceSectionIds: [`section-${segmentIndex}-${index}`], character: spec.character,
      ascentM: spec.ascentM ?? spec.intensity * spec.distanceKm / 2,
      descentM: spec.descentM ?? spec.intensity * spec.distanceKm / 2,
      verticalIntensityMPerKm: spec.intensity,
    };
    phases.push(phase);
    const groupName = groups[index] ?? `unit-${segmentIndex}-${index}`;
    let unit = units.find((candidate) => candidate.id === groupName);
    if (!unit) {
      unit = { id: groupName, ordinal: units.length + 1, segmentIndex, startKm, endKm, phaseIds: [], structuralPattern: spec.pattern ?? spec.character,
        transitionIds: [], significantEventIds: [], supportingFactIds: [], reasonCodes: [] };
      units.push(unit);
    } else {
      unit.endKm = endKm;
      unit.phaseIds.push(phaseId);
      unit.structuralPattern = "evolving";
    }
    if (!unit.phaseIds.includes(phaseId)) unit.phaseIds.push(phaseId);
    phaseToUnit.set(phaseId, unit.id);
  }
  const transitions = [];
  for (let i = 1; i < phases.length; i += 1) {
    const before = phases[i - 1]; const after = phases[i];
    if (before.segmentIndex !== after.segmentIndex || before.character === after.character) continue;
    const id = `transition-${before.id}-${after.id}`;
    transitions.push({ id: `narrative-${id}`, sourceTransitionId: id, segmentIndex: before.segmentIndex,
      fromPhaseId: before.id, toPhaseId: after.id, fromCharacter: before.character, toCharacter: after.character,
      boundaryKm: before.endKm, verticalIntensityBeforeMPerKm: before.verticalIntensityMPerKm,
      verticalIntensityAfterMPerKm: after.verticalIntensityMPerKm, intensityDeltaMPerKm: after.verticalIntensityMPerKm - before.verticalIntensityMPerKm,
      significance: "significant", reasonCodes: ["directional-reversal"], fromUnitId: phaseToUnit.get(before.id),
      toUnitId: phaseToUnit.get(after.id), isInternalToUnit: phaseToUnit.get(before.id) === phaseToUnit.get(after.id) });
  }
  const narrativeEvents = events.map((event, index) => {
    const phase = phases[event.phaseIndex];
    const unitId = phaseToUnit.get(phase.id);
    const startKm = phase.startKm + (event.offsetStartKm ?? 0.1);
    const endKm = phase.startKm + (event.offsetEndKm ?? 0.2);
    const sourceEventId = event.id ?? `event-${index}`;
    return { id: `narrative-event-s${phase.segmentIndex}-${sourceEventId}`, sourceEventId, segmentIndex: phase.segmentIndex,
      kind: event.kind, startKm, endKm, ascentM: event.ascentM ?? 0, descentM: event.descentM ?? 0,
      keyMomentRoles: event.roles ?? [], tier: event.roles?.length ? "anchor" : event.tier ?? "supporting-interruption",
      phaseIds: [phase.id], unitIds: [unitId], reasonCodes: event.roles?.length ? ["key-moment-anchor"] :
        [event.tier === "context-only" ? "event-below-relative-materiality" : "supporting-interruption"] };
  });
  const routeExtrema = extrema.map((item) => {
    const phase = phases[item.phaseIndex];
    return { kind: item.kind, segmentIndex: phase.segmentIndex, atKm: phase.startKm + 0.3, elevationM: item.elevationM,
      phaseId: phase.id, unitId: phaseToUnit.get(phase.id) };
  });
  const evolutionFacts = phases.filter((phase) => phase.character === "low-vertical" &&
    phase.endKm === components.find((component) => component.segmentIndex === phase.segmentIndex)?.endKm)
    .map((phase) => ({ id: `finish-${phase.id}`, type: "low-vertical-to-component-finish", segmentIndex: phase.segmentIndex,
      phaseIds: [phase.id], unitIds: [phaseToUnit.get(phase.id)], endKm: phase.endKm }));
  return { phases, units, transitions, routeExtrema, evolutionFacts, components, totalDistance,
    model: { algorithmVersion: 1, units, transitions, events: narrativeEvents, routeExtrema, evolutionFacts } };
}

function brief(specs, options) {
  const source = synthetic(specs, options);
  return projectCourseBriefInputV2(source.totalDistance, source.components, source.phases, source.model);
}

const simpleSpecs = [{ character: "low-vertical", intensity: 8, distanceKm: 10, ascentM: 40, descentM: 40 }];

test("low-vertical component produces a compact V2 structural input", () => {
  const input = brief(simpleSpecs);
  assert.equal(input.schemaVersion, 2);
  assert.deepEqual(input.units.map((unit) => unit.character), ["low-vertical"]);
  assert.ok(input.facts.some((fact) => fact.type === "UNIT_CHARACTER" && fact.eligibility.selectable));
  assert.ok(!("sections" in input) && !("coordinates" in input.route));
});

test("climb unit and canonical climb anchor share a redundancy group", () => {
  const input = brief([{ character: "climb-dominant", intensity: 80, distanceKm: 10, ascentM: 800 }], {
    events: [{ phaseIndex: 0, kind: "climb", roles: ["longest", "largest"], ascentM: 800, id: "climb-anchor" }],
  });
  const unit = input.facts.find((fact) => fact.type === "UNIT_CHARACTER");
  const anchor = input.facts.find((fact) => fact.type === "ANCHOR_WITHIN_UNIT");
  assert.ok(unit && anchor);
  assert.equal(anchor.roles.length, 2);
  assert.equal(anchor.narrativeGroupId, unit.narrativeGroupId);
  assert.equal(anchor.groupRole, "supporting");
});

test("climb-to-descent transition is represented as a direct structural fact", () => {
  const input = brief([
    { character: "climb-dominant", intensity: 80, distanceKm: 10, ascentM: 800 },
    { character: "descent-dominant", intensity: 70, distanceKm: 10, descentM: 700 },
  ]);
  const transition = input.facts.find((fact) => fact.type === "STRUCTURAL_TRANSITION");
  assert.equal(transition.fromCharacter, "climb-dominant");
  assert.equal(transition.toCharacter, "descent-dominant");
  assert.equal(transition.startKm, 10);
  assert.equal(transition.eligibility.selectable, true);
});

test("repeated-vertical unit stays a closed unit-character fact", () => {
  const input = brief([{ character: "repeated-vertical", intensity: 70, distanceKm: 20, ascentM: 700, descentM: 700 }]);
  assert.equal(input.facts.find((fact) => fact.type === "UNIT_CHARACTER").character, "repeated-vertical");
});

function phase(id, index, intensity, segmentIndex = 0) {
  const startKm = index * 10;
  return { id, ordinal: index + 1, segmentIndex, startKm, endKm: startKm + 10, distanceKm: 10,
    character: "mixed", verticalIntensityMPerKm: intensity, ascentM: intensity * 5, descentM: intensity * 5 };
}

test("evolution requires three consecutive phases and a 25 percent reduction", () => {
  const result = findDecreasingIntensitySequences([phase("p0", 0, 100), phase("p1", 1, 80), phase("p2", 2, 75)]);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].map((item) => item.verticalIntensityMPerKm), [100, 80, 75]);
  assert.equal((100 - 75) / 100, MINIMUM_EVOLUTION_REDUCTION_RATIO);
});

test("evolution threshold boundary: below fails, exact and above pass", () => {
  assert.equal(findDecreasingIntensitySequences([phase("b0", 0, 100), phase("b1", 1, 80), phase("b2", 2, 75.01)]).length, 0);
  assert.equal(findDecreasingIntensitySequences([phase("e0", 0, 100), phase("e1", 1, 80), phase("e2", 2, 75)]).length, 1);
  assert.equal(findDecreasingIntensitySequences([phase("a0", 0, 100), phase("a1", 1, 80), phase("a2", 2, 74)]).length, 1);
});

test("near-flat values and only one decrease do not create evolution", () => {
  assert.equal(findDecreasingIntensitySequences([phase("n0", 0, 100), phase("n1", 1, 99.99), phase("n2", 2, 99.98)]).length, 0);
  assert.equal(findDecreasingIntensitySequences([phase("q0", 0, 0.3), phase("q1", 1, 0.25), phase("q2", 2, 0.2)]).length, 0);
  assert.equal(findDecreasingIntensitySequences([phase("n3", 0, 100), phase("n4", 1, 80)]).length, 0);
});

test("intensity evolution never crosses disconnected components", () => {
  assert.equal(findDecreasingIntensitySequences([
    phase("c0a", 0, 100, 0), phase("c0b", 1, 80, 0), phase("c1a", 0, 70, 1), phase("c1b", 1, 60, 1),
  ]).length, 0);
});

test("low-vertical finish character is explicit and component-scoped", () => {
  const input = brief([{ character: "low-vertical", intensity: 8, distanceKm: 10, ascentM: 40, descentM: 40 }]);
  const finish = input.facts.find((fact) => fact.type === "PERSISTENT_FINISH_CHARACTER");
  assert.equal(finish.character, "low-vertical");
  assert.equal(finish.componentEndKm, 10);
  const notAtFinish = brief([
    { character: "low-vertical", intensity: 8, distanceKm: 5, ascentM: 20, descentM: 20 },
    { character: "climb-dominant", intensity: 50, distanceKm: 5, ascentM: 250 },
  ]);
  assert.equal(notAtFinish.facts.some((fact) => fact.type === "PERSISTENT_FINISH_CHARACTER"), false);
});

test("longest and largest roles on one event produce one anchor fact", () => {
  const input = brief([{ character: "climb-dominant", intensity: 80, distanceKm: 10, ascentM: 800 }], {
    events: [{ phaseIndex: 0, kind: "climb", roles: ["longest", "largest"], ascentM: 800, id: "dual-anchor" }],
  });
  assert.equal(input.facts.filter((fact) => fact.type === "ANCHOR_WITHIN_UNIT" && fact.sourceId === "dual-anchor").length, 1);
});

test("highest and lowest extrema are assigned to their containing units", () => {
  const input = brief([
    { character: "climb-dominant", intensity: 80, distanceKm: 10, ascentM: 800 },
    { character: "descent-dominant", intensity: 70, distanceKm: 10, descentM: 700 },
  ], { extrema: [{ phaseIndex: 0, kind: "highest", elevationM: 900 }, { phaseIndex: 1, kind: "lowest", elevationM: 100 }] });
  const anchors = input.facts.filter((fact) => fact.type === "ANCHOR_WITHIN_UNIT");
  assert.deepEqual(anchors.map(({ anchorKind, segmentIndex }) => [anchorKind, segmentIndex]), [["highest", 0], ["lowest", 0]]);
  assert.notEqual(anchors[0].unitId, anchors[1].unitId);
});

test("Narrative supporting interruptions are retained but fail Brief eligibility", () => {
  const input = brief([{ character: "low-vertical", intensity: 8, distanceKm: 10, ascentM: 40, descentM: 40 }], {
    events: [{ phaseIndex: 0, kind: "descent", tier: "supporting-interruption", descentM: 18, id: "small-descent" }],
  });
  const interruption = input.facts.find((fact) => fact.type === "SIGNIFICANT_INTERRUPTION");
  assert.equal(interruption.eligibility.selectable, false);
  assert.equal(interruption.eligibility.reasonCode, "brief-interruption-policy-conservative");
});

test("tiny events in low-work phases do not become Brief-eligible", () => {
  const input = brief([{ character: "low-vertical", intensity: 8, distanceKm: 10, ascentM: 40, descentM: 40 }], {
    events: [{ phaseIndex: 0, kind: "climb", tier: "context-only", ascentM: 5, id: "tiny-climb" }],
  });
  const interruption = input.facts.find((fact) => fact.type === "SIGNIFICANT_INTERRUPTION");
  assert.equal(interruption.eligibility.selectable, false);
});

test("component boundary prevents cross-component transition and ordering leakage", () => {
  const source = synthetic([
    { character: "climb-dominant", intensity: 80, distanceKm: 10, ascentM: 800, segmentIndex: 0 },
    { character: "descent-dominant", intensity: 70, distanceKm: 10, descentM: 700, segmentIndex: 1 },
  ]);
  const input = projectCourseBriefInputV2(source.totalDistance, source.components, source.phases, source.model);
  assert.equal(input.facts.some((fact) => fact.type === "STRUCTURAL_TRANSITION"), false);
  assert.deepEqual(input.route.components.map(({ segmentIndex }) => segmentIndex), [0, 1]);
});

test("semantic validation rejects an anchor outside its narrative unit", () => {
  const input = brief([{ character: "climb-dominant", intensity: 80, distanceKm: 10, ascentM: 800 }], {
    events: [{ phaseIndex: 0, kind: "climb", roles: ["largest"], ascentM: 800, id: "anchor-range" }],
  });
  const broken = structuredClone(input);
  broken.facts.find((fact) => fact.type === "ANCHOR_WITHIN_UNIT").endKm = 15;
  assert.deepEqual(validateCourseBriefInputV2(broken), { ok: false, error: "inconsistent_input" });
});

test("strict validation rejects unknown fact types and unsupported unit characters", () => {
  const input = brief(simpleSpecs);
  const unknownType = structuredClone(input);
  unknownType.facts[0].type = "MAIN_CLIMBING_OVER";
  assert.equal(validateCourseBriefInputV2(unknownType).ok, false);
  const unsupportedCharacter = structuredClone(input);
  unsupportedCharacter.units[0].character = "runnable";
  assert.equal(validateCourseBriefInputV2(unsupportedCharacter).ok, false);
});

test("strict validation rejects duplicate fact IDs and stale evolution order", () => {
  const withAnchor = brief([
    { character: "climb-dominant", intensity: 100, distanceKm: 10, ascentM: 1000 },
    { character: "descent-dominant", intensity: 80, distanceKm: 10, descentM: 800 },
    { character: "low-vertical", intensity: 70, distanceKm: 10, ascentM: 350, descentM: 350 },
  ], { events: [{ phaseIndex: 0, kind: "climb", roles: ["largest"], ascentM: 1000, id: "validation-anchor" }] });
  const duplicate = structuredClone(withAnchor);
  duplicate.facts[1].factId = duplicate.facts[0].factId;
  assert.deepEqual(validateCourseBriefInputV2(duplicate), { ok: false, error: "duplicate_fact_id" });
  const reordered = structuredClone(withAnchor);
  const evolution = reordered.facts.find((fact) => fact.type === "VERTICAL_INTENSITY_EVOLUTION");
  [evolution.phaseIds[0], evolution.phaseIds[1]] = [evolution.phaseIds[1], evolution.phaseIds[0]];
  assert.equal(validateCourseBriefInputV2(reordered).ok, false);
  const staleId = structuredClone(withAnchor);
  staleId.facts.find((fact) => fact.type === "ANCHOR_WITHIN_UNIT").factId = "stale-anchor-id";
  assert.deepEqual(validateCourseBriefInputV2(staleId), { ok: false, error: "inconsistent_input" });
});

test("highest and lowest anchors retain the correct disconnected component identity", () => {
  const input = brief([
    { segmentIndex: 0, character: "climb-dominant", intensity: 80, distanceKm: 10, ascentM: 800 },
    { segmentIndex: 1, character: "descent-dominant", intensity: 70, distanceKm: 10, descentM: 700 },
  ], { extrema: [{ phaseIndex: 0, kind: "highest", elevationM: 900 }, { phaseIndex: 1, kind: "lowest", elevationM: 100 }] });
  const extremes = input.facts.filter((fact) => fact.type === "ANCHOR_WITHIN_UNIT" && fact.anchorKind !== "key-moment");
  assert.deepEqual(extremes.map(({ anchorKind, segmentIndex }) => [anchorKind, segmentIndex]), [["highest", 0], ["lowest", 1]]);
});

test("no vertical-concentration or other prohibited interpretation fact exists in V2", () => {
  const input = brief([
    { character: "climb-dominant", intensity: 90, distanceKm: 10, ascentM: 900 },
    { character: "descent-dominant", intensity: 80, distanceKm: 10, descentM: 800 },
    { character: "low-vertical", intensity: 60, distanceKm: 10, ascentM: 300, descentM: 300 },
  ]);
  assert.ok(input.facts.every((fact) => !["VERTICAL_WORK_CONCENTRATION", "EASIER_LATER", "RUNNABLE", "TECHNICAL", "RECOVERY"].includes(fact.type)));
});

test("fact ordering is deterministic and same-unit facts expose redundancy grouping", () => {
  const source = synthetic([
    { character: "climb-dominant", intensity: 80, distanceKm: 10, ascentM: 800 },
    { character: "low-vertical", intensity: 10, distanceKm: 10, ascentM: 50, descentM: 50 },
  ], { groups: ["unit-opening", "unit-opening"], events: [{ phaseIndex: 0, kind: "climb", roles: ["largest"], ascentM: 800, id: "same-unit-anchor" }] });
  const first = projectCourseBriefInputV2(source.totalDistance, source.components, source.phases, source.model);
  const reversed = { ...source.model, units: [...source.model.units].reverse(), transitions: [...source.model.transitions].reverse(), events: [...source.model.events].reverse() };
  const second = projectCourseBriefInputV2(source.totalDistance, source.components, source.phases, reversed);
  assert.deepEqual(first.facts, second.facts);
  const sameUnitFacts = first.facts.filter((fact) => fact.narrativeGroupId === "narrative-group.unit-opening");
  assert.ok(sameUnitFacts.length >= 2);
  assert.equal(sameUnitFacts.find((fact) => fact.type === "UNIT_CHARACTER").groupRole, "primary");
});

test("simple and complex courses scale facts without a fixed count", () => {
  const simple = brief(simpleSpecs);
  const complex = brief([
    { character: "climb-dominant", intensity: 90, distanceKm: 10, ascentM: 900 },
    { character: "descent-dominant", intensity: 80, distanceKm: 10, descentM: 800 },
    { character: "repeated-vertical", intensity: 70, distanceKm: 10, ascentM: 350, descentM: 350 },
    { character: "low-vertical", intensity: 10, distanceKm: 10, ascentM: 50, descentM: 50 },
  ], { events: [
    { phaseIndex: 0, kind: "climb", roles: ["largest"], ascentM: 900, id: "complex-climb" },
    { phaseIndex: 1, kind: "descent", roles: ["largest"], descentM: 800, id: "complex-descent" },
  ], extrema: [{ phaseIndex: 0, kind: "highest", elevationM: 1000 }, { phaseIndex: 3, kind: "lowest", elevationM: 20 }] });
  assert.ok(complex.facts.length > simple.facts.length);
  assert.equal(buildCourseBriefNarrativeFactIndex(complex).eligibleFacts.length, complex.facts.filter((fact) => fact.eligibility.selectable).length);
});

test("invalid cross-component transition is rejected instead of becoming a fact", () => {
  const source = synthetic([
    { character: "climb-dominant", intensity: 80, distanceKm: 10, ascentM: 800, segmentIndex: 0 },
    { character: "descent-dominant", intensity: 70, distanceKm: 10, descentM: 700, segmentIndex: 1 },
  ]);
  source.model.transitions.push({ id: "bad-cross", sourceTransitionId: "bad-cross", segmentIndex: 0,
    fromPhaseId: source.phases[0].id, toPhaseId: source.phases[1].id, fromCharacter: "climb-dominant", toCharacter: "descent-dominant",
    boundaryKm: 10, verticalIntensityBeforeMPerKm: 80, verticalIntensityAfterMPerKm: 70, intensityDeltaMPerKm: -10,
    significance: "significant", reasonCodes: ["directional-reversal"], fromUnitId: source.units[0].id, toUnitId: source.units[1].id, isInternalToUnit: false });
  assert.throws(() => projectCourseBriefInputV2(source.totalDistance, source.components, source.phases, source.model), /failed validation/);
});

test("real Istria route projects to generic facts without equal-thirds authority or stronger claims", async () => {
  const gpx = await readFile(new URL("../public/ISTRIA_110K_2027.gpx", import.meta.url), "utf8");
  const analysis = analyzeGpxRoute(parseGpxText(gpx));
  const input = buildCourseBriefInputV2(analysis, 2);
  const facts = buildCourseBriefNarrativeFactIndex(input).eligibleFacts;
  assert.equal(input.schemaVersion, 2);
  assert.equal(input.units.length, 4);
  assert.ok(facts.some((fact) => fact.type === "UNIT_CHARACTER" && fact.character === "climb-dominant" && fact.startKm === 0));
  assert.ok(facts.some((fact) => fact.type === "VERTICAL_INTENSITY_EVOLUTION" && fact.direction === "decreasing"));
  assert.ok(facts.some((fact) => fact.type === "PERSISTENT_FINISH_CHARACTER" && fact.character === "low-vertical"));
  assert.ok(facts.some((fact) => fact.type === "ANCHOR_WITHIN_UNIT" && fact.anchorKind === "highest"));
  assert.ok(facts.some((fact) => fact.type === "ANCHOR_WITHIN_UNIT" && fact.anchorKind === "key-moment" && fact.roles.includes("longest") && fact.roles.includes("largest")));
  assert.equal(facts.some((fact) => fact.type === "SIGNIFICANT_INTERRUPTION" && fact.eligibility.selectable), false);
  assert.ok(input.facts.some((fact) => fact.type === "SIGNIFICANT_INTERRUPTION" && fact.descentM === 18 && !fact.eligibility.selectable));
  assert.equal("verticalProgression" in input, false);
  assert.equal(JSON.stringify(input).includes("most climbing"), false);
  assert.equal(JSON.stringify(input).includes("geographic"), false);
  assert.deepEqual(validateCourseBriefInputV2(input).ok, true);
});
