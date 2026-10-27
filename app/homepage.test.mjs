import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [homePage, raceSearch, routeMode, resolver, featureFlags, raceEditionPage] = await Promise.all([
  readFile(new URL("./page.tsx", import.meta.url), "utf8"),
  readFile(new URL("./RaceSearch.tsx", import.meta.url), "utf8"),
  readFile(new URL("./RouteMode.tsx", import.meta.url), "utf8"),
  readFile(new URL("./raceResolver.ts", import.meta.url), "utf8"),
  readFile(new URL("./featureFlags.ts", import.meta.url), "utf8"),
  readFile(new URL("./race/[raceId]/[year]/page.tsx", import.meta.url), "utf8"),
]);

test("homepage is a generic product introduction with no Istria-specific presentation", () => {
  assert.match(homePage, /Don&apos;t just analyze the route\. Understand it\./);
  assert.doesNotMatch(homePage, /Istria|Buzet|Umag|2027 Edition|homepageRaceRecord|CourseCharacter|CourseSection|CourseAnalysis|RaceSources/);
  assert.match(homePage, /Illustrative visual only\. No route or measured values are shown\./);
  assert.match(homePage, /Illustrative elevation profile with no measured route data/);
});

test("Route Analysis is the only public V1 entry and Race Mode is centrally gated off", () => {
  assert.match(featureFlags, /RACE_MODE_V1_ENABLED = false/);
  assert.match(homePage, /RACE_MODE_V1_ENABLED && <article[\s\S]*?<RaceGpxDiscovery\s*\/>/);
  assert.match(homePage, /RACE_MODE_V1_ENABLED && <details[\s\S]*?<RaceSearch records=\{raceRegistry\}\s*\/>/);
  assert.match(homePage, /Analyze a route/);
  assert.match(homePage, /Route Analysis/);
  assert.match(homePage, /Explore a GPX route/);
  assert.doesNotMatch(homePage, /Will every race webpage provide a route\?/);
  assert.doesNotMatch(homePage, /Choose a race page or GPX file/);
  assert.doesNotMatch(homePage, /race or GPX course/);
});

test("old registered Race Mode URLs redirect to the primary GPX upload experience", () => {
  assert.match(raceEditionPage, /if \(!RACE_MODE_V1_ENABLED\) redirect\("\/route"\)/);
  assert.match(raceEditionPage, /resolveByRaceEdition/);
});

test("GPX upload remains the primary route analysis entry point", () => {
  assert.match(homePage, /href="\/route"[\s\S]*?Upload a GPX route/);
});

test("preserved Race Mode modules remain available behind the V1 feature flag", () => {
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
