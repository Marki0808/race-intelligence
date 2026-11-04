import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  ANALYTICS_CONSENT_KEY,
  isValidGaMeasurementId,
  readAnalyticsConsent,
  readEffectiveAnalyticsConsent,
  safeAnalyticsPage,
  saveAnalyticsConsent,
  sendSafeAnalyticsEvent,
  sendSafePageView,
  startBasicAnalytics,
  stopBasicAnalytics,
  toSafeAnalyticsPayload,
} from "./analyticsConsent.ts";

const memoryStorage = () => {
  const values = new Map();
  return { values, getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
};

test("analytics consent defaults to unset, persists accept/reject, and can be withdrawn", () => {
  const storage = memoryStorage();
  assert.equal(readAnalyticsConsent(storage), null);
  assert.equal(saveAnalyticsConsent(storage, "accepted"), true);
  assert.equal(readAnalyticsConsent(storage), "accepted");
  assert.equal(saveAnalyticsConsent(storage, "rejected"), true);
  assert.equal(readAnalyticsConsent(storage), "rejected");
  assert.equal(ANALYTICS_CONSENT_KEY, "endurset.analytics-consent.v1");
  const previouslyAccepted = memoryStorage();
  saveAnalyticsConsent(previouslyAccepted, "accepted");
  assert.equal(readEffectiveAnalyticsConsent(previouslyAccepted, "rejected"), "rejected", "a rejected in-session choice overrides stale stored acceptance");
});

test("analytics script is not inserted without consent or a valid measurement ID", () => {
  let appended = 0;
  const document = { querySelector: () => null, createElement: () => ({ dataset: {}, async: false }), head: { appendChild: () => appended++ } };
  const window = { dataLayer: [], location: { origin: "https://endurset.com", hostname: "endurset.com" } };
  assert.equal(startBasicAnalytics(document, window, "G-ABCD1234", null), false);
  assert.equal(startBasicAnalytics(document, window, "G-ABCD1234", "rejected"), false);
  assert.equal(startBasicAnalytics(document, window, "", "accepted"), false);
  assert.equal(appended, 0, "no script request is initiated before affirmative consent and valid configuration");
});

test("accepted analytics configuration disables automatic page view and inserts one script", () => {
  let appended = 0;
  const calls = [];
  const script = { dataset: {}, async: false, src: "" };
  const document = { querySelector: () => null, createElement: () => script, head: { appendChild: () => appended++ } };
  const window = { dataLayer: [], location: { origin: "https://endurset.com", hostname: "endurset.com" } };
  assert.equal(startBasicAnalytics(document, window, "G-ABCD1234", "accepted", "/route?filename=private.gpx"), true);
  assert.equal(appended, 1);
  assert.match(script.src, /googletagmanager\.com\/gtag\/js\?id=G-ABCD1234/);
  assert.equal(script.dataset.endursetGa, "true");
  assert.equal(window["ga-disable-G-ABCD1234"], undefined, "affirmative consent clears the Google disable flag");
  // The queue is limited to consent/setup/config commands; page view is sent separately with a sanitized path.
  assert.equal(window.dataLayer.length, 3);
  assert.deepEqual(window.dataLayer[0], ["consent", "update", {
    analytics_storage: "granted", ad_storage: "denied", ad_user_data: "denied", ad_personalization: "denied",
  }]);
  window.gtag = (...args) => calls.push(args);
  // The config queued values are safe, including sanitized page URL.
  assert.equal(window.dataLayer[2][2].page_path, "/route");
  assert.equal(window.dataLayer[2][2].page_location, "https://endurset.com/route");
  assert.equal(window.dataLayer[2][2].cookie_domain, "endurset.com");
  assert.equal(window.dataLayer[2][2].cookie_path, "/");
});

test("withdrawal disables a loaded tag, updates consent, and removes only scoped analytics cookies", () => {
  const removals = [];
  const writes = [];
  const script = { remove: () => removals.push(true) };
  const document = {
    querySelectorAll: () => [script],
    get cookie() { return "_ga=secret; _gid=secret2; _ga_property=secret3; unrelated=keep"; },
    set cookie(value) { writes.push(value); },
  };
  const calls = [];
  const window = { dataLayer: [], location: { hostname: "endurset.com" }, gtag: (...args) => { calls.push(args); window.dataLayer.push(args); } };
  const originalQueue = window.dataLayer;
  stopBasicAnalytics(document, window, "G-ABCD1234");
  assert.equal(removals.length, 0, "the existing loader is retained to avoid duplicate tag initialization on re-acceptance");
  assert.equal(window["ga-disable-G-ABCD1234"], true);
  assert.deepEqual(calls, [["consent", "update", {
    analytics_storage: "denied", ad_storage: "denied", ad_user_data: "denied", ad_personalization: "denied",
  }]]);
  assert.equal("gtag" in window, false);
  assert.equal(window.dataLayer, originalQueue, "the loaded Google tag keeps its queue reference for a later re-acceptance");
  assert.deepEqual(window.dataLayer, calls, "only the denied consent update remains queued");
  assert.equal(writes.length, 6, "host-only and configured-domain variants are expired for each GA cookie");
  assert.ok(writes.every((value) => value.includes("Max-Age=0") && !value.includes("secret")));
  assert.ok(writes.every((value) => value.includes("path=/")));
  assert.equal(writes.filter((value) => value.includes("Domain=endurset.com")).length, 3);
  assert.equal(writes.filter((value) => !value.includes("Domain=")).length, 3);
});

test("consent rejection blocks events, and later affirmative consent safely re-enables analytics", () => {
  const storage = memoryStorage();
  const scripts = [];
  const removed = new Set();
  const document = {
    querySelector: () => scripts.find((script) => !removed.has(script)) ?? null,
    querySelectorAll: () => scripts.filter((script) => !removed.has(script)).map((script) => ({ remove: () => removed.add(script) })),
    createElement: () => ({ dataset: {}, async: false, src: "" }),
    head: { appendChild: (script) => scripts.push(script) },
    cookie: "",
  };
  const window = { localStorage: storage, location: { origin: "https://endurset.com", hostname: "endurset.com" } };

  assert.equal(startBasicAnalytics(document, window, "G-ABCD1234", null), false);
  assert.equal(scripts.length, 0, "unset consent makes no tag request");

  saveAnalyticsConsent(storage, "accepted");
  assert.equal(startBasicAnalytics(document, window, "G-ABCD1234", "accepted"), true);
  let eventCalls = 0;
  const originalGtag = window.gtag;
  window.gtag = (...args) => { if (args[0] === "event") eventCalls += 1; originalGtag(...args); };
  sendSafeAnalyticsEvent(window, { type: "gpx_analysis_success" });
  assert.equal(eventCalls, 1);

  stopBasicAnalytics(document, window, "G-ABCD1234");
  saveAnalyticsConsent(storage, "rejected");
  sendSafeAnalyticsEvent(window, { type: "gpx_analysis_success" });
  sendSafePageView(window, "/route");
  assert.equal(eventCalls, 1, "neither application events nor page views dispatch after withdrawal");
  assert.equal(window["ga-disable-G-ABCD1234"], true);

  saveAnalyticsConsent(storage, "accepted");
  assert.equal(startBasicAnalytics(document, window, "G-ABCD1234", "accepted"), true);
  assert.equal(window["ga-disable-G-ABCD1234"], undefined);
  sendSafeAnalyticsEvent(window, { type: "gpx_analysis_success" });
  assert.equal(scripts.length, 1, "re-acceptance reuses the existing loader rather than inserting a duplicate");
  assert.deepEqual(window.dataLayer[1][0], "consent", "the denial is followed by an affirmative consent update");
});

test("event payloads and page views exclude route identifiers, names, metrics, and arbitrary text", () => {
  assert.deepEqual(toSafeAnalyticsPayload({ type: "gpx_analysis_failure", category: "invalid_gpx" }), {
    name: "gpx_analysis_failure", parameters: { error_category: "invalid_gpx" },
  });
  assert.deepEqual(toSafeAnalyticsPayload({ type: "sections_mode_selected", mode: "custom" }), {
    name: "sections_mode_selected", parameters: { mode: "custom" },
  });
  const page = safeAnalyticsPage("/route?name=secret#track");
  assert.equal(page.path, "/route");
  assert.equal(page.title, "GPX Route Analysis | Endurset");
  assert.equal(safeAnalyticsPage("/route/private-race?name=secret").path, "/other");
  const eventSource = toSafeAnalyticsPayload({ type: "feedback_submit_success" });
  assert.deepEqual(eventSource.parameters, {});
  assert.deepEqual(toSafeAnalyticsPayload({ type: "gpx_analysis_failure", category: "private route name" }), {
    name: "gpx_analysis_failure", parameters: { error_category: "processing_error" },
  });
  assert.equal(isValidGaMeasurementId("G-1A2B3C4D"), true);
  assert.equal(isValidGaMeasurementId("G-INVALID-ID-THAT-IS-TOO-LONG"), false);
});

test("analytics events and page views are not dispatched without a stored opt-in", () => {
  let calls = 0;
  const storage = memoryStorage();
  const window = { localStorage: storage, location: { origin: "https://endurset.com" }, gtag: () => calls++ };
  sendSafeAnalyticsEvent(window, { type: "gpx_analysis_success" }, "/route");
  sendSafePageView(window, "/route");
  assert.equal(calls, 0);
  saveAnalyticsConsent(storage, "accepted");
  sendSafeAnalyticsEvent(window, { type: "gpx_analysis_success" }, "/route?file=private.gpx");
  sendSafePageView(window, "/route?file=private.gpx");
  assert.equal(calls, 2);
});

test("privacy route, footer/settings entry points, and consent UI are accessible and responsive", async () => {
  const [page, home, manager, route] = await Promise.all([
    readFile(new URL("./privacy/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("./page.tsx", import.meta.url), "utf8"),
    readFile(new URL("./AnalyticsConsentManager.tsx", import.meta.url), "utf8"),
    readFile(new URL("./route/page.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(page, /export const metadata: Metadata/);
  assert.match(page, /Privacy Policy/);
  assert.match(page, /Data Controller &amp; Contact/);
  assert.match(page, /Marcel Bračić/);
  assert.match(page, /independent personal project operated by Marcel Bračić in Croatia/);
  assert.doesNotMatch(page, /before publication|must confirm|verify with provider|review applicable legal|must verify|must identify|TODO|FIXME|placeholder/i);
  assert.match(page, /endurset@gmail\.com/);
  assert.match(page, /derived route fingerprints are not sent to Endurset servers/);
  assert.match(page, /V1 does not check routes against a shared-route registry or save route geometry or analysis to a shared server database/);
  assert.doesNotMatch(page, /sends those fingerprints to Endurset|eligible shared-route persistence|check eligibility for shared-route reuse/);
  assert.match(page, /Course Brief in normal V1 Route Analysis is generated locally/);
  assert.doesNotMatch(page, /OPENAI_API_KEY|Course Brief API route remains|OpenAI as a recipient/);
  assert.match(page, /pseudonymous client identifier/);
  assert.match(page, /approximate visitor location such as country/);
  assert.match(page, /limited page views and approved product events/);
  assert.match(page, /legitimate interest under Article 6\(1\)\(f\).*improving Route Analysis/);
  assert.match(page, /spam and abuse prevention, service availability, and necessary security and operations/);
  assert.match(page, /You may object to processing based on legitimate interests/);
  assert.match(page, /A new analysis can be completed without that cache/);
  assert.match(page, /cache is not sent to Endurset servers and has no automatic expiry/);
  assert.match(page, /There is no in-app control to clear it/);
  assert.doesNotMatch(page, /Necessary storage supports requested app features/);
  assert.match(home, /href="\/privacy"[^>]*>Privacy Policy/);
  assert.match(home, /<PrivacySettingsLink\s*\/>/);
  assert.match(route, /<SiteFooter\s*\/>/);
  assert.match(manager, /role="region"/);
  assert.match(manager, /Accept analytics/);
  assert.match(manager, /Reject analytics/);
  assert.match(manager, /fixed inset-x-3 bottom-14[\s\S]*?flex flex-col gap-2 sm:flex-row/);
  assert.match(manager, /startBasicAnalytics\(document, window, measurementId, choice/);
  assert.match(manager, /choice === "accepted"/);
});
