import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { analyzeGpxRoute, parseGpxText } from "./gpxAnalysis.ts";
import { buildCourseBriefInputV2 } from "./courseBriefNarrativeFacts.ts";
import { generateDeterministicCourseBriefV2 } from "./courseBriefCandidates.ts";
import {
  buildCourseBriefNarrativePrototypeInput,
  buildCourseBriefNarrativePrototypePrompt,
  courseBriefNarrativeResponseSchema,
  generateCourseBriefNarrativePrototype,
  validateCourseBriefNarrativeResponse,
} from "./courseBriefNarrativePrototype.ts";
import { OpenAiCourseBriefNarrativePrototypeWriter } from "./server/openAiCourseBriefNarrativePrototypeWriter.ts";
import { COURSE_BRIEF_MODEL, COURSE_BRIEF_PROVIDER_TIMEOUT_MS } from "./server/openAiCourseBriefProvider.ts";

function profile(runs, { pointsPerRun = 81, climbSlopeByRun = {}, longitude = 0 } = {}) {
  const points = [];
  let elevation = 100;
  for (const [runIndex, run] of runs.entries()) {
    const base = elevation;
    for (let index = 0; index < pointsPerRun; index += 1) {
      const step = climbSlopeByRun[runIndex] ?? 5;
      elevation = base + (run === "climb" ? index * step : run === "descent" ? -index * 5 : 0);
      points.push({ latitude: 45, longitude: longitude + points.length * 0.0007, elevationM: elevation });
    }
  }
  return points;
}

function analyze(runs, opts = {}) {
  const analysis = analyzeGpxRoute({ segments: runs.map((run, index) => profile(run, { ...opts, longitude: index * 5 })), name: "Synthetic prototype fixture" });
  return { analysis, input: buildCourseBriefInputV2(analysis) };
}

const qualitativeSentence = (character) => ({
  "climb-dominant": "Climbing defines this section.",
  "descent-dominant": "Descending defines this section.",
  "repeated-vertical": "Climbing and descending alternate in this section.",
  "low-vertical": "There is little elevation change in this section.",
  mixed: "Climbing and descending share this section.",
  evolving: "The elevation pattern changes in this section.",
}[character] ?? "The course profile changes in this section.");

function fullyCitedFixture(input) {
  return {
    schemaVersion: 1,
    paragraphs: input.facts.filter((fact) => fact.type === "unit").map((fact) => ({
      componentIndex: fact.componentIndex,
      text: qualitativeSentence(fact.character),
      factIds: [fact.factId],
    })),
  };
}

async function fiveRoutes() {
  const gpx = parseGpxText(await readFile(new URL("../public/ISTRIA_110K_2027.gpx", import.meta.url), "utf8"));
  return [
    ["Istria 110K", buildCourseBriefInputV2(analyzeGpxRoute(gpx))],
    ["sustained climb then descent (synthetic)", analyze([["climb", "descent"]], { pointsPerRun: 101 }).input],
    ["comparable short alternations (synthetic)", analyze([["climb", "descent", "climb", "descent", "climb", "descent", "climb"]], { pointsPerRun: 41 }).input],
    ["protected dominant climb (synthetic)", analyze([["climb", "descent", "climb", "descent", "climb", "descent", "climb"]], { pointsPerRun: 41, climbSlopeByRun: { 2: 8 } }).input],
    ["low-vertical route (synthetic)", analyze([["flat"]], { pointsPerRun: 201 }).input],
  ];
}

test("builds compact, validated inputs for Istria and all four requested synthetic profiles", async () => {
  const routes = await fiveRoutes();
  assert.equal(routes.length, 5);
  for (const [name, v2Input] of routes) {
    const built = buildCourseBriefNarrativePrototypeInput(v2Input);
    assert.equal(built.ok, true, name);
    assert.ok(built.input.facts.some((fact) => fact.type === "unit"), name);
    assert.ok(built.input.route.components.length > 0, name);
    const prompt = buildCourseBriefNarrativePrototypePrompt(built.input);
    assert.ok(prompt.systemInstructions.length < 1200);
    assert.doesNotMatch(prompt.userData, /latitude|longitude|rendered paragraphs|The route opens/);
    assert.equal(courseBriefNarrativeResponseSchema.safeParse(fullyCitedFixture(built.input)).success, true, name);
    const deterministic = generateDeterministicCourseBriefV2(v2Input);
    assert.equal(deterministic.ok, true, name);
    assert.ok(deterministic.output.observations.length > 0, name);
  }
});

test("writer input preserves event provenance and does not invent missing route geometry", async () => {
  const gpx = parseGpxText(await readFile(new URL("../public/ISTRIA_110K_2027.gpx", import.meta.url), "utf8"));
  const v2 = buildCourseBriefInputV2(analyzeGpxRoute(gpx));
  const sourceEvent = v2.facts.find((fact) => fact.type === "ANCHOR_WITHIN_UNIT" && fact.anchorKind === "key-moment");
  assert.ok(sourceEvent, "Istria provides a verified significant climb/descent event for this projection check");
  const built = buildCourseBriefNarrativePrototypeInput(v2);
  assert.equal(built.ok, true);
  const event = built.input.facts.find((fact) => fact.type === "significant_event");
  assert.equal(event.sourceFactId, sourceEvent.sourceFactId);
  assert.equal(event.distanceKm, sourceEvent.measurements.distanceKm);
  assert.equal(event.verticalChangeM, sourceEvent.measurements.elevationChangeM);
  assert.equal(built.input.facts.some((fact) => fact.type === "significant_event" && fact.distanceKm === null), false);
  assert.equal(Object.hasOwn(built.input.route, "name"), false);
  assert.equal(JSON.stringify(built.input).includes("latitude"), false);
  assert.equal(JSON.stringify(built.input).includes("longitude"), false);
});

