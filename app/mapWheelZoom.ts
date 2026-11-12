import type { Map as LeafletMap } from "leaflet";

type MapWheelZoomController = {
  activate: () => void;
  deactivate: () => void;
  dispose: () => void;
};

type WheelZoomMap = Pick<LeafletMap, "on" | "off"> & {
  scrollWheelZoom: Pick<LeafletMap["scrollWheelZoom"], "enable" | "disable">;
};

type MapContainer = Pick<HTMLElement, "contains">;
type InteractionDocument = Pick<Document, "addEventListener" | "removeEventListener">;

/** Keeps wheel zoom opt-in and scoped to a single Leaflet map instance. */
export function attachMapWheelZoom(
  map: WheelZoomMap,
  container: MapContainer,
  onActiveChange: (active: boolean) => void,
  eventDocument: InteractionDocument = document,
): MapWheelZoomController {
  let active = false;
  let disposed = false;

  const deactivate = () => {
    if (!active || disposed) return;
    active = false;
    map.scrollWheelZoom.disable();
    onActiveChange(false);
  };

  const activate = () => {
    if (active || disposed) return;
    active = true;
    map.scrollWheelZoom.enable();
    onActiveChange(true);
  };

  const onMapClick = () => activate();
  const onDocumentPointerDown = (event: Event) => {
    if (!container.contains(event.target as Node | null)) deactivate();
  };
  const onDocumentKeyDown = (event: Event) => {
    if ((event as KeyboardEvent).key === "Escape") deactivate();
  };

  map.on("click", onMapClick);
  eventDocument.addEventListener("pointerdown", onDocumentPointerDown);
  eventDocument.addEventListener("keydown", onDocumentKeyDown);

  return {
    activate,
    deactivate,
    dispose() {
      if (disposed) return;
      deactivate();
      disposed = true;
      map.off("click", onMapClick);
      eventDocument.removeEventListener("pointerdown", onDocumentPointerDown);
      eventDocument.removeEventListener("keydown", onDocumentKeyDown);
    },
  };
}
