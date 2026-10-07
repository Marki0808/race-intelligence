import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { analyzeGpxRoute, parseGpxText } from "./gpxAnalysis.ts";
import { buildCourseBriefInputV2, projectCourseBriefInputV2 } from "./courseBriefNarrativeFacts.ts";
import {
  buildCourseBriefCandidates,
  generateDeterministicCourseBriefV2,
  selectCourseBriefCandidates,
  validateCourseBriefCandidatePool,
  COURSE_BRIEF_MAX_OBSERVATIONS_V2,
} from "./courseBriefCandidates.ts";

function makeInput(specs, { anchors = [], extrema = [] } = {}) {
  const phases = [];
  const units = [];
  const phaseToUnit = new Map();
  const components = [];
  let routeKm = 0;
  const localKm = new Map();

  for (const [index, spec] of specs.entries()) {
    const segmentIndex = spec.segmentIndex ?? 0;
    const startKm = localKm.get(segmentIndex) ?? routeKm;
    const endKm = startKm + spec.distanceKm;
    localKm.set(segmentIndex, endKm);
    routeKm = Math.max(routeKm, endKm);
    let component = components.find((item) => item.segmentIndex === segmentIndex);
    if (!component) {
      component = { segmentIndex, startKm, endKm, traversedDistanceKm: spec.distanceKm };
      components.push(component);
    } else {
      component.endKm = endKm;
      component.traversedDistanceKm = endKm - component.startKm;
    }
    const phaseId = `phase-s${segmentIndex}-${index}`;
    phases.push({
      id: phaseId, ordinal: phases.length + 1, segmentIndex, startKm, endKm, distanceKm: spec.distanceKm,
      sourceSectionIds: [`section-s${segmentIndex}-${index}`], character: spec.character,
      ascentM: spec.ascentM ?? spec.intensity * spec.distanceKm / 2,
      descentM: spec.descentM ?? spec.intensity * spec.distanceKm / 2,
      verticalIntensityMPerKm: spec.intensity,
    });
    const groupId = spec.unitGroup ?? `unit-s${segmentIndex}-${index}`;
    let unit = units.find((item) => item.id === groupId);
    if (!unit) {
      unit = { id: groupId, ordinal: units.length + 1, segmentIndex, startKm, endKm, phaseIds: [], structuralPattern: spec.character };
      units.push(unit);
    }
    unit.endKm = endKm;
    unit.phaseIds.push(phaseId);
    if (unit.phaseIds.length > 1) unit.structuralPattern = "evolving";
    phaseToUnit.set(phaseId, groupId);
  }

  const transitions = [];
  for (let index = 1; index < phases.length; index += 1) {
    const before = phases[index - 1];
    const after = phases[index];
    if (before.segmentIndex !== after.segmentIndex || before.character === after.character) continue;
    const transitionId = `transition-s${before.segmentIndex}-${index}`;
    transitions.push({
      id: `narrative-${transitionId}`, sourceTransitionId: transitionId, segmentIndex: before.segmentIndex,
      fromPhaseId: before.id, toPhaseId: after.id, fromCharacter: before.character, toCharacter: after.character,
      boundaryKm: before.endKm, verticalIntensityBeforeMPerKm: before.verticalIntensityMPerKm,
      verticalIntensityAfterMPerKm: after.verticalIntensityMPerKm,
      fromUnitId: phaseToUnit.get(before.id), toUnitId: phaseToUnit.get(after.id),
      significance: "significant", reasonCodes: ["directional-reversal"],
    });
  }

  const events = anchors.map((anchor, index) => {
    const phase = phases[anchor.phaseIndex];
    const sourceEventId = anchor.id ?? `anchor-${index}`;
    return {
      id: `narrative-event-s${phase.segmentIndex}-${sourceEventId}`, sourceEventId, segmentIndex: phase.segmentIndex,
      kind: anchor.kind, startKm: phase.startKm + (anchor.startOffsetKm ?? 0.2), endKm: phase.startKm + (anchor.endOffsetKm ?? 1),
      ascentM: anchor.kind === "climb" ? anchor.elevationChangeM ?? 100 : 0,
      descentM: anchor.kind === "descent" ? anchor.elevationChangeM ?? 100 : 0,
      keyMomentRoles: anchor.roles, tier: "anchor", phaseIds: [phase.id], unitIds: [phaseToUnit.get(phase.id)],
      reasonCodes: ["key-moment-anchor"],
    };
  });

  const routeExtrema = extrema.map((extreme) => {
    const phase = phases[extreme.phaseIndex];
    return { kind: extreme.kind, segmentIndex: phase.segmentIndex, atKm: phase.startKm + 0.4, elevationM: extreme.elevationM,
      phaseId: phase.id, unitId: phaseToUnit.get(phase.id) };
  });
  const evolutionFacts = phases.filter((phase) => phase.character === "low-vertical" &&
    phase.endKm === components.find((item) => item.segmentIndex === phase.segmentIndex)?.endKm)
    .map((phase) => ({ id: `finish-${phase.id}`, type: "low-vertical-to-component-finish", segmentIndex: phase.segmentIndex,
      phaseIds: [phase.id], unitIds: [phaseToUnit.get(phase.id)], endKm: phase.endKm }));
  const narrative = { algorithmVersion: 1, units, transitions, events, routeExtrema, evolutionFacts };
  return projectCourseBriefInputV2(routeKm, components, phases, narrative);
}

