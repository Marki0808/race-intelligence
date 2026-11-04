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

test("homepage presents the GPX product with a clearly illustrative route preview", () => {
  assert.match(homePage, /Don&apos;t just analyze the route\. Understand it\./);
  assert.doesNotMatch(homePage, /Istria|Buzet|Umag|2027 Edition|homepageRaceRecord|CourseCharacter|CourseSection|CourseAnalysis|RaceSources/);
  assert.match(homePage, /Illustrative example/);
  assert.match(homePage, /Fictional profile and description\. No real route or measured values are shown\./);
  assert.match(homePage, /Illustrative trail elevation profile/);
  assert.match(homePage, /Why analyze your route\?/);
  assert.match(homePage, /className="topo-hero relative overflow-hidden/);
  assert.match(homePage, /className="topo-benefits border-y/);
  assert.match(homePage, /rounded-2xl border border-\[#e0e5dc\] bg-white\/95/);
  assert.match(homePage, /rounded-\[1\.75rem\] border border-\[#dce2d6\] bg-white\/81/);
  assert.doesNotMatch(homePage.match(/function AnalysisPreview\(\) \{[\s\S]*?\n\}/)?.[0] ?? "", /opacity-/);
});

test("Route Analysis is the only public V1 entry and Race Mode is centrally gated off", () => {
  assert.match(featureFlags, /RACE_MODE_V1_ENABLED = false/);
  assert.doesNotMatch(homePage, /RaceGpxDiscovery|RaceSearch|Analyze a race|Race Mode/);
  assert.match(homePage, /Analyze your route/);
  assert.doesNotMatch(homePage, /Will every race webpage provide a route\?/);
  assert.doesNotMatch(homePage, /Choose a race page or GPX file/);
  assert.doesNotMatch(homePage, /race or GPX course/);
  assert.match(homePage, /<RouteMode embedded\s*\/>/);
  assert.match(homePage, /href="#analyze"/);
  assert.match(homePage, /href="#faq"/);
  assert.match(homePage, /Understand the climbs|Explore meaningful sections|Know what to expect/);
  assert.doesNotMatch(homePage, /Choose how to start|Choose your starting point/);
});

test("landing sections are ordered with benefits before upload and the header CTA remains accessible", async () => {
  const styles = await readFile(new URL("./globals.css", import.meta.url), "utf8");
  const heroPosition = homePage.indexOf("Don&apos;t just analyze the route.");
  const benefitsPosition = homePage.indexOf("Why analyze your route?");
  const uploadPosition = homePage.indexOf("<RouteMode embedded");
  const faqPosition = homePage.indexOf('id="faq"');
  assert.ok(heroPosition >= 0 && heroPosition < benefitsPosition);
  assert.ok(benefitsPosition < uploadPosition && uploadPosition < faqPosition);
  assert.match(homePage, /href="#analyze" className="inline-flex[^"]*bg-\[#26382f\][^"]*text-white[^"]*hover:bg-\[#354b3f\][^"]*focus-visible:outline/);
  assert.match(routeMode, /Choose GPX file/);
  assert.match(routeMode, /bg-\[#b9d975\]/);
  assert.match(routeMode, /id="analyze" className="topo-upload scroll-mt-24/);
  assert.match(homePage, /id="faq" className="topo-benefits scroll-mt-24/);
  assert.match(styles, /scroll-padding-top: 5\.5rem/);
  assert.match(styles, /\.topo-hero[\s\S]*?linear-gradient\(100deg,[\s\S]*?url\("\/hero-trail-runner\.webp"\)/);
  assert.match(styles, /\.topo-benefits[\s\S]*?url\("\/topographic-contours\.svg"\)/);
  assert.match(styles, /@media \(max-width: 640px\)[\s\S]*?\.topo-hero[\s\S]*?background-position: center, 25% center/);
  assert.match(styles, /rgba\(245, 246, 239, \.94\) 0%[\s\S]*?rgba\(239, 242, 233, \.12\) 67%/);
  assert.match(homePage, /bg-white\/81/);
  assert.match(styles, /\.topo-upload[\s\S]*?linear-gradient\(112deg,[\s\S]*?url\("\/topographic-contours\.svg"\)/);
  const heroImage = await readFile(new URL("../public/hero-trail-runner.webp", import.meta.url));
  assert.equal(heroImage.toString("ascii", 0, 4), "RIFF");
  assert.equal(heroImage.toString("ascii", 8, 12), "WEBP");
  assert.ok(heroImage.length < 300_000, "optimized hero image should remain web-efficient");
  const contours = await readFile(new URL("../public/topographic-contours.svg", import.meta.url), "utf8");
  assert.match(contours, /stroke-opacity="\.48" stroke-width="1\.35"/);
  assert.ok((contours.match(/<path/g) ?? []).length >= 10, "contour groups retain nested cartographic shapes");
});

test("old registered Race Mode URLs redirect to the primary GPX upload experience", () => {
  assert.match(raceEditionPage, /if \(!RACE_MODE_V1_ENABLED\) redirect\("\/route"\)/);
  assert.match(raceEditionPage, /resolveByRaceEdition/);
});

test("the homepage embeds the existing Route Mode upload and analysis workflow directly", () => {
  assert.match(routeMode, /export default function RouteMode\(\{ embedded = false \}/);
  assert.match(routeMode, /if \(embedded\)[\s\S]*?<section id="analyze"/);
  assert.match(routeMode, /type="file"/);
  assert.match(routeMode, /onChange=\{handleFileChange\}/);
  assert.match(routeMode, /onDrop=/);
  assert.match(routeMode, /readGpxUpload\(file\)/);
  assert.match(routeMode, /<RouteAnalysisView/);
  assert.match(routeMode, /input\.value = ""/);
  assert.match(routeMode, /Your GPX file is analyzed in this browser/);
  assert.match(routeMode, /No route fingerprint or route geometry is sent to Endurset servers/);
  assert.match(routeMode, /href="\/privacy"/);
  assert.match(routeMode, /Free to use\. No account required\./);
});

test("homepage upload retains valid selection, invalid file feedback, and re-upload safeguards", async () => {
  const uploadTests = await readFile(new URL("./gpxUpload.test.mjs", import.meta.url), "utf8");
  assert.match(uploadTests, /valid GPX|valid file|accepts valid/i);
  assert.match(uploadTests, /unsupported-file-name|invalid/i);
  assert.match(routeMode, /handleSelectedFile\(file\)/);
  assert.match(routeMode, /beginRouteRequest\(\)/);
  assert.match(routeMode, /aria-live="polite"/);
  assert.match(routeMode, /role="alert"/);
  assert.match(routeMode, /requestGate\.current\.isCurrent\(requestId\)/);
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
  assert.match(routeMode, /accept="\.gpx,\.xml,application\/gpx\+xml,application\/xml,text\/xml"/);
  assert.match(routeMode, /onChange=\{handleFileChange\}/);
  assert.match(routeMode, /readGpxUpload\(file\)/);
  assert.match(routeMode, /setIsProcessing\(true\)/);
  assert.match(routeMode, /requestGate\.current\.isCurrent\(requestId\)/);
  assert.doesNotMatch(routeMode, /Race Search|choose a discovered route link/);
});

test("homepage FAQ is data-driven and limited to supported application behavior", () => {
  assert.match(homePage, /<section id="faq" className="topo-benefits scroll-mt-24/);
  assert.match(homePage, /const faqs = \[/);
  assert.equal((homePage.match(/question: "/g) ?? []).length, 7);
  assert.match(homePage, /Frequently asked questions/);
  assert.match(homePage, /Can this predict how difficult a race will be for me\?/);
  assert.match(homePage, /does not predict race time, trail surface, conditions or your personal effort/);
  assert.match(homePage, /derived route fingerprints are not sent to Endurset servers/);
  assert.match(homePage, /Map tiles are requested for the area you view/);
  assert.match(homePage, /Privacy Policy/);
  assert.match(homePage, /<RouteMode embedded\s*\/>\s*<NewsletterSignup\s*\/>\s*<section id="faq"/);
  assert.match(homePage, /import NewsletterSignup from "\.\/NewsletterSignup"/);
});
