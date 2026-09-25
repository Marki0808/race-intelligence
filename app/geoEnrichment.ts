import type { GpxRoutePointData } from "./gpxAnalysis";

export type EvidenceAvailability = "available" | "not-found" | "unknown" | "not-applicable";
export type EvidenceProvenance = "official" | "gpx" | "osm" | "osm-derived" | "mapillary" | "land-cover" | "previous-edition" | "estimated" | "unknown";
export type GeoEvidenceSourceData = {
  type: "osm" | "mapillary" | "land-cover" | "other";
  name: string;
  attribution?: string;
};
export type EvidenceValue = {
  value: string | null;
  rawValue: string | null;
  provenance: EvidenceProvenance;
  availability: EvidenceAvailability;
};
export type OSMWayEvidence = {
  source: "OpenStreetMap";
  sourceId: string;
  tags: Record<string, string>;
  geometry: Array<{ latitude: number; longitude: number }>;
  startDistanceKm: number;
  endDistanceKm: number;
  matchQuality: "high" | "moderate";
};
export type GeoSegmentEvidence = {
  id: string;
  startDistanceKm: number;
  endDistanceKm: number;
  lengthKm: number;
  evidenceCoverage: number;
  matchQuality: "high" | "moderate" | "unknown";
  osmWays: OSMWayEvidence[];
  surface: EvidenceValue;
  pathType: EvidenceValue;
  trackCondition: EvidenceValue;
  smoothness: EvidenceValue;
  hikingDifficulty: EvidenceValue;
  trailVisibility: EvidenceValue;
  incline: EvidenceValue;
  width: EvidenceValue;
  informal: EvidenceValue;
  trailblazed: EvidenceValue;
  assistedTrail: EvidenceValue;
};
export type GeoEnrichmentData = {
  source: GeoEvidenceSourceData;
  availability: EvidenceAvailability;
  segments: GeoSegmentEvidence[];
  matchedRoutePercent: number;
  note?: string;
  attribution: string;
};
export type OSMWayFeature = {
  id: number;
  type: "way";
  tags?: Record<string, string>;
  geometry?: Array<{ lat: number; lon: number }>;
};
export type GeoRoutePoint = Pick<GpxRoutePointData, "latitude" | "longitude" | "distanceM">;
export type RouteCorridorWindow = {
  box: NonNullable<ReturnType<typeof getRouteBoundingBox>>;
  startDistanceKm: number;
  endDistanceKm: number;
};

const relevantTags = ["surface", "highway", "tracktype", "smoothness", "sac_scale", "trail_visibility", "incline", "width", "informal", "trailblazed", "assisted_trail"] as const;

export function normalizeOsmTags(tags: Record<string, string> = {}) {
  const normalize = (key: string) => {
    const rawValue = tags[key]?.trim() || null;
    return {
      value: rawValue,
      rawValue,
      provenance: "osm" as const,
      availability: rawValue ? "available" as const : "not-found" as const,
    };
  };
  return {
    surface: normalize("surface"),
    pathType: normalize("highway"),
    trackCondition: normalize("tracktype"),
    smoothness: normalize("smoothness"),
    hikingDifficulty: normalize("sac_scale"),
    trailVisibility: normalize("trail_visibility"),
    incline: normalize("incline"),
    width: normalize("width"),
    informal: normalize("informal"),
    trailblazed: normalize("trailblazed"),
    assistedTrail: normalize("assisted_trail"),
  };
}

