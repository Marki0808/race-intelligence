import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [home, routeMode, racePage, layout, privacy] = await Promise.all([
  readFile(new URL("./page.tsx", import.meta.url), "utf8"),
  readFile(new URL("./RouteMode.tsx", import.meta.url), "utf8"),
  readFile(new URL("./RacePageContent.tsx", import.meta.url), "utf8"),
  readFile(new URL("./layout.tsx", import.meta.url), "utf8"),
  readFile(new URL("./privacy/page.tsx", import.meta.url), "utf8"),
]);

function pngDimensions(buffer) {
  assert.equal(buffer.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", "asset should be a PNG");
  return [buffer.readUInt32BE(16), buffer.readUInt32BE(20)];
}

test("public brand locations use the supplied wordmark with accessible home links", () => {
  assert.equal((home.match(/ENDURSET/g) ?? []).length, 0);
  assert.equal((home.match(/aria-label="Endurset home"/g) ?? []).length, 2);
  assert.match(home, /src="\/brand\/endurset-wordmark\.png"/);
  assert.match(home, /src="\/brand\/endurset-e\.png"/);
  assert.match(home, /min-\[380px\]:block/);
  assert.match(routeMode, /aria-label="Endurset home"/);
  assert.match(routeMode, /src="\/brand\/endurset-wordmark\.png"/);
  assert.match(routeMode, /src="\/brand\/endurset-e\.png"/);
  assert.match(racePage, /src="\/brand\/endurset-wordmark\.png"/);
  assert.match(racePage, /aria-label="Endurset home"/);
  assert.match(privacy, /src="\/brand\/endurset-wordmark\.png"/);
  assert.match(privacy, /src="\/brand\/endurset-e\.png"/);
  assert.match(privacy, /min-\[380px\]:block/);
  assert.match(privacy, /Back to Endurset/);
  assert.match(privacy, /src="\/brand\/endurset-wordmark-dark\.png"/);
  assert.doesNotMatch(privacy, /<Link href="\/" className="text-lg font-black tracking-\[\.12em\] text-\[#203329\]"[^>]*>ENDURSET/);
});

test("approved supplied brand assets and native icon sizes are installed without upscaling", async () => {
  const assets = [
    ["../public/brand/endurset-wordmark.png", [2015, 314]],
    ["../public/brand/endurset-e.png", [417, 314]],
    ["../public/brand/endurset-wordmark-dark.png", [2015, 314]],
    ...[16, 32, 64, 512].flatMap((size) => [
      [`../public/brand/icons/endurset-icon-light-${size}.png`, [size, size]],
      [`../public/brand/icons/endurset-icon-dark-${size}.png`, [size, size]],
    ]),
    ["./apple-icon.png", [512, 512]],
  ];
  for (const [path, expected] of assets) {
    const data = await readFile(new URL(path, import.meta.url));
    assert.deepEqual(pngDimensions(data), expected, `${path} should retain its supplied dimensions`);
  }
});

test("SEO and social metadata use Endurset without claiming an unverified canonical domain or image", () => {
  assert.match(layout, /applicationName: "Endurset"/);
  assert.match(layout, /Endurset — GPX Route Analysis for Trail Running/);
  assert.match(layout, /Understand your trail route before race day\./);
  assert.match(layout, /openGraph:\s*\{[\s\S]*?siteName: "Endurset"[\s\S]*?type: "website"/);
  assert.match(layout, /twitter:\s*\{[\s\S]*?card: "summary"[\s\S]*?title:/);
  assert.match(layout, /prefers-color-scheme: dark/);
  assert.match(layout, /endurset-icon-dark-16\.png/);
  assert.match(layout, /endurset-icon-light-16\.png/);
  assert.doesNotMatch(layout, /metadataBase|canonical|endurset\.com|images:/i);
  assert.doesNotMatch(layout.match(/openGraph:\s*\{[\s\S]*?\n  \}/)?.[0] ?? "", /url:/i);
});

test("dark-surface footer uses the transparent high-contrast wordmark without a badge", () => {
  assert.match(home, /<footer className="bg-\[#203329\] py-8 text-white">/);
  assert.match(home, /src="\/brand\/endurset-wordmark-dark\.png"/);
  assert.match(racePage, /src="\/brand\/endurset-wordmark-dark\.png"/);
  assert.doesNotMatch(home.match(/<footer[\s\S]*?<\/footer>/)?.[0] ?? "", /bg-\[#f5f5ef\]|rounded/);
  assert.match(home, /max-w-7xl flex-col gap-4 px-5 sm:flex-row sm:items-center sm:justify-between sm:px-8 lg:px-10/);
});
