import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const explorer = await readFile(new URL("./CourseExplorer.tsx", import.meta.url), "utf8");
const sectionProfile = await readFile(new URL("./RouteSectionProfile.tsx", import.meta.url), "utf8");

test("full-route profile keeps a readable mobile width in a keyboard-accessible horizontal scroller", () => {
  assert.match(explorer, /role="region" aria-label="Scrollable full-route elevation profile" tabIndex=\{0\} onScroll=\{\(event\) => \{ profileScrollLeftRef\.current = event\.currentTarget\.scrollLeft; if \(inspectedPoint\) \{ setProfileScrollLeft\(event\.currentTarget\.scrollLeft\); setInspectedPoint\(null\); \} \}\} className="relative w-full min-w-0 max-w-full overflow-x-auto overscroll-x-contain/);
  assert.match(explorer, /h-56 w-full min-w-\[720px\] touch-auto sm:min-w-0 sm:touch-pan-y/);
  assert.match(explorer, /className="mt-2 px-1 text-xs text-white\/55 sm:hidden">Swipe horizontally to explore the elevation profile\./);
});

test("section-capable elevation profile explains click and tap selection accessibly", () => {
  assert.match(explorer, /aria-describedby=\{onSelectSection && sections\.length > 0 \? "full-route-profile-selection-hint" : undefined\}/);
  assert.match(explorer, /onSelectSection && sections\.length > 0 && <p id="full-route-profile-selection-hint"/);
  assert.match(explorer, /Click an interval on the elevation profile to explore route sections\./);
  assert.match(explorer, /Tap an interval on the elevation profile to explore route sections\./);
  assert.match(explorer, /<span className="hidden sm:inline">Click an interval/);
  assert.match(explorer, /<span className="sm:hidden">Tap an interval/);
});

test("mobile scrolling preserves profile inspection, section and Key Moment interactions", () => {
  assert.match(explorer, /onPointerDown=\{onPointerDown\} onPointerMove=\{onPointerMove\} onPointerUp=\{onPointerUp\}/);
  assert.match(explorer, /onSelectSection\(isSelected \? null : section\)/);
  assert.match(explorer, /onSelectMoment\?\.\(momentId\)/);
  assert.match(explorer, /units === "metric" \? "meters" : "feet"/);
  assert.match(explorer, /units === "metric" \? "kilometers" : "miles"/);
  assert.match(explorer, /touchInspection\.current = true/);
  assert.match(explorer, /setProfileScrollLeft\(event\.currentTarget\.scrollLeft\)/);
  assert.match(explorer, /profileScrollLeftRef\.current = event\.currentTarget\.scrollLeft/);
  assert.match(explorer, /Math\.min\(profileScrollerWidth - 60, xForDistance\(inspectedPoint\.distanceM\) - profileScrollLeft\)/);
  assert.match(explorer, /xForDistance\(inspectedPoint\.distanceM\) - profileScrollLeft/);
});

test("section mini-profiles retain their existing responsive sizing and touch inspection", () => {
  assert.match(sectionProfile, /h-52 w-full rounded-xl bg-\[#17211c\] touch-pan-y sm:h-56/);
  assert.match(sectionProfile, /current\?\.held\) inspect\(event\.clientX, event\.clientY\)/);
  assert.doesNotMatch(sectionProfile, /min-w-\[720px\]|overflow-x-auto/);
});
