import {
  createGeoEnrichment,
  createUnknownGeoEnrichment,
  getRouteBoundingBoxes,
  isUsefulBoundingBox,
  thinRouteForMatching,
} from "./geoEnrichment.ts";
import type { GeoRoutePoint, OSMWayFeature } from "./geoEnrichment.ts";

const OVERPASS_ENDPOINT = "https://overpass-api.de/api/interpreter";
const CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_CACHE_ENTRIES = 20;
const MAX_ROUTE_POINTS = 20_000;
const MIN_REQUEST_INTERVAL_MS = 2_000;
const MAX_REQUESTS_PER_DAY = 90;
const cache = new Map<string, { expiresAt: number; ways: OSMWayFeature[] }>();
const requestTimestamps: number[] = [];
let requestQueue: Promise<void> = Promise.resolve();
let lastRequestAt = 0;

export async function enrichRouteWithOsm(points: GeoRoutePoint[]) {
  if (points.length < 2 || points.length > MAX_ROUTE_POINTS) {
    return createUnknownGeoEnrichment("The route geometry was outside the supported matching limits.");
  }
  const route = thinRouteForMatching(points);
  const boxes = getRouteBoundingBoxes(route);
  if (boxes.length === 0 || boxes.length > 40 || boxes.some((box) => !isUsefulBoundingBox(box))) {
    return createUnknownGeoEnrichment("The route covers too large an area for a safe OSM query.");
  }

  try {
    const ways = await getCachedWays(boxes);
    if (ways.length === 0) {
      return createGeoEnrichment(route, []);
    }
    return createGeoEnrichment(route, ways);
  } catch (error) {
    console.warn("[geo-enrichment] OSM lookup failed", error);
    return createUnknownGeoEnrichment("OpenStreetMap terrain evidence is currently unavailable for this route.");
  }
}

type RouteBoundingBox = NonNullable<ReturnType<typeof getRouteBoundingBoxes>>[number];

async function getCachedWays(boxes: RouteBoundingBox[]) {
  const key = boxes.map((box) => Object.values(box).map((value) => value.toFixed(3)).join(",")).join(";");
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.ways;
  if (cached) cache.delete(key);

  const query = buildOverpassQuery(boxes);
  const result = requestQueue.then(async () => {
    const cachedAfterQueue = cache.get(key);
    if (cachedAfterQueue && cachedAfterQueue.expiresAt > Date.now()) return cachedAfterQueue.ways;
    const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
    while (requestTimestamps[0] !== undefined && requestTimestamps[0] < dayAgo) requestTimestamps.shift();
    if (requestTimestamps.length >= MAX_REQUESTS_PER_DAY) throw new Error("Daily Overpass prototype request limit reached");
    const waitMs = Math.max(0, MIN_REQUEST_INTERVAL_MS - (Date.now() - lastRequestAt));
    if (waitMs) await new Promise((resolve) => setTimeout(resolve, waitMs));
    lastRequestAt = Date.now();
    requestTimestamps.push(lastRequestAt);
    const response = await fetch(OVERPASS_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "User-Agent": "RaceScope Geo Enrichment prototype (local GPX route matching)",
      },
      body: new URLSearchParams({ data: query }),
      signal: AbortSignal.timeout(25_000),
    });
    if (!response.ok) {
      const body = (await response.text()).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 300);
      throw new Error(`Overpass returned HTTP ${response.status}${body ? `: ${body}` : ""}`);
    }
    const json: unknown = await response.json();
    const ways = parseOverpassWays(json);
    cache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, ways });
    while (cache.size > MAX_CACHE_ENTRIES) {
      const oldestKey = cache.keys().next().value;
      if (oldestKey === undefined) break;
      cache.delete(oldestKey);
    }
    return ways;
  });
  requestQueue = result.then(() => undefined, () => undefined);
  return result;
}

export function buildOverpassQuery(boxes: RouteBoundingBox[]) {
  const queries = boxes.map((box) => {
    const [south, west, north, east] = [box.south, box.west, box.north, box.east].map((value) => value.toFixed(5));
    return `way["highway"~"^(path|track|footway|bridleway|steps|cycleway|unclassified|residential|service|tertiary|secondary|primary|living_street|pedestrian)$"](${south},${west},${north},${east});`;
  });
  return `[out:json][timeout:20];(${queries.join("")} );out tags geom;`;
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
