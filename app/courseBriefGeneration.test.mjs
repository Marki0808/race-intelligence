import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { APIError, APIConnectionTimeoutError } from "openai";
import { buildCourseBriefFactIndex } from "./courseBriefFactIndex.ts";
import { validateCourseBriefCandidate } from "./courseBriefClaimValidation.ts";
import {
  MAX_COURSE_BRIEF_REQUEST_BYTES,
  courseBriefInputSchema,
  validateCourseBriefInput,
} from "./courseBriefInputValidation.ts";
import { generateCourseBrief } from "./courseBriefGeneration.ts";
import { renderCourseBrief } from "./courseBriefOutput.ts";
import { COURSE_BRIEF_PROMPT_VERSION, buildCourseBriefPrompt } from "./courseBriefPrompt.ts";
import {
  COURSE_BRIEF_MAX_OUTPUT_TOKENS,
  COURSE_BRIEF_MODEL,
  COURSE_BRIEF_MAX_RETRIES,
  COURSE_BRIEF_PROVIDER_TIMEOUT_MS,
  OpenAiCourseBriefProvider,
} from "./server/openAiCourseBriefProvider.ts";
import { createCourseBriefPostHandler } from "./courseBriefApi.ts";
import { buildCourseBriefInput } from "./courseBriefInput.ts";
import { analyzeGpxRoute, parseGpxText } from "./gpxAnalysis.ts";

const BASE_INPUT = makeInput();
const PROGRESSION_IDS = ["progression.early", "progression.middle", "progression.late"];

function makeInput(overrides = {}) {
  const sectionId = "section.s0.m0-30000.climb";
  const section = {
    factId: sectionId, ordinal: 1, segmentIndex: 0, startKm: 0, endKm: 30, distanceKm: 30,
    rhythm: "climb", ascentM: 700, descentM: 200,
  };
  return {
    schemaVersion: 1,
    analysisVersion: 2,
    directFacts: {
      distance: { factId: "route.distance", value: { km: 30 } },
      rawGain: { factId: "route.raw-gain", value: { m: 1000 } },
      rawLoss: { factId: "route.raw-loss", value: { m: 1000 } },
      highest: { factId: "route.highest", value: { elevationM: 1400, atKm: 4, segmentIndex: 0 } },
      lowest: { factId: "route.lowest", value: { elevationM: 400, atKm: 0, segmentIndex: 0 } },
      components: [{ factId: "route.component.0", segmentIndex: 0, startKm: 0, endKm: 30, traversedDistanceKm: 30, hasTraversedDistance: true }],
    },
    derivedFacts: {
      verticalProgression: {
        basis: "route-dynamics-smoothed-profile",
        early: { factId: "progression.early", gainM: 600, lossM: 0 },
        middle: { factId: "progression.middle", gainM: 100, lossM: 0 },
        late: { factId: "progression.late", gainM: 0, lossM: 900 },
      },
      sections: [section],
      keyMoments: [
        { factId: "key.climb.s0.segment-0-dynamic-event-1", kind: "climb", roles: ["longest", "largest"], segmentIndex: 0, startKm: 1, endKm: 5, distanceKm: 4, elevationChangeM: 300 },
        { factId: "key.descent.s0.segment-0-dynamic-event-2", kind: "descent", roles: ["longest"], segmentIndex: 0, startKm: 5, endKm: 10, distanceKm: 5, elevationChangeM: 400 },
      ],
    },
    evidenceScopedFacts: {
      osmSurface: {
        requestState: "received",
        responseAvailability: "available",
        sections: [{ factId: `surface.${sectionId}`, sectionFactId: sectionId, status: "partial", classifiableCoveragePercent: 0.5, categories: [{ category: "gravel", shareOfClassifiableEvidencePercent: 100 }] }],
      },
    },
    ...overrides,
  };
}

function observation(claimType, supportingFactIds, extras = {}) {
  return {
    claimType,
    supportingFactIds,
    phase: null,
    direction: null,
    transition: null,
    role: null,
    terrainCategory: null,
    ...extras,
  };
}

function candidate(observations, headlineObservationIndex = 0, schemaVersion = 1) {
  return { schemaVersion, headlineObservationIndex, observations };
}

function successfulResponse(parsed) {
  return {
    status: "completed",
    incomplete_details: null,
    output: [{ type: "message", content: [{ type: "output_text", text: "unused" }] }],
    output_parsed: parsed,
    model: COURSE_BRIEF_MODEL,
    _request_id: "req_test_01",
    usage: { input_tokens: 150, output_tokens: 90, total_tokens: 240, input_tokens_details: { cached_tokens: 10 }, output_tokens_details: { reasoning_tokens: 4 } },
  };
}

