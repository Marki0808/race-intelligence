import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [data, presentation, home, racePage, raceMode, sectionBrowser] = await Promise.all([
  readFile(new URL("./istria110kData.ts", import.meta.url), "utf8"),
  readFile(new URL("./CourseCharacter.tsx", import.meta.url), "utf8"),
  readFile(new URL("./page.tsx", import.meta.url), "utf8"),
  readFile(new URL("./RacePageContent.tsx", import.meta.url), "utf8"),
  readFile(new URL("./CourseSection.tsx", import.meta.url), "utf8"),
  readFile(new URL("./RouteSectionBrowser.tsx", import.meta.url), "utf8"),
]);

test("Istria terrain claims are explicitly organizer-sourced and linked in both consumers", () => {
  assert.match(data, /organizer describes the section leading to Buzet as very rocky and demanding/);
  assert.match(data, /says it gets easier toward Umag/);
  assert.match(presentation, /Organizer&apos;s terrain description/);
  assert.match(presentation, /Source: \{terrainSource\.title\}/);
  assert.match(presentation, /href=\{terrainSource\.url\}/);
  assert.match(home, /terrainSource=\{homepageRaceRecord\.sources\.find\(\(source\) => source\.id === "official-110k"\)\}/);
  assert.match(racePage, /terrainSource=\{record\.sources\.find\(\(source\) => source\.id === "official-110k"\)\}/);
});

test("GPX-derived Course Character avoids unqualified technicality and location claims", () => {
  assert.match(data, /technicality: "Technical difficulty is not assessed from the GPX\."/);
  assert.doesNotMatch(presentation, />\s*Technicality\s*</);
  assert.match(presentation, /Elevation pattern · GPX-derived/);
  assert.match(presentation, /Course rhythm · GPX-derived/);
  assert.match(presentation, /Attention points · GPX-derived/);
  assert.match(data, /The GPX reaches its highest point at approximately 23\.6 km/);
  assert.match(data, /A major descent follows the high-point section/);
  assert.doesNotMatch(data, /hard mountain opening|major descent toward Buzet|mixed trail terrain/);
});

test("Race Mode removes the incorrect None status while retaining mutually exclusive selection", () => {
  assert.doesNotMatch(raceMode, /Selected:\s*\{selectedMoment \?\? "None"\}/);
  assert.match(raceMode, /function selectMoment\(momentId: string\)\s*\{[\s\S]*?moment: toggleKeyMomentSelection\(current\.editionKey === editionKey \? current\.moment : null, momentId\)/);
  assert.match(raceMode, /selected=\{selectedMoment === item\.id\}/);
  assert.match(raceMode, /sectionKey: section \? routeSectionSelectionKey\(section\) : null/);
  assert.match(raceMode, /moment: section \? null/);
  assert.match(sectionBrowser, /aria-pressed=\{isSelected\}/);
  assert.match(sectionBrowser, /onClick=\{\(\) => onSelectSection\(isSelected \? null : section\)\}/);
});
