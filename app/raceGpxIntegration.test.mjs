import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [home, discoveryUi, routeMode, downloadModule, downloadRoute, downloadHandler, transfer, featureFlags] = await Promise.all([
  readFile(new URL("./page.tsx", import.meta.url), "utf8"),
  readFile(new URL("./RaceGpxDiscovery.tsx", import.meta.url), "utf8"),
  readFile(new URL("./RouteMode.tsx", import.meta.url), "utf8"),
  readFile(new URL("./officialGpxDownload.ts", import.meta.url), "utf8"),
  readFile(new URL("./api/race-gpx-download/route.ts", import.meta.url), "utf8"),
  readFile(new URL("./raceGpxDownloadHandler.ts", import.meta.url), "utf8"),
  readFile(new URL("./discoveredGpxTransfer.ts", import.meta.url), "utf8"),
  readFile(new URL("./featureFlags.ts", import.meta.url), "utf8"),
]);

test("race discovery remains implemented but is gated off from the public V1 homepage", () => {
  assert.match(featureFlags, /RACE_MODE_V1_ENABLED = false/);
  assert.match(home, /RACE_MODE_V1_ENABLED && <article[\s\S]*?<RaceGpxDiscovery\s*\/>/);
  assert.match(home, /href="\/route"[\s\S]*?Upload a GPX route/);
  assert.match(discoveryUi, /\/api\/race-gpx-discovery/);
});

test("race URL input is enabled and focusable on initial idle render", () => {
  assert.match(discoveryUi, /useState<"idle" \| "loading"[\s\S]*?>\("idle"\)/);
  assert.match(discoveryUi, /id="official-race-url"[\s\S]*?type="url"[\s\S]*?value=\{raceUrl\}[\s\S]*?onChange=\{\(event\) => setRaceUrl\(event\.target\.value\)\}[\s\S]*?disabled=\{busy\}/);
  assert.match(discoveryUi, /const busy = status === "loading" \|\| status === "downloading" \|\| status === "ready"/);
  assert.doesNotMatch(discoveryUi, /disabled=\{status !== "idle"\}/);
});

test("typing or pasting updates the submitted URL and the search button has accurate idle/loading states", () => {
  assert.match(discoveryUi, /onChange=\{\(event\) => setRaceUrl\(event\.target\.value\)\}/);
  assert.match(discoveryUi, /await discoverPage\(raceUrl\.trim\(\)\)/);
  assert.match(discoveryUi, /disabled=\{busy \|\| !raceUrl\.trim\(\)\}/);
  assert.match(discoveryUi, /status === "loading" \? "Searching race page…" : "Find GPX route links"/);
  assert.match(discoveryUi, /disabled:cursor-not-allowed/);
  assert.doesNotMatch(discoveryUi, /disabled:cursor-wait/);
});