function providerFrom(result) {
  return { async generate() { return result; } };
}

function metadata(overrides = {}) {
  return {
    provider: "openai", model: COURSE_BRIEF_MODEL, durationMs: 12, requestId: "req_test_01",
    usage: { inputTokens: 10, outputTokens: 8, totalTokens: 18, cachedInputTokens: 2, reasoningTokens: 0 }, ...overrides,
  };
}

function post(handler, body, headers = {}) {
  return handler(new Request("http://localhost/api/course-brief", {
    method: "POST", headers: { "Content-Type": "application/json", ...headers }, body,
  }));
}

test("valid CourseBriefInputV1 passes strict runtime validation", () => {
  const result = validateCourseBriefInput(BASE_INPUT);
  assert.equal(result.ok, true);
  assert.equal(result.input.schemaVersion, 1);
  assert.equal(courseBriefInputSchema.safeParse(BASE_INPUT).success, true);
});

test("runtime validation accepts the current Istria CourseBriefInputV1 projection", async () => {
  const gpx = await readFile(new URL("../public/ISTRIA_110K_2027.gpx", import.meta.url), "utf8");
  const input = buildCourseBriefInput(analyzeGpxRoute(parseGpxText(gpx)), { analysisVersion: 2 });
  const result = validateCourseBriefInput(input);
  assert.equal(result.ok, true, result.ok ? "" : result.error);
  assert.equal(result.input.schemaVersion, 1);
});

test("input validation rejects wrong version, malformed nested data, unknown fields, invalid enums, and non-finite values", () => {
  assert.equal(validateCourseBriefInput({ ...BASE_INPUT, schemaVersion: 2 }).ok, false);
  assert.equal(validateCourseBriefInput({ ...BASE_INPUT, unexpected: true }).ok, false);
  assert.equal(validateCourseBriefInput({ ...BASE_INPUT, derivedFacts: { ...BASE_INPUT.derivedFacts, sections: [{ ...BASE_INPUT.derivedFacts.sections[0], rhythm: "technical" }] } }).ok, false);
  assert.equal(validateCourseBriefInput({ ...BASE_INPUT, directFacts: { ...BASE_INPUT.directFacts, distance: { factId: "route.distance", value: { km: Number.NaN } } } }).ok, false);
  assert.equal(validateCourseBriefInput({ ...BASE_INPUT, directFacts: { ...BASE_INPUT.directFacts, rawGain: { factId: "route.raw-gain", value: { m: Number.POSITIVE_INFINITY } } } }).ok, false);
  assert.equal(validateCourseBriefInput({ ...BASE_INPUT, derivedFacts: { ...BASE_INPUT.derivedFacts, sections: [{}] } }).ok, false);
});

test("input validation rejects excessive arrays, malformed IDs, duplicate IDs, and inconsistent ranges", () => {
  const manySections = Array.from({ length: 129 }, (_, index) => ({ ...BASE_INPUT.derivedFacts.sections[0], ordinal: index + 1 }));
  assert.equal(validateCourseBriefInput({ ...BASE_INPUT, derivedFacts: { ...BASE_INPUT.derivedFacts, sections: manySections } }).ok, false);
  assert.equal(validateCourseBriefInput({ ...BASE_INPUT, derivedFacts: { ...BASE_INPUT.derivedFacts, sections: [{ ...BASE_INPUT.derivedFacts.sections[0], factId: "bad id" }] } }).ok, false);
  assert.equal(validateCourseBriefInput({ ...BASE_INPUT, derivedFacts: { ...BASE_INPUT.derivedFacts, keyMoments: [{ ...BASE_INPUT.derivedFacts.keyMoments[0], factId: "route.distance" }] } }).ok, false);
  assert.equal(validateCourseBriefInput({ ...BASE_INPUT, derivedFacts: { ...BASE_INPUT.derivedFacts, sections: [{ ...BASE_INPUT.derivedFacts.sections[0], endKm: 31 }] } }).ok, false);
});

