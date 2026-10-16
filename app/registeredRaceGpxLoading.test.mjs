import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [courseSection, explorer] = await Promise.all([
  readFile(new URL("./CourseSection.tsx", import.meta.url), "utf8"),
  readFile(new URL("./CourseExplorer.tsx", import.meta.url), "utf8"),
]);

test("registered GPX load failures show an understandable alert and an accessible retry action", () => {
  assert.match(courseSection, /Could not load this race edition’s GPX\. Check your connection and try again\./);
  assert.match(explorer, /role=\{error \? "alert" : undefined\}/);
  assert.match(explorer, /\{error && onRetry && <button[\s\S]*?onClick=\{onRetry\}[\s\S]*?>Try again<\/button>\}/);
  assert.match(courseSection, /onRetry=\{retryRaceGpx\}/);
});

test("retry reloads the currently selected edition through the existing fetch, parser, and analyzer", () => {
  assert.match(courseSection, /fetch\(raceRecord\.edition\.gpxPath, \{ signal: controller\.signal \}\)/);
  assert.match(courseSection, /parseGpxText\(await response\.text\(\)\)/);
  assert.match(courseSection, /analyzeGpxRoute\(\s*parsed,/);
  assert.match(courseSection, /\[editionKey, raceRecord\.edition\.gpxPath, raceRecord\.edition\.year, raceRecord\.race\.name, retryRequest\]/);
  assert.match(courseSection, /editionKey = JSON\.stringify\(\[raceRecord\.race\.id, raceRecord\.edition\.year, raceRecord\.edition\.distanceKm, raceRecord\.edition\.gpxPath\]\)/);
});

test("retry immediately clears the error into loading state and prevents duplicate retries", () => {
  assert.match(courseSection, /if \(currentLoad\?\.status !== "error" \|\| retryPendingRef\.current\) return/);
  assert.match(courseSection, /retryPendingRef\.current = true;\s*setLoadState\(\{ editionKey, status: "loading" \}\);\s*setRetryRequest/);
  assert.match(courseSection, /currentLoad\?\.status === "error" \? currentLoad\.message : ""/);
  assert.match(courseSection, /currentLoad === null \|\| currentLoad\.status === "loading"/);
});

test("only the latest non-aborted edition request can publish success or failure", () => {
  assert.match(courseSection, /const controller = new AbortController\(\)/);
  assert.match(courseSection, /const requestId = \+\+gpxRequestIdRef\.current/);
  assert.match(courseSection, /!controller\.signal\.aborted && gpxRequestIdRef\.current === requestId/);
  assert.match(courseSection, /return \(\) => \{\s*controller\.abort\(\)/);
  assert.match(courseSection, /loadState\?\.editionKey === editionKey/);
});

test("successful analysis restores the ready view and derives errors only from an error state", () => {
  assert.match(courseSection, /setLoadState\(\{ editionKey, status: "ready", analysis, routeFingerprint \}\)/);
  assert.match(courseSection, /currentLoad\?\.status === "ready" \? currentLoad\.analysis : null/);
  assert.match(courseSection, /currentLoad\?\.status === "error" \? currentLoad\.message : ""/);
});
