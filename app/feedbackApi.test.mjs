import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createFeedbackPostHandler, getTrustedClientAddress } from "./feedbackApi.ts";
import { MAX_FEEDBACK_CHARACTERS, MAX_FEEDBACK_REQUEST_BYTES } from "./feedbackContract.ts";
import { FEEDBACK_RATE_LIMITS, feedbackRateLimitExceeded } from "./feedbackRateLimit.ts";
import { FeedbackSubmissionGate } from "./feedbackSubmissionGate.ts";

function request(body, options = {}) {
  return new Request("https://race.example/api/feedback", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.12", ...options.headers },
    body,
  });
}

test("feedback API trims and stores a successful message without returning stored content", async () => {
  const calls = [];
  const post = createFeedbackPostHandler(async (...args) => { calls.push(args); return "stored"; }, () => "203.0.113.12");
  const response = await post(request(JSON.stringify({ feedback: "  Useful route breakdown.  " })));
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { success: true });
  assert.deepEqual(calls, [["Useful route breakdown.", "203.0.113.12"]]);
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("empty, whitespace, oversized and malformed submissions are rejected before storage", async () => {
  let writes = 0;
  const post = createFeedbackPostHandler(async () => { writes += 1; return "stored"; }, () => "203.0.113.12");
  assert.equal((await post(request(JSON.stringify({ feedback: " \n " })))).status, 400);
  assert.equal((await post(request(JSON.stringify({ feedback: "x".repeat(MAX_FEEDBACK_CHARACTERS + 1) })))).status, 413);
  assert.equal((await post(request("{"))).status, 400);
  assert.equal((await post(request(JSON.stringify({ feedback: "x" }), { headers: { "content-length": String(MAX_FEEDBACK_REQUEST_BYTES + 1) } }))).status, 413);
  assert.equal((await post(request(JSON.stringify({ feedback: "x" }), { headers: { "content-type": "text/plain" } }))).status, 415);
  assert.equal(writes, 0);
});

test("a durable rate-limit denial is returned as 429 and the message is not written", async () => {
  const post = createFeedbackPostHandler(async () => "rate_limited", () => "203.0.113.12");
  const response = await post(request(JSON.stringify({ feedback: "Please improve this." })));
  assert.equal(response.status, 429);
  assert.deepEqual(await response.json(), { error: "rate_limited" });
});

test("per-client and global hourly/daily limits allow the documented boundary and block the next request", () => {
  assert.deepEqual(FEEDBACK_RATE_LIMITS, { perClientHourly: 3, globalHourly: 30, globalDaily: 100 });
  assert.equal(feedbackRateLimitExceeded({ perClientHourly: 3, globalHourly: 30, globalDaily: 100 }), false);
  assert.equal(feedbackRateLimitExceeded({ perClientHourly: 4, globalHourly: 0, globalDaily: 0 }), true);
  assert.equal(feedbackRateLimitExceeded({ perClientHourly: 0, globalHourly: 31, globalDaily: 0 }), true);
  assert.equal(feedbackRateLimitExceeded({ perClientHourly: 0, globalHourly: 0, globalDaily: 101 }), true);
});

test("database failures return a generic response without exposing secrets or message text", async () => {
  const post = createFeedbackPostHandler(async () => { throw new Error("POSTGRES_URL=postgres-secret feedback private text"); }, () => "203.0.113.12");
  const response = await post(request(JSON.stringify({ feedback: "private user text" })));
  assert.equal(response.status, 503);
  const body = await response.text();
  assert.equal(body, JSON.stringify({ error: "feedback_unavailable" }));
  assert.doesNotMatch(body, /postgres-secret|private user text|POSTGRES_URL/);
});

test("missing trusted client address fails closed instead of bypassing rate limiting", async () => {
  let writes = 0;
  const post = createFeedbackPostHandler(async () => { writes += 1; return "stored"; }, () => null);
  assert.equal((await post(request(JSON.stringify({ feedback: "message" })))).status, 503);
  assert.equal(writes, 0);
  assert.equal(getTrustedClientAddress(new Request("https://race.example/api/feedback", { headers: { "x-forwarded-for": "spoofed" } })), null);
});

test("submission gate blocks rapid duplicate activation and unlocks after completion", () => {
  const gate = new FeedbackSubmissionGate();
  assert.equal(gate.begin(), true);
  assert.equal(gate.begin(), false);
  gate.finish();
  assert.equal(gate.begin(), true);
  gate.finish();
});

test("feedback UI is isolated from analysis data and preserves text after request failure", async () => {
  const [form, view, routeMode] = await Promise.all([
    readFile(new URL("./FeedbackForm.tsx", import.meta.url), "utf8"),
    readFile(new URL("./RouteAnalysisView.tsx", import.meta.url), "utf8"),
    readFile(new URL("./RouteMode.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(form, /maxLength=\{MAX_FEEDBACK_CHARACTERS\}/);
  assert.match(form, /if \(!feedback \|\| !submissionGate\.current\.begin\(\)\) return/);
  assert.match(form, /catch \(caught\) \{\s*setError\(caught instanceof Error[\s\S]*?Feedback could not be sent right now/);
  assert.match(form, /setSubmitted\(true\);\s*setMessage\(""\);/);
  assert.match(form, /label htmlFor="route-feedback-message"/);
  assert.match(form, /role="status" aria-live="polite"/);
  assert.match(form, /<section className="topo-benefits border-t border-\[#e0e5dc\]/);
  assert.match(form, /rounded-3xl border border-\[#dce2d6\] bg-\[#f4f2ed\]/);
  assert.doesNotMatch(view, /FeedbackForm/);
  assert.match(routeMode, /<section id="analyze"[\s\S]*?<\/section>\s*\{analysis && <FeedbackForm \/>\}/);
  assert.match(routeMode, /\{analysisView\}[\s\S]*?\{analysis && <FeedbackForm \/>\}/);
  assert.doesNotMatch(form, /routeFingerprint|routeName|filename|coordinates|email/i);
});

test("feedback schema stores only the submission ID, text and timestamp; limiter digest has expiry and RLS", async () => {
  const migration = await readFile(new URL("../supabase/migrations/202611010001_route_feedback.sql", import.meta.url), "utf8");
  const submission = migration.match(/create table if not exists public\.route_feedback_submissions \(([\s\S]*?)\n\);/i)?.[1] ?? "";
  assert.match(submission, /id uuid primary key/);
  assert.match(submission, /feedback_text text not null/);
  assert.match(submission, /created_at timestamptz not null default now\(\)/);
  assert.doesNotMatch(submission, /ip|email|route|fingerprint|filename|user_id/i);
  assert.match(migration, /bucket_hash text primary key/);
  assert.match(migration, /expires_at timestamptz not null/);
  assert.match(migration, /alter table public\.route_feedback_submissions enable row level security/i);
  assert.match(migration, /alter table public\.route_feedback_rate_limit_buckets enable row level security/i);
});

test("privileged database and limiter secrets stay in server-only modules", async () => {
  const clientFiles = ["FeedbackForm.tsx", "RouteAnalysisView.tsx"];
  for (const file of clientFiles) {
    const source = await readFile(new URL(`./${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /POSTGRES_URL|FEEDBACK_RATE_LIMIT_SECRET|SUPABASE_SERVICE_ROLE_KEY/);
  }
  const store = await readFile(new URL("./server/feedbackSubmissionStore.ts", import.meta.url), "utf8");
  assert.match(store, /process\.env\.POSTGRES_URL/);
  assert.match(store, /process\.env\.FEEDBACK_RATE_LIMIT_SECRET/);
  assert.match(store, /createHmac\("sha256"/);
  assert.match(store, /database\.begin\(async \(transaction\)/);
  assert.match(store, /insert into public\.route_feedback_rate_limit_buckets[\s\S]*?on conflict \(bucket_hash\) do update/);
  assert.match(store, /insert into public\.route_feedback_submissions \(id, feedback_text\)/);
  assert.doesNotMatch(store, /\.unsafe\(|console\.(?:log|warn|error)/);
});

test("feedback privacy, deployment requirements and deletion procedure are documented", async () => {
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
  assert.match(readme, /FEEDBACK_RATE_LIMIT_SECRET/);
  assert.match(readme, /HMACs the address/);
  assert.match(readme, /12 months/);
  assert.match(readme, /delete from public\.route_feedback_submissions/);
});
