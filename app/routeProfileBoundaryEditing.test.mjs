import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { profileClientXToDistanceM, profilePointerMoved } from "./routeProfileBoundaryEditing.ts";

test("profile click maps its responsive SVG coordinate to cumulative route distance", () => {
  const distance = profileClientXToDistanceM(350, {
    svgLeft: 0,
    svgWidth: 720,
    chartWidth: 720,
    plotLeft: 56,
    plotRight: 20,
    routeDistanceM: 10000,
  });
  assert.equal(Math.round(distance), 4565);
});

test("profile click mapping includes horizontal scroll and rejects chart margins", () => {
  const plot = { svgLeft: -100, svgWidth: 720, chartWidth: 720, plotLeft: 56, plotRight: 20, routeDistanceM: 10000 };
  assert.equal(Math.round(profileClientXToDistanceM(250, plot)), 4565, "scrolled and unscrolled positions at the same SVG point map identically");
  assert.equal(profileClientXToDistanceM(-50, plot), null, "clicks left of the plot are rejected");
  assert.equal(profileClientXToDistanceM(620, plot), null, "clicks in the right chart margin are rejected");
  const responsive = { ...plot, svgLeft: 0, svgWidth: 360, chartWidth: 360 };
  const x = 56 + (360 - 56 - 20) * 0.5;
  assert.equal(Math.round(profileClientXToDistanceM(x, responsive)), 5000);
});

test("pointer movement distinguishes a tap from horizontal mobile scrolling", () => {
  assert.equal(profilePointerMoved(100, 100, 104, 103), false);
  assert.equal(profilePointerMoved(100, 100, 112, 101), true);
  assert.equal(profilePointerMoved(100, 100, 100, 110), true);
});

test("stable distance and elevation readout stays above the plot and uses selected display units", async () => {
  const profile = await readFile(new URL("./CourseExplorer.tsx", import.meta.url), "utf8");
  const readoutStart = profile.indexOf('aria-label="Elevation profile inspection values"');
  const chartStart = profile.indexOf('ref={profileScrollerRef}', readoutStart);
  assert.ok(readoutStart > 0 && chartStart > readoutStart, "the fixed-height readout is rendered immediately before the horizontally scrolling plot");
  const readout = profile.slice(readoutStart - 260, chartStart);
  assert.match(readout, /flex h-10 items-center justify-center/);
  assert.match(readout, /flex max-w-full items-center gap-3 sm:gap-4/);
  assert.match(readout, /border-l border-white\/20 pl-3 sm:pl-4/);
  assert.match(readout, /whitespace-nowrap/);
  assert.match(readout, /formatDistanceMeters\(inspectedPoint\.distanceM, units\)/);
  assert.match(readout, /formatElevationMeters\(inspectedPoint\.elevationM, units\)/);
  assert.doesNotMatch(readout, /absolute|tooltip/i);
  const { formatDistanceMeters, formatElevationMeters } = await import("./routeUnits.ts");
  assert.equal(formatDistanceMeters(12450, "metric"), "12.45 km");
  assert.equal(formatElevationMeters(684, "metric"), "684 m");
  assert.equal(formatDistanceMeters(12450, "us-customary"), "7.74 mi");
  assert.equal(formatElevationMeters(684, "us-customary"), "2,244 ft");
});

test("profile editing is discoverable in Route Analysis and preserves normal profile interactions outside edit mode", async () => {
  const [view, profile, controls, raceView] = await Promise.all([
    readFile(new URL("./RouteAnalysisView.tsx", import.meta.url), "utf8"),
    readFile(new URL("./CourseExplorer.tsx", import.meta.url), "utf8"),
    readFile(new URL("./CustomSectionControls.tsx", import.meta.url), "utf8"),
    readFile(new URL("./CourseSection.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(profile, /Want to focus on specific climbs or descents\?/);
  assert.match(profile, /Select sections on profile/);
  assert.match(profile, /profileBoundaryEditing \? "Done selecting"/);
  assert.match(profile, /Click or tap the profile to add a boundary\. Set its exact distance below\./);
  assert.match(view, /startProfileBoundaryEditing\(\)[\s\S]*segmentationMode: "custom"/);
  assert.match(view, /customPlanState\.analysis === analysis \? customPlanState\.plan : createCustomSectionPlan\(\)/);
  assert.match(profile, /showCustomBoundaries && customBoundaries\.map/);
  assert.match(profile, /boundaryEditing && <rect/);
  assert.match(profile, /event\.detail > 0 && ignorePointerSelection\(event\)/);
  assert.match(profile, /profilePointerMoved\(gesture\.startX, gesture\.startY, event\.clientX, event\.clientY\)/);
  assert.match(profile, /onPointerDown=\{onPointerDown\} onPointerMove=\{onPointerMove\}/);
  assert.match(profile, /event\.pointerType === "mouse" \|\| \(!boundaryEditing && gesture\?\.longPressed\)/, "desktop inspection works during normal exploration and boundary preview");
  assert.match(profile, /nearestRouteProfilePoint\(points, distanceM, elevationM\)/, "tooltip values come from an existing GPX sample");
  assert.match(profile, /<span className="shrink-0 text-white\/55">Distance<\/span>[\s\S]*formatDistanceMeters\(inspectedPoint\.distanceM, units\)/);
  assert.match(profile, /<span className="shrink-0 text-white\/55">Elevation<\/span>[\s\S]*formatElevationMeters\(inspectedPoint\.elevationM, units\)/);
  assert.match(profile, /strokeDasharray=\{boundaryEditing \? "6 5" : undefined\}/, "the live boundary preview is dashed");
  assert.match(profile, /stroke="#a7c957" strokeWidth="3" \/>/, "committed custom boundaries remain solid");
  assert.match(profile, /boundaryEditing && onRemoveCustomBoundary && customBoundaries\.map/);
  assert.match(profile, /Remove custom boundary at/);
  assert.match(profile, /event\.stopPropagation\(\); remove\(\)/, "removing a marker does not trigger the chart add overlay");
  assert.match(profile, /Undo last boundary/);
  assert.match(profile, /showCustomBoundaries && customBoundaries\.length > 0 && <div/);
  assert.match(profile, /Your custom sections are ready below/);
  assert.match(profile, /Scroll down to explore your sections, adjust distances, rename them, or remove boundaries\./);
  assert.match(profile, /onSelectSection && !boundaryEditing/);
  assert.match(controls, /sortCustomSectionBoundaries/);
  assert.match(controls, /Remove boundary/);
  assert.match(profile, /overflow-x-auto overscroll-x-contain/);
  assert.doesNotMatch(raceView, /onStartProfileBoundaryEditing|Select sections on profile/);
});