test("fact index maps known fact kinds and retains segment and OSM section scope", () => {
  const index = buildCourseBriefFactIndex(BASE_INPUT);
  assert.ok(index);
  assert.equal(index.get("key.climb.s0.segment-0-dynamic-event-1").kind, "keyMoment");
  assert.equal(index.get("key.climb.s0.segment-0-dynamic-event-1").segmentIndex, 0);
  assert.equal(index.get(`surface.${BASE_INPUT.derivedFacts.sections[0].factId}`).kind, "osmSurfaceSection");
  assert.equal(index.get(`surface.${BASE_INPUT.derivedFacts.sections[0].factId}`).sectionFactId, BASE_INPUT.derivedFacts.sections[0].factId);
});

test("all V1 claim types validate from their required fact kinds", () => {
  const cases = [
    observation("vertical_concentration", PROGRESSION_IDS, { phase: "early", direction: "climb" }),
    observation("vertical_transition", PROGRESSION_IDS, { transition: "climb-to-descent" }),
    observation("key_moment", [BASE_INPUT.derivedFacts.keyMoments[0].factId], { direction: "climb", role: "longest" }),
    observation("highest_point", ["route.highest"]),
    observation("lowest_point", ["route.lowest"]),
    observation("osm_surface_category", [BASE_INPUT.evidenceScopedFacts.osmSurface.sections[0].factId], { terrainCategory: "gravel" }),
  ];
  for (const item of cases) {
    const result = validateCourseBriefCandidate(candidate([item]), BASE_INPUT);
    assert.equal(result.ok, true, item.claimType);
    assert.equal(renderCourseBrief(result.brief, BASE_INPUT).observations.length, 1, `${item.claimType} renders after validation`);
  }
});

test("opposite-direction concentration and transition claims are supported when facts prove them", () => {
  const descendingConcentration = makeInput({ derivedFacts: { ...BASE_INPUT.derivedFacts, verticalProgression: {
    ...BASE_INPUT.derivedFacts.verticalProgression,
    early: { factId: "progression.early", gainM: 0, lossM: 50 },
    middle: { factId: "progression.middle", gainM: 0, lossM: 100 },
    late: { factId: "progression.late", gainM: 0, lossM: 400 },
  } } });
  assert.equal(validateCourseBriefCandidate(candidate([observation("vertical_concentration", PROGRESSION_IDS, { phase: "late", direction: "descent" })]), descendingConcentration).ok, true);

  const reverseTransition = makeInput({ derivedFacts: { ...BASE_INPUT.derivedFacts, verticalProgression: {
    ...BASE_INPUT.derivedFacts.verticalProgression,
    early: { factId: "progression.early", gainM: 0, lossM: 300 },
    middle: { factId: "progression.middle", gainM: 0, lossM: 50 },
    late: { factId: "progression.late", gainM: 250, lossM: 0 },
  } } });
  assert.equal(validateCourseBriefCandidate(candidate([observation("vertical_transition", PROGRESSION_IDS, { transition: "descent-to-climb" })]), reverseTransition).ok, true);
});

test("claim validation fails closed for missing IDs, wrong fact kinds, invalid parameters, and bad headline indexes", () => {
  assert.equal(validateCourseBriefCandidate(candidate([observation("highest_point", ["route.absent"])]), BASE_INPUT).error, "invalid_provider_response");
  assert.equal(validateCourseBriefCandidate(candidate([observation("highest_point", ["route.distance"])]), BASE_INPUT).error, "unsupported_generated_claim");
  assert.equal(validateCourseBriefCandidate(candidate([observation("vertical_concentration", PROGRESSION_IDS, { phase: "late", direction: "climb" })]), BASE_INPUT).error, "unsupported_generated_claim");
  assert.equal(validateCourseBriefCandidate(candidate([observation("vertical_transition", PROGRESSION_IDS, { transition: "descent-to-climb" })]), BASE_INPUT).error, "unsupported_generated_claim");
  assert.equal(validateCourseBriefCandidate(candidate([observation("highest_point", ["route.highest"])], 1), BASE_INPUT).error, "invalid_provider_response");
  assert.equal(validateCourseBriefCandidate(candidate([observation("highest_point", ["route.highest"])], 0, 2), BASE_INPUT).error, "invalid_provider_response");
});

test("claim redundancy is rejected and headline fact selection remains explicit", () => {
  const high = observation("highest_point", ["route.highest"]);
  assert.equal(validateCourseBriefCandidate(candidate([high, { ...high }]), BASE_INPUT).error, "unsupported_generated_claim");
  const valid = validateCourseBriefCandidate(candidate([observation("lowest_point", ["route.lowest"]), high], 1), BASE_INPUT);
  assert.equal(valid.ok, true);
  assert.equal(valid.brief.headlineObservationIndex, 1);
  const invalids = candidate([
    observation("highest_point", ["route.lowest"]),
    observation("lowest_point", ["route.highest"]),
    observation("key_moment", ["route.distance"], { direction: "climb", role: "longest" }),
  ]);
  assert.equal(validateCourseBriefCandidate(invalids, BASE_INPUT).ok, false);
});

