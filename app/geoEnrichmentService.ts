import {
  createGeoEnrichment,
  createUnknownGeoEnrichment,
  getRouteBoundingBox,
  getRouteCorridorWindows,
  isUsefulBoundingBox,
  thinRouteForMatching,
} from "./geoEnrichment.ts";
import type { GeoDistanceRange, GeoRetrievalFailureCounts, GeoRoutePoint, OSMWayFeature, RouteCorridorWindow } from "./geoEnrichment.ts";

const OVERPASS_ENDPOINT = "https://overpass-api.de/api/interpreter";
const CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_CACHE_ENTRIES = 40;
const MAX_ROUTE_POINTS = 20_000;
const MIN_REQUEST_INTERVAL_MS = 2_000;
const MAX_CONCURRENT_REQUESTS = 2;
const MAX_REQUESTS_PER_DAY = 90;
export const MAX_CORRIDOR_BOXES_PER_QUERY = 8;
export const MAX_CORRIDOR_QUERIES_PER_ROUTE = 6;
const MAX_CORRIDOR_WINDOWS_PER_ROUTE = MAX_CORRIDOR_BOXES_PER_QUERY * MAX_CORRIDOR_QUERIES_PER_ROUTE;
export const MAX_ADAPTIVE_RETRIES_PER_ROUTE = 12;
export const MAX_ADAPTIVE_SUBDIVISION_DEPTH = 2;
export const MAX_OVERPASS_ATTEMPTS_PER_ROUTE = MAX_CORRIDOR_QUERIES_PER_ROUTE + MAX_ADAPTIVE_RETRIES_PER_ROUTE;
const ADAPTIVE_WINDOW_PADDING_DEGREES = 0.003;
const cache = new Map<string, { expiresAt: number; ways: OSMWayFeature[] }>();
const requestTimestamps: number[] = [];
const pendingRequests: Array<() => Promise<void>> = [];
let activeRequests = 0;
let lastRequestStartedAt = 0;
let requestTimer: ReturnType<typeof setTimeout> | undefined;

export type OverpassCorridorQuery = {
  windows: RouteCorridorWindow[];
  boxes: RouteCorridorWindow["box"][];
  startDistanceKm: number;
  endDistanceKm: number;
};

export type RetrievalFailureCategory = keyof GeoRetrievalFailureCounts;
export type AdaptiveQueryFailure<Query> = {
  query: Query;
  category: RetrievalFailureCategory;
  attempted: boolean;
};
export type AdaptiveQueryResult<Query, Value> = {
  successes: Array<{ query: Query; value: Value }>;
  failures: AdaptiveQueryFailure<Query>[];
  attempts: number;
  failureCounts: GeoRetrievalFailureCounts;
};

export function createOverpassCorridorQueries(points: GeoRoutePoint[]): OverpassCorridorQuery[] | null {
  const windows = getRouteCorridorWindows(points);
  if (
    windows.length === 0 ||
    windows.length > MAX_CORRIDOR_WINDOWS_PER_ROUTE ||
    windows.some((window) => !isUsefulBoundingBox(window.box))
  ) return null;

  const queries: OverpassCorridorQuery[] = [];
  for (let start = 0; start < windows.length; start += MAX_CORRIDOR_BOXES_PER_QUERY) {
    const group = windows.slice(start, start + MAX_CORRIDOR_BOXES_PER_QUERY);
    queries.push({
      windows: group,
      boxes: group.map((window) => window.box),
      startDistanceKm: group[0].startDistanceKm,
      endDistanceKm: group.at(-1)!.endDistanceKm,
    });
  }
  return queries.length <= MAX_CORRIDOR_QUERIES_PER_ROUTE ? queries : null;
}

