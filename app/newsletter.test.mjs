import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createNewsletterPostHandler } from "./newsletterApi.ts";
import {
  NEWSLETTER_CONSENT_TEXT_VERSION,
  NEWSLETTER_MAX_EMAIL_CHARACTERS,
  NEWSLETTER_MAX_REQUEST_BYTES,
  NEWSLETTER_RATE_LIMITS,
  newsletterRateLimitExceeded,
  normalizeNewsletterEmail,
} from "./newsletterContract.ts";

function request(body, headers = {}) {
  return new Request("https://endurset.example/api/newsletter", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.7", ...headers },
    body,
  });
}

test("newsletter email is trimmed, normalized, length-bounded, and validated", () => {
  assert.equal(normalizeNewsletterEmail("  Runner.Name+Trail@Example.COM "), "runner.name+trail@example.com");
  for (const value of ["", "not-an-email", "a@localhost", "a..b@example.com", "a @example.com", "a".repeat(NEWSLETTER_MAX_EMAIL_CHARACTERS + 1) + "@x.example"]) {
    assert.equal(normalizeNewsletterEmail(value), null);
  }
});

test("valid consent records a normalized address and returns no subscriber data", async () => {
  const calls = [];
  const post = createNewsletterPostHandler(async (...args) => { calls.push(args); return "recorded"; });
  const response = await post(request(JSON.stringify({ email: " Runner@Example.com ", consent: true })));
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.deepEqual(body, { success: true });
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(calls, [["runner@example.com", "203.0.113.7"]]);
  assert.doesNotMatch(JSON.stringify(body), /runner@example.com|pending_confirmation/);
});

test("duplicate addresses are indistinguishable and consent is mandatory", async () => {
  const post = createNewsletterPostHandler(async () => "recorded");
  const first = await post(request(JSON.stringify({ email: "same@example.com", consent: true })));
  const repeat = await post(request(JSON.stringify({ email: "same@example.com", consent: true })));
  assert.equal(first.status, repeat.status);
  assert.deepEqual(await first.json(), await repeat.json());
  assert.equal((await post(request(JSON.stringify({ email: "same@example.com", consent: false })))).status, 400);
  assert.equal((await post(request(JSON.stringify({ email: "same@example.com" })))).status, 400);
});

test("malformed, invalid, oversized, and non-JSON requests are rejected before storage", async () => {
  let writes = 0;
  const post = createNewsletterPostHandler(async () => { writes += 1; return "recorded"; });
  assert.equal((await post(request("{"))).status, 400);
  assert.equal((await post(request(JSON.stringify({ email: "bad", consent: true })))).status, 400);
  assert.equal((await post(request(JSON.stringify({ email: "x".repeat(NEWSLETTER_MAX_EMAIL_CHARACTERS + 1), consent: true })))).status, 413);
  assert.equal((await post(request(JSON.stringify({ email: "a@example.com", consent: true }), { "content-length": String(NEWSLETTER_MAX_REQUEST_BYTES + 1) }))).status, 413);
  assert.equal((await post(request("{}", { "content-type": "text/plain" }))).status, 415);
  assert.equal(writes, 0);
});

test("rate limits and database failure responses do not disclose address or storage details", async () => {
  const limited = createNewsletterPostHandler(async () => "rate_limited");
  assert.equal((await limited(request(JSON.stringify({ email: "private@example.com", consent: true })))).status, 429);
  const failing = createNewsletterPostHandler(async () => { throw new Error("private@example.com POSTGRES_URL=secret"); });
  const response = await failing(request(JSON.stringify({ email: "private@example.com", consent: true })));
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "newsletter_unavailable" });
  assert.deepEqual(NEWSLETTER_RATE_LIMITS, { perClientHourly: 3, globalHourly: 30, globalDaily: 100 });
  assert.equal(newsletterRateLimitExceeded({ perClientHourly: 3, globalHourly: 30, globalDaily: 100 }), false);
  assert.equal(newsletterRateLimitExceeded({ perClientHourly: 4, globalHourly: 0, globalDaily: 0 }), true);
  assert.equal(newsletterRateLimitExceeded({ perClientHourly: 0, globalHourly: 31, globalDaily: 0 }), true);
  assert.equal(newsletterRateLimitExceeded({ perClientHourly: 0, globalHourly: 0, globalDaily: 101 }), true);
});

