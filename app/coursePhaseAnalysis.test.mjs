import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { analyzeGpxRoute, parseGpxText } from "./gpxAnalysis.ts";
import { analyzeCoursePhases, COURSE_PHASE_ALGORITHM_VERSION } from "./coursePhaseAnalysis.ts";

function makeSections(specs, { segmentIndexes } = {}) {
  let distanceKm = 0;
  return specs.map((spec, index) => {
    const segmentIndex = segmentIndexes?.[index] ?? 0;
    const startKm = distanceKm;
    distanceKm += spec.distanceKm;
    const ascentM = spec.ascentM ?? 0;
    const descentM = spec.descentM ?? 0;
    const verticalM = ascentM + descentM;
    const section = {
      id: `section-${segmentIndex}-${index + 1}`,
      startKm,
      endKm: distanceKm,
      segmentIndex,
      startPosition: { distanceM: startKm * 1000, segmentIndex },
      endPosition: { distanceM: distanceKm * 1000, segmentIndex },
      distanceKm: spec.distanceKm,
      dominantRhythm: spec.rhythm,
      elevationStartM: 100,
      elevationEndM: 100 + ascentM - descentM,
      elevationMinM: 100,
      elevationMaxM: 100 + ascentM,
      ascentM,
      descentM,
      elevationProfile: [],
      embeddedEvents: (spec.events ?? []).map((event, eventIndex) => ({
        id: `event-${index + 1}-${eventIndex + 1}`,
        rhythm: event.rhythm,
        startKm: startKm + event.startKm,
        endKm: startKm + event.endKm,
        distanceKm: event.endKm - event.startKm,
        ascentM: event.ascentM ?? 0,
        descentM: event.descentM ?? 0,
        significance: event.significance ?? 0.2,
        segmentIndex,
        startPosition: { distanceM: (startKm + event.startKm) * 1000, segmentIndex },
        endPosition: { distanceM: (startKm + event.endKm) * 1000, segmentIndex },
      })),
      dynamicsSummary: {
        verticalIntensityMPerKm: verticalM / spec.distanceKm,
        directionBalance: verticalM > 0 ? (ascentM - descentM) / verticalM : 0,
        directionStrength: verticalM > 0 ? Math.abs(ascentM - descentM) / verticalM : 0,
        stability: spec.stability ?? 0.9,
      },
      description: "fixture",
    };
    if (spec.mapData) section.mapData = spec.mapData;
    return section;
  });
}

const getPhases = (specs, options) => analyzeCoursePhases(makeSections(specs, options));
const spec = (rhythm, distanceKm, ascentM, descentM = 0, extra = {}) => ({ rhythm, distanceKm, ascentM, descentM, ...extra });

test("Course Phase output is versioned and empty input stays empty", () => {
  assert.equal(COURSE_PHASE_ALGORITHM_VERSION, 1);
  assert.deepEqual(analyzeCoursePhases([]), { algorithmVersion: 1, phases: [], transitions: [] });
});

test("one sustained climb becomes one climb-dominant phase", () => {
  const result = getPhases([
    spec("climb", 4, 240, 0, { events: [{ rhythm: "descent", startKm: 1, endKm: 1.4, descentM: 18 }] }),
    spec("climb", 4, 220),
    spec("climb", 4, 240),
  ]);
  assert.equal(result.phases.length, 1);
  assert.equal(result.phases[0].character, "climb-dominant");
  assert.deepEqual(result.phases[0].sourceSectionIds, ["section-0-1", "section-0-2", "section-0-3"]);
  assert.deepEqual(result.phases[0].embeddedEventIds, ["event-1-1"]);
  assert.equal(result.phases[0].interruptions[0].sourceEventId, "event-1-1");
  assert.equal(result.phases[0].interruptions[0].character, "descent-dominant");
});

test("one sustained descent becomes one descent-dominant phase", () => {
  const result = getPhases([spec("descent", 4, 0, 240), spec("descent", 4, 0, 220), spec("descent", 4, 0, 240)]);
  assert.equal(result.phases.length, 1);
  assert.equal(result.phases[0].character, "descent-dominant");
  assert.equal(result.phases[0].descentM, 700);
});

test("flat low-vertical sections form one phase without equal thirds", () => {
  const result = getPhases([spec("flat", 10, 20, 20), spec("flat", 10, 18, 18), spec("flat", 10, 17, 17)]);
  assert.equal(result.phases.length, 1);
  assert.equal(result.phases[0].character, "low-vertical");
  assert.equal(result.phases[0].startKm, 0);
  assert.equal(result.phases[0].endKm, 30);
});