test("segment identity prevents a claim from substituting another equal-kilometer component fact", () => {
  const secondSection = { ...BASE_INPUT.derivedFacts.sections[0], factId: "section.s1.m30000-60000.climb", ordinal: 2, segmentIndex: 1, startKm: 30, endKm: 60 };
  const input = makeInput({
    directFacts: { ...BASE_INPUT.directFacts, distance: { factId: "route.distance", value: { km: 60 } }, components: [
      BASE_INPUT.directFacts.components[0],
      { factId: "route.component.1", segmentIndex: 1, startKm: 30, endKm: 60, traversedDistanceKm: 30, hasTraversedDistance: true },
    ] },
    derivedFacts: { ...BASE_INPUT.derivedFacts, sections: [BASE_INPUT.derivedFacts.sections[0], secondSection] },
    evidenceScopedFacts: { osmSurface: { ...BASE_INPUT.evidenceScopedFacts.osmSurface, sections: [
      BASE_INPUT.evidenceScopedFacts.osmSurface.sections[0],
      { factId: `surface.${secondSection.factId}`, sectionFactId: secondSection.factId, status: "mapped", classifiableCoveragePercent: 100, categories: [{ category: "paved", shareOfClassifiableEvidencePercent: 100 }] },
    ] } },
  });
  const result = validateCourseBriefInput(input);
  assert.equal(result.ok, true);
  const index = buildCourseBriefFactIndex(result.input);
  assert.equal(index.get(`surface.${secondSection.factId}`).segmentIndex, 1);
  assert.equal(validateCourseBriefCandidate(candidate([observation("osm_surface_category", [`surface.${secondSection.factId}`], { terrainCategory: "paved" })]), result.input).ok, true);
});

test("OSM input validation rejects evidence incompatible with global availability", () => {
  const section = BASE_INPUT.evidenceScopedFacts.osmSurface.sections[0];
  const withOsm = (requestState, responseAvailability, surface = section) => makeInput({ evidenceScopedFacts: { osmSurface: {
    requestState, responseAvailability, sections: [surface],
  } } });
  const positive = { ...section, status: "partial", classifiableCoveragePercent: 0.5,
    categories: [{ category: "gravel", shareOfClassifiableEvidencePercent: 100 }] };

  assert.equal(validateCourseBriefInput(withOsm("received", "not-found", positive)).ok, false,
    "reproduces the mismatch where not-found carried positive section evidence");
  assert.equal(validateCourseBriefInput(withOsm("received", "not-applicable", positive)).ok, false);
  assert.equal(validateCourseBriefInput(withOsm("unavailable", null, {
    ...positive, status: "unavailable",
  })).ok, false, "unavailable state cannot carry positive coverage or categories");
  assert.equal(validateCourseBriefInput(withOsm("not-requested", null, {
    ...positive, status: "not-requested",
  })).ok, false, "not-requested state cannot carry positive coverage or categories");
  assert.equal(validateCourseBriefInput(withOsm("received", "available", positive)).ok, true);

  const mapped = { ...section, status: "mapped", classifiableCoveragePercent: 100,
    categories: [{ category: "gravel", shareOfClassifiableEvidencePercent: 100 }] };
  assert.equal(validateCourseBriefInput(withOsm("received", "available", mapped)).ok, true);

  const zeroWithCategory = { ...section, status: "missing", classifiableCoveragePercent: 0,
    categories: [{ category: "gravel", shareOfClassifiableEvidencePercent: 100 }] };
  assert.equal(validateCourseBriefInput(withOsm("received", "available", zeroWithCategory)).ok, false);
  assert.equal(validateCourseBriefInput(withOsm("received", "unknown", positive)).ok, true,
    "received unknown can retain directly observed, section-scoped evidence");
  assert.equal(validateCourseBriefInput(withOsm("not-requested", null, {
    ...section, status: "not-requested", classifiableCoveragePercent: null, categories: [],
  })).ok, true);
});