test("missing trusted client address fails closed and no mailing-status lookup endpoint exists", async () => {
  const post = createNewsletterPostHandler(async () => "recorded");
  const response = await post(new Request("https://endurset.example/api/newsletter", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "a@example.com", consent: true }),
  }));
  assert.equal(response.status, 503);
  const route = await readFile(new URL("./api/newsletter/route.ts", import.meta.url), "utf8");
  assert.match(route, /export const POST/);
  assert.doesNotMatch(route, /export const (?:GET|PUT|PATCH|DELETE)/);
});

test("signup remains pending and stores only required fields with atomic, isolated limiter state", async () => {
  const [store, migration] = await Promise.all([
    readFile(new URL("./server/newsletterSubscriberStore.ts", import.meta.url), "utf8"),
    readFile(new URL("../supabase/migrations/202611040001_endurset_newsletter.sql", import.meta.url), "utf8"),
  ]);
  assert.equal(NEWSLETTER_CONSENT_TEXT_VERSION, "newsletter-consent-v1");
  assert.match(store, /'pending_confirmation'/);
  assert.match(store, /where newsletter_subscribers\.status = 'unsubscribed'/);
  assert.match(store, /database\.begin\(async \(transaction\)/);
  assert.match(store, /createHmac\("sha256"/);
  assert.match(store, /NEWSLETTER_RATE_LIMIT_SECRET/);
  assert.match(store, /insert into public\.newsletter_subscribers[\s\S]*?email_normalized, registered_at, consent_at, consent_text_version, status/);
  assert.doesNotMatch(store, /console\.(?:log|warn|error)|\.unsafe\(|insert into public\.route_feedback/);
  assert.match(migration, /create table if not exists public\.newsletter_subscribers/);
  assert.match(migration, /email_normalized text not null unique/);
  assert.match(migration, /status in \('pending_confirmation', 'subscribed', 'unsubscribed'\)/);
  assert.match(migration, /alter table public\.newsletter_subscribers enable row level security/);
  assert.match(migration, /revoke all on public\.newsletter_subscribers from public, anon, authenticated/);
  assert.match(migration, /create table if not exists public\.newsletter_rate_limit_buckets/);
  assert.doesNotMatch(migration, /ip_address|route_fingerprint|coordinates|analytics_id/i);
});

test("newsletter UI is separate from analytics and policy describes real pending-confirmation behavior", async () => {
  const [form, page, privacy, operations] = await Promise.all([
    readFile(new URL("./NewsletterSignup.tsx", import.meta.url), "utf8"),
    readFile(new URL("./page.tsx", import.meta.url), "utf8"),
    readFile(new URL("./privacy/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../docs/newsletter-operations.md", import.meta.url), "utf8"),
  ]);
  assert.match(page, /<RouteMode embedded\s*\/>\s*<NewsletterSignup\s*\/>\s*<section id="faq"/);
  assert.match(form, /Stay in the loop\./);
  assert.match(form, /type="email"/);
  assert.match(form, /required checked=\{consent\}/);
  assert.match(form, /You can withdraw consent by emailing/);
  assert.match(form, /Email verification will be required before updates are sent/);
  assert.match(form, /submitted\.current/);
  assert.doesNotMatch(form, /analyticsClient|routeFingerprint|filename|coordinates/i);
  assert.match(privacy, /Newsletter signups/);
  assert.match(privacy, /pending confirmation; no confirmation email is sent/);
  assert.match(privacy, /Pending signups are due for deletion after six months/);
  assert.match(privacy, /newsletter signups, the server uses transient connection information/);
  assert.match(privacy, /raw address is not stored in the feedback or newsletter rate-limit tables/);
  assert.match(operations, /status = 'subscribed'/);
  assert.match(operations, /No real subscriber list has been exported/);
  assert.match(operations, /newsletter_subscribers/);
});