/** Deterministic, bounded retry orchestration shared by the live service and fixture tests. */
export async function runAdaptiveRetrieval<Query, Value>(
  initialQueries: Query[],
  execute: (query: Query) => Promise<Value>,
  subdivide: (query: Query) => Query[],
  isRetryable: (error: unknown) => RetrievalFailureCategory | null,
  getRange: (query: Query) => GeoDistanceRange,
  options: { maxAttempts: number; maxDepth: number },
): Promise<AdaptiveQueryResult<Query, Value>> {
  type Task = { query: Query; depth: number };
  let pending: Task[] = initialQueries.map((query) => ({ query, depth: 0 }));
  const successes: AdaptiveQueryResult<Query, Value>["successes"] = [];
  const failures: AdaptiveQueryFailure<Query>[] = [];
  const failureCounts: GeoRetrievalFailureCounts = {
    http429: 0,
    http504: 0,
    timeout: 0,
    otherTransient: 0,
    permanent: 0,
    budgetExhausted: 0,
  };
  let attempts = 0;

  while (pending.length > 0) {
    const available = Math.max(0, options.maxAttempts - attempts);
    if (available === 0) {
      failures.push(...pending.map(({ query }) => ({ query, category: "budgetExhausted" as const, attempted: false })));
      failureCounts.budgetExhausted += pending.length;
      break;
    }
    const batch = selectFairTasks(pending, Math.min(available, pending.length), getRange);
    const selected = new Set(batch);
    const skipped = pending.filter((task) => !selected.has(task));
    failures.push(...skipped.map(({ query }) => ({ query, category: "budgetExhausted" as const, attempted: false })));
    failureCounts.budgetExhausted += skipped.length;
    attempts += batch.length;
    const results = await Promise.allSettled(batch.map(({ query }) => execute(query)));
    const next: Task[] = [];

    results.forEach((result, index) => {
      const task = batch[index];
      if (result.status === "fulfilled") {
        successes.push({ query: task.query, value: result.value });
        return;
      }
      const category = isRetryable(result.reason);
      failureCounts[category ?? "permanent"] += 1;
      const children = category && task.depth < options.maxDepth ? subdivide(task.query) : [];
      if (children.length === 0) {
        failures.push({ query: task.query, category: category ?? "permanent", attempted: true });
        return;
      }
      next.push(...children.map((query) => ({ query, depth: task.depth + 1 })));
    });
    pending = next.sort((a, b) => getRange(a.query).startDistanceKm - getRange(b.query).startDistanceKm);
  }

  return { successes, failures, attempts, failureCounts };
}

function selectFairTasks<Query>(
  tasks: Array<{ query: Query; depth: number }>,
  count: number,
  getRange: (query: Query) => GeoDistanceRange,
) {
  if (count >= tasks.length) return tasks;
  const sorted = [...tasks].sort((a, b) => getRange(a.query).startDistanceKm - getRange(b.query).startDistanceKm);
  return Array.from({ length: count }, (_, index) => sorted[Math.floor((index * sorted.length) / count)]);
}

export function subdivideOverpassCorridorQuery(
  query: OverpassCorridorQuery,
  route: GeoRoutePoint[],
): OverpassCorridorQuery[] {
  let childGroups: RouteCorridorWindow[][];
  if (query.windows.length > 1) {
    const splitAt = Math.ceil(query.windows.length / 2);
    childGroups = [query.windows.slice(0, splitAt), query.windows.slice(splitAt)].filter((windows) => windows.length > 0);
  } else {
    const parent = query.windows[0];
    const midpointKm = (parent.startDistanceKm + parent.endDistanceKm) / 2;
    const children = [
      createWindow(route, parent.startDistanceKm, midpointKm),
      createWindow(route, midpointKm, parent.endDistanceKm),
    ].filter((window): window is RouteCorridorWindow => window !== null);
    childGroups = children.map((window) => [window]);
  }
  return childGroups.filter((windows) => windows.every((window) => isUsefulBoundingBox(window.box))).map((windows) => ({
    windows,
    boxes: windows.map((window) => window.box),
    startDistanceKm: windows[0].startDistanceKm,
    endDistanceKm: windows.at(-1)!.endDistanceKm,
  }));
}