test("a persistent alternating block becomes one repeated-vertical phase", () => {
  const result = getPhases([
    spec("climb", 30, 1050), spec("descent", 12, 0, 600),
    spec("climb", 3, 100), spec("descent", 3, 0, 100),
    spec("climb", 3, 100), spec("descent", 3, 0, 100),
    spec("climb", 3, 100), spec("descent", 3, 0, 100),
    spec("flat", 11, 50, 50),
  ]);
  const repeated = result.phases.filter(({ character }) => character === "repeated-vertical");
  assert.equal(repeated.length, 1);
  assert.equal(repeated[0].startKm, 42);
  assert.equal(repeated[0].endKm, 60);
  assert.equal(repeated[0].sourceSectionIds.length, 6);
});

test("a brief descent between climbing runs is retained as an interruption", () => {
  const result = getPhases([spec("climb", 5, 250), spec("descent", 0.5, 0, 20), spec("climb", 5, 250)]);
  assert.equal(result.phases.length, 1);
  assert.equal(result.phases[0].character, "climb-dominant");
  assert.equal(result.phases[0].interruptions.length, 1);
  assert.equal(result.phases[0].interruptions[0].character, "descent-dominant");
  assert.equal(result.phases[0].interruptions[0].sourceSectionId, "section-0-2");
});

test("a meaningful sustained climb-to-descent change remains separate", () => {
  const result = getPhases([spec("climb", 12, 600), spec("descent", 10, 0, 500)]);
  assert.deepEqual(result.phases.map(({ character }) => character), ["climb-dominant", "descent-dominant"]);
  assert.equal(result.transitions.length, 1);
  assert.equal(result.transitions[0].fromCharacter, "climb-dominant");
  assert.equal(result.transitions[0].toCharacter, "descent-dominant");
});

test("a short climb within lower-vertical terrain stays an interruption", () => {
  const result = getPhases([
    spec("flat", 10, 52.5, 52.5),
    spec("climb", 0.5, 20),
    spec("flat", 10, 52.5, 52.5),
  ]);
  assert.equal(result.phases.length, 1);
  assert.equal(result.phases[0].character, "low-vertical");
  assert.equal(result.phases[0].interruptions.length, 1);
  assert.equal(result.phases[0].interruptions[0].character, "climb-dominant");
});

test("a 120 km structured route can produce more than six phases", () => {
  const patterns = ["climb", "descent", "flat", "climb", "descent", "flat", "climb", "descent"];
  const specs = patterns.flatMap((rhythm) => [
    rhythm === "climb" ? spec("climb", 7.5, 300) : rhythm === "descent" ? spec("descent", 7.5, 0, 300) : spec("flat", 7.5, 20, 20),
    rhythm === "climb" ? spec("climb", 7.5, 300) : rhythm === "descent" ? spec("descent", 7.5, 0, 300) : spec("flat", 7.5, 20, 20),
  ]);
  const result = getPhases(specs);
  assert.equal(result.phases.reduce((sum, phase) => sum + phase.distanceKm, 0), 120);
  assert.ok(result.phases.length > 6);
  assert.ok(result.phases.every((phase) => phase.startKm < phase.endKm));
});

test("disconnected components group independently and never get a transition", () => {
  const sections = makeSections([spec("climb", 10, 400), spec("descent", 10, 0, 400)], { segmentIndexes: [0, 1] });
  const result = analyzeCoursePhases(sections);
  assert.equal(result.phases.length, 2);
  assert.deepEqual(result.phases.map(({ segmentIndex }) => segmentIndex), [0, 1]);
  assert.deepEqual(result.phases.map(({ ordinal }) => ordinal), [1, 2]);
  assert.equal(result.transitions.length, 0);
  assert.notEqual(result.phases[0].id, result.phases[1].id);
});

test("global phase ordinals follow GPX component order even when section input order differs", () => {
  const sections = makeSections([spec("climb", 10, 400), spec("descent", 10, 0, 400)], { segmentIndexes: [0, 1] });
  const result = analyzeCoursePhases([...sections].reverse());
  assert.deepEqual(result.phases.map(({ segmentIndex, ordinal }) => [segmentIndex, ordinal]), [[0, 1], [1, 2]]);
});

