import {
  createGeoEnrichment,
  createUnknownGeoEnrichment,
  getRouteCorridorWindows,
  isUsefulBoundingBox,
  thinRouteForMatching,
} from "./geoEnrichment.ts";
import type { GeoRoutePoint, OSMWayFeature, RouteCorridorWindow } from "./geoEnrichment.ts";

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

  const results = await Promise.allSettled(queries.map((query) => getCachedWays(query.boxes)));
  const successfulGroups: OSMWayFeature[][] = [];
  const failedErrors: unknown[] = [];
  for (const result of results) {
    if (result.status === "fulfilled") successfulGroups.push(result.value);
    else failedErrors.push(result.reason);
  }

  for (const error of failedErrors) console.warn("[geo-enrichment] Overpass corridor query failed", error);
  if (successfulGroups.length === 0) {
    return createUnknownGeoEnrichment("OpenStreetMap terrain evidence is currently unavailable for this route.");
  }

  const enrichment = createGeoEnrichment(route, mergeOsmWays(successfulGroups));
  if (failedErrors.length === 0) return enrichment;

  const note = `OpenStreetMap evidence is partial: ${successfulGroups.length} of ${queries.length} corridor queries succeeded.`;
  return {
    ...enrichment,
    availability: enrichment.matchedRoutePercent === 0 ? "unknown" as const : enrichment.availability,
    note: enrichment.matchedRoutePercent === 0
      ? `${note} No route-matched evidence was found in the successful corridors.`
      : note,
  };
}

type RouteBoundingBox = RouteCorridorWindow["box"];

async function getCachedWays(boxes: RouteBoundingBox[]) {
  const key = boxes.map((box) => Object.values(box).map((value) => value.toFixed(3)).join(",")).join(";");
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.ways;
  if (cached) cache.delete(key);

  const query = buildOverpassQuery(boxes);
  const ways = await scheduleOverpassRequest(async () => {
    const cachedAfterQueue = cache.get(key);
    if (cachedAfterQueue && cachedAfterQueue.expiresAt > Date.now()) return cachedAfterQueue.ways;
    const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
    while (requestTimestamps[0] !== undefined && requestTimestamps[0] < dayAgo) requestTimestamps.shift();
    if (requestTimestamps.length >= MAX_REQUESTS_PER_DAY) throw new Error("Daily Overpass prototype request limit reached");
    requestTimestamps.push(Date.now());
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
      throw new Error(`Overpass returned HTTP ${response.status}${body ? `: ${body}` : ""}`);
    }
    const json: unknown = await response.json();
    const parsedWays = parseOverpassWays(json);
    cache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, ways: parsedWays });
    while (cache.size > MAX_CACHE_ENTRIES) {
      const oldestKey = cache.keys().next().value;
      if (oldestKey === undefined) break;
      cache.delete(oldestKey);
    }
    return parsedWays;
  });
  return ways;
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
