import { createUnknownGeoEnrichment, thinRouteForMatching, type GeoEnrichmentData, type GeoRoutePoint } from "./geoEnrichment.ts";

export type RouteTerrainRequestResult = { status: "ready" | "unavailable"; data: GeoEnrichmentData };

/** Calls the existing bounded OSM endpoint with the selected analysis geometry. */
export async function requestRouteTerrainEvidence(
  points: readonly GeoRoutePoint[],
  signal?: AbortSignal,
): Promise<RouteTerrainRequestResult> {
  try {
    const response = await fetch("/api/geo-enrichment", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ points: thinRouteForMatching([...points]).map(({ latitude, longitude, distanceM, segmentIndex }) => ({ latitude, longitude, distanceM, segmentIndex })) }),
      signal,
    });
    if (!response.ok) return { status: "unavailable", data: createUnknownGeoEnrichment("OpenStreetMap evidence could not be retrieved.") };
    const data: unknown = await response.json();
    if (!isGeoEnrichmentData(data)) return { status: "unavailable", data: createUnknownGeoEnrichment("OpenStreetMap evidence was not available in a usable format.") };
    if (data.availability === "unknown" && data.segments.length === 0 && !data.retrieval) {
      return { status: "unavailable", data };
    }
    return { status: "ready", data };
  } catch {
    return { status: "unavailable", data: createUnknownGeoEnrichment("OpenStreetMap evidence could not be retrieved.") };
  }
}

function isGeoEnrichmentData(value: unknown): value is GeoEnrichmentData {
  if (!value || typeof value !== "object") return false;
  const data = value as Record<string, unknown>;
  if (!Array.isArray(data.segments) || !["available", "not-found", "unknown"].includes(String(data.availability))) return false;
  return data.segments.every((item) => {
    if (!item || typeof item !== "object") return false;
    const segment = item as Record<string, unknown>;
    return typeof segment.id === "string" && typeof segment.startDistanceKm === "number" && Number.isFinite(segment.startDistanceKm) &&
      typeof segment.endDistanceKm === "number" && Number.isFinite(segment.endDistanceKm) && segment.endDistanceKm >= segment.startDistanceKm &&
      (segment.segmentIndex === undefined || Number.isInteger(segment.segmentIndex)) &&
      segment.surface !== null && typeof segment.surface === "object" &&
      ["available", "not-found", "unknown"].includes(String((segment.surface as Record<string, unknown>).availability));
  });
}