function createWindow(route: GeoRoutePoint[], startDistanceKm: number, endDistanceKm: number): RouteCorridorWindow | null {
  const portion = route.filter((point) => point.distanceM / 1000 >= startDistanceKm && point.distanceM / 1000 <= endDistanceKm);
  if (portion.length < 2) return null;
  const box = getRouteBoundingBox(portion, ADAPTIVE_WINDOW_PADDING_DEGREES);
  return box ? { box, startDistanceKm, endDistanceKm } : null;
}


export function mergeOsmWays(groups: OSMWayFeature[][]): OSMWayFeature[] {
  const unique = new Map<number, OSMWayFeature>();
  for (const group of groups) {
    for (const way of group) {
      const existing = unique.get(way.id);
      if (!existing || (way.geometry?.length ?? 0) > (existing.geometry?.length ?? 0)) {
        unique.set(way.id, {
          ...way,
          tags: { ...(existing?.tags ?? {}), ...(way.tags ?? {}) },
        });
      } else if (existing) {
        existing.tags = { ...(way.tags ?? {}), ...(existing.tags ?? {}) };
      }
    }
  }
  return [...unique.values()].sort((a, b) => a.id - b.id);
}

export async function enrichRouteWithOsm(points: GeoRoutePoint[]) {
  if (points.length < 2 || points.length > MAX_ROUTE_POINTS) {
    return createUnknownGeoEnrichment("The route geometry was outside the supported matching limits.");
  }
  const route = thinRouteForMatching(points);
  const queries = createOverpassCorridorQueries(route);
  if (!queries) {
    return createUnknownGeoEnrichment("The route requires more safe OpenStreetMap corridor queries than this service allows.");
  }

  const requestCounts = { requestsSent: 0, requestsSucceeded: 0, requestsFailed: 0, cacheHits: 0 };
  const retrieval = await runAdaptiveRetrieval(
    queries,
    (query) => getCachedWays(query.boxes, requestCounts),
    (query) => subdivideOverpassCorridorQuery(query, route),
    classifyRetryableOverpassError,
    (query) => ({ startDistanceKm: query.startDistanceKm, endDistanceKm: query.endDistanceKm }),
    { maxAttempts: MAX_OVERPASS_ATTEMPTS_PER_ROUTE, maxDepth: MAX_ADAPTIVE_SUBDIVISION_DEPTH },
  );
  const successfulGroups = retrieval.successes.map(({ value }) => value.ways);
  const retrievedRanges = mergeDistanceRanges(retrieval.successes.map(({ query }) => ({
    startDistanceKm: query.startDistanceKm,
    endDistanceKm: query.endDistanceKm,
  })));
  const failedRanges = retrieval.failures.map(({ query }) => ({
    startDistanceKm: query.startDistanceKm,
    endDistanceKm: query.endDistanceKm,
  }));
  const totalDistanceKm = (route.at(-1)?.distanceM ?? 0) / 1000;
  const unavailableRanges = subtractDistanceRanges(mergeDistanceRanges(failedRanges), retrievedRanges);
  const coveredKm = retrievedRanges.reduce((total, range) => total + range.endDistanceKm - range.startDistanceKm, 0);
  const failureCounts = retrieval.failureCounts;
  const retrievalSummary = {
    queryAttempts: retrieval.attempts,
    ...requestCounts,
    retrievalCoveragePercent: totalDistanceKm > 0 ? Math.round((coveredKm / totalDistanceKm) * 100) : 0,
    retrievedRanges,
    unavailableRanges,
    failureCounts,
  };

  if (retrieval.failures.length > 0) {
    console.warn("[geo-enrichment] Adaptive Overpass retrieval ended with unavailable corridor ranges", {
      requestsSent: requestCounts.requestsSent,
      requestsFailed: requestCounts.requestsFailed,
      retrievalCoveragePercent: retrievalSummary.retrievalCoveragePercent,
      failureCounts,
    });
  }
  if (successfulGroups.length === 0) {
    return {
      ...createUnknownGeoEnrichment("OpenStreetMap terrain evidence is currently unavailable for this route."),
      retrieval: retrievalSummary,
    };
  }

  const enrichment = createGeoEnrichment(route, mergeOsmWays(successfulGroups));
  if (retrieval.failures.length === 0) return { ...enrichment, retrieval: retrievalSummary };

  const note = `OpenStreetMap retrieval was partial: ${requestCounts.requestsSucceeded} of ${requestCounts.requestsSent} network requests succeeded; ${retrievalSummary.retrievalCoveragePercent}% of route distance was successfully queried.`;
  return {
    ...enrichment,
    availability: enrichment.matchedRoutePercent === 0 ? "unknown" as const : enrichment.availability,
    note: enrichment.matchedRoutePercent === 0
      ? `${note} No route-matched evidence was found in successfully queried areas.`
      : note,
    retrieval: retrievalSummary,
  };
}

