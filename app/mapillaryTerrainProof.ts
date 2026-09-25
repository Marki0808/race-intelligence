import type { EvidenceAvailability } from "./geoEnrichment";

export type MapillaryRoutePoint = {
  latitude: number;
  longitude: number;
  distanceM: number;
};

export type MapillaryTerrainSectionRequest = {
  id: string;
  startDistanceKm: number;
  endDistanceKm: number;
  points: MapillaryRoutePoint[];
};

export type MapillaryImageEvidence = {
  id: string;
  latitude: number;
  longitude: number;
  distanceAlongRouteKm: number;
  capturedAt: number | null;
  sequenceId: string | null;
  thumbnailUrl: string | null;
  sourceUrl: string;
};

export type MapillarySectionEvidence = {
  id: string;
  availability: EvidenceAvailability;
  images: MapillaryImageEvidence[];
  note?: string;
};

export type MapillaryTerrainProofData = {
  source: { type: "mapillary"; name: "Mapillary"; attribution: "© Mapillary" };
  sections: MapillarySectionEvidence[];
};

type ParsedMapillaryImage = Omit<MapillaryImageEvidence, "distanceAlongRouteKm"> & { distanceAlongRouteKm?: never };
type Bbox = { west: number; south: number; east: number; north: number };

const MAX_SECTIONS = 20;
const MAX_POINTS_PER_SECTION = 300;
const MAX_TOTAL_POINTS = 2400;
const MAX_API_WINDOWS = 24;
const MAX_IMAGES_PER_WINDOW = 100;
const MATCH_TOLERANCE_M = 35;
const MIN_IMAGE_SEPARATION_M = 50;

export function parseMapillaryImages(payload: unknown): ParsedMapillaryImage[] {
  if (!payload || typeof payload !== "object") return [];
  const data = "data" in payload && Array.isArray(payload.data) ? payload.data :
    "features" in payload && Array.isArray(payload.features) ? payload.features : [];
  return data.flatMap((item): ParsedMapillaryImage[] => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    const properties = record.properties && typeof record.properties === "object" ? record.properties as Record<string, unknown> : record;
    const id = properties.id;
    const geometry = properties.computed_geometry ?? properties.geometry ?? record.geometry;
    if ((typeof id !== "string" && typeof id !== "number") || !geometry || typeof geometry !== "object") return [];
    const coordinates = "coordinates" in geometry && Array.isArray(geometry.coordinates) ? geometry.coordinates : null;
    if (!coordinates || typeof coordinates[0] !== "number" || typeof coordinates[1] !== "number") return [];
    const longitude = coordinates[0];
    const latitude = coordinates[1];
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return [];
    const capturedAt = typeof properties.captured_at === "number" && Number.isFinite(properties.captured_at)
      ? properties.captured_at
      : null;
    const sequence = properties.sequence ?? properties.sequence_id;
    const sequenceId = typeof sequence === "string" || typeof sequence === "number" ? String(sequence) : null;
    const thumbnail = properties.thumb_1024_url ?? properties.thumb_256_url;
    const thumbnailUrl = typeof thumbnail === "string" && isHttpsUrl(thumbnail) ? thumbnail : null;
    const imageId = String(id);
    return [{
      id: imageId,
      latitude,
      longitude,
      capturedAt,
      sequenceId,
      thumbnailUrl,
      sourceUrl: `https://www.mapillary.com/app/?pKey=${encodeURIComponent(imageId)}`,
    }];
  });
}

export function matchMapillaryImages(
  images: ParsedMapillaryImage[],
  points: MapillaryRoutePoint[],
  toleranceM = MATCH_TOLERANCE_M,
): MapillaryImageEvidence[] {
  if (points.length < 2) return [];
  const matched = images.flatMap((image): MapillaryImageEvidence[] => {
    const nearest = nearestRouteDistance(image, points);
    return nearest.distanceM <= toleranceM
      ? [{ ...image, distanceAlongRouteKm: nearest.distanceMAlongRoute / 1000 }]
      : [];
  });
  return chooseRepresentativeImages(matched);
}

