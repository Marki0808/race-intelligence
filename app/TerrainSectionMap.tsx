"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Layer, Map as LeafletMap } from "leaflet";
import type { GpxRoutePointData } from "./gpxAnalysis";
import type { RouteSection } from "./routeSectionEngine";
import { clipRoutePointsToSection } from "./routeSectionSelection";
import { groupAnalyzedPointsBySegment } from "./gpxAnalysis";

export default function TerrainSectionMap({
  points,
  section,
  startDistanceKm,
  endDistanceKm,
}: {
  points: readonly GpxRoutePointData[];
  section: Pick<RouteSection, "id" | "segmentIndex" | "startPosition" | "endPosition">;
  startDistanceKm: number;
  endDistanceKm: number;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const leafletRef = useRef<typeof import("leaflet") | null>(null);
  const selectionLayers = useRef<Layer[]>([]);
  const [mapReady, setMapReady] = useState(false);
  const components = useMemo(() => groupAnalyzedPointsBySegment(points), [points]);

  useEffect(() => {
    if (!containerRef.current || points.length < 2) return;
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
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { attribution: "&copy; OpenStreetMap contributors", maxZoom: 19 }).addTo(map);
      const coordinates = components.filter((segment) => segment.length > 1).map((segment) => segment.map(({ latitude, longitude }) => [latitude, longitude] as [number, number]));
      for (const path of coordinates) L.polyline(path, { color: "#aeb7b0", weight: 3, opacity: 0.95, lineCap: "round", lineJoin: "round" }).addTo(map);
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
    return () => { cancelled = true; intersection?.disconnect(); resizeObserver?.disconnect(); map?.remove(); mapRef.current = null; leafletRef.current = null; selectionLayers.current = []; setMapReady(false); };
  }, [components, points]);

  useEffect(() => {
    const map = mapRef.current;
    const L = leafletRef.current;
    if (!map || !L || !mapReady) return;
    for (const layer of selectionLayers.current) layer.removeFrom(map);
    selectionLayers.current = [];
    const selectedPoints = clipRoutePointsToSection(points, section);
    if (selectedPoints.length > 1) selectionLayers.current.push(L.polyline(
      selectedPoints.map(({ latitude, longitude }) => [latitude, longitude]) as [number, number][],
      { color: "#17211c", weight: 7, opacity: 1, lineCap: "round", lineJoin: "round" },
    ).addTo(map));
  }, [mapReady, points, section]);

  return points.length >= 2 ? (
    <div ref={containerRef} className="mt-3 h-56 w-full min-w-0 overflow-hidden rounded-xl border border-black/10 bg-[#e7e8e2] sm:h-64" role="region" aria-label={`Full route map with Route Section ${startDistanceKm} to ${endDistanceKm} kilometres highlighted in dark line. OpenStreetMap basemap.`} />
  ) : <div className="mt-3 flex h-56 w-full items-center justify-center rounded-xl border border-black/10 bg-[#e7e8e2] px-4 text-center text-sm text-black/45" role="note">The full route map is unavailable because this analysis has fewer than two location points.</div>;
}
