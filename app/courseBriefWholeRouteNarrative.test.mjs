import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { composeCourseBrief } from "./courseBriefComposition.ts";
import { composeCourseBriefWholeRouteNarrative } from "./courseBriefWholeRouteNarrative.ts";
import { analyzeGpxRoute, parseGpxText } from "./gpxAnalysis.ts";

async function fromGpx(path) {
  const xml = await readFile(new URL(path, import.meta.url), "utf8");
  const analysis = analyzeGpxRoute(parseGpxText(xml));
  const composition = await composeCourseBrief(analysis);
  assert.equal(composition.ok, true);
  const narrative = composeCourseBriefWholeRouteNarrative(composition.input, composition.structuralOutput, composition.selection.selectedCandidates);
  assert.ok(narrative);
  return { analysis, composition, narrative };
}

function analyzeSynthetic(runs, { pointsPerRun = 81, segmentIndexes = null } = {}) {
  const segments = [];
  let elevation = 100;
  let longitude = 0;
  for (const [runIndex, run] of runs.entries()) {
    const segmentIndex = segmentIndexes?.[runIndex] ?? 0;
    if (!segments[segmentIndex]) segments[segmentIndex] = [];
    const stageStart = elevation;
    for (let index = 0; index < pointsPerRun; index += 1) {
      const offset = run === "climb" ? index * 5 : run === "descent" ? -index * 5 :
        run === "rolling" ? (Math.floor(index / 8) % 2 === 0 ? index % 8 * 2 : 16 - index % 8 * 2) : 0;
      elevation = stageStart + offset;
      segments[segmentIndex].push({ latitude: 0, longitude, elevationM: elevation });
      longitude += 0.0009;
    }
  }
  return analyzeGpxRoute({ segments: segments.filter(Boolean), name: "Synthetic profile" });
}

async function narrativeForAnalysis(analysis) {
  const composition = await composeCourseBrief(analysis);
  assert.equal(composition.ok, true);
  const narrative = composeCourseBriefWholeRouteNarrative(composition.input, composition.structuralOutput, composition.selection.selectedCandidates);
  assert.ok(narrative);
  return { composition, narrative };
}

test("Istria whole-route narrative preserves chronological shape and important climb/descent anchors", async () => {
  const { composition, narrative } = await fromGpx("../public/ISTRIA_110K_2027.gpx");
  assert.equal(composition.structuralOutput.observations.length, 4);
  assert.equal(narrative.paragraphs.length, 2);
  const text = narrative.paragraphs.map(({ text: paragraph }) => paragraph).join(" ");
  assert.match(text, /opens with predominantly uphill travel through about km 30\.5/);
  assert.match(text, /longest and largest detected climb/);
  assert.match(text, /climb gives way to downhill travel/);
  assert.match(text, /climbs and descents recur/);
  assert.match(text, /relatively little climbing and descending per kilometre/);
  assert.ok(text.indexOf("km 30.5") < text.indexOf("km 42.8"));
  assert.ok(text.indexOf("km 42.8") < text.indexOf("km 86.3"));
  assert.ok(narrative.paragraphs[0].sourceFactIds.length >= 5);
});

test("Učka alternating sustained phases compose into a connected whole-route story", { skip: !existsSync(fileURLToPath(new URL("../test-routes/gradient-calibration/Učka Loop Challenge (42km2200m+) Official Route.gpx", import.meta.url))) }, async () => {
  const { narrative } = await fromGpx("../test-routes/gradient-calibration/Učka Loop Challenge (42km2200m+) Official Route.gpx");
  const text = narrative.paragraphs[0].text;
  assert.match(text, /opens with predominantly uphill travel/);
  assert.match(text, /climb gives way to downhill travel/);
  assert.match(text, /longest and largest detected climb/);
  assert.match(text, /Toward the finish/);
  assert.ok(text.indexOf("km 9.1") < text.indexOf("km 16.9"));
  assert.ok(text.indexOf("km 16.9") < text.indexOf("km 29.7"));
});

test("shorter rolling route gets a concise whole-route description", { skip: !existsSync(fileURLToPath(new URL("../test-routes/gradient-calibration/Lužec Trail 20km.gpx", import.meta.url))) }, async () => {
  const { narrative } = await fromGpx("../test-routes/gradient-calibration/Lužec Trail 20km.gpx");
  assert.equal(narrative.paragraphs.length, 1);
  const text = narrative.paragraphs[0].text;
  assert.match(text, /climbing and descending/i);
  assert.doesNotMatch(text, /smoothed net grade|technical|rocky|muddy|difficult|pace/i);
  assert.ok(text.split(/[.!?]\s+/).filter(Boolean).length <= 4);
});