const low = (distanceKm = 10, extra = {}) => ({ character: "low-vertical", intensity: 8, distanceKm, ascentM: 40, descentM: 40, ...extra });
const climb = (distanceKm = 10, extra = {}) => ({ character: "climb-dominant", intensity: 80, distanceKm, ascentM: 800, descentM: 30, ...extra });
const descent = (distanceKm = 10, extra = {}) => ({ character: "descent-dominant", intensity: 75, distanceKm, ascentM: 25, descentM: 725, ...extra });
const rolling = (distanceKm = 10, extra = {}) => ({ character: "repeated-vertical", intensity: 70, distanceKm, ascentM: 350, descentM: 350, ...extra });

function run(input) {
  const built = buildCourseBriefCandidates(input);
  assert.equal(built.ok, true, JSON.stringify(built));
  const selected = selectCourseBriefCandidates(built.input, built.candidates);
  assert.equal(selected.ok, true, JSON.stringify(selected));
  return { built, selected, generated: generateDeterministicCourseBriefV2(input) };
}

test("flat/simple low-vertical route creates one candidate and one deterministic observation", () => {
  const { built, selected, generated } = run(makeInput([low()]));
  assert.equal(built.candidates.length, 1);
  assert.equal(selected.selectedCandidates.length, 1);
  assert.equal(generated.ok, true);
  assert.equal(generated.output.observations.length, 1);
  assert.match(generated.output.observations[0].text, /low-vertical/);
});

test("sustained climb and its dual-role anchor render as one observation", () => {
  const input = makeInput([climb()], { anchors: [{ phaseIndex: 0, kind: "climb", roles: ["longest", "largest"], id: "climb-km" }] });
  const { built, generated } = run(input);
  assert.equal(built.candidates.length, 1);
  assert.equal(built.candidates[0].renderPatternId, "UNIT_WITH_ANCHOR");
  assert.equal(built.candidates[0].supportingFactIds.filter((id) => id.includes("anchor")).length, 1);
  assert.match(generated.output.observations[0].text, /longest and largest detected climb/);
});

test("climb to descent creates two chronological observations and attaches the incoming transition once", () => {
  const { built, generated } = run(makeInput([climb(), descent()]));
  assert.equal(built.candidates.length, 2);
  assert.equal(built.candidates.filter(({ renderPatternId }) => renderPatternId === "STANDALONE_TRANSITION").length, 0);
  const descentCandidate = built.candidates.find(({ renderPatternId }) => renderPatternId === "TRANSITION_TO_UNIT");
  assert.ok(descentCandidate);
  assert.equal(descentCandidate.supportingFactIds.filter((id) => id.includes("transition")).length, 1);
  assert.equal(generated.output.observations.length, 2);
  assert.ok(generated.output.observations[0].startKm < generated.output.observations[1].startKm);
});

