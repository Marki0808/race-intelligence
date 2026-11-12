export type TerrainReadiness = "loading" | "pending" | "ready" | "unavailable";

export const TERRAIN_LOADING_HINT_DELAY_MS = 5_000;

/** A successful DEM content response is enough to report usable terrain while the camera is still moving. */
export function resolveTerrainReadiness(
  current: TerrainReadiness,
  event: { sourceId?: string; sourceDataType?: string },
): TerrainReadiness {
  if (current === "unavailable") return current;
  return event.sourceId === "mapterhorn-dem" && event.sourceDataType === "content" ? "ready" : current;
}

/** Hide the transient spinner after a grace period without claiming that terrain succeeded. */
export function expireTerrainLoadingHint(current: TerrainReadiness): TerrainReadiness {
  return current === "loading" ? "pending" : current;
}

