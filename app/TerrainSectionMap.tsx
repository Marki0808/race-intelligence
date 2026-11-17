"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Layer, Map as LeafletMap } from "leaflet";
import type { GpxRoutePointData } from "./gpxAnalysis";
import type { RouteSection } from "./routeSectionEngine";
import type { RouteUnitSystem } from "./routeUnits";
import { formatRouteDistanceKm } from "./routeUnits";
import { clipRoutePointsToSection } from "./routeSectionSelection";
import { groupAnalyzedPointsBySegment } from "./gpxAnalysis";
import { ROUTE_MAP_STYLES } from "./routeMapStyles";
import { attachMapWheelZoom } from "./mapWheelZoom";
import dynamic from "next/dynamic";
import { RouteMapModeSelector, type RouteMapMode } from "./RouteMapMode";
import MapFullscreenRegion, { MAP_CONTROL_BUTTON_CLASS } from "./MapFullscreenRegion";

const MapLibreRouteMap = dynamic(() => import("./MapLibreRouteMap"), { ssr: false });

export default function TerrainSectionMap({
  points,
  section,
  startDistanceKm,
  endDistanceKm,
  units = "metric",
  mapMode = "3d",
  onMapModeChange = () => undefined,
}: {
  points: readonly GpxRoutePointData[];
  section: Pick<RouteSection, "id" | "segmentIndex" | "startPosition" | "endPosition">;
  startDistanceKm: number;
  endDistanceKm: number;
  units?: RouteUnitSystem;
  mapMode?: RouteMapMode;
  onMapModeChange?: (mode: RouteMapMode) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const interactionRef = useRef<HTMLDivElement | null>(null);
  const wheelZoomRef = useRef<ReturnType<typeof attachMapWheelZoom> | null>(null);
  const leafletRef = useRef<typeof import("leaflet") | null>(null);
  const selectionLayers = useRef<Layer[]>([]);
  const [mapReady, setMapReady] = useState(false);
  const [wheelZoomActive, setWheelZoomActive] = useState(false);
  const components = useMemo(() => groupAnalyzedPointsBySegment(points), [points]);
  const selectedPoints = useMemo(() => clipRoutePointsToSection(points, section), [points, section]);
  const sectionFocusPoints = useMemo(() => points.filter((point) => point.segmentIndex === section.segmentIndex && point.distanceM >= section.startPosition.distanceM - 1500 && point.distanceM <= section.endPosition.distanceM + 1500), [points, section]);

  useEffect(() => {
    if (mapMode !== "2d" || !containerRef.current || points.length < 2) return;
    let cancelled = false;
    let map: LeafletMap | undefined;
    let resizeObserver: ResizeObserver | undefined;
    async function initialize() {
      if (map || cancelled || !containerRef.current) return;
      const L = await import("leaflet");
      if (cancelled || !containerRef.current) return;
      leafletRef.current = L;
      map = L.map(containerRef.current, { scrollWheelZoom: false, zoomControl: true, attributionControl: true });
      mapRef.current = map;
      wheelZoomRef.current = attachMapWheelZoom(map, interactionRef.current ?? containerRef.current, setWheelZoomActive);
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { attribution: "&copy; OpenStreetMap contributors", maxZoom: 19 }).addTo(map);
      const coordinates = components.filter((segment) => segment.length > 1).map((segment) => segment.map(({ latitude, longitude }) => [latitude, longitude] as [number, number]));
      for (const path of coordinates) {
        L.polyline(path, ROUTE_MAP_STYLES.contextHalo).addTo(map);
        L.polyline(path, ROUTE_MAP_STYLES.context).addTo(map);
      }
      const bounds = L.latLngBounds(points.map(({ latitude, longitude }) => [latitude, longitude]));
      if (bounds.isValid()) map.fitBounds(bounds, { padding: [22, 22], maxZoom: 13 });
      const valid = components.filter((segment) => segment.length > 1);
      const first = valid[0]?.[0];
      const last = valid.at(-1)?.at(-1);
      if (first) L.circleMarker([first.latitude, first.longitude], { radius: 5, color: "#17211c", weight: 2, fillColor: "#a7c957", fillOpacity: 1 }).addTo(map).bindTooltip("Route start");
      if (last) L.circleMarker([last.latitude, last.longitude], { radius: 5, color: "#17211c", weight: 2, fillColor: "#ffffff", fillOpacity: 1 }).addTo(map).bindTooltip("Route finish");
      resizeObserver = new ResizeObserver(() => map?.invalidateSize({ pan: false }));
      resizeObserver.observe(containerRef.current);
      requestAnimationFrame(() => map?.invalidateSize({ pan: false }));
      setMapReady(true);
    }
    const intersection = new IntersectionObserver((entries) => { if (entries.some((entry) => entry.isIntersecting)) { intersection.disconnect(); void initialize(); } }, { rootMargin: "240px" });
    intersection.observe(containerRef.current);
    return () => { cancelled = true; intersection?.disconnect(); resizeObserver?.disconnect(); wheelZoomRef.current?.dispose(); wheelZoomRef.current = null; map?.remove(); mapRef.current = null; leafletRef.current = null; selectionLayers.current = []; setMapReady(false); };
  }, [components, mapMode, points]);

  useEffect(() => {
    const map = mapRef.current;
    const L = leafletRef.current;
    if (mapMode !== "2d" || !map || !L || !mapReady) return;
    for (const layer of selectionLayers.current) layer.removeFrom(map);
    selectionLayers.current = [];
    if (selectedPoints.length > 1) {
      const coordinates = selectedPoints.map(({ latitude, longitude }) => [latitude, longitude]) as [number, number][];
      selectionLayers.current.push(L.polyline(coordinates, ROUTE_MAP_STYLES.selectedHalo).addTo(map));
      selectionLayers.current.push(L.polyline(coordinates, ROUTE_MAP_STYLES.selectedSection).addTo(map));
    }
  }, [mapMode, mapReady, points, section, selectedPoints]);

  return points.length >= 2 ? (
    <div className="mt-3">
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className="text-xs font-medium text-[var(--analysis-muted)]">Map view</span>
        <RouteMapModeSelector mode={mapMode} onChange={onMapModeChange} label="Section map display" />
      </div>
      <div ref={interactionRef} className="relative w-full min-w-0">
        {mapMode === "3d" ? (
          <MapLibreRouteMap
            points={points}
            selectedPoints={selectedPoints}
            showSelectedSectionMarkers
            focusPoints={sectionFocusPoints}
            focusKey={`section:${section.segmentIndex}:${section.id}`}
            focusOnKeyChange={false}
            onFallbackTo2d={() => onMapModeChange("2d")}
            label={`Route map with section from ${formatRouteDistanceKm(startDistanceKm, units, 2)} to ${formatRouteDistanceKm(endDistanceKm, units, 2)} highlighted`}
            frameClassName="relative h-56 w-full min-w-0 overflow-hidden rounded-xl border border-black/10 bg-[#e7e8e2] sm:h-64"
          />
        ) : (
          <MapFullscreenRegion
            label={`Route section map ${formatRouteDistanceKm(startDistanceKm, units, 2)} to ${formatRouteDistanceKm(endDistanceKm, units, 2)}`}
            className="relative h-56 w-full min-w-0 sm:h-64"
            onResize={() => mapRef.current?.invalidateSize({ pan: false })}
          >{(fullscreen, fullscreenButton) => <div className={`relative w-full min-w-0 overflow-hidden rounded-xl border border-black/10 bg-[#e7e8e2] ${fullscreen ? "map-fullscreen-map-viewport h-full" : "h-full"}`}>
            <div ref={containerRef} className="absolute inset-0" role="region" aria-label={`Full route map with Route Section ${formatRouteDistanceKm(startDistanceKm, units, 2)} to ${formatRouteDistanceKm(endDistanceKm, units, 2)} highlighted in dark line. OpenStreetMap basemap.`} />
            {mapMode === "2d" && <div className="absolute left-3 top-3 z-[600] flex max-w-[calc(100%-3rem)] flex-wrap gap-2">
            <button
              type="button"
              aria-pressed={wheelZoomActive}
              aria-label={wheelZoomActive ? "Disable map scroll-wheel zoom" : "Enable map scroll-wheel zoom"}
              onClick={() => wheelZoomActive ? wheelZoomRef.current?.deactivate() : wheelZoomRef.current?.activate()}
              disabled={!mapReady}
              className={MAP_CONTROL_BUTTON_CLASS}
            >{wheelZoomActive ? "Scroll to zoom · Esc to exit" : "Enable wheel zoom"}</button>
            {fullscreenButton}
            </div>}
          </div>}</MapFullscreenRegion>
        )}
    </div>
    </div>
  ) : <div className="mt-3 flex h-56 w-full items-center justify-center rounded-xl border border-black/10 bg-[#e7e8e2] px-4 text-center text-sm text-[var(--analysis-muted)]" role="note">The full route map is unavailable because this analysis has fewer than two location points.</div>;
}