test("OSM category claims fail closed when global response availability is incompatible", () => {
  const section = BASE_INPUT.evidenceScopedFacts.osmSurface.sections[0];
  const incompatible = makeInput({ evidenceScopedFacts: { osmSurface: {
    requestState: "received", responseAvailability: "not-found",
    sections: [{ ...section, status: "partial", classifiableCoveragePercent: 0.5,
      categories: [{ category: "gravel", shareOfClassifiableEvidencePercent: 100 }] }],
  } } });
  const claim = observation("osm_surface_category", [section.factId], { terrainCategory: "gravel" });
  assert.equal(validateCourseBriefInput(incompatible).ok, false);
  assert.equal(buildCourseBriefFactIndex(incompatible), null);
  assert.equal(validateCourseBriefCandidate(candidate([claim]), incompatible).error, "invalid_provider_response");
  assert.throws(() => renderCourseBrief(candidate([claim]), incompatible), /semantic validation/);

  const validDirect = renderCourseBrief(candidate([claim]), BASE_INPUT);
  assert.match(validDirect.headline.text, /100% is gravel/);
});

test("vertical claim validation rejects concentration ties and flat or tied transitions", () => {
  const tiedConcentration = makeInput({ derivedFacts: { ...BASE_INPUT.derivedFacts, verticalProgression: {
    basis: "route-dynamics-smoothed-profile",
    early: { factId: "progression.early", gainM: 500, lossM: 0 },
    middle: { factId: "progression.middle", gainM: 250, lossM: 0 },
    late: { factId: "progression.late", gainM: 250, lossM: 0 },
  } } });
  assert.equal(validateCourseBriefCandidate(candidate([observation("vertical_concentration", PROGRESSION_IDS,
    { phase: "early", direction: "climb" })]), tiedConcentration).error, "unsupported_generated_claim");

  const flat = makeInput({ derivedFacts: { ...BASE_INPUT.derivedFacts, verticalProgression: {
    basis: "route-dynamics-smoothed-profile",
    early: { factId: "progression.early", gainM: 0, lossM: 0 },
    middle: { factId: "progression.middle", gainM: 0, lossM: 0 },
    late: { factId: "progression.late", gainM: 0, lossM: 0 },
  } } });
  assert.equal(validateCourseBriefCandidate(candidate([observation("vertical_transition", PROGRESSION_IDS,
    { transition: "climb-to-descent" })]), flat).error, "unsupported_generated_claim");

  const tiedLateDirection = makeInput({ derivedFacts: { ...BASE_INPUT.derivedFacts, verticalProgression: {
    basis: "route-dynamics-smoothed-profile",
    early: { factId: "progression.early", gainM: 300, lossM: 0 },
    middle: { factId: "progression.middle", gainM: 0, lossM: 0 },
    late: { factId: "progression.late", gainM: 100, lossM: 100 },
  } } });
  assert.equal(validateCourseBriefCandidate(candidate([observation("vertical_transition", PROGRESSION_IDS,
    { transition: "climb-to-descent" })]), tiedLateDirection).error, "unsupported_generated_claim");
});

test("partial and sub-one-percent OSM claims remain evidence-scoped; zero coverage cannot support a claim", () => {
  const surfaceId = BASE_INPUT.evidenceScopedFacts.osmSurface.sections[0].factId;
  const partialClaim = observation("osm_surface_category", [surfaceId], { terrainCategory: "gravel" });
  const valid = validateCourseBriefCandidate(candidate([partialClaim]), BASE_INPUT);
  assert.equal(valid.ok, true);
  const rendered = renderCourseBrief(valid.brief, BASE_INPUT);
  assert.match(rendered.headline.text, /mapped and classifiable OSM evidence/);
  assert.match(rendered.headline.text, /<1% of this section/);
  assert.match(rendered.headline.text, /100% is gravel/);

  const zeroCoverage = makeInput({ evidenceScopedFacts: { osmSurface: {
    requestState: "received", responseAvailability: "available",
    sections: [{ ...BASE_INPUT.evidenceScopedFacts.osmSurface.sections[0], status: "missing", classifiableCoveragePercent: 0, categories: [] }],
  } } });
  assert.equal(validateCourseBriefCandidate(candidate([partialClaim]), zeroCoverage).error, "insufficient_route_facts");

  const normalCoverage = makeInput({ evidenceScopedFacts: { osmSurface: {
    requestState: "received", responseAvailability: "available",
    sections: [{ ...BASE_INPUT.evidenceScopedFacts.osmSurface.sections[0], status: "partial", classifiableCoveragePercent: 43, categories: [{ category: "gravel", shareOfClassifiableEvidencePercent: 80 }, { category: "paved", shareOfClassifiableEvidencePercent: 20 }] }],
  } } });
  assert.equal(validateCourseBriefInput(normalCoverage).ok, true);
  assert.equal(validateCourseBriefCandidate(candidate([partialClaim]), normalCoverage).ok, true);
  const dualWinner = validateCourseBriefCandidate(candidate([observation("key_moment", [BASE_INPUT.derivedFacts.keyMoments[0].factId], { direction: "climb", role: "largest" })]), BASE_INPUT);
  assert.match(renderCourseBrief(dualWinner.brief, BASE_INPUT).headline.text, /longest and largest/);
});