export function createGeoEnrichment(
  points: GeoRoutePoint[],
  ways: OSMWayFeature[],
  maxDistanceM = 35,
): GeoEnrichmentData {
  const usableWays = ways.filter((way) => way.type === "way" && (way.geometry?.length ?? 0) > 1);
  const matches = points.map((point) => {
    const candidates = usableWays
      .map((way) => ({ way, distanceM: distanceToWay(point, way) }))
      .filter((match) => match.distanceM <= maxDistanceM)
      .sort((a, b) => a.distanceM - b.distanceM);
    const nearest = candidates[0];
    return nearest
      ? { point, way: nearest.way, distanceM: nearest.distanceM, alternatives: candidates.filter((candidate) => candidate.distanceM - nearest.distanceM < 5).map((candidate) => candidate.way) }
      : { point, way: null, distanceM: Infinity, alternatives: [] as OSMWayFeature[] };
  });
  const matchedRoutePercent = points.length
    ? Math.round((matches.filter((match) => match.way).length / points.length) * 100)
    : 0;
  const chunks: Array<typeof matches> = [];
  for (const match of matches) {
    const previous = chunks.at(-1)?.at(-1);
    const previousSignature = previous?.way ? relevantTags.map((key) => previous.way?.tags?.[key] ?? "").join("|") : "unmatched";
    const currentSignature = match.way ? relevantTags.map((key) => match.way?.tags?.[key] ?? "").join("|") : "unmatched";
    if (!previous || previousSignature !== currentSignature) chunks.push([match]);
    else chunks.at(-1)!.push(match);
  }

  const segments: GeoSegmentEvidence[] = chunks.map((chunk, index) => {
    const first = chunk[0].point;
    const last = chunk.at(-1)!.point;
    const hasSustainedAmbiguity = chunk.some(
      (item, pointIndex) => item.alternatives.length > 1 && chunk[pointIndex + 1]?.alternatives.length > 1,
    );
    const ambiguous = hasSustainedAmbiguity;
    const candidateWays = chunk.flatMap((item) => ambiguous ? item.alternatives : item.way ? [item.way] : []);
    const matchedWays = [...new Map(candidateWays.map((way) => [way.id, way])).values()];
    const sameTags = matchedWays.length && matchedWays.every((way) =>
      relevantTags.every((key) => way.tags?.[key] === matchedWays[0].tags?.[key]),
    );
    const tags = sameTags ? matchedWays[0].tags ?? {} : {};
    const normalized = normalizeOsmTags(tags);
    const coverage = chunk.filter((item) => item.way).length / chunk.length;
    const quality = coverage === 0 ? "unknown" : coverage >= 0.8 && !ambiguous ? "high" : "moderate";
    const reliableMatch = matchedWays.length > 0 && Boolean(sameTags) && !ambiguous;
    const startDistanceKm = roundKm(first.distanceM);
    const endDistanceKm = roundKm(last.distanceM);
    return {
      id: `geo-segment-${index + 1}`,
      startDistanceKm,
      endDistanceKm,
      lengthKm: roundKm(last.distanceM - first.distanceM),
      evidenceCoverage: coverage,
      matchQuality: quality,
      osmWays: matchedWays.map((way) => ({
        source: "OpenStreetMap",
        sourceId: `way/${way.id}`,
        tags: way.tags ?? {},
        geometry: (way.geometry ?? []).map((point) => ({ latitude: point.lat, longitude: point.lon })),
        startDistanceKm,
        endDistanceKm,
        matchQuality: wayMatchQuality(chunk, way.id, ambiguous),
      })),
      surface: withMatchAvailability(normalized.surface, reliableMatch),
      pathType: withMatchAvailability(normalized.pathType, reliableMatch),
      trackCondition: withMatchAvailability(normalized.trackCondition, reliableMatch),
      smoothness: withMatchAvailability(normalized.smoothness, reliableMatch),
      hikingDifficulty: withMatchAvailability(normalized.hikingDifficulty, reliableMatch),
      trailVisibility: withMatchAvailability(normalized.trailVisibility, reliableMatch),
      incline: withMatchAvailability(normalized.incline, reliableMatch),
      width: withMatchAvailability(normalized.width, reliableMatch),
      informal: withMatchAvailability(normalized.informal, reliableMatch),
      trailblazed: withMatchAvailability(normalized.trailblazed, reliableMatch),
      assistedTrail: withMatchAvailability(normalized.assistedTrail, reliableMatch),
    };
  });

  return {
    source: { type: "osm", name: "OpenStreetMap", attribution: "© OpenStreetMap contributors" },
    availability: matchedRoutePercent === 0 ? "not-found" : matchedRoutePercent < 15 ? "unknown" : "available",
    segments,
    matchedRoutePercent,
    ...(matchedRoutePercent === 0
      ? { note: "No nearby OpenStreetMap ways could be matched to this route." }
      : matchedRoutePercent < 15
        ? { note: "The route could not be matched reliably to OpenStreetMap ways." }
        : {}),
    attribution: "© OpenStreetMap contributors",
  };
}