export function chooseRepresentativeImages(images: MapillaryImageEvidence[], maxImages = 8): MapillaryImageEvidence[] {
  const sorted = [...images].sort((a, b) => a.distanceAlongRouteKm - b.distanceAlongRouteKm || a.id.localeCompare(b.id));
  const selected: MapillaryImageEvidence[] = [];
  const sequenceCounts = new Map<string, number>();
  while (selected.length < maxImages && selected.length < sorted.length) {
    const eligible = sorted.filter((candidate) => {
      const sameSequenceCount = candidate.sequenceId ? sequenceCounts.get(candidate.sequenceId) ?? 0 : 0;
      return sameSequenceCount < 2 && selected.every((chosen) =>
        Math.abs(chosen.distanceAlongRouteKm - candidate.distanceAlongRouteKm) * 1000 >= MIN_IMAGE_SEPARATION_M,
      );
    });
    if (!eligible.length) break;
    const chosen = eligible.reduce((best, candidate) => {
      const spacing = selected.length === 0 ? Infinity : Math.min(...selected.map((item) =>
        Math.abs(item.distanceAlongRouteKm - candidate.distanceAlongRouteKm),
      ));
      const bestSpacing = selected.length === 0 ? Infinity : Math.min(...selected.map((item) =>
        Math.abs(item.distanceAlongRouteKm - best.distanceAlongRouteKm),
      ));
      return spacing > bestSpacing || (spacing === bestSpacing && candidate.id.localeCompare(best.id) < 0) ? candidate : best;
    });
    selected.push(chosen);
    if (chosen.sequenceId) sequenceCounts.set(chosen.sequenceId, (sequenceCounts.get(chosen.sequenceId) ?? 0) + 1);
  }
  return selected.sort((a, b) => a.distanceAlongRouteKm - b.distanceAlongRouteKm || a.id.localeCompare(b.id));
}

export function validateMapillarySections(value: unknown): MapillaryTerrainSectionRequest[] | null {
  if (!value || typeof value !== "object" || !("sections" in value) || !Array.isArray(value.sections)) return null;
  if (value.sections.length === 0 || value.sections.length > MAX_SECTIONS) return null;
  const sections: MapillaryTerrainSectionRequest[] = [];
  let totalPoints = 0;
  for (const item of value.sections) {
    if (!item || typeof item !== "object") return null;
    const section = item as Record<string, unknown>;
    if (
      typeof section.id !== "string" || section.id.length === 0 || section.id.length > 100 ||
      typeof section.startDistanceKm !== "number" || !Number.isFinite(section.startDistanceKm) || section.startDistanceKm < 0 ||
      typeof section.endDistanceKm !== "number" || !Number.isFinite(section.endDistanceKm) || section.endDistanceKm <= section.startDistanceKm ||
      !Array.isArray(section.points) || section.points.length < 2 || section.points.length > MAX_POINTS_PER_SECTION
    ) return null;
    const points: MapillaryRoutePoint[] = [];
    for (const pointValue of section.points) {
      if (!pointValue || typeof pointValue !== "object") return null;
      const point = pointValue as Record<string, unknown>;
      if (
        typeof point.latitude !== "number" || !Number.isFinite(point.latitude) || Math.abs(point.latitude) > 90 ||
        typeof point.longitude !== "number" || !Number.isFinite(point.longitude) || Math.abs(point.longitude) > 180 ||
        typeof point.distanceM !== "number" || !Number.isFinite(point.distanceM) || point.distanceM < 0
      ) return null;
      points.push({ latitude: point.latitude, longitude: point.longitude, distanceM: point.distanceM });
    }
    if (points.some((point, index) => index > 0 && point.distanceM < points[index - 1].distanceM)) return null;
    totalPoints += points.length;
    sections.push({ id: section.id, startDistanceKm: section.startDistanceKm, endDistanceKm: section.endDistanceKm, points });
  }
  if (totalPoints > MAX_TOTAL_POINTS || new Set(sections.map((section) => section.id)).size !== sections.length) return null;
  return sections;
}

