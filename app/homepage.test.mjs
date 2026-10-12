import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [homePage, raceSearch, routeMode, resolver] = await Promise.all([
  readFile(new URL("./page.tsx", import.meta.url), "utf8"),
  readFile(new URL("./RaceSearch.tsx", import.meta.url), "utf8"),
  readFile(new URL("./RouteMode.tsx", import.meta.url), "utf8"),
  readFile(new URL("./raceResolver.ts", import.meta.url), "utf8"),
]);

test("homepage offers supported-race lookup and the existing GPX upload as equal entry paths", () => {
  assert.match(homePage, /href="#race-search-entry"[\s\S]*?Analyze a race/);
  assert.match(homePage, /grid max-w-4xl gap-4 sm:grid-cols-2/);
  assert.match(homePage, /Find a supported race/);
  assert.match(homePage, /href="\/route"[\s\S]*?Open GPX upload/);
  assert.match(homePage, /id="race-search-entry"/);
  assert.match(homePage, /<RaceGpxDiscovery\s*\/>/);
});

test("race lookup still resolves a supported race to its registered edition route", () => {
  assert.match(raceSearch, /onSubmit=\{handleSubmit\}/);
  assert.match(raceSearch, /setResult\(resolveRace\(query\)\)/);
  assert.match(raceSearch, /href=\{getRaceRoute\(result\.record\)\}/);
  assert.match(resolver, /candidate\.sources\.some/);
  assert.match(resolver, /normalizedSourceUrl === queryUrl/);
});

test("GPX entry still opens the local file picker and processes selected GPX files", () => {
  assert.match(routeMode, /type="file"/);
  assert.match(routeMode, /accept="\.gpx,application\/gpx\+xml,application\/xml,text\/xml"/);
  assert.match(routeMode, /onChange=\{handleFileChange\}/);
  assert.match(routeMode, /parseGpxText\(text\)/);
});
