import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [homePage, raceSearch, routeMode, resolver] = await Promise.all([
  readFile(new URL("./page.tsx", import.meta.url), "utf8"),
  readFile(new URL("./RaceSearch.tsx", import.meta.url), "utf8"),
  readFile(new URL("./RouteMode.tsx", import.meta.url), "utf8"),
  readFile(new URL("./raceResolver.ts", import.meta.url), "utf8"),
]);

test("homepage is a generic product introduction with no Istria-specific presentation", () => {
  assert.match(homePage, /Don&apos;t just analyze the route\. Understand it\./);
  assert.doesNotMatch(homePage, /Istria|Buzet|Umag|2027 Edition|homepageRaceRecord|CourseCharacter|CourseSection|CourseAnalysis|RaceSources/);
  assert.match(homePage, /Illustrative visual only\. No route or measured values are shown\./);
  assert.match(homePage, /Illustrative elevation profile with no measured route data/);
});

test("race URL discovery and GPX upload are equally prominent primary entry flows", () => {
  assert.match(homePage, /grid gap-5 lg:grid-cols-2/);
  assert.match(homePage, /<RaceGpxDiscovery\s*\/>/);
  assert.match(homePage, /Paste an official race webpage to look for route links/);
  assert.match(homePage, /href="\/route"[\s\S]*?Upload a GPX route/);
  assert.match(homePage, /Some pages may not expose a usable route/);
});

test("supported-race search remains available as a clearly secondary registry capability", () => {
  assert.match(homePage, /Looking for a race already in the registry\?/);
  assert.match(homePage, /<RaceSearch records=\{raceRegistry\}\s*\/>/);
  assert.match(raceSearch, /onSubmit=\{handleSubmit\}/);
  assert.match(raceSearch, /setResult\(resolveRace\(query\)\)/);
  assert.match(raceSearch, /href=\{getRaceRoute\(result\.record\)\}/);
  assert.match(resolver, /candidate\.sources\.some/);
  assert.match(resolver, /normalizedSourceUrl === queryUrl/);
});

test("Route Mode keeps the existing GPX file analysis flow", () => {
  assert.match(routeMode, /type="file"/);
  assert.match(routeMode, /accept="\.gpx,application\/gpx\+xml,application\/xml,text\/xml"/);
  assert.match(routeMode, /onChange=\{handleFileChange\}/);
  assert.match(routeMode, /parseGpxText\(text\)/);
});

test("homepage FAQ is data-driven and limited to supported application behavior", () => {
  assert.match(homePage, /const faqs = \[/);
  assert.match(homePage, /Frequently asked questions/);
  assert.match(homePage, /Does the analysis predict my finish time\?/);
  assert.match(homePage, /does not predict an individual runner’s performance/);
});