test("validates fact references, chronology, component isolation and endpoint coverage", async () => {
  const multi = analyze([["climb"], ["descent"]], { pointsPerRun: 81 }).input;
  const built = buildCourseBriefNarrativePrototypeInput(multi);
  assert.equal(built.ok, true);
  const fixture = fullyCitedFixture(built.input);
  assert.equal(validateCourseBriefNarrativeResponse(fixture, built.input).ok, true);

  const unknown = structuredClone(fixture);
  unknown.paragraphs[0].factIds = ["invented.fact"];
  assert.deepEqual(validateCourseBriefNarrativeResponse(unknown, built.input), { ok: false, error: "unknown_fact_reference" });

  const crossComponent = structuredClone(fixture);
  crossComponent.paragraphs[0].factIds.push(crossComponent.paragraphs[1].factIds[0]);
  assert.deepEqual(validateCourseBriefNarrativeResponse(crossComponent, built.input), { ok: false, error: "mixed_components" });

  const reversed = structuredClone(fixture);
  reversed.paragraphs.reverse();
  assert.deepEqual(validateCourseBriefNarrativeResponse(reversed, built.input), { ok: false, error: "out_of_order" });

  const bridged = structuredClone(fixture);
  bridged.paragraphs[1].text = "Then the course descends through a new segment.";
  assert.deepEqual(validateCourseBriefNarrativeResponse(bridged, built.input), { ok: false, error: "unsupported_claim" });

  const missingFinish = structuredClone(fixture);
  missingFinish.paragraphs.pop();
  assert.deepEqual(validateCourseBriefNarrativeResponse(missingFinish, built.input), { ok: false, error: "incomplete_route_coverage" });
});

test("rejects unsupported place, terrain, weather, difficulty, advice, and numeric claims", async () => {
  const built = buildCourseBriefNarrativePrototypeInput(analyze([["climb", "descent"]], { pointsPerRun: 101 }).input);
  assert.equal(built.ok, true);
  for (const text of [
    "The route passes through a village.",
    "A gravel road climbs here.",
    "The climb is steep.",
    "Wind makes this section exposed.",
    "This is the hardest part; you should slow down.",
    "The climb gains 500 m.",
  ]) {
    const response = fullyCitedFixture(built.input);
    response.paragraphs[0].text = text;
    assert.deepEqual(validateCourseBriefNarrativeResponse(response, built.input), { ok: false, error: "unsupported_claim" }, text);
  }
});

test("generation reports validation failure and never silently accepts a fabricated response", async () => {
  const v2Input = analyze([["climb", "descent"]], { pointsPerRun: 101 }).input;
  let calls = 0;
  const writer = { async write() { calls += 1; return { ok: true, response: { schemaVersion: 1, paragraphs: [] } }; } };
  assert.deepEqual(await generateCourseBriefNarrativePrototype(v2Input, writer), {
    ok: false, error: "invalid_narrative", reason: "malformed_output",
  });
  assert.equal(calls, 1);
  const invalid = await generateCourseBriefNarrativePrototype({ schemaVersion: -1 }, writer);
  assert.deepEqual(invalid, { ok: false, error: "invalid_input" });
  assert.equal(calls, 1, "invalid route facts fail before provider invocation");
});

test("OpenAI writer reuses existing model settings with Structured Outputs, store:false, and no retries", async () => {
  const fixtureInput = buildCourseBriefNarrativePrototypeInput(analyze([["climb", "descent"]], { pointsPerRun: 101 }).input);
  assert.equal(fixtureInput.ok, true);
  let request;
  const responses = { async parse(value) {
    request = value;
    return { status: "completed", incomplete_details: null, output: [], output_parsed: fullyCitedFixture(fixtureInput.input),
      usage: { input_tokens: 120, output_tokens: 90, total_tokens: 210, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
  } };
  const writer = new OpenAiCourseBriefNarrativePrototypeWriter({ apiKey: "test-only-not-a-secret", responses });
  const result = await writer.write(buildCourseBriefNarrativePrototypePrompt(fixtureInput.input));
  assert.equal(result.ok, true);
  assert.equal(request.model, COURSE_BRIEF_MODEL);
  assert.equal(request.max_output_tokens, 500);
  assert.equal(request.store, false);
  assert.deepEqual(request.reasoning, { effort: "none" });
  assert.ok(request.text.format);
  assert.ok(COURSE_BRIEF_PROVIDER_TIMEOUT_MS <= 15_000);
  assert.equal(result.usage.totalTokens, 210);
});

test("missing provider configuration is reported without a network request", async () => {
  const writer = new OpenAiCourseBriefNarrativePrototypeWriter();
  assert.deepEqual(await writer.write({ systemInstructions: "", userData: "" }), {
    ok: false, error: "provider_not_configured",
  });
});