export async function lookupMapillaryTerrainProof(
  sections: MapillaryTerrainSectionRequest[],
  token: string | undefined,
  fetcher: typeof fetch = fetch,
): Promise<MapillaryTerrainProofData> {
  const source = { type: "mapillary" as const, name: "Mapillary" as const, attribution: "© Mapillary" as const };
  if (!token?.trim()) {
    return { source, sections: sections.map(({ id }) => ({ id, availability: "unknown", images: [], note: "Terrain imagery is unavailable because Mapillary is not configured." })) };
  }
  const windows = createSearchWindows(sections);
  const candidates = new Map<string, ParsedMapillaryImage[]>();
  const failedSections = new Set<string>();
  let nextWindow = 0;
  const workers = Array.from({ length: Math.min(6, windows.length) }, async () => {
    while (nextWindow < windows.length) {
      const window = windows[nextWindow++];
      try {
        const params = new URLSearchParams({
          fields: "id,geometry,captured_at,sequence,thumb_1024_url",
          bbox: [window.bbox.west, window.bbox.south, window.bbox.east, window.bbox.north].join(","),
          limit: String(MAX_IMAGES_PER_WINDOW),
        });
        const response = await fetcher(`https://graph.mapillary.com/images?${params}`, {
          headers: { Authorization: `OAuth ${token}` },
          cache: "no-store",
          signal: AbortSignal.timeout(5_500),
        });
        if (!response.ok) throw new Error(`Mapillary returned HTTP ${response.status}`);
        const payload: unknown = await response.json();
        const parsed = parseMapillaryImages(payload);
        const itemCount = getCollectionItemCount(payload);
        if (itemCount === null || itemCount !== parsed.length) throw new Error("Mapillary returned an invalid image collection.");
        candidates.set(window.key, [...(candidates.get(window.key) ?? []), ...parsed]);
      } catch {
        failedSections.add(window.sectionId);
      }
    }
  });
  await Promise.all(workers);
  const sectionResults = sections.map((section): MapillarySectionEvidence => {
    const sectionWindows = windows.filter((window) => window.sectionId === section.id);
    const images = [...new Map(sectionWindows.flatMap((window) => candidates.get(window.key) ?? []).map((image) => [image.id, image])).values()];
    const matched = matchMapillaryImages(images, section.points);
    const hasFailure = failedSections.has(section.id);
    if (matched.length) return { id: section.id, availability: "available", images: matched, ...(hasFailure ? { note: "Some Mapillary searches for this section could not be completed." } : {}) };
    if (hasFailure) return { id: section.id, availability: "unknown", images: [], note: "Terrain imagery could not be loaded for this section." };
    return { id: section.id, availability: "not-found", images: [], note: "No terrain imagery found for this section." };
  });
  return { source, sections: sectionResults };
}

function createSearchWindows(sections: MapillaryTerrainSectionRequest[]) {
  const windows: Array<{ key: string; sectionId: string; bbox: Bbox }> = [];
  const baseCount = Math.min(sections.length, MAX_API_WINDOWS);
  const extraCount = Math.min(sections.length, MAX_API_WINDOWS - baseCount);
  const extraSections = new Set(Array.from({ length: extraCount }, (_, index) =>
    Math.floor(((index + 0.5) / extraCount) * sections.length),
  ));
  sections.forEach((section, sectionIndex) => {
    const count = 1 + (extraSections.has(sectionIndex) ? 1 : 0);
    for (let index = 0; index < count; index += 1) {
      const pointIndex = Math.round(((index + 0.5) / count) * (section.points.length - 1));
      const point = section.points[pointIndex];
      const latPadding = 0.0015;
      const lonPadding = latPadding / Math.max(0.2, Math.cos(point.latitude * Math.PI / 180));
      windows.push({
        key: `${section.id}:${index}`,
        sectionId: section.id,
        bbox: {
          west: point.longitude - lonPadding,
          south: point.latitude - latPadding,
          east: point.longitude + lonPadding,
          north: point.latitude + latPadding,
        },
      });
    }
  });
  return windows;
}

function nearestRouteDistance(image: Pick<ParsedMapillaryImage, "latitude" | "longitude">, points: MapillaryRoutePoint[]) {
  let closest = { distanceM: Infinity, distanceMAlongRoute: points[0].distanceM };
  for (let index = 1; index < points.length; index += 1) {
    const start = points[index - 1];
    const end = points[index];
    const longitudeScale = 111_320 * Math.cos(image.latitude * Math.PI / 180);
    const px = (image.longitude - start.longitude) * longitudeScale;
    const py = (image.latitude - start.latitude) * 111_320;
    const dx = (end.longitude - start.longitude) * longitudeScale;
    const dy = (end.latitude - start.latitude) * 111_320;
    const denominator = dx * dx + dy * dy;
    const t = denominator === 0 ? 0 : Math.max(0, Math.min(1, (px * dx + py * dy) / denominator));
    const distanceM = Math.hypot(px - t * dx, py - t * dy);
    if (distanceM < closest.distanceM) {
      closest = { distanceM, distanceMAlongRoute: start.distanceM + t * (end.distanceM - start.distanceM) };
    }
  }
  return closest;
}

function isHttpsUrl(value: string) {
  try { return new URL(value).protocol === "https:"; } catch { return false; }
}

function getCollectionItemCount(payload: unknown) {
  if (!payload || typeof payload !== "object") return null;
  if ("data" in payload && Array.isArray(payload.data)) return payload.data.length;
  if ("features" in payload && Array.isArray(payload.features)) return payload.features.length;
  return null;
}
