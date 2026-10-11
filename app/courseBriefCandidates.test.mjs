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
  const generated = generateDeterministicCourseBriefV2(input);
  assert.equal(generated.ok, true, JSON.stringify(generated));
  assert.deepEqual(generated.output.observations.map(({ candidateId }) => candidateId),
    selected.selectedCandidates.map(({ candidateId }) => candidateId));
  generated.output.observations.forEach((observation, index) => {
    const candidate = selected.selectedCandidates[index];
    assert.deepEqual(observation.sourceFactIds, [candidate.primaryFactId, ...candidate.supportingFactIds]);
  });
  return { built, selected, generated };
}

function profileRuns(runs, { pointsPerRun = 81, longitude = 0, climbSlopeByRun = {} } = {}) {
  const points = [];
  let elevation = 100;
  let pointLongitude = longitude;
  for (const [runIndex, run] of runs.entries()) {
    const stageStart = elevation;
    for (let index = 0; index < pointsPerRun; index += 1) {
      const climbStep = climbSlopeByRun[runIndex] ?? 5;
      const offset = run === "climb" ? index * climbStep : run === "descent" ? -index * 5 :
        run === "rolling" ? (Math.floor(index / 8) % 2 === 0 ? index % 8 * 2 : 16 - index % 8 * 2) : 0;
      elevation = stageStart + offset;
      points.push({ latitude: 0, longitude: pointLongitude, elevationM: elevation });
      pointLongitude += 0.0009;
    }
  }
  return points;
}

function analyzeProfile(segments, name) {
  const routeAnalysis = analyzeGpxRoute({ segments, name });
  const input = buildCourseBriefInputV2(routeAnalysis);
  const built = buildCourseBriefCandidates(input);
  assert.equal(built.ok, true, JSON.stringify(built));
  const selected = selectCourseBriefCandidates(input, built.candidates);
  assert.equal(selected.ok, true, JSON.stringify(selected));
  const generated = generateDeterministicCourseBriefV2(input);
  assert.equal(generated.ok, true, JSON.stringify(generated));
  assert.deepEqual(generated.output.observations.map(({ candidateId }) => candidateId),
    selected.selectedCandidates.map(({ candidateId }) => candidateId));
  generated.output.observations.forEach((observation, index) => {
    const candidate = selected.selectedCandidates[index];
    assert.deepEqual(observation.sourceFactIds, [candidate.primaryFactId, ...candidate.supportingFactIds]);
  });
  return { routeAnalysis, input, built, selected, output: generated.output };
}