function classifyRetryableOverpassError(error: unknown): RetrievalFailureCategory | null {
  if (error instanceof OverpassHttpError) {
    if (error.status === 429) return "http429";
    if (error.status === 504) return "http504";
    return error.status === 408 || error.status === 425 || error.status >= 500 ? "otherTransient" : null;
  }
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) return "timeout";
  if (error instanceof TypeError) return "otherTransient";
  return null;
}

class OverpassHttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "OverpassHttpError";
    this.status = status;
  }
}

function mergeDistanceRanges(ranges: GeoDistanceRange[]): GeoDistanceRange[] {
  const sorted = ranges
    .filter((range) => Number.isFinite(range.startDistanceKm) && Number.isFinite(range.endDistanceKm) && range.endDistanceKm > range.startDistanceKm)
    .sort((a, b) => a.startDistanceKm - b.startDistanceKm);
  const merged: GeoDistanceRange[] = [];
  for (const range of sorted) {
    const previous = merged.at(-1);
    if (previous && range.startDistanceKm <= previous.endDistanceKm + 0.001) {
      previous.endDistanceKm = Math.max(previous.endDistanceKm, range.endDistanceKm);
    } else merged.push({ ...range });
  }
  return merged;
}

function subtractDistanceRanges(ranges: GeoDistanceRange[], covered: GeoDistanceRange[]): GeoDistanceRange[] {
  const remaining: GeoDistanceRange[] = [];
  for (const range of ranges) {
    let pieces = [{ ...range }];
    for (const coverage of covered) {
      pieces = pieces.flatMap((piece) => {
        if (coverage.endDistanceKm <= piece.startDistanceKm || coverage.startDistanceKm >= piece.endDistanceKm) return [piece];
        const left = coverage.startDistanceKm > piece.startDistanceKm
          ? [{ startDistanceKm: piece.startDistanceKm, endDistanceKm: coverage.startDistanceKm }]
          : [];
        const right = coverage.endDistanceKm < piece.endDistanceKm
          ? [{ startDistanceKm: coverage.endDistanceKm, endDistanceKm: piece.endDistanceKm }]
          : [];
        return [...left, ...right];
      });
    }
    remaining.push(...pieces);
  }
  return mergeDistanceRanges(remaining);
}

type RouteBoundingBox = RouteCorridorWindow["box"];

async function getCachedWays(
  boxes: RouteBoundingBox[],
  counters: { requestsSent: number; requestsSucceeded: number; requestsFailed: number; cacheHits: number },
) {
  const key = boxes.map((box) => Object.values(box).map((value) => value.toFixed(3)).join(",")).join(";");
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    counters.cacheHits += 1;
    return { ways: cached.ways, cacheHit: true };
  }
  if (cached) cache.delete(key);

  const query = buildOverpassQuery(boxes);
  return scheduleOverpassRequest(async () => {
    const cachedAfterQueue = cache.get(key);
    if (cachedAfterQueue && cachedAfterQueue.expiresAt > Date.now()) {
      counters.cacheHits += 1;
      return { ways: cachedAfterQueue.ways, cacheHit: true };
    }
    const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
    while (requestTimestamps[0] !== undefined && requestTimestamps[0] < dayAgo) requestTimestamps.shift();
    if (requestTimestamps.length >= MAX_REQUESTS_PER_DAY) throw new Error("Daily Overpass prototype request limit reached");
    requestTimestamps.push(Date.now());
    counters.requestsSent += 1;
    try {
      const response = await fetch(OVERPASS_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
          "User-Agent": "RaceScope Geo Enrichment prototype (local GPX route matching)",
        },
        body: new URLSearchParams({ data: query }),
        signal: AbortSignal.timeout(9_000),
      });
      if (!response.ok) {
        const body = (await response.text()).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 300);
        throw new OverpassHttpError(response.status, `Overpass returned HTTP ${response.status}${body ? `: ${body}` : ""}`);
      }
      const json: unknown = await response.json();
      const parsedWays = parseOverpassWays(json);
      counters.requestsSucceeded += 1;
      cache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, ways: parsedWays });
      while (cache.size > MAX_CACHE_ENTRIES) {
        const oldestKey = cache.keys().next().value;
        if (oldestKey === undefined) break;
        cache.delete(oldestKey);
      }
      return { ways: parsedWays, cacheHit: false };
    } catch (error) {
      counters.requestsFailed += 1;
      throw error;
    }
  });
}