test("repeated-vertical route remains one observation", () => {
  const { built, generated } = run(makeInput([rolling()]));
  assert.equal(built.candidates.length, 1);
  assert.equal(generated.output.observations.length, 1);
  assert.match(generated.output.observations[0].text, /repeated-vertical/);
});

test("climb, descent and repeated-vertical produce three observations", () => {
  const { built, generated } = run(makeInput([climb(), descent(), rolling()]));
  assert.equal(built.candidates.length, 3);
  assert.equal(generated.output.observations.length, 3);
  assert.deepEqual(generated.output.observations.map(({ componentIndex }) => componentIndex), [0, 0, 0]);
});

test("evolving finish combines its internal transition and persistent finish fact", () => {
  const input = makeInput([
    descent(6, { unitGroup: "late-evolving" }),
    low(4, { unitGroup: "late-evolving" }),
  ]);
  const { built, generated } = run(input);
  const candidate = built.candidates[0];
  assert.equal(candidate.renderPatternId, "EVOLVING_FINISH");
  assert.equal(candidate.supportingFactIds.filter((id) => id.includes("transition")).length, 1);
  assert.ok(candidate.supportingFactIds.some((id) => id.includes("finish")));
  assert.match(generated.output.observations[0].text, /changes to low-vertical/);
  assert.match(generated.output.observations[0].text, /component finish/);
});

test("broad intensity evolution does not suppress distinct descent and repeated-vertical stories", () => {
  const input = makeInput([
    climb(5, { intensity: 100, ascentM: 500, descentM: 0 }),
    descent(5, { intensity: 80, ascentM: 0, descentM: 400 }),
    rolling(5, { intensity: 60, ascentM: 150, descentM: 150 }),
    low(5, { intensity: 40, ascentM: 100, descentM: 100 }),
  ]);
  const { built, generated } = run(input);
  assert.ok(input.facts.some((fact) => fact.type === "VERTICAL_INTENSITY_EVOLUTION"));
  assert.ok(built.candidates.some((candidate) => input.facts.find((fact) => fact.factId === candidate.primaryFactId)?.type === "UNIT_CHARACTER" &&
    input.facts.find((fact) => fact.factId === candidate.primaryFactId)?.character === "descent-dominant"));
  assert.ok(built.candidates.some((candidate) => input.facts.find((fact) => fact.factId === candidate.primaryFactId)?.type === "UNIT_CHARACTER" &&
    input.facts.find((fact) => fact.factId === candidate.primaryFactId)?.character === "repeated-vertical"));
  assert.equal(generated.output.observations.length, 4);
});

test("multiple anchors in one unit attach at most one, preferring the dual-role Key Moment", () => {
  const input = makeInput([climb()], { anchors: [
    { phaseIndex: 0, kind: "climb", roles: ["longest"], id: "single-role", startOffsetKm: 0.1 },
    { phaseIndex: 0, kind: "climb", roles: ["longest", "largest"], id: "dual-role", startOffsetKm: 2, endOffsetKm: 3 },
  ], extrema: [{ phaseIndex: 0, kind: "highest", elevationM: 900 }] });
  const { built } = run(input);
  assert.equal(built.candidates.length, 1);
  assert.equal(built.candidates[0].supportingFactIds.filter((id) => id.includes("anchor")).length, 1);
  assert.ok(built.candidates[0].supportingFactIds.some((id) => id.includes("dual-role")));
});

test("incoming transition is not duplicated as a standalone story", () => {
  const { built } = run(makeInput([climb(), descent()]));
  const transitionFacts = built.input.facts.filter((fact) => fact.type === "STRUCTURAL_TRANSITION");
  for (const transition of transitionFacts) {
    const owners = built.candidates.filter((candidate) => candidate.supportingFactIds.includes(transition.factId) || candidate.primaryFactId === transition.factId);
    assert.equal(owners.length, 1);
  }
});

