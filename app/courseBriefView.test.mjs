import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { buildCourseBriefCandidates, renderCourseBriefV2, selectCourseBriefCandidates } from "./courseBriefCandidates.ts";
import { composeCourseBrief } from "./courseBriefComposition.ts";
import { buildCourseBriefInputV2 } from "./courseBriefNarrativeFacts.ts";
import { analyzeGpxRoute, parseGpxText } from "./gpxAnalysis.ts";

const componentSource = await readFile(new URL("./CourseBriefView.tsx", import.meta.url), "utf8");
const raceSource = await readFile(new URL("./CourseSection.tsx", import.meta.url), "utf8");
const routeSource = await readFile(new URL("./RouteAnalysisView.tsx", import.meta.url), "utf8");
const routeModeSource = await readFile(new URL("./RouteMode.tsx", import.meta.url), "utf8");

test("Istria renders four V2 observations in canonical order with exact structural text", async () => {
  const xml = await readFile(new URL("../public/ISTRIA_110K_2027.gpx", import.meta.url), "utf8");
  const routeAnalysis = analyzeGpxRoute(parseGpxText(xml));
  const input = buildCourseBriefInputV2(routeAnalysis);
  const candidates = buildCourseBriefCandidates(input);
  assert.equal(candidates.ok, true);
  const selection = selectCourseBriefCandidates(input, candidates.candidates);
  assert.equal(selection.ok, true);
  const expected = renderCourseBriefV2(input, candidates.candidates, selection);
  const result = await composeCourseBrief(routeAnalysis);

  assert.equal(expected.observations.length, 4);
  assert.equal(result.ok, true);
  assert.equal(result.kind, "structural");
  assert.deepEqual(result.structuralOutput, expected);
  assert.deepEqual(result.structuralOutput.observations.map(({ text }) => text), expected.observations.map(({ text }) => text));
});

test("Course Brief view composes the provided analysis once per analysis/key change and guards stale results", () => {
  assert.match(componentSource, /composeCourseBrief\(routeAnalysis\)/);
  assert.match(componentSource, /\[routeAnalysis, routeKey\]/);
  assert.match(componentSource, /if \(!current\) return/);
  assert.match(componentSource, /state\?\.routeAnalysis === routeAnalysis && state\.routeKey === routeKey/);
  assert.match(componentSource, /return \(\) => \{\s*current = false;/);
});

test("Race Mode passes the selected edition's existing analysis and isolates edition changes", () => {
  assert.match(raceSource, /fetch\(raceRecord\.edition\.gpxPath\)/);
  assert.match(raceSource, /const analysis = analyzeGpxRoute\(/);
  assert.match(raceSource, /setLoadState\(\{ editionKey, status: "ready", analysis \}\)/);
  assert.match(raceSource, /loadedAnalysis|loadState\?\.editionKey === editionKey/);
  assert.match(raceSource, /<CourseBriefView[\s\S]*?routeKey=\{editionKey\}[\s\S]*?routeAnalysis=\{routeAnalysis\}/);
});

test("Route Mode passes its existing analysis to Course Brief without another GPX read", () => {
  assert.match(routeModeSource, /parseGpxText\(await file\.text\(\)\)/);
  assert.match(routeModeSource, /<RouteAnalysisView[\s\S]*?analysis=\{analysis\}/);
  assert.match(routeSource, /<CourseBriefView routeAnalysis=\{analysis\}/);
  assert.equal((routeSource.match(/analyzeGpxRoute|parseGpxText/g) ?? []).length, 0);
});

test("view preserves structural text only and isolates failures from course content", () => {
  assert.match(componentSource, /currentState\.result\.structuralOutput\.observations\.map/);
  assert.match(componentSource, /\{observation\.text\}/);
  assert.match(componentSource, /Course Brief is unavailable for this route/);
  assert.match(componentSource, /\.catch\(\(\) => \{/);
  assert.doesNotMatch(componentSource, /geographicPresentation|\.geographic\b|location label/i);
  assert.doesNotMatch(componentSource, /courseBriefApi|courseBriefGeneration|openAiCourseBriefProvider|fetch\s*\(/);
});

test("single-column layout wraps long text on narrow screens", () => {
  assert.match(componentSource, /min-w-0 space-y-3/);
  assert.match(componentSource, /\[overflow-wrap:anywhere\]/);
  assert.match(componentSource, /px-4 py-3[\s\S]*?sm:px-5/);
});
