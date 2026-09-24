import assert from "node:assert/strict";
import test from "node:test";
import { homepageRaceRecord, raceRegistry } from "./raceRegistry.ts";
import { createRaceResolver, getRaceRoute } from "./raceResolver.ts";

const istria110kRaceRecord = homepageRaceRecord;
const resolveRace = createRaceResolver(raceRegistry);

test("registry contains only the currently available race record", () => {
  assert.equal(raceRegistry.length, 1);
  assert.equal(raceRegistry[0], istria110kRaceRecord);
});

test("resolves the Istria 110K race name", () => {
  assert.deepEqual(resolveRace("Istria 110K"), {
    status: "resolved",
    record: istria110kRaceRecord,
  });
});

test("resolves case and whitespace variants of the race name", () => {
  assert.equal(resolveRace("  istria   110k ").record, istria110kRaceRecord);
});

test("resolves the official source URL entered as the race query", () => {
  assert.equal(
    resolveRace("https://www.istria.utmb.world/races/110k/?ref=source#info")
      .record,
    istria110kRaceRecord,
  );
});

test("resolves an official URL supplied separately", () => {
  assert.equal(
    resolveRace("", "https://www.istria.utmb.world/races/110k/?ref=source#info")
      .record,
    istria110kRaceRecord,
  );
});

test("returns not-found for an unknown race", () => {
  assert.deepEqual(resolveRace("Unknown Trail Race"), {
    status: "not-found",
    record: null,
  });
});

test("resolves a race record by race id and edition year", () => {
  assert.equal(
    resolveRace.resolveByRaceEdition("istria-110k", 2027).record,
    istria110kRaceRecord,
  );
});

test("builds the route from race identity and selected edition", () => {
  assert.equal(getRaceRoute(istria110kRaceRecord), "/race/istria-110k/2027");
});

test("does not resolve an unknown race edition", () => {
  assert.deepEqual(resolveRace.resolveByRaceEdition("unknown-race", 2027), {
    status: "not-found",
    record: null,
  });
});