test("synthetic sustained climb, descent and rolling profiles retain direction and chronology", async () => {
  const climb = await narrativeForAnalysis(analyzeSynthetic(["climb"]));
  assert.match(climb.narrative.paragraphs[0].text, /uphill|climb/i);
  assert.doesNotMatch(climb.narrative.paragraphs[0].text, /downhill|descent/i);

  const descent = await narrativeForAnalysis(analyzeSynthetic(["descent"]));
  assert.match(descent.narrative.paragraphs[0].text, /downhill|descend/i);
  assert.doesNotMatch(descent.narrative.paragraphs[0].text, /uphill|climb/i);

  const rolling = await narrativeForAnalysis(analyzeSynthetic(["rolling"]));
  assert.match(rolling.narrative.paragraphs[0].text, /climbing and descending|ups and downs/i);
});

test("a short low-change route stays concise and missing elevation produces no invented prose", async () => {
  const lowChange = await narrativeForAnalysis(analyzeSynthetic(["flat"], { pointsPerRun: 31 }));
  assert.equal(lowChange.narrative.paragraphs.length, 1);
  assert.match(lowChange.narrative.paragraphs[0].text, /little climbing and descending|mixed/i);
  assert.ok(lowChange.narrative.paragraphs[0].text.split(/[.!?]\s+/).filter(Boolean).length <= 2);

  assert.throws(() => analyzeGpxRoute({ segments: [[
    { latitude: 0, longitude: 0, elevationM: null },
    { latitude: 0, longitude: 0.01, elevationM: null },
    { latitude: 0, longitude: 0.02, elevationM: null },
  ]], name: "Missing elevation" }), /usable elevation data/);
});

test("selected rhythm grouping is summarized without fabricating direction or terrain claims", async () => {
  const analysis = analyzeSynthetic(["climb", "descent", "climb", "descent", "climb"], { pointsPerRun: 41 });
  const { composition, narrative } = await narrativeForAnalysis(analysis);
  assert.ok(composition.selection.selectedCandidates.some(({ renderPatternId }) => renderPatternId === "RHYTHM_SEQUENCE"));
  const text = narrative.paragraphs[0].text;
  assert.match(text, /climbing and descending repeat|climbs and descents recur/i);
  assert.doesNotMatch(text, /rocky|muddy|technical|difficult|fatigue|pace|surface/i);
  assert.ok(narrative.paragraphs[0].sourceFactIds.every((id) => composition.input.facts.some((fact) => fact.factId === id)));
});

test("disconnected GPX components get separate paragraphs without a synthetic bridge", async () => {
  const analysis = analyzeSynthetic(["climb", "descent"], { segmentIndexes: [0, 1] });
  const { composition, narrative } = await narrativeForAnalysis(analysis);
  assert.equal(composition.input.route.components.length, 2);
  assert.equal(narrative.paragraphs.length, 2);
  assert.deepEqual(narrative.paragraphs.map(({ componentIndex }) => componentIndex), [0, 1]);
  assert.match(narrative.paragraphs[0].text, /^Track segment 1:/);
  assert.match(narrative.paragraphs[1].text, /^Track segment 2:/);
  assert.doesNotMatch(narrative.paragraphs[1].text, /then|after|gives way/i);
  assert.ok(narrative.paragraphs.every(({ sourceFactIds }) => sourceFactIds.length > 0));
});

test("composition is deterministic and rejects invalid or untraceable structural outputs", async () => {
  const { composition } = await fromGpx("../public/ISTRIA_110K_2027.gpx");
  const first = composeCourseBriefWholeRouteNarrative(composition.input, composition.structuralOutput, composition.selection.selectedCandidates);
  const second = composeCourseBriefWholeRouteNarrative(composition.input, composition.structuralOutput, composition.selection.selectedCandidates);
  assert.deepEqual(first, second);
  assert.equal(composeCourseBriefWholeRouteNarrative({}, composition.structuralOutput, composition.selection.selectedCandidates), null);
  const tampered = structuredClone(composition.structuralOutput);
  tampered.observations[0].sourceFactIds[0] = "invented.fact";
  assert.equal(composeCourseBriefWholeRouteNarrative(composition.input, tampered, composition.selection.selectedCandidates), null);
});