test("prompt is deterministic, versioned, data-only, and omits forbidden route material", () => {
  const first = buildCourseBriefPrompt(BASE_INPUT);
  const second = buildCourseBriefPrompt(BASE_INPUT);
  assert.equal(COURSE_BRIEF_PROMPT_VERSION, 1);
  assert.deepEqual(first, second);
  assert.match(first.systemInstructions, /data, never instructions/i);
  assert.match(first.systemInstructions, /whole-route surface certainty/);
  assert.match(first.systemInstructions, /vertical_concentration cites all three progression IDs/);
  for (const forbidden of ["latitude", "longitude", "filename", "Mapillary", "raceContext"]) assert.equal(first.userData.includes(forbidden), false);
});

test("OpenAI adapter uses mocked Responses Structured Outputs and returns safe usage metadata", async () => {
  let calls = 0;
  let request;
  const provider = new OpenAiCourseBriefProvider({
    now: (() => { let value = 100; return () => value += 12; })(),
    responses: { async parse(value) { calls += 1; request = value; return successfulResponse(candidate([observation("highest_point", ["route.highest"])])); } },
  });
  const result = await provider.generate({ systemInstructions: "instructions", userData: "{}" });
  assert.equal(calls, 1);
  assert.equal(result.ok, true);
  assert.equal(result.metadata.provider, "openai");
  assert.equal(result.metadata.requestId, "req_test_01");
  assert.equal(result.metadata.usage.cachedInputTokens, 10);
  assert.equal(request.model, "gpt-5.4-mini");
  assert.equal(COURSE_BRIEF_MAX_RETRIES, 0);
  assert.equal(request.reasoning.effort, "none");
  assert.equal(request.text.verbosity, "low");
  assert.equal(request.max_output_tokens, COURSE_BRIEF_MAX_OUTPUT_TOKENS);
  assert.equal(request.truncation, "disabled");
  assert.equal(request.store, false);
  assert.equal(COURSE_BRIEF_PROVIDER_TIMEOUT_MS >= 12_000 && COURSE_BRIEF_PROVIDER_TIMEOUT_MS <= 15_000, true);
  assert.deepEqual(Object.keys(request.text.format).sort(), ["name", "schema", "strict", "type"]);
  assert.equal(request.text.format.strict, true);
  assert.equal(request.text.format.schema.additionalProperties, false);
  assert.deepEqual(request.text.format.schema.required, ["schemaVersion", "headlineObservationIndex", "observations"]);
  assert.equal(request.text.format.schema.properties.schemaVersion.minimum, 1);
  assert.equal(request.text.format.schema.properties.schemaVersion.maximum, 1);
  assert.equal("const" in request.text.format.schema.properties.schemaVersion, false);
  assert.equal(request.text.format.schema.properties.observations.maxItems, 3);
  assert.deepEqual(request.text.format.schema.properties.observations.items.required, [
    "claimType", "supportingFactIds", "phase", "direction", "transition", "role", "terrainCategory",
  ]);
});

test("OpenAI adapter handles missing key, refusal, incomplete, and missing parsed output", async () => {
  const missing = await new OpenAiCourseBriefProvider().generate({ systemInstructions: "", userData: "{}" });
  assert.equal(missing.ok, false);
  assert.equal(missing.error, "provider_not_configured");

  const refusal = successfulResponse(null);
  refusal.output = [{ type: "message", content: [{ type: "refusal", refusal: "private provider text" }] }];
  const refused = await new OpenAiCourseBriefProvider({ responses: { async parse() { return refusal; } } }).generate({ systemInstructions: "", userData: "{}" });
  assert.equal(refused.ok, false);
  assert.equal(refused.error, "refusal_or_incomplete");
  assert.equal(JSON.stringify(refused).includes("private provider text"), false);

  const incomplete = successfulResponse(candidate([observation("highest_point", ["route.highest"])]));
  incomplete.status = "incomplete";
  incomplete.incomplete_details = { reason: "max_output_tokens" };
  const partial = await new OpenAiCourseBriefProvider({ responses: { async parse() { return incomplete; } } }).generate({ systemInstructions: "", userData: "{}" });
  assert.equal(partial.error, "refusal_or_incomplete");

  const malformed = await new OpenAiCourseBriefProvider({ responses: { async parse() { return successfulResponse({ invalid: true }); } } }).generate({ systemInstructions: "", userData: "{}" });
  assert.equal(malformed.ok, true);
  assert.equal(validateCourseBriefCandidate(malformed.candidate, BASE_INPUT).error, "invalid_provider_response");
});