test("flat/simple low-vertical route creates one candidate and one deterministic observation", () => {
  const { built, selected, generated } = run(makeInput([low()]));
  assert.equal(built.candidates.length, 1);
  assert.equal(selected.selectedCandidates.length, 1);
  assert.equal(generated.ok, true);
  assert.equal(generated.output.observations.length, 1);
  assert.match(generated.output.observations[0].text, /little climbing and descending per kilometre/);
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
  assert.match(generated.output.observations[0].text, /repeated climbs and descents/);
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
  assert.match(generated.output.observations[0].text, /gives way to a final section with relatively little climbing and descending per kilometre/);
  assert.match(generated.output.observations[0].text, /finish/);
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

test("highest and lowest elevation anchors retain their measurements and route positions", () => {
  const input = makeInput([
    climb(10, { segmentIndex: 0 }),
    low(10, { segmentIndex: 1 }),
  ], { extrema: [
    { phaseIndex: 0, kind: "highest", elevationM: 900 },
    { phaseIndex: 1, kind: "lowest", elevationM: 80 },
  ] });
  const { generated } = run(input);
  const text = generated.output.observations.map(({ text: value }) => value).join(" ");
  assert.match(text, /highest point at 900 m near 0\.4 km/);
  assert.match(text, /lowest point at 80 m near 10\.4 km/);
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
  assert.match(generated.output.observations[0].text, /Around 10\.0 km, the profile shifts from climbing to descending/);
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
  assert.equal(generated.output.observations[0].text,
    "Across successive phases, combined climbing and descending per kilometre decreases.");
  assert.doesNotMatch(generated.output.observations[0].text, /100, 80, then 60 m\/km/);
});

test("five material stories retain their distinct chronological passages", () => {
  const { built, selected } = run(makeInput([climb(5), descent(5), rolling(5), low(5), climb(5)]));
  assert.ok(built.candidates.length >= 5);
  assert.equal(selected.selectedCandidates.length, built.candidates.length);
  assert.equal(selected.omittedCandidateIds.length, 0);
});

test("complex structural overflow retains all nonredundant stories instead of truncating at five", () => {
  const specs = [climb(2), descent(2), rolling(2), low(2), climb(2), descent(2), rolling(2)];
  const input = makeInput(specs);
  const { built, selected, generated } = run(input);
  assert.deepEqual(input.phases.map(({ character }) => character), specs.map(({ character }) => character));
  assert.deepEqual(input.units.map(({ character }) => character), specs.map(({ character }) => character));
  assert.ok(built.candidates.length >= 7);
  assert.equal(selected.selectedCandidates.length, built.candidates.length);
  assert.deepEqual(selected.selectedCandidates.map(({ candidateId }) => candidateId), built.candidates.map(({ candidateId }) => candidateId));
  assert.equal(selected.omittedCandidateIds.length, 0);
  assert.equal(generated.output.observations.length, built.candidates.length);
  assert.equal(generated.output.diagnostics.omittedCount, 0);
  assert.ok(generated.output.diagnostics.selectionReasons.every(({ codes }) => codes.includes("safe_structural_overflow")));
  assert.equal(generated.output.diagnostics.componentCoverageComplete, true);
});

test("repeated alternating climb/descent units form one traceable rhythm passage", () => {
  const input = makeInput([climb(3), descent(3), climb(3), descent(3), climb(3)]);
  const { built, selected, generated } = run(input);
  assert.equal(input.phases.length, 5);
  assert.equal(input.units.length, 5);
  assert.equal(built.candidates.length, 1);
  assert.equal(built.candidates[0].renderPatternId, "RHYTHM_SEQUENCE");
  assert.equal(selected.selectedCandidates.length, 1);
  assert.match(generated.output.observations[0].text, /Climbing and descending alternate/);
  assert.equal(generated.output.observations[0].sourceFactIds.filter((id) => id.includes("narrative-fact.unit.")).length, 5);
  assert.equal(generated.output.observations[0].sourceFactIds.filter((id) => id.includes("narrative-fact.transition.")).length, 4);
});

function alternatingWorkSpecs(kinds, overrides = {}) {
  return kinds.map((kind, index) => {
    const isClimb = kind === "climb";
    const base = isClimb
      ? { character: "climb-dominant", intensity: 100, distanceKm: 2, ascentM: 180, descentM: 20 }
      : { character: "descent-dominant", intensity: 100, distanceKm: 2, ascentM: 20, descentM: 180 };
    return { ...base, ...overrides[index] };
  });
}

function assertVisibleRhythmTrace(result, expectedUnitCount, expectedTransitionCount) {
  const { built, selected, generated } = result;
  assert.equal(selected.selectedCandidates.length, generated.output.observations.length);
  assert.deepEqual(generated.output.observations.map(({ startKm }) => startKm),
    [...generated.output.observations].map(({ startKm }) => startKm).sort((a, b) => a - b));
  assert.deepEqual(generated.output.observations.map(({ componentIndex }) => componentIndex),
    Array.from({ length: generated.output.observations.length }, () => 0));
  assert.deepEqual(selected.selectedCandidates.map(({ candidateId }) => candidateId),
    built.candidates.map(({ candidateId }) => candidateId));
  const sourceIds = generated.output.observations.flatMap(({ sourceFactIds }) => sourceFactIds);
  assert.equal(sourceIds.filter((id) => id.includes("narrative-fact.unit.")).length, expectedUnitCount);
  assert.equal(sourceIds.filter((id) => id.includes("narrative-fact.transition.")).length, expectedTransitionCount);
  assert.equal(new Set(sourceIds).size, sourceIds.length);
  assert.equal(built.candidates.length, selected.selectedCandidates.length);
  return generated.output.observations;
}

test("comparable short alternating units stay one visible rolling passage", () => {
  const result = run(makeInput(alternatingWorkSpecs(["climb", "descent", "climb", "descent", "climb"])));
  const observations = assertVisibleRhythmTrace(result, 5, 4);
  assert.equal(result.built.candidates.length, 1);
  assert.equal(result.built.candidates[0].renderPatternId, "RHYTHM_SEQUENCE");
  assert.equal(observations.length, 1);
  assert.match(observations[0].text, /Climbing and descending alternate/);
});

test("dominant long climb inside alternation remains a distinct rendered passage", () => {
  const specs = alternatingWorkSpecs(["climb", "descent", "climb", "descent", "climb"], {
    2: { distanceKm: 16, ascentM: 1600, descentM: 30, intensity: 101.9 },
  });
  const result = run(makeInput(specs));
  const observations = assertVisibleRhythmTrace(result, 5, 4);
  assert.equal(result.built.candidates.length, 5);
  assert.ok(result.built.candidates.every(({ renderPatternId }) => renderPatternId !== "RHYTHM_SEQUENCE"));
  const defining = observations.find(({ startKm, endKm }) => startKm === 4 && endKm === 20);
  assert.ok(defining);
  assert.match(defining.text, /Around 4\.0 km, the profile shifts from descending to climbing through about 20\.0 km/);
  assert.deepEqual(observations.map(({ startKm }) => startKm), [0, 2, 4, 20, 22]);
});

test("dominant sustained descent inside alternation remains a distinct rendered passage", () => {
  const specs = alternatingWorkSpecs(["climb", "descent", "climb", "descent", "climb"], {
    3: { distanceKm: 16, ascentM: 30, descentM: 1600, intensity: 101.9 },
  });
  const result = run(makeInput(specs));
  const observations = assertVisibleRhythmTrace(result, 5, 4);
  assert.equal(result.built.candidates.length, 3);
  assert.deepEqual(result.built.candidates.map(({ renderPatternId }) => renderPatternId), [
    "RHYTHM_SEQUENCE", "TRANSITION_TO_UNIT", "TRANSITION_TO_UNIT",
  ]);
  const defining = observations.find(({ startKm, endKm }) => startKm === 6 && endKm === 22);
  assert.ok(defining);
  assert.match(defining.text, /Around 6\.0 km, the profile shifts from climbing to descending through about 22\.0 km/);
  assert.deepEqual(observations.map(({ startKm }) => startKm), [0, 6, 22]);
});

test("dominant vertical contribution is protected without being the longest unit", () => {
  const specs = alternatingWorkSpecs(["climb", "descent", "climb", "descent", "climb"], {
    2: { ascentM: 600, descentM: 20, intensity: 310 },
  });
  const result = run(makeInput(specs));
  const observations = assertVisibleRhythmTrace(result, 5, 4);
  assert.equal(specs[2].distanceKm, 2);
  assert.equal(Math.max(...specs.map(({ distanceKm }) => distanceKm)), 2);
  assert.equal(result.built.candidates.length, 5);
  const defining = observations.find(({ startKm, endKm }) => startKm === 4 && endKm === 6);
  assert.ok(defining);
  assert.match(defining.text, /Around 4\.0 km, the profile shifts from descending to climbing through about 6\.0 km/);
});

test("multiple defining alternating members remain separate and in course order", () => {
  const specs = alternatingWorkSpecs(["climb", "descent", "climb", "descent", "climb", "descent", "climb"], {
    1: { descentM: 700, intensity: 360 },
    4: { ascentM: 700, intensity: 360 },
  });
  const result = run(makeInput(specs));
  const observations = assertVisibleRhythmTrace(result, 7, 6);
  assert.equal(result.built.candidates.length, 7);
  assert.deepEqual(observations.map(({ startKm }) => startKm), [0, 2, 4, 6, 8, 10, 12]);
  assert.match(observations[1].text, /profile shifts from climbing to descending through about 4\.0 km/);
  assert.match(observations[4].text, /profile shifts from descending to climbing through about 10\.0 km/);
});

test("rhythm dominance uses strict twice-neighbor-mean boundaries for distance and vertical work", () => {
  const exactDistance = alternatingWorkSpecs(["climb", "descent", "climb", "descent", "climb"], {
    2: { distanceKm: 4 },
  });
  const exactDistanceResult = run(makeInput(exactDistance));
  assert.equal(exactDistanceResult.built.candidates.length, 1);
  assert.equal(exactDistanceResult.built.candidates[0].renderPatternId, "RHYTHM_SEQUENCE");
  assert.match(exactDistanceResult.generated.output.observations[0].text, /Climbing and descending alternate/);
  assert.equal(exactDistanceResult.generated.output.observations[0].sourceFactIds.filter((id) => id.includes("narrative-fact.unit.")).length, 5);

  const aboveDistance = alternatingWorkSpecs(["climb", "descent", "climb", "descent", "climb"], {
    2: { distanceKm: 4.01 },
  });
  const aboveDistanceResult = run(makeInput(aboveDistance));
  assert.equal(aboveDistanceResult.built.candidates.length, 5);
  assert.ok(aboveDistanceResult.built.candidates.every(({ renderPatternId }) => renderPatternId !== "RHYTHM_SEQUENCE"));
  assert.match(aboveDistanceResult.generated.output.observations.find(({ startKm, endKm }) => startKm === 4 && endKm > 8).text,
    /shifts from descending to climbing/);

  const exactWork = alternatingWorkSpecs(["climb", "descent", "climb", "descent", "climb"], {
    2: { ascentM: 360, intensity: 190 },
  });
  const exactWorkResult = run(makeInput(exactWork));
  assert.equal(exactWorkResult.built.candidates.length, 1);
  assert.match(exactWorkResult.generated.output.observations[0].text, /Climbing and descending alternate/);

  const aboveWork = alternatingWorkSpecs(["climb", "descent", "climb", "descent", "climb"], {
    2: { ascentM: 361, intensity: 190.5 },
  });
  const aboveWorkResult = run(makeInput(aboveWork));
  assert.equal(aboveWorkResult.built.candidates.length, 5);
  const defining = aboveWorkResult.generated.output.observations.find(({ startKm, endKm }) => startKm === 4 && endKm === 6);
  assert.ok(defining);
  assert.match(defining.text, /shifts from descending to climbing/);
});

test("a selected longest/largest event protects its host phase from rhythm grouping", () => {
  const input = makeInput(alternatingWorkSpecs(["climb", "descent", "climb", "descent", "climb"]), {
    anchors: [{ phaseIndex: 2, kind: "climb", roles: ["longest", "largest"], id: "defining-climb" }],
  });
  const result = run(input);
  const observations = assertVisibleRhythmTrace(result, 5, 4);
  assert.equal(result.built.candidates.length, 5);
  const defining = observations.find(({ startKm }) => startKm === 4);
  assert.ok(defining);
  assert.match(defining.text, /longest and largest detected climb/);
});

test("directional changes separated by another character are not mislabeled as an alternating sequence", () => {
  const { built } = run(makeInput([climb(3), descent(3), rolling(3), climb(3), descent(3)]));
  assert.equal(built.candidates.some(({ renderPatternId }) => renderPatternId === "RHYTHM_SEQUENCE"), false);
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
  assert.match(generated.output.observations[0].text, /^In track segment 1, the route opens with climbing/);
  assert.match(generated.output.observations[1].text, /^Within track segment 2, from about 5\.0 to 10\.0 km, descending defines this section/);
});

test("more than five useful disconnected components remain ordered and fully represented", () => {
  const specs = Array.from({ length: 6 }, (_, index) => ({ ...climb(2), segmentIndex: index }));
  const { built, generated } = run(makeInput(specs));
  assert.equal(built.candidates.length, 6);
  assert.equal(generated.output.observations.length, 6);
  assert.equal(generated.output.diagnostics.componentCoverageComplete, true);
  assert.equal(generated.output.diagnostics.omittedCount, 0);
  assert.deepEqual(generated.output.observations.map(({ componentIndex }) => componentIndex), [0, 1, 2, 3, 4, 5]);
});

test("RouteAnalysisData baselines record phases, units, candidates, and selections by route rhythm", () => {
  const sustained = analyzeProfile([profileRuns(["climb", "descent"], { pointsPerRun: 101 })], "sustained climb then descent");
  assert.deepEqual(sustained.input.phases.map(({ character }) => character), ["climb-dominant", "descent-dominant"]);
  assert.deepEqual(sustained.input.units.map(({ character }) => character), ["climb-dominant", "descent-dominant"]);
  assert.deepEqual(sustained.built.candidates.map(({ renderPatternId }) => renderPatternId), ["UNIT_WITH_ANCHOR", "TRANSITION_TO_UNIT"]);
  assert.equal(sustained.selected.selectedCandidates.length, 2);

  const alternating = analyzeProfile([profileRuns(["climb", "descent", "climb", "descent", "climb", "descent", "climb"], { pointsPerRun: 41 })],
    "repeated short climb and descent alternations");
  assert.deepEqual(alternating.input.phases.map(({ character }) => character), [
    "climb-dominant", "descent-dominant", "climb-dominant", "descent-dominant", "climb-dominant", "descent-dominant", "climb-dominant",
  ]);
  assert.equal(alternating.input.units.length, 7);
  assert.deepEqual(alternating.built.candidates.map(({ renderPatternId }) => renderPatternId), ["UNIT_WITH_ANCHOR", "RHYTHM_SEQUENCE"]);
  assert.equal(alternating.selected.selectedCandidates.length, 2);
  assert.equal(alternating.output.observations[0].sourceFactIds.filter((id) => id.includes("narrative-fact.unit.")).length, 1);
  assert.equal(alternating.output.observations[1].sourceFactIds.filter((id) => id.includes("narrative-fact.unit.")).length, 6);
  assert.equal(alternating.output.observations.flatMap(({ sourceFactIds }) => sourceFactIds)
    .filter((id) => id.includes("narrative-fact.transition.")).length, 6);
  assert.match(alternating.output.observations[0].text, /detected climb/);
  assert.match(alternating.output.observations[1].text, /keeps alternating between climbing and descending/);

  const dominant = analyzeProfile([profileRuns(
    ["climb", "descent", "climb", "descent", "climb", "descent", "climb"],
    { pointsPerRun: 41, climbSlopeByRun: { 2: 8 } },
  )], "alternating profile with one protected dominant climb");
  assert.equal(dominant.input.phases.length, 7);
  assert.equal(dominant.input.units.length, 7);
  assert.equal(dominant.built.candidates.length, 6);
  assert.equal(dominant.selected.selectedCandidates.length, 6);
  assert.equal(dominant.output.diagnostics.componentCoverageComplete, true);
  assert.equal(dominant.output.diagnostics.omittedCount, 0);
  assert.equal(dominant.output.observations[2].startKm, 7.45);
  assert.match(dominant.output.observations[2].text, /longest and largest detected climb/);
  assert.equal(dominant.output.observations.at(-1).startKm, 15.95);
  assert.match(dominant.output.observations.at(-1).text, /keeps alternating between climbing and descending/);
  assert.equal(dominant.output.observations.find(({ candidateId }) => candidateId.startsWith("candidate:evolution:" )).text,
    "Across successive phases, combined climbing and descending per kilometre decreases.");

  const lowVertical = analyzeProfile([profileRuns(["flat"], { pointsPerRun: 201 })], "low-vertical route");
  assert.deepEqual(lowVertical.input.phases.map(({ character }) => character), ["low-vertical"]);
  assert.deepEqual(lowVertical.input.units.map(({ character }) => character), ["low-vertical"]);
  assert.deepEqual(lowVertical.built.candidates.map(({ renderPatternId }) => renderPatternId), ["EVOLVING_FINISH"]);
  assert.equal(lowVertical.output.observations.length, 1);
  assert.doesNotMatch(lowVertical.output.observations[0].text, /highest point|lowest point/);
  assert.ok(lowVertical.output.observations[0].sourceFactIds.some((id) => id.includes("anchor.extreme.highest")),
    "the endpoint extreme remains traceable in structured evidence");

  const disconnected = analyzeProfile([
    profileRuns(["climb"], { longitude: 0 }),
    profileRuns(["descent"], { longitude: 20 }),
  ], "disconnected components");
  assert.deepEqual(disconnected.input.phases.map(({ segmentIndex, character }) => [segmentIndex, character]), [
    [0, "climb-dominant"], [1, "descent-dominant"],
  ]);
  assert.deepEqual(disconnected.input.units.map(({ segmentIndex }) => segmentIndex), [0, 1]);
  assert.equal(disconnected.input.facts.some((fact) => fact.type === "STRUCTURAL_TRANSITION" && fact.fromUnitId !== fact.toUnitId), false);
  assert.deepEqual(disconnected.built.candidates.map(({ componentIndex }) => componentIndex), [0, 1]);
  assert.deepEqual(disconnected.output.observations.map(({ componentIndex }) => componentIndex), [0, 1]);
  assert.equal(disconnected.output.observations.some(({ text }) => /shifts from climbing to descending|shifts from descending to climbing/.test(text)), false);
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
  for (const forbidden of ["easier", "harder", "runnable", "technical", "mountainous", "recovery", "demanding", "controlled", "pace", "nutrition", "readiness", "surface", "weather", "village", "town"]) {
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
  assert.deepEqual(input.phases.map(({ character }) => character), [
    "climb-dominant", "descent-dominant", "repeated-vertical", "descent-dominant", "low-vertical",
  ]);
  assert.deepEqual(input.units.map(({ character }) => character), [
    "climb-dominant", "descent-dominant", "repeated-vertical", "evolving",
  ]);
  assert.equal(input.facts.length, 25);
  assert.equal(input.facts.filter((fact) => fact.eligibility.selectable).length, 14);
  assert.equal(result.built.candidates.length, 4);
  assert.deepEqual(result.built.candidates.map(({ renderPatternId }) => renderPatternId), [
    "UNIT_WITH_ANCHOR", "TRANSITION_TO_UNIT", "TRANSITION_TO_UNIT", "EVOLVING_FINISH",
  ]);
  assert.equal(result.selected.selectedCandidates.length, 4);
  assert.equal(result.generated.output.diagnostics.omittedCount, 0);
  assert.deepEqual(result.generated.output.observations.map(({ candidateId }) => candidateId),
    result.built.candidates.map(({ candidateId }) => candidateId));
  const evolvingText = result.generated.output.observations.at(-1).text;
  const [opening, firstChange, middle, finish] = result.generated.output.observations.map(({ text }) => text);
  assert.match(opening, /route opens with climbing through about 30\.5 km/);
  assert.match(opening, /longest and largest detected climb.*526 m ascent/);
  assert.match(firstChange, /shifts from climbing to descending through about 42\.8 km/);
  assert.match(firstChange, /longest and largest detected descent.*482 m descent/);
  assert.match(middle, /repeated climbs and descents/);
  assert.match(finish, /about 86\.3 to 100\.6 km/);
  assert.equal(finish.match(/100\.6 km/g)?.length, 1, "the transition boundary is not repeated in adjacent sentences");
  assert.match(finish, /110\.7 km finish/);
  assert.doesNotMatch(finish, /combined climbing and descending per kilometre decreases/,
    "the selected evolution remains structured but is omitted when the selected transitions already narrate it");
  assert.ok(result.generated.output.observations.at(-1).sourceFactIds.some((id) => id.includes("evolution.decreasing")));
  assert.doesNotMatch(finish, /82\.1|75\.8|26\.4|8\.2/);
  assert.match(finish, /lowest point at 3 m near 110\.4 km/,
    "a measured low point near, but not at, the component endpoint remains visible");
  assert.ok(finish.length < 500, "the final observation should not become a statistical paragraph");
  assert.doesNotMatch(evolvingText, /climb-dominant|descent-dominant|repeated-vertical|low-vertical/);
});

test("all phase labels render as runner-readable wording and all distinct transitions are natural", () => {
  const cases = [
    [climb(), "route opens with climbing"],
    [descent(), "route opens with descending"],
    [rolling(), "repeated climbs and descents"],
    [low(), "little climbing and descending per kilometre"],
    [{ character: "mixed", intensity: 40, distanceKm: 10, ascentM: 200, descentM: 200 }, "mix of climbing and descending"],
  ];
  const internalLabels = /climb-dominant|descent-dominant|repeated-vertical|low-vertical/;
  for (const [phase, expected] of cases) {
    const { generated } = run(makeInput([phase]));
    const text = generated.output.observations[0].text;
    assert.match(text, new RegExp(expected));
    assert.doesNotMatch(text, internalLabels);
  }

  const phaseSpecs = [
    { character: "climb-dominant", intensity: 80, distanceKm: 5, ascentM: 400, descentM: 0 },
    { character: "descent-dominant", intensity: 75, distanceKm: 5, ascentM: 0, descentM: 375 },
    { character: "repeated-vertical", intensity: 70, distanceKm: 5, ascentM: 175, descentM: 175 },
    { character: "low-vertical", intensity: 8, distanceKm: 5, ascentM: 20, descentM: 20 },
    { character: "mixed", intensity: 40, distanceKm: 5, ascentM: 100, descentM: 100 },
  ];
  for (const from of phaseSpecs) {
    for (const to of phaseSpecs) {
      if (from.character === to.character) continue;
      const { generated } = run(makeInput([from, to]));
      const text = generated.output.observations.map(({ text: item }) => item).join(" ");
      assert.match(text, /Around 5\.0 km, .* (?:shifts from .* to |gives way to )/, `${from.character} -> ${to.character}`);
      assert.doesNotMatch(text, internalLabels, `${from.character} -> ${to.character}`);
    }
  }
});
