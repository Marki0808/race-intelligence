import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("shared map fullscreen shell supports native mode, mobile fallback, Escape, scroll lock, and accessible exit", async () => {
  const [component, styles] = await Promise.all([
    readFile(new URL("./MapFullscreenRegion.tsx", import.meta.url), "utf8"),
    readFile(new URL("./globals.css", import.meta.url), "utf8"),
  ]);
  assert.match(component, /region\.requestFullscreen\(\)/);
  assert.match(component, /setMode\("fallback"\)/);
  assert.match(component, /document\.exitFullscreen\(\)/);
  assert.match(component, /event\.key === "Escape"/);
  assert.match(component, /body\.style\.position = "fixed"/);
  assert.match(component, /root\.style\.overflow = "hidden"/);
  assert.match(component, /aria-label=\{`\$\{fullscreen \? "Exit" : "Enter"\} fullscreen \$\{label\}`\}/);
  assert.match(component, /fullscreen \? "Exit full screen" : "Full screen"/);
  assert.match(component, /MAP_CONTROL_BUTTON_CLASS/);
  assert.doesNotMatch(component, /map-fullscreen-toggle|<svg/);
  assert.match(styles, /\.map-fullscreen-region--active[\s\S]*?height: 100dvh/);
  assert.doesNotMatch(styles, /\.map-fullscreen-toggle/);
});

test("full-route, section, and Key Moments maps use fullscreen without recreating live map instances", async () => {
  const [mapLibre, flyover, explorer, sectionMap, moments] = await Promise.all([
    readFile(new URL("./MapLibreRouteMap.tsx", import.meta.url), "utf8"),
    readFile(new URL("./RouteFlyover.tsx", import.meta.url), "utf8"),
    readFile(new URL("./CourseExplorer.tsx", import.meta.url), "utf8"),
    readFile(new URL("./TerrainSectionMap.tsx", import.meta.url), "utf8"),
    readFile(new URL("./KeyRouteMoments.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(mapLibre, /<MapFullscreenRegion label=\{label\} onResize=\{\(\) => mapRef\.current\?\.resize\(\)\}/);
  assert.match(mapLibre, /map-fullscreen-map-viewport/);
  assert.match(mapLibre, /<RouteFlyover[\s\S]*?terrainStatus=\{terrainStatus\}/);
  assert.match(flyover, /map-fullscreen-controls/);
  assert.match(mapLibre, /fullscreenLayout=\{fullscreen\}/, "the existing Flyover remains mounted while its panel joins the fullscreen layout");
  assert.match(mapLibre, /\{fullscreenButton\}/, "3D controls place the text button beside Fit route, Reset 3D view and wheel zoom");
  assert.match(explorer, /<MapFullscreenRegion[\s\S]*?leafletMapRef\.current\?\.invalidateSize/);
  assert.match(explorer, /\{fullscreenButton\}/, "the full-route 2D controls include Full screen beside wheel zoom");
  assert.match(sectionMap, /<MapFullscreenRegion[\s\S]*?mapRef\.current\?\.invalidateSize/);
  assert.match(sectionMap, /\{fullscreenButton\}/, "the section 2D controls include Full screen beside wheel zoom");
  assert.match(sectionMap, /showSelectedSectionMarkers/);
  assert.match(moments, /<MapLibreRouteMap[\s\S]*?keyMomentMarkers=\{mapMarkers\}/);
  assert.match(moments, /focusKey=\{selectedMapMarker\?\.id/);
  assert.match(mapLibre, /const mapRef = useRef<MapLibreMap \| null>\(null\)/);
});