test("OpenAI adapter categorizes timeout, 429, and provider 5xx without retries", async () => {
  let calls = 0;
  const timedOut = await new OpenAiCourseBriefProvider({ responses: { async parse() { calls += 1; throw new APIConnectionTimeoutError(); } } }).generate({ systemInstructions: "", userData: "{}" });
  assert.equal(timedOut.error, "timeout");
  const rateLimited = await new OpenAiCourseBriefProvider({ responses: { async parse() { calls += 1; throw new APIError(429, {}, "hidden", new Headers({ "retry-after": "7" })); } } }).generate({ systemInstructions: "", userData: "{}" });
  assert.equal(rateLimited.error, "rate_limited");
  assert.equal(rateLimited.retryAfterSeconds, 7);
  const unavailable = await new OpenAiCourseBriefProvider({ responses: { async parse() { calls += 1; throw new APIError(503, {}, "hidden", new Headers()); } } }).generate({ systemInstructions: "", userData: "{}" });
  assert.equal(unavailable.error, "provider_unavailable");
  assert.equal(JSON.stringify([timedOut, rateLimited, unavailable]).includes("hidden"), false);
  assert.equal(calls, 3);
  assert.equal(COURSE_BRIEF_PROVIDER_TIMEOUT_MS, 13_500);
});

test("generation returns deterministic 1- and 3-claim results and emits metadata only", async () => {
  const first = observation("highest_point", ["route.highest"]);
  const third = observation("key_moment", [BASE_INPUT.derivedFacts.keyMoments[1].factId], { direction: "descent", role: "longest" });
  const provider = providerFrom({ ok: true, candidate: candidate([first, third, observation("lowest_point", ["route.lowest"])], 1), metadata: metadata() });
  const events = [];
  const a = await generateCourseBrief(BASE_INPUT, provider, (event) => events.push(event));
  const b = await generateCourseBrief(BASE_INPUT, provider);
  assert.equal(a.ok, true);
  assert.equal(a.brief.observations.length, 3);
  assert.deepEqual(a, b);
  assert.equal(a.rendered.headline.claimType, "key_moment");
  assert.equal(events[0].inputTokens, 10);
  assert.equal("userData" in events[0], false);
  assert.equal("providerOutput" in events[0], false);
  const one = await generateCourseBrief(BASE_INPUT, providerFrom({ ok: true, candidate: candidate([first]), metadata: metadata() }));
  assert.equal(one.brief.observations.length, 1);
});

test("generation rejects invalid input before provider call and maps provider/configuration failures", async () => {
  let calls = 0;
  const unusedProvider = { async generate() { calls += 1; throw new Error("secret text"); } };
  assert.equal((await generateCourseBrief({ ...BASE_INPUT, schemaVersion: 2 }, unusedProvider)).error, "invalid_input");
  assert.equal(calls, 0);
  assert.equal((await generateCourseBrief(BASE_INPUT, unusedProvider)).error, "provider_unavailable");
  const missing = await generateCourseBrief(BASE_INPUT, providerFrom({ ok: false, error: "provider_not_configured", retryable: false, retryAfterSeconds: null, metadata: metadata() }));
  assert.equal(missing.error, "provider_not_configured");
  const allInvalid = await generateCourseBrief(BASE_INPUT, providerFrom({ ok: true, candidate: candidate([observation("highest_point", ["route.lowest"])]), metadata: metadata() }));
  assert.equal(allInvalid.error, "unsupported_generated_claim");
});

