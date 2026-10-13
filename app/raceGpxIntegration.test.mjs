import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [home, discoveryUi, routeMode, downloadModule, downloadRoute, transfer] = await Promise.all([
  readFile(new URL("./page.tsx", import.meta.url), "utf8"),
  readFile(new URL("./RaceGpxDiscovery.tsx", import.meta.url), "utf8"),
  readFile(new URL("./RouteMode.tsx", import.meta.url), "utf8"),
  readFile(new URL("./officialGpxDownload.ts", import.meta.url), "utf8"),
  readFile(new URL("./api/race-gpx-download/route.ts", import.meta.url), "utf8"),
  readFile(new URL("./discoveredGpxTransfer.ts", import.meta.url), "utf8"),
]);

test("homepage exposes race-page discovery beside the existing manual GPX entry", () => {
  assert.match(home, /<RaceGpxDiscovery\s*\/>/);
  assert.match(home, /href="\/route"[\s\S]*?Open GPX upload/);
  assert.match(discoveryUi, /\/api\/race-gpx-discovery/);
});

test("candidate UI requires explicit radio selection and confirmation even for one candidate", () => {
  assert.match(discoveryUi, /const \[selectedUrl, setSelectedUrl\] = useState\(""\)/);
  assert.match(discoveryUi, /type="radio"/);
  assert.match(discoveryUi, /checked=\{selectedUrl === candidate\.gpxUrl\}/);
  assert.match(discoveryUi, /Confirm selection and analyze GPX/);
  assert.match(discoveryUi, /disabled=\{\(!selectedUrl && !selectedArchiveUrl\) \|\| busy\}/);
  assert.match(discoveryUi, /link-evidence-only/);
  assert.match(discoveryUi, /These links are not verified route files yet/);
  assert.match(discoveryUi, /candidate\.displayLabel/);
  assert.match(discoveryUi, /typeof candidate\.displayLabel === "string"/);
});

test("organizer event choices require explicit selection and launch a fresh scoped discovery", () => {
  assert.match(discoveryUi, /event-selection-required/);
  assert.match(discoveryUi, /type="radio" name="selected-race-event"/);
  assert.match(discoveryUi, /Search this event for GPX links/);
  assert.match(discoveryUi, /discoverPage\(selectedEventUrl\)/);
  assert.match(discoveryUi, /body: JSON\.stringify\(\{ url \}\)/);
  assert.match(discoveryUi, /choice\.sourcePageUrl/);
  assert.match(discoveryUi, /new URL\(choice\.url\)\.origin === new URL\(choice\.sourcePageUrl\)\.origin/);
});

test("GPX-labeled ZIP archives have explicit confirmation and validated inner-file selection", () => {
  assert.match(discoveryUi, /resourceType: "zip"/);
  assert.match(discoveryUi, /ZIP archive · \{archive\.displayLabel\}/);
  assert.match(discoveryUi, /This is an archive, not a validated GPX/);
  assert.match(discoveryUi, /Confirm archive and inspect GPX files/);
  assert.match(discoveryUi, /Choose the GPX route inside the archive/);
  assert.match(discoveryUi, /archive-choices/);
  assert.match(discoveryUi, /resourceType: "zip-entry"/);
  assert.match(discoveryUi, /archiveDigest/);
  assert.match(discoveryUi, /Analyze selected GPX/);
  assert.match(discoveryUi, /File names are not treated as race or edition identity/);
  assert.match(discoveryUi, /Open manual GPX upload/);
});

test("no-results and failures offer the existing manual-upload route", () => {
  assert.match(discoveryUi, /status === "no-results"/);
  assert.match(discoveryUi, /status === "error"/);
  assert.match(discoveryUi, /upload a GPX file instead/i);
  assert.match(discoveryUi, /Open manual GPX upload/);
  assert.match(discoveryUi, /href="\/route"/);
  assert.match(discoveryUi, /No route links or distinct event choices could be identified/);
  assert.match(discoveryUi, /try its direct event or course page/);
  assert.match(discoveryUi, /We couldn’t inspect usable page content/);
});

test("confirmed GPX enters the existing RouteMode parser and analysis path in memory", () => {
  assert.match(discoveryUi, /\/api\/race-gpx-download/);
  assert.match(discoveryUi, /openDiscoveredGpx\(text, fallbackName\)/);
  assert.match(discoveryUi, /setPendingDiscoveredGpx\(\{ text, name \}\)/);
  assert.match(discoveryUi, /router\.push\("\/route"\)/);
  assert.match(transfer, /consumePendingDiscoveredGpx/);
  assert.match(routeMode, /consumePendingDiscoveredGpx\(\)/);
  assert.match(routeMode, /parseGpxText\(text\)/);
  assert.match(routeMode, /analyzeGpxRoute\(parsed\)/);
  assert.match(routeMode, /RouteAnalysisView/);
});

test("download endpoint revalidates page link evidence and bounds body and GPX retrieval", () => {
  assert.match(downloadModule, /createOfficialGpxDiscovery\(\)/);
  assert.match(downloadModule, /result\.candidates\.some\(\(candidate\) => candidate\.gpxUrl === candidateUrl\)/);
  assert.match(downloadModule, /maxBytes: 4 \* 1024 \* 1024/);
  assert.match(downloadModule, /parseGpxText\(text\)/);
  assert.match(downloadRoute, /MAX_REQUEST_BYTES = 8_192/);
  assert.match(downloadRoute, /maxDuration = 30/);
  assert.match(downloadRoute, /Cache-Control.*no-store/);
  assert.match(downloadRoute, /resourceType === "zip-entry"/);
});

test("discovered route stays GPX-derived without assigning race-edition provenance", () => {
  assert.match(discoveryUi, /not bound to a race edition/);
  assert.match(routeMode, /Route Mode · GPX-derived/);
  assert.doesNotMatch(downloadModule, /raceRegistry|raceEdition|editionId/);
});