test("discovery loading is bounded, duplicate submits are blocked, and errors restore an enabled retry path", () => {
  assert.match(discoveryUi, /if \(discoveryInFlight\.current\) return/);
  assert.match(discoveryUi, /new AbortController\(\)/);
  assert.match(discoveryUi, /window\.setTimeout\(\(\) => controller\.abort\(\), 15_000\)/);
  assert.match(discoveryUi, /signal: controller\.signal/);
  assert.match(discoveryUi, /finally \{\s*window\.clearTimeout\(timeoutId\);\s*discoveryInFlight\.current = false;/);
  assert.match(discoveryUi, /catch \{\s*setMessage\("Race-page discovery is temporarily unavailable[\s\S]*?setStatus\("error"\)/);
  assert.match(discoveryUi, /setMessage\(""\);\s*setStatus\("loading"\)/);
});

test("supported-race registry lookup remains independent from official-page discovery state", () => {
  assert.match(home, /RACE_MODE_V1_ENABLED && <details[\s\S]*?<RaceSearch records=\{raceRegistry\}\s*\/>/);
  assert.doesNotMatch(home, /RaceGpxDiscovery[^<]*busy|RaceSearch[^<]*busy/);
  assert.match(discoveryUi, /const \[raceUrl, setRaceUrl\] = useState\(""\)/);
  assert.match(discoveryUi, /const \[status, setStatus\] = useState/);
});

test("an exact course resource is preselected and shown with confirmation, while ambiguous resources require selection", () => {
  assert.match(discoveryUi, /const \[selectedUrl, setSelectedUrl\] = useState\(""\)/);
  assert.match(discoveryUi, /findUniqueCourseResourcePreselection|courseSelection\.preselection/);
  assert.match(discoveryUi, /const showDirectCourseConfirmation =/);
  assert.match(discoveryUi, /data-testid="exact-course-resource"/);
  assert.match(discoveryUi, /This is an exact course-label match from the official page\. The linked file will be validated only after you confirm\./);
  assert.match(discoveryUi, /Confirm this course route/);
  assert.match(discoveryUi, /type="radio"/);
  assert.match(discoveryUi, /checked=\{selectedUrl === candidate\.gpxUrl\}/);
  assert.match(discoveryUi, /!showDirectCourseConfirmation && archives\.map/);
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

test("organizer course choices require explicit distance selection and restart discovery from the exact course URL", () => {
  assert.match(discoveryUi, /course-selection-required/);
  assert.match(discoveryUi, /type="radio" name="selected-race-course"/);
  assert.match(discoveryUi, /Course distance: \{choice\.distanceLabel\}/);
  assert.match(discoveryUi, /Search this course for GPX links/);
  assert.match(discoveryUi, /discoverPage\(selectedCourseUrl\)/);
  assert.match(discoveryUi, /new URL\(choice\.url\)\.origin === new URL\(choice\.sourcePageUrl\)\.origin/);
  assert.match(discoveryUi, /choice\.supportingEvidence\.length <= 6/);
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
  assert.match(discoveryUi, /We couldn&apos;t find a route on this page\./);
  assert.match(discoveryUi, /If this is an organizer&apos;s homepage, open the specific race or course page and paste its URL here\./);
  assert.match(discoveryUi, /upload a GPX file directly\./);
  assert.match(discoveryUi, /We couldn’t inspect usable page content/);
  assert.match(discoveryUi, /if \(result\.status === "no-results"\) \{\s*setStatus\("no-results"\);\s*return;\s*\}\s*setMessage\(result\.status/);
});

test("confirmed GPX enters the existing RouteMode parser and analysis path in memory", () => {
  assert.match(discoveryUi, /\/api\/race-gpx-download/);
  assert.match(discoveryUi, /openDiscoveredGpx\(text, fallbackName, isAidStationDiscoveryV1\(downloaded\?\.stationEvidence\)/);
  assert.match(discoveryUi, /setPendingDiscoveredGpx\(\{ text, name, aidStationDiscoveryV1 \}\)/);
  assert.match(discoveryUi, /router\.push\("\/route"\)/);
  assert.match(transfer, /consumePendingDiscoveredGpx/);
  assert.match(routeMode, /consumePendingDiscoveredGpx\(\)/);
  assert.match(routeMode, /parseGpxText\(text\)/);
  assert.match(routeMode, /pending\.aidStationDiscoveryV1/);
  assert.match(routeMode, /analyzeGpxRoute\(parsed\)/);
  assert.match(routeMode, /RouteAnalysisView/);
});

test("download endpoint revalidates page link evidence and bounds body and GPX retrieval", () => {
  assert.match(downloadModule, /createOfficialGpxDiscovery\(\)/);
  assert.match(downloadModule, /result\.candidates\.some\(\(candidate\) => candidate\.gpxUrl === candidateUrl\)/);
  assert.match(downloadModule, /maxBytes: 4 \* 1024 \* 1024/);
  assert.match(downloadModule, /parseGpxText\(text\)/);
  assert.match(downloadHandler, /MAX_REQUEST_BYTES = 8_192/);
  assert.match(downloadRoute, /maxDuration = 30/);
  assert.match(downloadHandler, /Cache-Control.*no-store/);
  assert.match(downloadHandler, /resourceType === "zip-entry"/);
});

test("GPX download failures distinguish an HTML index from an oversized file using safe fixed reasons", () => {
  assert.match(downloadModule, /reason: "response-too-large"/);
  assert.match(downloadModule, /reason: "html-response"/);
  assert.match(downloadHandler, /result\.reason \? \{ reason: result\.reason \}/);
  assert.match(discoveryUi, /failure\.reason === "html-response"[\s\S]*?instead of a GPX file/);
  assert.match(discoveryUi, /failure\.reason === "response-too-large"[\s\S]*?4 MiB download limit/);
  assert.doesNotMatch(discoveryUi, /rawError|stackTrace|responseBody|internalAddress/);
});

test("discovered route stays GPX-derived without assigning race-edition provenance", () => {
  assert.match(discoveryUi, /do not by themselves prove that a linked file belongs to that edition/);
  assert.match(routeMode, /Route Mode · GPX-derived/);
  assert.doesNotMatch(downloadModule, /raceRegistry|raceEdition|editionId/);
});
