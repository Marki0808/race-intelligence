import type { Map as MapLibreMap } from "maplibre-gl";

type ManualMapInput = {
  type: string;
  key?: string;
  button?: number;
  ctrlKey?: boolean;
  touches?: { length: number };
  target?: { closest?: (selector: string) => unknown } | null;
};

export type FlyoverMapInteractionOptions = {
  scrollZoomEnabled: boolean;
  doubleClickZoomEnabled: boolean;
  keyboardEnabled: boolean;
};

const CAMERA_KEYS = new Set(["ArrowDown", "ArrowLeft", "ArrowRight", "ArrowUp", "+", "-", "=", "_"]);

type MapStyleLifecycle = Pick<MapLibreMap, "isStyleLoaded" | "on" | "off">;

/** Retry marker setup after style updates instead of silently abandoning it during a style transition. */
export function runWhenMapStyleReady(map: MapStyleLifecycle, install: () => boolean): () => void {
  let disposed = false;
  let installed = false;
  let installing = false;
  const removeListeners = () => {
    map.off("styledata", tryInstall);
    map.off("idle", tryInstall);
  };
  const tryInstall = () => {
    if (disposed || installed || installing || !map.isStyleLoaded()) return;
    installing = true;
    try {
      installed = install();
    } catch {
      installed = false;
    } finally {
      installing = false;
    }
    if (installed) removeListeners();
  };

  tryInstall();
  if (!installed) {
    map.on("styledata", tryInstall);
    map.on("idle", tryInstall);
  }
  return () => {
    disposed = true;
    removeListeners();
  };
}

/** Recognize user input that can move the camera; MapLibre movement events also fire for app camera animations. */
export function isFlyoverManualMapInput(event: ManualMapInput, options: FlyoverMapInteractionOptions): boolean {
  if (event.type === "wheel") return options.scrollZoomEnabled;
  if (event.type === "dblclick") return options.doubleClickZoomEnabled;
  if (event.type === "touchstart") return (event.touches?.length ?? 0) > 1;
  if (event.type === "pointerdown") return event.button === 2 || (event.button === 0 && event.ctrlKey === true);
  if (event.type === "click") return Boolean(event.target?.closest?.(".maplibregl-ctrl button"));
  if (event.type === "keydown") {
    return options.keyboardEnabled && CAMERA_KEYS.has(event.key ?? "") &&
      Boolean(event.target?.closest?.(".maplibregl-canvas, .maplibregl-ctrl button"));
  }
  return false;
}