test("repeated coordinates do not merge separate loop traversals", () => {
  const repeatedMap = [{ latitude: 45, longitude: 13, elevationM: 100, distanceM: 0, segmentIndex: 0 }];
  const sections = makeSections([
    spec("climb", 10, 400, 0, { mapData: repeatedMap }),
    spec("descent", 10, 0, 400, { mapData: repeatedMap }),
    spec("climb", 10, 400, 0, { mapData: repeatedMap }),
  ]);
  const result = analyzeCoursePhases(sections);
  assert.deepEqual(result.phases.map(({ character }) => character), ["climb-dominant", "descent-dominant", "climb-dominant"]);
  assert.deepEqual(result.phases.map(({ ordinal }) => ordinal), [1, 2, 3]);
});

test("a 24 km climb and descent is grouped by structure, not distance template", () => {
  const result = getPhases([spec("climb", 12, 500), spec("descent", 12, 0, 500)]);
  assert.equal(result.phases.length, 2);
  assert.deepEqual(result.phases.map(({ distanceKm }) => distanceKm), [12, 12]);
});

test("relative distance significance boundary is below, at, and above eight percent", () => {
  for (const [share, expected] of [[0.0799, 1], [0.08, 3], [0.0801, 3]]) {
    const middleKm = share * 100;
    const flankKm = (100 - middleKm) / 2;
    const result = getPhases([
      spec("climb", flankKm, flankKm * 20),
      spec("descent", middleKm, 0, middleKm * 18),
      spec("climb", flankKm, flankKm * 20),
    ]);
    assert.equal(result.phases.length, expected, `distance share ${share}`);
    if (expected === 3) assert.equal(result.phases[1].character, "descent-dominant");
    else assert.equal(result.phases[0].interruptions.length, 1);
  }
});

test("relative vertical-work significance boundary is below, at, and above twenty percent", () => {
  for (const [share, expected] of [[0.1999, 1], [0.2, 3], [0.2001, 3]]) {
    const middleKm = 7;
    const flankKm = 46.5;
    const candidateVertical = 126;
    const flankAscentEach = candidateVertical * (1 - share) / (2 * share);
    const result = getPhases([
      spec("flat", flankKm, flankAscentEach / 2, flankAscentEach / 2),
      spec("descent", middleKm, 0, candidateVertical),
      spec("flat", flankKm, flankAscentEach / 2, flankAscentEach / 2),
    ]);
    assert.equal(result.phases.length, expected, `vertical share ${share}`);
    if (expected === 3) assert.equal(result.phases[1].character, "descent-dominant");
    else assert.equal(result.phases[0].interruptions.length, 1);
  }
});

test("same-character persistence boundary is one section below and two/three sections at or above", () => {
  const one = getPhases([spec("descent", 46, 0, 920), spec("climb", 6, 108), spec("descent", 48, 0, 960)]);
  assert.equal(one.phases.length, 1);
  for (const count of [2, 3]) {
    const climbSections = Array.from({ length: count }, () => spec("climb", 6 / count, 108 / count));
    const result = getPhases([spec("descent", 46, 0, 920), ...climbSections, spec("descent", 48, 0, 960)]);
    assert.equal(result.phases.length, 3, `persistent climb section count ${count}`);
    assert.equal(result.phases[1].character, "climb-dominant");
  }
});

test("single-section significance also requires stability at the existing stability boundary", () => {
  for (const [stability, expected] of [[0.5799, 1], [0.58, 3], [0.5801, 3]]) {
    const result = getPhases([
      spec("climb", 46, 920),
      spec("descent", 8, 0, 144, { stability }),
      spec("climb", 46, 920),
    ]);
    assert.equal(result.phases.length, expected, `stability ${stability}`);
  }
});

test("Istria 110K produces a compact component-aware phase result", async () => {
  const xml = await readFile(new URL("../public/ISTRIA_110K_2027.gpx", import.meta.url), "utf8");
  const analysis = analyzeGpxRoute(parseGpxText(xml));
  const result = analyzeCoursePhases(analysis.routeSections);
  assert.equal(analysis.routeSections.length, 15);
  assert.ok(result.phases.length < analysis.routeSections.length);
  assert.ok(result.phases.length > 0);
  const sourceIds = result.phases.flatMap(({ sourceSectionIds }) => sourceSectionIds);
  assert.deepEqual(sourceIds.sort(), analysis.routeSections.map(({ id }) => id).sort());
  assert.ok(result.phases.every((phase, index, phases) =>
    index === 0 || phases[index - 1].endKm <= phase.startKm));
  assert.ok(result.transitions.every((transition) => transition.segmentIndex === 0));
});
