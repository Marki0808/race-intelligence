import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { APIError, APIConnectionTimeoutError } from "openai";
import { buildCourseBriefFactIndex } from "./courseBriefFactIndex.ts";
import {
  enumerateEligibleCourseBriefClaimOptions,
  validateCourseBriefCandidate,
} from "./courseBriefClaimValidation.ts";
import {
  MAX_COURSE_BRIEF_REQUEST_BYTES,
  courseBriefInputSchema,
  validateCourseBriefInput,
} from "./courseBriefInputValidation.ts";
import { generateCourseBrief } from "./courseBriefGeneration.ts";
import { renderCourseBrief } from "./courseBriefOutput.ts";
import { COURSE_BRIEF_PROMPT_VERSION, buildCourseBriefPrompt } from "./courseBriefPrompt.ts";
import {
  COURSE_BRIEF_SELECTION_SCHEMA_VERSION,
  createCourseBriefSelectionSchema,
  mapCourseBriefSelectionToCandidate,
} from "./courseBriefSelection.ts";
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

function selectionFor(input, observations, headlineSelectionIndex = 0) {
  const options = enumerateEligibleCourseBriefClaimOptions(input);
  const canonical = ({ claimType, supportingFactIds, phase, direction, transition, role, terrainCategory }) =>
    JSON.stringify({ claimType, supportingFactIds, phase, direction, transition, role, terrainCategory });
  const selectedOptionIds = observations.map((target) => {
    const match = options.find((option) => canonical(option) === canonical(target));
    assert.ok(match, `No eligible option for ${JSON.stringify(target)}`);
    return match.optionId;
  });
  return {
    selectionSchemaVersion: COURSE_BRIEF_SELECTION_SCHEMA_VERSION,
    selectedOptionIds,
    headlineSelectionIndex,
  };
}

function successResult(input, observations, headlineSelectionIndex = 0) {
  return {
    ok: true,
    selection: selectionFor(input, observations, headlineSelectionIndex),
    metadata: metadata(),
  };
}

function withVerticalBins(input, gains, losses) {
  const copy = structuredClone(input);
  copy.derivedFacts.verticalProgression = {
    basis: "route-dynamics-smoothed-profile",
    early: { factId: "progression.early", gainM: gains[0], lossM: losses[0] },
    middle: { factId: "progression.middle", gainM: gains[1], lossM: losses[1] },
    late: { factId: "progression.late", gainM: gains[2], lossM: losses[2] },
  };
  return copy;
}

function withKeyMoments(input, keyMoments) {
  const copy = structuredClone(input);
  copy.derivedFacts.keyMoments = keyMoments;
  return copy;
}

function withOsmSurface(input, { requestState, responseAvailability, status, coverage, categories }) {
  const copy = structuredClone(input);
  copy.evidenceScopedFacts.osmSurface = {
    requestState,
    responseAvailability,
    sections: copy.derivedFacts.sections.map((section) => ({
      factId: `surface.${section.factId}`,
      sectionFactId: section.factId,
      status,
      classifiableCoveragePercent: coverage,
      categories,
    })),
  };
  return copy;
}

