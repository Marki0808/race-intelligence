type MapLibreWheelMap = Pick<{ on: (type: "click", handler: () => void) => unknown; off: (type: "click", handler: () => void) => unknown }, "on" | "off"> & {
  scrollZoom: { enable: () => void; disable: () => void };
};
type InteractionDocument = Pick<Document, "addEventListener" | "removeEventListener">;

/** Keep MapLibre's wheel zoom opt-in like the existing Leaflet maps. */
export function attachMapLibreWheelZoom(map: MapLibreWheelMap, container: Pick<HTMLElement, "contains">, onActiveChange: (active: boolean) => void, eventDocument: InteractionDocument = document) {
  let active = false;
  let disposed = false;
  const deactivate = () => {
    if (!active || disposed) return;
    active = false;
    map.scrollZoom.disable();
    onActiveChange(false);
  };
  const activate = () => {
    if (active || disposed) return;
    active = true;
    map.scrollZoom.enable();
    onActiveChange(true);
  };
  const onMapClick = () => activate();
  const onDocumentPointerDown = (event: Event) => { if (!container.contains(event.target as Node | null)) deactivate(); };
  const onDocumentKeyDown = (event: Event) => { if ((event as KeyboardEvent).key === "Escape") deactivate(); };
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