export function thinRouteForMatching(points: GeoRoutePoint[], maxPoints = 1800): GeoRoutePoint[] {
  if (points.length <= maxPoints) return points;
  const step = (points.length - 1) / (maxPoints - 1);
  return Array.from({ length: maxPoints }, (_, index) => points[Math.round(index * step)]);
}

export function getRouteBoundingBox(points: GeoRoutePoint[], paddingDegrees = 0.006) {
  if (!points.length) return null;
  const latitudes = points.map((point) => point.latitude);
  const longitudes = points.map((point) => point.longitude);
  return {
    south: Math.min(...latitudes) - paddingDegrees,
    west: Math.min(...longitudes) - paddingDegrees,
    north: Math.max(...latitudes) + paddingDegrees,
    east: Math.max(...longitudes) + paddingDegrees,
  };
}

export function getRouteBoundingBoxes(
  points: GeoRoutePoint[],
  windowKm = 5,
  overlapKm = 1,
  paddingDegrees = 0.003,
) {
  return getRouteCorridorWindows(points, windowKm, overlapKm, paddingDegrees).map((window) => window.box);
}

export function getRouteCorridorWindows(
  points: GeoRoutePoint[],
  windowKm = 5,
  overlapKm = 1,
  paddingDegrees = 0.003,
): RouteCorridorWindow[] {
  const totalKm = (points.at(-1)?.distanceM ?? 0) / 1000;
  if (points.length < 2 || totalKm <= 0 || windowKm <= overlapKm) return [];
  const stepKm = windowKm - overlapKm;
  const windows: RouteCorridorWindow[] = [];
  for (let startKm = 0; startKm < totalKm; startKm += stepKm) {
    const endKm = Math.min(totalKm, startKm + windowKm);
    const portion = points.filter((point) => {
      const distanceKm = point.distanceM / 1000;
      return distanceKm >= startKm && distanceKm <= endKm;
    });
    if (portion.length < 2) continue;
    const box = getRouteBoundingBox(portion, paddingDegrees);
    if (box) windows.push({ box, startDistanceKm: startKm, endDistanceKm: endKm });
  }
  return windows;
}

export function isUsefulBoundingBox(box: NonNullable<ReturnType<typeof getRouteBoundingBox>>) {
  return box.south >= -90 && box.north <= 90 && box.north > box.south && box.east > box.west &&
    box.north - box.south <= 0.75 && box.east - box.west <= 1.25;
}

export function createUnknownGeoEnrichment(note: string): GeoEnrichmentData {
  return { source: { type: "osm", name: "OpenStreetMap", attribution: "© OpenStreetMap contributors" }, availability: "unknown", segments: [], matchedRoutePercent: 0, note, attribution: "© OpenStreetMap contributors" };
}

function withMatchAvailability(value: EvidenceValue, hasMatch: boolean): EvidenceValue {
  return hasMatch ? value : { ...value, availability: "unknown" };
}

function wayMatchQuality(chunk: Array<{ way: OSMWayFeature | null; distanceM: number; alternatives: OSMWayFeature[] }>, wayId: number, ambiguous: boolean): "high" | "moderate" {
  return !ambiguous && chunk.some((item) => item.way?.id === wayId && item.distanceM <= 20) ? "high" : "moderate";
}

function distanceToWay(point: GeoRoutePoint, way: OSMWayFeature): number {
  const geometry = way.geometry ?? [];
  let nearest = Infinity;
  for (let index = 1; index < geometry.length; index += 1) {
    nearest = Math.min(nearest, pointToSegmentMeters(point, geometry[index - 1], geometry[index]));
  }
  return nearest;
}

function pointToSegmentMeters(point: { latitude: number; longitude: number }, start: { lat: number; lon: number }, end: { lat: number; lon: number }) {
  const latitudeScale = 111_320;
  const longitudeScale = 111_320 * Math.cos((point.latitude * Math.PI) / 180);
  const px = (point.longitude - start.lon) * longitudeScale;
  const py = (point.latitude - start.lat) * latitudeScale;
  const dx = (end.lon - start.lon) * longitudeScale;
  const dy = (end.lat - start.lat) * latitudeScale;
  const denominator = dx * dx + dy * dy;
  const t = denominator === 0 ? 0 : Math.max(0, Math.min(1, (px * dx + py * dy) / denominator));
  return Math.hypot(px - t * dx, py - t * dy);
}

function roundKm(distanceM: number) {
  return Number((distanceM / 1000).toFixed(2));
}