function optionsOfType(input, claimType) {
  return enumerateEligibleCourseBriefClaimOptions(input).filter((option) => option.claimType === claimType);
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
  const unknownFact = validateCourseBriefCandidate(candidate([observation("highest_point", ["route.absent"])]), BASE_INPUT);
  assert.equal(unknownFact.error, "invalid_provider_response");
  assert.equal("rejection" in unknownFact, false);
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

test("semantic rejection diagnostics distinguish claim rule failures without changing public categories", () => {
  const tiedConcentration = makeInput({ derivedFacts: { ...BASE_INPUT.derivedFacts, verticalProgression: {
    basis: "route-dynamics-smoothed-profile",
    early: { factId: "progression.early", gainM: 500, lossM: 0 },
    middle: { factId: "progression.middle", gainM: 250, lossM: 0 },
    late: { factId: "progression.late", gainM: 250, lossM: 0 },
  } } });
  const concentration = validateCourseBriefCandidate(candidate([
    observation("vertical_concentration", PROGRESSION_IDS, { phase: "early", direction: "climb" }),
  ]), tiedConcentration);
  assert.equal(concentration.error, "unsupported_generated_claim");
  assert.equal(concentration.rejection.code, "vertical_concentration_threshold_failed");
  assert.equal(validateCourseBriefCandidate(candidate([
    observation("vertical_concentration", PROGRESSION_IDS, { direction: "climb" }),
  ]), BASE_INPUT).rejection.code, "vertical_concentration_invalid_parameters");
  assert.equal(validateCourseBriefCandidate(candidate([
    observation("vertical_concentration", ["route.highest", PROGRESSION_IDS[1], PROGRESSION_IDS[2]], { phase: "early", direction: "climb" }),
  ]), BASE_INPUT).rejection.code, "vertical_concentration_invalid_facts");

  const transition = validateCourseBriefCandidate(candidate([
    observation("vertical_transition", PROGRESSION_IDS, { transition: "descent-to-climb" }),
  ]), BASE_INPUT);
  assert.equal(transition.rejection.code, "vertical_transition_direction_failed");
  assert.equal(validateCourseBriefCandidate(candidate([
    observation("vertical_transition", PROGRESSION_IDS, { phase: "early", transition: "climb-to-descent" }),
  ]), BASE_INPUT).rejection.code, "vertical_transition_invalid_parameters");
  assert.equal(validateCourseBriefCandidate(candidate([
    observation("vertical_transition", ["route.highest", PROGRESSION_IDS[1], PROGRESSION_IDS[2]], { transition: "climb-to-descent" }),
  ]), BASE_INPUT).rejection.code, "vertical_transition_invalid_facts");

  const descentId = BASE_INPUT.derivedFacts.keyMoments[1].factId;
  assert.equal(validateCourseBriefCandidate(candidate([
    observation("key_moment", [descentId], { phase: "early", direction: "descent", role: "longest" }),
  ]), BASE_INPUT).rejection.code, "key_moment_invalid_parameters");
  assert.equal(validateCourseBriefCandidate(candidate([
    observation("key_moment", ["route.highest"], { direction: "climb", role: "longest" }),
  ]), BASE_INPUT).rejection.code, "key_moment_invalid_fact");
  const keyDirection = validateCourseBriefCandidate(candidate([
    observation("key_moment", [descentId], { direction: "climb", role: "longest" }),
  ]), BASE_INPUT);
  assert.equal(keyDirection.rejection.code, "key_moment_direction_mismatch");
  const keyRole = validateCourseBriefCandidate(candidate([
    observation("key_moment", [descentId], { direction: "descent", role: "largest" }),
  ]), BASE_INPUT);
  assert.equal(keyRole.rejection.code, "key_moment_role_mismatch");

  const wrongHighestFact = validateCourseBriefCandidate(candidate([
    observation("highest_point", ["route.lowest"]),
  ]), BASE_INPUT);
  assert.equal(wrongHighestFact.rejection.code, "highest_point_invalid_fact");
  const invalidHighestParameters = validateCourseBriefCandidate(candidate([
    observation("highest_point", ["route.highest"], { direction: "climb" }),
  ]), BASE_INPUT);
  assert.equal(invalidHighestParameters.rejection.code, "highest_point_invalid_parameters");
  assert.equal(validateCourseBriefCandidate(candidate([
    observation("lowest_point", ["route.highest"]),
  ]), BASE_INPUT).rejection.code, "lowest_point_invalid_fact");
  assert.equal(validateCourseBriefCandidate(candidate([
    observation("lowest_point", ["route.lowest"], { role: "largest" }),
  ]), BASE_INPUT).rejection.code, "lowest_point_invalid_parameters");

  const surfaceId = BASE_INPUT.evidenceScopedFacts.osmSurface.sections[0].factId;
  const wrongOsmFact = validateCourseBriefCandidate(candidate([
    observation("osm_surface_category", ["route.distance"], { terrainCategory: "gravel" }),
  ]), BASE_INPUT);
  assert.equal(wrongOsmFact.rejection.code, "osm_surface_invalid_fact");
  const invalidOsmParameters = validateCourseBriefCandidate(candidate([
    observation("osm_surface_category", [surfaceId], { terrainCategory: "gravel", direction: "climb" }),
  ]), BASE_INPUT);
  assert.equal(invalidOsmParameters.rejection.code, "osm_surface_invalid_parameters");
  const wrongOsmCategory = validateCourseBriefCandidate(candidate([
    observation("osm_surface_category", [surfaceId], { terrainCategory: "paved" }),
  ]), BASE_INPUT);
  assert.equal(wrongOsmCategory.error, "insufficient_route_facts");
  assert.equal("rejection" in wrongOsmCategory, false,
    "category absence remains insufficient route evidence under existing public semantics");

  const noOsm = makeInput({ evidenceScopedFacts: { osmSurface: {
    requestState: "not-requested", responseAvailability: null,
    sections: [{ ...BASE_INPUT.evidenceScopedFacts.osmSurface.sections[0], status: "not-requested", classifiableCoveragePercent: null, categories: [] }],
  } } });
  const unavailableOsmClaim = validateCourseBriefCandidate(candidate([
    observation("osm_surface_category", [surfaceId], { terrainCategory: "gravel" }),
  ]), noOsm);
  assert.equal(unavailableOsmClaim.error, "insufficient_route_facts");
  assert.equal("rejection" in unavailableOsmClaim, false,
    "existing insufficient-evidence behavior is not mislabeled as unsupported generated semantics");
});

test("semantic diagnostics identify the first rejected observation with compact normalized metadata", () => {
  const validHighest = observation("highest_point", ["route.highest"]);
  const rejectedKeyMoment = observation("key_moment", [BASE_INPUT.derivedFacts.keyMoments[1].factId], {
    direction: "descent", role: "largest",
  });
  const result = validateCourseBriefCandidate(candidate([validHighest, rejectedKeyMoment]), BASE_INPUT);
  assert.equal(result.error, "unsupported_generated_claim");
  assert.deepEqual(result.rejection, {
    observationIndex: 1,
    claimType: "key_moment",
    supportingFactIds: [BASE_INPUT.derivedFacts.keyMoments[1].factId],
    parameters: { phase: null, direction: "descent", transition: null, role: "largest", terrainCategory: null },
    code: "key_moment_role_mismatch",
  });
});

test("redundant observations report the later observation and the specific redundancy rule", () => {
  const highest = observation("highest_point", ["route.highest"]);
  const duplicateClaim = validateCourseBriefCandidate(candidate([highest, { ...highest }]), BASE_INPUT);
  assert.equal(duplicateClaim.rejection.code, "duplicate_claim");
  assert.equal(duplicateClaim.rejection.observationIndex, 1);

  const key = BASE_INPUT.derivedFacts.keyMoments[0];
  const duplicateKey = validateCourseBriefCandidate(candidate([
    observation("key_moment", [key.factId], { direction: "climb", role: "longest" }),
    observation("key_moment", [key.factId], { direction: "climb", role: "largest" }),
  ]), BASE_INPUT);
  assert.equal(duplicateKey.rejection.code, "duplicate_key_moment");
  assert.equal(duplicateKey.rejection.observationIndex, 1);

  const surfaceId = BASE_INPUT.evidenceScopedFacts.osmSurface.sections[0].factId;
  const surface = observation("osm_surface_category", [surfaceId], { terrainCategory: "gravel" });
  const duplicateOsm = validateCourseBriefCandidate(candidate([surface, { ...surface }]), BASE_INPUT);
  assert.equal(duplicateOsm.rejection.code, "duplicate_osm_claim");
  assert.equal(duplicateOsm.rejection.observationIndex, 1);

  const transition = observation("vertical_transition", PROGRESSION_IDS, { transition: "climb-to-descent" });
  const duplicateTransition = validateCourseBriefCandidate(candidate([transition, { ...transition }]), BASE_INPUT);
  assert.equal(duplicateTransition.rejection.code, "duplicate_vertical_transition");
  assert.equal(duplicateTransition.rejection.observationIndex, 1);
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

test("eligible options use the final semantic evaluator and deterministic request-scoped IDs", () => {
  const first = enumerateEligibleCourseBriefClaimOptions(BASE_INPUT);
  const second = enumerateEligibleCourseBriefClaimOptions(BASE_INPUT);
  assert.deepEqual(first, second);
  assert.ok(first.length > 0);
  assert.deepEqual(first.map(({ optionId }) => optionId), first.map((_, index) => `option-${index}`));
  assert.ok(first.some((option) => option.claimType === "highest_point"));
  assert.ok(first.some((option) => option.claimType === "key_moment"));
  assert.ok(first.some((option) => option.claimType === "osm_surface_category"));
});

test("concentration enumeration includes only strict qualifying phase and direction options", () => {
  const qualifyingClimb = withVerticalBins(BASE_INPUT, [50, 20, 20], [0, 0, 0]);
  assert.deepEqual(optionsOfType(qualifyingClimb, "vertical_concentration").map(({ phase, direction }) => ({ phase, direction })), [
    { phase: "early", direction: "climb" },
  ]);

  const climbTie = withVerticalBins(BASE_INPUT, [40, 20, 20], [0, 0, 0]);
  assert.equal(optionsOfType(climbTie, "vertical_concentration").some(({ phase, direction }) => phase === "early" && direction === "climb"), false);
  const belowClimb = withVerticalBins(BASE_INPUT, [39, 20, 20], [0, 0, 0]);
  assert.equal(optionsOfType(belowClimb, "vertical_concentration").some(({ phase, direction }) => phase === "early" && direction === "climb"), false);

  const qualifyingDescent = withVerticalBins(BASE_INPUT, [0, 0, 0], [50, 20, 20]);
  assert.deepEqual(optionsOfType(qualifyingDescent, "vertical_concentration").map(({ phase, direction }) => ({ phase, direction })), [
    { phase: "early", direction: "descent" },
  ]);
  const descentTie = withVerticalBins(BASE_INPUT, [0, 0, 0], [40, 20, 20]);
  assert.equal(optionsOfType(descentTie, "vertical_concentration").some(({ phase, direction }) => phase === "early" && direction === "descent"), false);
});

test("transition enumeration preserves strict opposite early/late dominance and excludes ties", () => {
  const climbToDescent = withVerticalBins(BASE_INPUT, [50, 0, 0], [0, 0, 50]);
  assert.deepEqual(optionsOfType(climbToDescent, "vertical_transition").map(({ transition }) => transition), ["climb-to-descent"]);

  const descentToClimb = withVerticalBins(BASE_INPUT, [0, 0, 50], [50, 0, 0]);
  assert.deepEqual(optionsOfType(descentToClimb, "vertical_transition").map(({ transition }) => transition), ["descent-to-climb"]);

  for (const input of [
    withVerticalBins(BASE_INPUT, [20, 0, 0], [20, 0, 50]),
    withVerticalBins(BASE_INPUT, [50, 0, 20], [0, 0, 20]),
    withVerticalBins(BASE_INPUT, [50, 0, 50], [0, 0, 20]),
  ]) {
    assert.deepEqual(optionsOfType(input, "vertical_transition"), []);
  }
});

test("Key Moment enumeration uses each deterministic fact direction and declared roles only", () => {
  const input = withKeyMoments(BASE_INPUT, [
    { factId: "key.climb.s0.fixture-climb-longest", kind: "climb", roles: ["longest"], segmentIndex: 0, startKm: 1, endKm: 3, distanceKm: 2, elevationChangeM: 90 },
    { factId: "key.descent.s0.fixture-descent-largest", kind: "descent", roles: ["largest"], segmentIndex: 0, startKm: 4, endKm: 6, distanceKm: 2, elevationChangeM: 100 },
    { factId: "key.climb.s0.fixture-climb-dual", kind: "climb", roles: ["longest", "largest"], segmentIndex: 0, startKm: 7, endKm: 9, distanceKm: 2, elevationChangeM: 110 },
  ]);
  assert.deepEqual(optionsOfType(input, "key_moment").map(({ supportingFactIds, direction, role }) => ({ factId: supportingFactIds[0], direction, role })), [
    { factId: input.derivedFacts.keyMoments[0].factId, direction: "climb", role: "longest" },
    { factId: input.derivedFacts.keyMoments[1].factId, direction: "descent", role: "largest" },
    { factId: input.derivedFacts.keyMoments[2].factId, direction: "climb", role: "longest" },
    { factId: input.derivedFacts.keyMoments[2].factId, direction: "climb", role: "largest" },
  ]);
});

test("extrema enumeration contains only canonical highest and lowest facts with null parameters", () => {
  const input = withKeyMoments(BASE_INPUT, [
    { factId: "key.climb.s0.fixture-climb", kind: "climb", roles: ["longest"], segmentIndex: 0, startKm: 1, endKm: 3, distanceKm: 2, elevationChangeM: 100 },
  ]);
  const highest = optionsOfType(input, "highest_point");
  const lowest = optionsOfType(input, "lowest_point");
  assert.equal(highest.length, 1);
  assert.equal(lowest.length, 1);
  assert.deepEqual(highest[0], {
    optionId: highest[0].optionId,
    claimType: "highest_point",
    supportingFactIds: [input.directFacts.highest.factId],
    phase: null, direction: null, transition: null, role: null, terrainCategory: null,
  });
  assert.deepEqual(lowest[0], {
    optionId: lowest[0].optionId,
    claimType: "lowest_point",
    supportingFactIds: [input.directFacts.lowest.factId],
    phase: null, direction: null, transition: null, role: null, terrainCategory: null,
  });
  assert.equal(highest[0].supportingFactIds.includes(input.directFacts.distance.factId), false);
});

test("OSM enumeration requires received positive scoped evidence and an actually present category", () => {
  const gravel = [{ category: "gravel", shareOfClassifiableEvidencePercent: 100 }];
  const valid = withOsmSurface(BASE_INPUT, {
    requestState: "received", responseAvailability: "available", status: "partial", coverage: 12, categories: gravel,
  });
  assert.deepEqual(optionsOfType(valid, "osm_surface_category").map(({ terrainCategory }) => terrainCategory), ["gravel"]);
  assert.equal(optionsOfType(valid, "osm_surface_category").some(({ terrainCategory }) => terrainCategory === "paved"), false);

  const casesWithoutOsm = [
    withOsmSurface(BASE_INPUT, { requestState: "not-requested", responseAvailability: null, status: "not-requested", coverage: null, categories: [] }),
    withOsmSurface(BASE_INPUT, { requestState: "unavailable", responseAvailability: null, status: "unavailable", coverage: null, categories: [] }),
    withOsmSurface(BASE_INPUT, { requestState: "received", responseAvailability: "not-found", status: "missing", coverage: 0, categories: [] }),
    withOsmSurface(BASE_INPUT, { requestState: "received", responseAvailability: "available", status: "missing", coverage: 0, categories: [] }),
  ];
  for (const input of casesWithoutOsm) assert.deepEqual(optionsOfType(input, "osm_surface_category"), []);
});

test("selection mapping accepts only eligible IDs and valid bounded headline references", async () => {
  const options = enumerateEligibleCourseBriefClaimOptions(BASE_INPUT);
  const valid = {
    selectionSchemaVersion: 1,
    selectedOptionIds: [options[0].optionId],
    headlineSelectionIndex: 0,
  };
  const mapped = mapCourseBriefSelectionToCandidate(valid, options);
  assert.equal(mapped.ok, true);
  assert.deepEqual(mapped.candidate.observations[0], {
    claimType: options[0].claimType,
    supportingFactIds: options[0].supportingFactIds,
    phase: options[0].phase,
    direction: options[0].direction,
    transition: options[0].transition,
    role: options[0].role,
    terrainCategory: options[0].terrainCategory,
  });
  for (const invalid of [
    { ...valid, selectedOptionIds: ["unknown-option"] },
    { ...valid, selectedOptionIds: [] },
    { ...valid, selectedOptionIds: [options[0].optionId, options[1].optionId, options[2].optionId, options[3].optionId] },
    { ...valid, headlineSelectionIndex: 1 },
    { ...valid, selectionSchemaVersion: 2 },
    { ...valid, claimType: "highest_point" },
  ]) {
    assert.equal(mapCourseBriefSelectionToCandidate(invalid, options).error, "invalid_provider_response");
  }

  const duplicateId = [{ ...options[0], optionId: "same" }, { ...options[1], optionId: "same" }];
  assert.equal(mapCourseBriefSelectionToCandidate(valid, duplicateId).error, "invalid_provider_response");
  assert.equal(createCourseBriefSelectionSchema(["one"]).safeParse(valid).success, false);
  const repeatedSelection = await generateCourseBrief(BASE_INPUT, providerFrom({
    ok: true,
    selection: { ...valid, selectedOptionIds: [options[0].optionId, options[0].optionId] },
    metadata: metadata(),
  }));
  assert.equal(repeatedSelection.error, "unsupported_generated_claim");
});

test("Istria eligible options contain only canonically supported deterministic claims", async () => {
  const gpx = await readFile(new URL("../public/ISTRIA_110K_2027.gpx", import.meta.url), "utf8");
  const analysis = analyzeGpxRoute(parseGpxText(gpx));
  const input = buildCourseBriefInput(analysis, {
    analysisVersion: 2,
    osm: { requestState: "not-requested" },
  });
  assert.equal(validateCourseBriefInput(input).ok, true);
  const options = enumerateEligibleCourseBriefClaimOptions(input);
  assert.ok(options.length > 0);
  assert.equal(optionsOfType(input, "osm_surface_category").length, 0);
  assert.equal(optionsOfType(input, "vertical_concentration").length, 0);
  assert.deepEqual(options.filter(({ claimType }) => claimType === "vertical_transition").map(({ transition }) => transition), ["climb-to-descent"]);
  const keyOptions = optionsOfType(input, "key_moment");
  assert.equal(keyOptions.length, 4);
  assert.deepEqual(keyOptions.map(({ supportingFactIds, direction, role }) => ({ factId: supportingFactIds[0], direction, role })),
    input.derivedFacts.keyMoments.flatMap((moment) => moment.roles.map((role) => ({ factId: moment.factId, direction: moment.kind, role }))));
  assert.ok(keyOptions.some(({ direction }) => direction === "climb"));
  assert.ok(keyOptions.some(({ direction }) => direction === "descent"));
  assert.equal(optionsOfType(input, "highest_point").length, 1);
  assert.equal(optionsOfType(input, "lowest_point").length, 1);
  assert.equal(input.analysisVersion, 2);
  assert.equal(input.evidenceScopedFacts.osmSurface.requestState, "not-requested");
});

test("prompt is deterministic, versioned, data-only, and contains only canonical eligible options", () => {
  const options = enumerateEligibleCourseBriefClaimOptions(BASE_INPUT);
  const first = buildCourseBriefPrompt(BASE_INPUT, options);
  const second = buildCourseBriefPrompt(BASE_INPUT, options);
  assert.equal(COURSE_BRIEF_PROMPT_VERSION, 2);
  assert.deepEqual(first, second);
  assert.match(first.systemInstructions, /eligibleOptions only/i);
  assert.match(first.systemInstructions, /zero-based index/i);
  assert.match(first.systemInstructions, /do not author or alter claim types/i);
  assert.ok(first.systemInstructions.includes(`selectionSchemaVersion ${COURSE_BRIEF_SELECTION_SCHEMA_VERSION}`));
  const promptData = JSON.parse(first.userData);
  assert.deepEqual(promptData.eligibleOptions, options);
  for (const forbidden of ["latitude", "longitude", "filename", "Mapillary", "raceContext"]) assert.equal(first.userData.includes(forbidden), false);
});

test("request-specific selection schema binds exact eligible IDs and returns safe usage metadata", async () => {
  const optionIds = ["option-0", "option-1"];
  const optionSchema = createCourseBriefSelectionSchema(optionIds).toJSONSchema();
  assert.equal(optionSchema.additionalProperties, false);
  assert.deepEqual(optionSchema.required, ["selectionSchemaVersion", "selectedOptionIds", "headlineSelectionIndex"]);
  assert.deepEqual(optionSchema.properties.selectedOptionIds.items.enum, optionIds);
  assert.equal(optionSchema.properties.selectionSchemaVersion.minimum, 1);
  assert.equal(optionSchema.properties.selectionSchemaVersion.maximum, 1);
  assert.equal(optionSchema.properties.headlineSelectionIndex.maximum, 2);
  assert.equal(optionSchema.properties.selectedOptionIds.maxItems, 3);
  assert.equal(optionSchema.properties.selectedOptionIds.minItems, 1);

  let calls = 0;
  let request;
  const provider = new OpenAiCourseBriefProvider({
    now: (() => { let value = 100; return () => value += 12; })(),
    responses: { async parse(value) { calls += 1; request = value; return successfulResponse({
      selectionSchemaVersion: 1, selectedOptionIds: ["option-0"], headlineSelectionIndex: 0,
    }); } },
  });
  const result = await provider.generate({ systemInstructions: "instructions", userData: "{}", eligibleOptionIds: optionIds });
  assert.equal(calls, 1);
  assert.equal(result.ok, true);
  assert.deepEqual(result.selection, { selectionSchemaVersion: 1, selectedOptionIds: ["option-0"], headlineSelectionIndex: 0 });
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
  assert.deepEqual({ ...request.text.format.schema, $schema: optionSchema.$schema }, optionSchema);
  assert.equal(request.text.format.name, "course_brief_selection_v1");
});

test("low-option selection catalogs handle zero, one, and two eligible IDs deterministically", async () => {
  assert.throws(() => createCourseBriefSelectionSchema([]), /non-empty set/);

  const oneOptionSchema = createCourseBriefSelectionSchema(["only-option"]);
  assert.equal(oneOptionSchema.safeParse({
    selectionSchemaVersion: 1,
    selectedOptionIds: ["only-option"],
    headlineSelectionIndex: 0,
  }).success, true);

  const twoOptionSchema = createCourseBriefSelectionSchema(["option-a", "option-b"]);
  const twoOptionJsonSchema = twoOptionSchema.toJSONSchema();
  assert.deepEqual(twoOptionJsonSchema.properties.selectedOptionIds.items.enum, ["option-a", "option-b"]);
  assert.equal(twoOptionSchema.safeParse({
    selectionSchemaVersion: 1,
    selectedOptionIds: ["option-a"],
    headlineSelectionIndex: 0,
  }).success, true);
  assert.equal(twoOptionSchema.safeParse({
    selectionSchemaVersion: 1,
    selectedOptionIds: ["option-a", "option-b"],
    headlineSelectionIndex: 1,
  }).success, true);
  assert.equal(twoOptionSchema.safeParse({
    selectionSchemaVersion: 1,
    selectedOptionIds: ["option-c"],
    headlineSelectionIndex: 0,
  }).success, false);

  const minimalInput = withOsmSurface(withKeyMoments(BASE_INPUT, []), {
    requestState: "not-requested", responseAvailability: null, status: "not-requested", coverage: null, categories: [],
  });
  minimalInput.derivedFacts.verticalProgression = null;
  const validInput = validateCourseBriefInput(minimalInput);
  assert.equal(validInput.ok, true);
  const minimalOptions = enumerateEligibleCourseBriefClaimOptions(validInput.input);
  assert.deepEqual(minimalOptions.map(({ claimType }) => claimType), ["highest_point", "lowest_point"]);

  let capturedRequest;
  const generated = await generateCourseBrief(validInput.input, {
    async generate(request) {
      capturedRequest = request;
      return {
        ok: true,
        selection: { selectionSchemaVersion: 1, selectedOptionIds: [minimalOptions[0].optionId], headlineSelectionIndex: 0 },
        metadata: metadata(),
      };
    },
  });
  assert.equal(generated.ok, true);
  assert.deepEqual(capturedRequest.eligibleOptionIds, minimalOptions.map(({ optionId }) => optionId));
  // Valid CourseBriefInputV1 always includes canonical highest/lowest facts,
  // so a zero-option generation state cannot be produced without invalid input.
});

test("OpenAI adapter handles missing key, refusal, incomplete, and missing parsed output", async () => {
  const ids = enumerateEligibleCourseBriefClaimOptions(BASE_INPUT).map(({ optionId }) => optionId);
  const providerRequest = { systemInstructions: "", userData: "{}", eligibleOptionIds: ids };
  const missing = await new OpenAiCourseBriefProvider().generate(providerRequest);
  assert.equal(missing.ok, false);
  assert.equal(missing.error, "provider_not_configured");

  const refusal = successfulResponse(null);
  refusal.output = [{ type: "message", content: [{ type: "refusal", refusal: "private provider text" }] }];
  const refused = await new OpenAiCourseBriefProvider({ responses: { async parse() { return refusal; } } }).generate(providerRequest);
  assert.equal(refused.ok, false);
  assert.equal(refused.error, "refusal_or_incomplete");
  assert.equal(JSON.stringify(refused).includes("private provider text"), false);

  const validSelection = selectionFor(BASE_INPUT, [observation("highest_point", ["route.highest"])]);
  const incomplete = successfulResponse(validSelection);
  incomplete.status = "incomplete";
  incomplete.incomplete_details = { reason: "max_output_tokens" };
  const partial = await new OpenAiCourseBriefProvider({ responses: { async parse() { return incomplete; } } }).generate(providerRequest);
  assert.equal(partial.error, "refusal_or_incomplete");

  const malformed = await new OpenAiCourseBriefProvider({ responses: { async parse() { return successfulResponse({ invalid: true }); } } }).generate(providerRequest);
  assert.equal(malformed.ok, true);
  assert.equal(mapCourseBriefSelectionToCandidate(malformed.selection, enumerateEligibleCourseBriefClaimOptions(BASE_INPUT)).error, "invalid_provider_response");
});

test("OpenAI adapter categorizes timeout, 429, and provider 5xx without retries", async () => {
  let calls = 0;
  const ids = enumerateEligibleCourseBriefClaimOptions(BASE_INPUT).map(({ optionId }) => optionId);
  const providerRequest = { systemInstructions: "", userData: "{}", eligibleOptionIds: ids };
  const timedOut = await new OpenAiCourseBriefProvider({ responses: { async parse() { calls += 1; throw new APIConnectionTimeoutError(); } } }).generate(providerRequest);
  assert.equal(timedOut.error, "timeout");
  const rateLimited = await new OpenAiCourseBriefProvider({ responses: { async parse() { calls += 1; throw new APIError(429, {}, "hidden", new Headers({ "retry-after": "7" })); } } }).generate(providerRequest);
  assert.equal(rateLimited.error, "rate_limited");
  assert.equal(rateLimited.retryAfterSeconds, 7);
  const unavailable = await new OpenAiCourseBriefProvider({ responses: { async parse() { calls += 1; throw new APIError(503, {}, "hidden", new Headers()); } } }).generate(providerRequest);
  assert.equal(unavailable.error, "provider_unavailable");
  assert.equal(JSON.stringify([timedOut, rateLimited, unavailable]).includes("hidden"), false);
  assert.equal(calls, 3);
  assert.equal(COURSE_BRIEF_PROVIDER_TIMEOUT_MS, 13_500);
});

test("generation returns deterministic 1- and 3-claim results and emits metadata only", async () => {
  const first = observation("highest_point", ["route.highest"]);
  const third = observation("key_moment", [BASE_INPUT.derivedFacts.keyMoments[1].factId], { direction: "descent", role: "longest" });
  const provider = providerFrom(successResult(BASE_INPUT, [first, third, observation("lowest_point", ["route.lowest"])], 1));
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
  assert.equal("semanticRejection" in events[0], false);
  const one = await generateCourseBrief(BASE_INPUT, providerFrom(successResult(BASE_INPUT, [first])));
  assert.equal(one.brief.observations.length, 1);
});

test("generation rejects invalid input before provider call and maps provider/configuration failures", async () => {
  let calls = 0;
  const unusedProvider = { async generate() { calls += 1; throw new Error("secret text"); } };
  assert.equal((await generateCourseBrief({ ...BASE_INPUT, schemaVersion: 2 }, unusedProvider)).error, "invalid_input");
  assert.equal(calls, 0);
  assert.equal((await generateCourseBrief(BASE_INPUT, unusedProvider)).error, "provider_unavailable");
  const providerFailureEvents = [];
  const missing = await generateCourseBrief(BASE_INPUT, providerFrom({ ok: false, error: "provider_not_configured", retryable: false, retryAfterSeconds: null, metadata: metadata() }),
    (event) => providerFailureEvents.push(event));
  assert.equal(missing.error, "provider_not_configured");
  assert.equal("semanticRejection" in providerFailureEvents[0], false);
  const allInvalid = await generateCourseBrief(BASE_INPUT, providerFrom({
    ok: true, selection: { selectionSchemaVersion: 1, selectedOptionIds: ["not-eligible"], headlineSelectionIndex: 0 }, metadata: metadata(),
  }));
  assert.equal(allInvalid.error, "invalid_provider_response");
});

test("generation revalidates selected options and adds safe redundancy diagnostics to telemetry", async () => {
  const moment = BASE_INPUT.derivedFacts.keyMoments[0];
  const selected = [
    observation("key_moment", [moment.factId], { direction: "climb", role: "longest" }),
    observation("key_moment", [moment.factId], { direction: "climb", role: "largest" }),
  ];
  const events = [];
  const result = await generateCourseBrief(BASE_INPUT, providerFrom(successResult(BASE_INPUT, selected)), (event) => events.push(event));
  assert.equal(result.error, "unsupported_generated_claim");
  assert.deepEqual(events[0].semanticRejection, {
    observationIndex: 1,
    claimType: "key_moment",
    supportingFactIds: [moment.factId],
    parameters: { phase: null, direction: "climb", transition: null, role: "largest", terrainCategory: null },
    code: "duplicate_key_moment",
  });
  assert.equal(events[0].providerRequestId, "req_test_01");
  assert.equal(events[0].inputTokens, 10);
  assert.equal(events[0].outputTokens, 8);
  assert.equal(events[0].durationMs, 12);
  for (const privateField of ["prompt", "userData", "providerOutput", "rendered", "routeFacts", "OPENAI_API_KEY"]) {
    assert.equal(privateField in events[0], false, privateField);
  }
  assert.equal(JSON.stringify(events[0]).includes("private provider text"), false);
});

test("course brief API enforces body limits and returns sanitized success/error responses", async () => {
  let calls = 0;
  const successHandler = createCourseBriefPostHandler(() => providerFrom({
    ...successResult(BASE_INPUT, [observation("highest_point", ["route.highest"])]),
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

test("API logs compact semantic rejection details but returns only the generic sanitized error", async () => {
  const telemetry = [];
  const moment = BASE_INPUT.derivedFacts.keyMoments[0];
  const rejected = observation("key_moment", [moment.factId], { direction: "climb", role: "largest" });
  const selected = [observation("key_moment", [moment.factId], { direction: "climb", role: "longest" }), rejected];
  const handler = createCourseBriefPostHandler(() => providerFrom({
    ...successResult(BASE_INPUT, selected),
  }), (event) => telemetry.push(event));
  const response = await post(handler, JSON.stringify(BASE_INPUT));
  const body = await response.json();
  assert.equal(response.status, 502);
  assert.deepEqual(body, { error: "unsupported_generated_claim", retryable: false });
  assert.equal(JSON.stringify(body).includes("semanticRejection"), false);
  assert.equal(JSON.stringify(body).includes("key_moment_role_mismatch"), false);
  assert.equal(JSON.stringify(body).includes(rejected.supportingFactIds[0]), false);
  assert.equal(JSON.stringify(body).includes("key_moment"), false);
  assert.equal(telemetry.length, 1);
  assert.equal(telemetry[0].semanticRejection.code, "duplicate_key_moment");
  assert.equal(telemetry[0].semanticRejection.observationIndex, 1);
  assert.equal(telemetry[0].category, "unsupported_generated_claim");
});

test("course brief API trusts actual streamed byte count over missing or incorrect Content-Length", async () => {
  let providerCalls = 0;
  const handler = createCourseBriefPostHandler(() => ({ async generate() {
    providerCalls += 1;
    return successResult(BASE_INPUT, [observation("highest_point", ["route.highest"])]);
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
    return { async generate() { providerCalls += 1; return successResult(BASE_INPUT, [observation("highest_point", ["route.highest"])]); } };
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