test("internal evolving-unit transition is not duplicated", () => {
  const { built } = run(makeInput([
    climb(5, { unitGroup: "evolving" }),
    low(5, { unitGroup: "evolving" }),
  ]));
  const transition = built.input.facts.find((fact) => fact.type === "STRUCTURAL_TRANSITION");
  assert.ok(transition);
  assert.equal(built.candidates.filter((candidate) => candidate.supportingFactIds.includes(transition.factId)).length, 1);
  assert.equal(built.candidates.some(({ renderPatternId }) => renderPatternId === "STANDALONE_TRANSITION"), false);
});

test("transition attaches to the preceding unit only when the destination has no candidate", () => {
  const input = makeInput([climb(), descent()]);
  const destinationUnitId = input.units[1].unitId;
  input.facts = input.facts.filter((fact) => !(fact.type === "UNIT_CHARACTER" && fact.unitId === destinationUnitId));
  input.facts.forEach((fact, index) => { fact.courseOrder = index + 1; });
  const { built, generated } = run(input);
  assert.equal(built.candidates.length, 1);
  assert.equal(built.candidates[0].renderPatternId, "STANDALONE_TRANSITION");
  assert.ok(built.candidates[0].supportingFactIds.some((id) => id.includes("transition")));
  assert.match(generated.output.observations[0].text, /changes at 10\.0 km to descent-dominant/);
});

test("unattached multi-phase evolution becomes a standalone evolution candidate", () => {
  const input = makeInput([
    climb(4, { intensity: 100, ascentM: 400, descentM: 0 }),
    descent(4, { intensity: 80, ascentM: 0, descentM: 320 }),
    rolling(4, { intensity: 60, ascentM: 120, descentM: 120 }),
  ]);
  input.facts = input.facts.filter((fact) => fact.type !== "UNIT_CHARACTER" && fact.type !== "STRUCTURAL_TRANSITION");
  input.facts.forEach((fact, index) => { fact.courseOrder = index + 1; });
  const { built, generated } = run(input);
  const candidate = built.candidates.find(({ renderPatternId }) => renderPatternId === "EVOLUTION");
  assert.ok(candidate);
  assert.ok(candidate.partialCoverageAtomIds.length >= 2);
  assert.match(generated.output.observations[0].text, /vertical intensity decreases/);
});

test("five material stories stay within the five-observation safety ceiling", () => {
  const { built, selected } = run(makeInput([climb(5), descent(5), rolling(5), low(5), climb(5)]));
  assert.ok(built.candidates.length >= 5);
  assert.equal(selected.selectedCandidates.length, 5);
  assert.equal(COURSE_BRIEF_MAX_OBSERVATIONS_V2, 5);
});

test("seven material stories select five and report omitted candidates", () => {
  const specs = [climb(2), descent(2), rolling(2), low(2), climb(2), descent(2), rolling(2)];
  const { built, selected, generated } = run(makeInput(specs));
  assert.ok(built.candidates.length >= 7);
  assert.equal(selected.selectedCandidates.length, 5);
  assert.equal(selected.omittedCandidateIds.length, built.candidates.length - 5);
  assert.equal(generated.output.diagnostics.omittedCount, built.candidates.length - 5);
  assert.equal(generated.output.diagnostics.componentCoverageComplete, true);
});

test("adjacent same-character units coalesce, suppressing low-value repeated observations", () => {
  const input = makeInput([low(4), low(6)]);
  const { built, generated } = run(input);
  assert.equal(built.input.units.length, 2);
  assert.equal(built.candidates.length, 1);
  assert.equal(generated.output.observations.length, 1);
  assert.equal(generated.output.observations[0].startKm, 0);
  assert.equal(generated.output.observations[0].endKm, 10);
});

test("disconnected components are separate stories with no synthetic transition", () => {
  const input = makeInput([
    climb(5, { segmentIndex: 0 }),
    descent(5, { segmentIndex: 1 }),
  ]);
  const { built, generated } = run(input);
  assert.equal(built.candidates.length, 2);
  assert.deepEqual(built.candidates.map(({ componentIndex }) => componentIndex), [0, 1]);
  assert.equal(built.input.facts.some((fact) => fact.type === "STRUCTURAL_TRANSITION"), false);
  assert.deepEqual(generated.output.observations.map(({ componentIndex }) => componentIndex), [0, 1]);
  assert.ok(generated.output.observations[1].text.startsWith("On track segment 2,"));
});

