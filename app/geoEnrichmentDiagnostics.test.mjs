import assert from "node:assert/strict";
import test from "node:test";
import { createGeoEnrichmentDiagnostics, getAbortDiagnosticReason } from "./geoEnrichmentDiagnostics.ts";

test("geo diagnostics use a random correlation ID and emit only bounded aggregate fields", (context) => {
  const originalInfo = console.info;
  const logs = [];
  console.info = (...args) => logs.push(args);
  context.after(() => { console.info = originalInfo; });

  const diagnostics = createGeoEnrichmentDiagnostics();
  diagnostics.recordAttempt({
    attempt: 1, depth: 0, boxCount: 8, queryBytes: 1400, queueWaitMs: 12,
    cacheStatus: "miss", fetchStartedAfterRequestMs: 15, fetchElapsedMs: 25, outcome: "success",
    httpStatus: 200, bodyReadMs: 8, bodyBytes: 2048, jsonParseMs: 3,
    jsonParseOutcome: "success", abortReason: null,
  });
  diagnostics.finish({
    outcome: "completed", routePointCount: 20001, componentCount: 2, corridorWindowCount: 4,
    initialQueryCount: 1, rangesRetrieved: [{ startDistanceKm: 0, endDistanceKm: 12.345 }],
    rangesUnavailable: [],
  });

  assert.equal(logs.length, 3);
  const serialized = JSON.stringify(logs);
  assert.doesNotMatch(serialized, /45\.123|13\.456|private route name|secret response body|latitude|longitude/i);
  const requestIds = [...serialized.matchAll(/"requestId":"([^"]+)"/g)].map((match) => match[1]);
  assert.ok(requestIds[0]);
  assert.match(requestIds[0], /^[0-9a-f-]{36}$/i);
  assert.ok(requestIds.every((id) => id === requestIds[0]));
  assert.match(serialized, /"routePointCount":20000/);
  assert.match(serialized, /"retrievedLengthKm":12\.35/);
});

test("geo diagnostics cap log volume at twenty events per request", (context) => {
  const originalInfo = console.info;
  const logs = [];
  console.info = (...args) => logs.push(args);
  context.after(() => { console.info = originalInfo; });

  const diagnostics = createGeoEnrichmentDiagnostics();
  for (let index = 0; index < 40; index += 1) {
    diagnostics.recordAttempt({
      attempt: index + 1, depth: 1, boxCount: 1, queryBytes: 200, queueWaitMs: 0,
      cacheStatus: "miss", fetchStartedAfterRequestMs: 1, fetchElapsedMs: 1, outcome: "network_error",
      httpStatus: null, bodyReadMs: null, bodyBytes: null, jsonParseMs: null,
      jsonParseOutcome: "not_applicable", abortReason: null,
    });
  }
  diagnostics.finish({ outcome: "query_unavailable" });
  assert.equal(logs.length, 20);
  assert.equal(logs.at(-1)[1].event, "request_summary");
});

test("geo diagnostics distinguish deadline and client cancellation from queued work", (context) => {
  const originalInfo = console.info;
  const logs = [];
  console.info = (...args) => logs.push(args);
  context.after(() => { console.info = originalInfo; });
  const deadline = new AbortController();
  const client = new AbortController();
  const diagnostics = createGeoEnrichmentDiagnostics({ deadlineSignal: deadline.signal, clientSignal: client.signal });

  deadline.abort();
  assert.equal(getAbortDiagnosticReason(diagnostics), "deadline");
  client.abort();
  assert.equal(getAbortDiagnosticReason(diagnostics), "deadline", "deadline has priority when both signals have fired");
  diagnostics.recordUnattempted(2, "deadline");
  diagnostics.recordUnattempted(3, "client_cancelled");
  diagnostics.recordUnattempted(1, "attempt_budget");
  diagnostics.recordUnattempted(4, "queued_cancelled");
  diagnostics.finish({ outcome: "deadline" });

  const summary = logs.at(-1)[1];
  assert.equal(summary.pendingDescendantsNotAttempted, 10);
  assert.equal(summary.unattemptedDueToDeadline, 2);
  assert.equal(summary.unattemptedDueToClientCancellation, 3);
  assert.equal(summary.unattemptedDueToAttemptBudget, 1);
  assert.equal(summary.unattemptedWhileQueued, 4);
});
