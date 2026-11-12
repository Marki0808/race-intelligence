export type FlyoverTerrainStartupStatus = "loading" | "pending" | "ready" | "unavailable";
export type FlyoverPreparationOutcome = "ready" | "terrain-unavailable" | "timeout";

export const FLYOVER_PREPARATION_TIMEOUT_MS = 1_800;

export type FlyoverPreparationMap = {
  on: (event: string, listener: (payload?: unknown) => void) => unknown;
  off: (event: string, listener: (payload?: unknown) => void) => unknown;
  isSourceLoaded: (sourceId: string) => boolean;
};

/**
 * Wait for a frame after the startup camera move and the first usable DEM signal.
 * This intentionally does not wait for every visible or future map tile.
 */
export function waitForFlyoverPreparation(
  map: FlyoverPreparationMap,
  getTerrainStatus: () => FlyoverTerrainStartupStatus,
  onComplete: (outcome: FlyoverPreparationOutcome) => void,
  timeoutMs = FLYOVER_PREPARATION_TIMEOUT_MS,
) {
  let settled = false;
  let rendered = false;
  let terrainOutcome: FlyoverPreparationOutcome | null = null;
  let timeout: ReturnType<typeof setTimeout> | null = null;

  const cleanup = () => {
    if (timeout) clearTimeout(timeout);
    timeout = null;
    map.off("render", onRender);
    map.off("sourcedata", onSourceData);
    map.off("error", onError);
  };
  const finish = (outcome: FlyoverPreparationOutcome) => {
    if (settled) return;
    settled = true;
    cleanup();
    onComplete(outcome);
  };
  const checkReady = () => {
    if (settled || !rendered) return;
    const status = getTerrainStatus();
    if (status === "unavailable") terrainOutcome = "terrain-unavailable";
    else if (status === "ready" || status === "pending") terrainOutcome = "ready";
    else {
      try {
        if (map.isSourceLoaded("mapterhorn-dem")) terrainOutcome = "ready";
      } catch { /* Source state can be unavailable while the map is being removed. */ }
    }
    if (terrainOutcome) finish(terrainOutcome);
  };
  const onRender = () => {
    rendered = true;
    checkReady();
  };
  const onSourceData = (payload?: unknown) => {
    const event = payload as { sourceId?: string; sourceDataType?: string } | undefined;
    if (event?.sourceId === "mapterhorn-dem" && event.sourceDataType === "content") terrainOutcome = "ready";
    checkReady();
  };
  const onError = (payload?: unknown) => {
    const event = payload as { sourceId?: string; error?: { url?: string } } | undefined;
    let failedHost = "";
    try { failedHost = new URL(event?.error?.url ?? "").hostname; } catch { /* No request URL is available. */ }
    if (event?.sourceId === "mapterhorn-dem" || failedHost === "tiles.mapterhorn.com") terrainOutcome = "terrain-unavailable";
    checkReady();
  };

  map.on("render", onRender);
  map.on("sourcedata", onSourceData);
  map.on("error", onError);
  timeout = setTimeout(() => finish("timeout"), Math.max(0, timeoutMs));
  checkReady();

  return () => {
    if (settled) return;
    settled = true;
    cleanup();
  };
}