test("more than five useful components report incomplete component coverage", () => {
  const specs = Array.from({ length: 6 }, (_, index) => ({ ...climb(2), segmentIndex: index }));
  const { built, generated } = run(makeInput(specs));
  assert.equal(built.candidates.length, 6);
  assert.equal(generated.output.observations.length, 5);
  assert.equal(generated.output.diagnostics.componentCoverageComplete, false);
});

test("valid input with no selectable structural facts returns typed insufficient-facts", () => {
  const input = {
    schemaVersion: 2,
    versions: { routeAnalysis: 2, coursePhase: 1, courseNarrative: 1, narrativeFactSchema: 1 },
    route: { distanceKm: 1, components: [{ segmentIndex: 0, startKm: 0, endKm: 1, traversedDistanceKm: 1 }] },
    phases: [], units: [], facts: [],
  };
  assert.deepEqual(generateDeterministicCourseBriefV2(input), { ok: false, error: "insufficient_route_facts" });
});

test("candidate pool validation rejects malformed support relationships", () => {
  const input = makeInput([climb(), descent()]);
  const built = buildCourseBriefCandidates(input);
  assert.equal(built.ok, true);
  const malformed = structuredClone(built.candidates);
  malformed[1].supportingFactIds.push("not-a-real-fact");
  assert.deepEqual(validateCourseBriefCandidatePool(input, malformed), { ok: false, error: "invalid_candidate_pool" });
});

test("candidate ordering is canonical even if candidate objects arrive in reverse order", () => {
  const input = makeInput([climb(), descent(), rolling()]);
  const built = buildCourseBriefCandidates(input);
  const normal = selectCourseBriefCandidates(input, built.candidates);
  const reversed = selectCourseBriefCandidates(input, [...built.candidates].reverse());
  assert.deepEqual(normal, reversed);
});

test("renderer is repeatable and contains no forbidden runner-advice language", () => {
  const input = makeInput([climb(), descent(), rolling()]);
  const first = generateDeterministicCourseBriefV2(input);
  const second = generateDeterministicCourseBriefV2(input);
  assert.deepEqual(first, second);
  const text = first.output.observations.map(({ text: value }) => value).join(" ").toLowerCase();
  for (const forbidden of ["easier", "harder", "runnable", "technical", "mountainous", "recovery", "demanding", "controlled", "pace", "nutrition", "readiness"]) {
    assert.equal(text.includes(forbidden), false, `forbidden word: ${forbidden}`);
  }
});

test("every rendered observation traces only to source facts in the validated input", () => {
  const input = makeInput([climb(), descent()]);
  const result = generateDeterministicCourseBriefV2(input);
  const factIds = new Set(input.facts.map(({ factId }) => factId));
  for (const observation of result.output.observations) {
    assert.ok(observation.sourceFactIds.length > 0);
    assert.ok(observation.sourceFactIds.every((id) => factIds.has(id)));
    assert.ok(observation.startKm <= observation.endKm);
  }
});

test("checked-in Istria produces a reviewable deterministic V2 candidate pool and brief", async () => {
  const xml = await readFile(new URL("../public/ISTRIA_110K_2027.gpx", import.meta.url), "utf8");
  const input = buildCourseBriefInputV2(analyzeGpxRoute(parseGpxText(xml)));
  const result = run(input);
  assert.equal(input.route.distanceKm, 110.73);
  assert.equal(input.phases.length, 5);
  assert.equal(input.units.length, 4);
  assert.equal(input.facts.length, 25);
  assert.equal(input.facts.filter((fact) => fact.eligibility.selectable).length, 14);
  assert.equal(result.built.candidates.length, 4);
  assert.equal(result.selected.selectedCandidates.length, 4);
  assert.equal(result.generated.output.diagnostics.omittedCount, 0);
  assert.deepEqual(result.generated.output.observations.map(({ candidateId }) => candidateId),
    result.built.candidates.map(({ candidateId }) => candidateId));
  const evolvingText = result.generated.output.observations.at(-1).text;
  assert.match(evolvingText, /; then at 100\.6 km,/);
  assert.doesNotMatch(evolvingText, /; then At /);
});