function scheduleOverpassRequest<T>(operation: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    pendingRequests.push(async () => {
      try {
        resolve(await operation());
      } catch (error) {
        reject(error);
      }
    });
    startQueuedRequests();
  });
}

function startQueuedRequests() {
  if (activeRequests >= MAX_CONCURRENT_REQUESTS || pendingRequests.length === 0) return;
  const waitMs = Math.max(0, MIN_REQUEST_INTERVAL_MS - (Date.now() - lastRequestStartedAt));
  if (waitMs > 0) {
    if (requestTimer === undefined) {
      requestTimer = setTimeout(() => {
        requestTimer = undefined;
        startQueuedRequests();
      }, waitMs);
    }
    return;
  }

  const request = pendingRequests.shift();
  if (!request) return;
  activeRequests += 1;
  lastRequestStartedAt = Date.now();
  void request().finally(() => {
    activeRequests -= 1;
    startQueuedRequests();
  });
  startQueuedRequests();
}

export function buildOverpassQuery(boxes: RouteBoundingBox[]) {
  const queries = boxes.map((box) => {
    const [south, west, north, east] = [box.south, box.west, box.north, box.east].map((value) => value.toFixed(5));
    return `way["highway"~"^(path|track|footway|bridleway|steps|cycleway|unclassified|residential|service|tertiary|secondary|primary|living_street|pedestrian)$"](${south},${west},${north},${east});`;
  });
  return `[out:json][timeout:8];(${queries.join("")} );out tags geom;`;
}

export function parseOverpassWays(json: unknown): OSMWayFeature[] {
  if (!json || typeof json !== "object" || !("elements" in json) || !Array.isArray(json.elements)) {
    throw new Error("Malformed Overpass response");
  }
  const elements = json.elements;
  const parsed = elements.flatMap((element): OSMWayFeature[] => {
    if (!element || typeof element !== "object") return [];
    const candidate = element as Record<string, unknown>;
    if (candidate.type !== "way") return [];
    if (typeof candidate.id !== "number" || !Array.isArray(candidate.geometry)) {
      throw new Error("Malformed Overpass way geometry");
    }
    const geometry = candidate.geometry.flatMap((point): Array<{ lat: number; lon: number }> => {
      if (!point || typeof point !== "object") return [];
      const coordinates = point as Record<string, unknown>;
      return typeof coordinates.lat === "number" && typeof coordinates.lon === "number"
        ? [{ lat: coordinates.lat, lon: coordinates.lon }]
        : [];
    });
    if (geometry.length !== candidate.geometry.length || geometry.length < 2) {
      throw new Error("Malformed Overpass way geometry");
    }
    const tags = candidate.tags && typeof candidate.tags === "object" && !Array.isArray(candidate.tags)
      ? Object.fromEntries(Object.entries(candidate.tags).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
      : {};
    return geometry.length > 1 ? [{ id: candidate.id, type: "way", tags, geometry }] : [];
  });
  return [...new Map(parsed.map((way) => [way.id, way])).values()];
}
