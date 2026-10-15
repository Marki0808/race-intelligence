import { randomUUID } from "node:crypto";

const MAX_EVENTS_PER_REQUEST = 20;
const MAX_COUNT = 20_000;

export type GeoDiagnosticOutcome = "success" | "http_failure" | "network_error" | "abort" | "deadline" | "response_failure";
export type GeoAttemptDiagnostic = {
  attempt: number; depth: number; boxCount: number; queryBytes: number; queueWaitMs: number;
  cacheStatus: "hit" | "miss";
  fetchStartedAfterRequestMs: number | null; fetchElapsedMs: number | null; outcome: GeoDiagnosticOutcome;
  httpStatus: number | null; bodyReadMs: number | null; bodyBytes: number | null; jsonParseMs: number | null;
  jsonParseOutcome: "success" | "invalid" | "not_applicable"; abortReason: "attempt_timeout" | "deadline" | "client_cancelled" | "unknown" | null;
};

export type GeoEnrichmentDiagnostics = ReturnType<typeof createGeoEnrichmentDiagnostics>;

export function createGeoEnrichmentDiagnostics(options: { clientSignal?: AbortSignal; deadlineSignal?: AbortSignal } = {}) {
  const requestId = randomUUID();
  const startedAt = Date.now();
  let eventCount = 0;
  let finalized = false;
  const totals = {
    queryAttempts: 0,
    networkRequestsAttempted: 0,
    networkFailures: 0,
    httpFailures: 0,
    pendingDescendantsNotAttempted: 0,
    unattemptedDueToDeadline: 0,
    unattemptedDueToClientCancellation: 0,
    unattemptedDueToAttemptBudget: 0,
    unattemptedWhileQueued: 0,
    retries: 0,
    subdivisions: 0,
    cacheHits: 0,
    cacheMisses: 0,
    logicalTaskFailures: 0,
    retrievedRangeCount: 0,
    retrievedLengthKm: 0,
    unavailableRangeCount: 0,
    unavailableLengthKm: 0,
  };

  const emit = (event: string, fields: Record<string, number | string | boolean | null>) => {
    const eventLimit = event === "request_summary" ? MAX_EVENTS_PER_REQUEST : MAX_EVENTS_PER_REQUEST - 1;
    if (eventCount >= eventLimit) return;
    eventCount += 1;
    console.info("[geo-enrichment]", { event, requestId, ...fields });
  };

  emit("request_started", {});

  return {
    requestId,
    startedAt,
    clientSignal: options.clientSignal,
    deadlineSignal: options.deadlineSignal,
    totals,
    recordAttempt(fields: {
      attempt: number; depth: number; boxCount: number; queryBytes: number; queueWaitMs: number;
      cacheStatus: "hit" | "miss";
      fetchStartedAfterRequestMs: number | null; fetchElapsedMs: number | null; outcome: GeoDiagnosticOutcome;
      httpStatus: number | null; bodyReadMs: number | null; bodyBytes: number | null; jsonParseMs: number | null;
      jsonParseOutcome: "success" | "invalid" | "not_applicable"; abortReason: "attempt_timeout" | "deadline" | "client_cancelled" | "unknown" | null;
    }) {
      totals.queryAttempts += 1;
      if (fields.depth > 0 && (fields.fetchStartedAfterRequestMs !== null || fields.cacheStatus === "hit")) totals.retries += 1;
      if (fields.cacheStatus === "hit") totals.cacheHits += 1;
      else totals.cacheMisses += 1;
      if (fields.fetchStartedAfterRequestMs !== null) totals.networkRequestsAttempted += 1;
      if (fields.fetchStartedAfterRequestMs !== null && (fields.outcome === "network_error" || fields.outcome === "abort" || fields.outcome === "deadline")) totals.networkFailures += 1;
      if (fields.outcome === "http_failure") totals.httpFailures += 1;
      emit("query", fields);
    },
    recordLogicalFailure() {
      totals.logicalTaskFailures += 1;
    },
    recordSubdivision() {
      totals.subdivisions += 1;
    },
    recordUnattempted(count: number, reason: "deadline" | "client_cancelled" | "attempt_budget" | "queued_cancelled") {
      totals.pendingDescendantsNotAttempted += count;
      if (reason === "deadline") totals.unattemptedDueToDeadline += count;
      else if (reason === "client_cancelled") totals.unattemptedDueToClientCancellation += count;
      else if (reason === "attempt_budget") totals.unattemptedDueToAttemptBudget += count;
      else totals.unattemptedWhileQueued += count;
    },
    finish(fields: {
      outcome: "completed" | "deadline" | "client_cancelled" | "input_rejected" | "invalid_route" | "query_unavailable";
      routePointCount?: number; componentCount?: number; corridorWindowCount?: number; initialQueryCount?: number;
      rangesRetrieved?: Array<{ startDistanceKm: number; endDistanceKm: number }>;
      rangesUnavailable?: Array<{ startDistanceKm: number; endDistanceKm: number }>;
    }) {
      if (finalized) return;
      finalized = true;
      totals.retrievedRangeCount = fields.rangesRetrieved?.length ?? 0;
      totals.retrievedLengthKm = roundKm(totalLength(fields.rangesRetrieved));
      totals.unavailableRangeCount = fields.rangesUnavailable?.length ?? 0;
      totals.unavailableLengthKm = roundKm(totalLength(fields.rangesUnavailable));
      emit("request_summary", {
        outcome: fields.outcome,
        elapsedMs: boundedDuration(Date.now() - startedAt),
        deadlineOutcome: fields.outcome === "deadline" ? "expired" : "not_expired",
        routePointCount: boundedCount(fields.routePointCount ?? 0),
        componentCount: boundedCount(fields.componentCount ?? 0),
        corridorWindowCount: boundedCount(fields.corridorWindowCount ?? 0),
        initialQueryCount: boundedCount(fields.initialQueryCount ?? 0),
        ...totals,
        diagnosticEventCount: eventCount + 1,
      });
    },
  };
}

export function getAbortDiagnosticReason(diagnostics: GeoEnrichmentDiagnostics, signal?: AbortSignal) {
  if (diagnostics.deadlineSignal?.aborted) return "deadline" as const;
  if (diagnostics.clientSignal?.aborted) return "client_cancelled" as const;
  if (signal?.aborted) {
    if (signal.reason instanceof Error && signal.reason.name === "TimeoutError") return "deadline" as const;
    if (signal.reason instanceof Error && signal.reason.name === "AbortError") return "client_cancelled" as const;
    return "unknown" as const;
  }
  return null;
}

function totalLength(ranges: Array<{ startDistanceKm: number; endDistanceKm: number }> = []) {
  return ranges.reduce((total, range) => total + Math.max(0, range.endDistanceKm - range.startDistanceKm), 0);
}

function roundKm(value: number) {
  return Math.min(1_000_000, Math.round(value * 100) / 100);
}

function boundedCount(value: number) {
  return Math.min(MAX_COUNT, Math.max(0, Math.round(Number.isFinite(value) ? value : 0)));
}

function boundedDuration(value: number) {
  return Math.min(120_000, Math.max(0, Math.round(Number.isFinite(value) ? value : 0)));
}