test("course brief API enforces body limits and returns sanitized success/error responses", async () => {
  let calls = 0;
  const successHandler = createCourseBriefPostHandler(() => providerFrom({
    ok: true, candidate: candidate([observation("highest_point", ["route.highest"])]), metadata: metadata(),
  }), () => { calls += 1; });
  const tooLarge = await successHandler(new Request("http://localhost/api/course-brief", {
    method: "POST", headers: { "content-length": String(MAX_COURSE_BRIEF_REQUEST_BYTES + 1) }, body: "{}",
  }));
  assert.equal(tooLarge.status, 413);
  assert.equal(calls, 0);
  const streamedLarge = await successHandler(new Request("http://localhost/api/course-brief", {
    method: "POST",
    body: new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(MAX_COURSE_BRIEF_REQUEST_BYTES + 1)); controller.close(); } }),
    duplex: "half",
  }));
  assert.equal(streamedLarge.status, 413);
  assert.equal(calls, 0);

  const malformedJson = await post(successHandler, "{");
  assert.equal(malformedJson.status, 400);
  const valid = await post(successHandler, JSON.stringify(BASE_INPUT));
  const body = await valid.json();
  assert.equal(valid.status, 200);
  assert.equal(valid.headers.get("cache-control"), "no-store");
  assert.equal(body.courseBrief.schemaVersion, 1);
  assert.match(body.rendered.headline.text, /highest point/);
  assert.equal(JSON.stringify(body).includes("req_test_01"), false);

  const rateHandler = createCourseBriefPostHandler(() => providerFrom({
    ok: false, error: "rate_limited", retryable: true, retryAfterSeconds: 7, metadata: metadata(),
  }), () => undefined);
  const limited = await post(rateHandler, JSON.stringify(BASE_INPUT));
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("retry-after"), "7");
  const limitedBody = await limited.json();
  assert.deepEqual(limitedBody, { error: "rate_limited", retryable: true });
  assert.equal(JSON.stringify(limitedBody).includes("hidden"), false);
  assert.equal(calls, 1);
});

test("course brief API trusts actual streamed byte count over missing or incorrect Content-Length", async () => {
  let providerCalls = 0;
  const handler = createCourseBriefPostHandler(() => ({ async generate() {
    providerCalls += 1;
    return { ok: true, candidate: candidate([observation("highest_point", ["route.highest"])]), metadata: metadata() };
  } }), () => undefined);
  const validBody = JSON.stringify(BASE_INPUT);
  const withoutLength = await handler(new Request("http://localhost/api/course-brief", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: validBody,
  }));
  assert.equal(withoutLength.status, 200);

  const undersizedLength = await handler(new Request("http://localhost/api/course-brief", {
    method: "POST", headers: { "Content-Type": "application/json", "Content-Length": "1" }, body: validBody,
  }));
  assert.equal(undersizedLength.status, 200, "an incorrect small header does not reject a bounded actual body");

  const oversizedActualBody = new Uint8Array(MAX_COURSE_BRIEF_REQUEST_BYTES + 1);
  const undersizedLengthLargeStream = await handler(new Request("http://localhost/api/course-brief", {
    method: "POST", headers: { "Content-Type": "application/json", "Content-Length": "1" },
    body: new ReadableStream({ start(controller) { controller.enqueue(oversizedActualBody); controller.close(); } }),
    duplex: "half",
  }));
  assert.equal(undersizedLengthLargeStream.status, 413, "actual streamed bytes enforce the limit even with a false header");
  assert.equal(providerCalls, 2);
});

test("API rejects structural and semantic invalidity before provider work and is ephemeral", async () => {
  let providerCalls = 0;
  let providerFactoryCalls = 0;
  let telemetryCalls = 0;
  const handler = createCourseBriefPostHandler(() => {
    providerFactoryCalls += 1;
    return { async generate() { providerCalls += 1; return { ok: true, candidate: candidate([observation("highest_point", ["route.highest"])]), metadata: metadata() }; } };
  }, () => { telemetryCalls += 1; });
  const invalid = await post(handler, JSON.stringify({ ...BASE_INPUT, extra: "x" }));
  assert.equal(invalid.status, 400);
  assert.equal(providerCalls, 0);
  assert.equal(providerFactoryCalls, 0);
  const success = await post(handler, JSON.stringify(BASE_INPUT));
  assert.equal(success.status, 200);
  assert.equal(providerCalls, 1);
  assert.equal(providerFactoryCalls, 1);
  assert.equal(telemetryCalls, 2);
  assert.equal(success.headers.get("cache-control"), "no-store");
});

test("missing API key is a sanitized unavailable response and performs no network request", async () => {
  const originalFetch = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = async () => { networkCalls += 1; throw new Error("must not execute"); };
  try {
    const handler = createCourseBriefPostHandler(() => new OpenAiCourseBriefProvider(), () => undefined);
    const response = await post(handler, JSON.stringify(BASE_INPUT));
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: "provider_not_configured", retryable: false });
    assert.equal(networkCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
