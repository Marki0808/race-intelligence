"use client";

import { useEffect, useRef } from "react";
import type { Map as LeafletMap } from "leaflet";
import type { RouteSectionMapPoint } from "./routeSectionEngine";
import { hasRenderableSectionMap } from "./routeSectionPresentation";
import { groupAnalyzedPointsBySegment } from "./gpxAnalysis";

export default function TerrainSectionMap({
  points,
  startDistanceKm,
  endDistanceKm,
}: {
  points: RouteSectionMapPoint[];
  startDistanceKm: number;
  endDistanceKm: number;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!containerRef.current || !hasRenderableSectionMap(points)) return;
    let cancelled = false;
    let map: LeafletMap | undefined;
    async function initialize() {
      if (map || cancelled) return;
      const L = await import("leaflet");
      if (cancelled || !containerRef.current) return;
      map = L.map(containerRef.current, { scrollWheelZoom: false, zoomControl: false, attributionControl: true });
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: "&copy; OpenStreetMap contributors",
        maxZoom: 19,
      }).addTo(map);
      const paths = groupAnalyzedPointsBySegment(points).map((segment) => segment.map((point) => [point.latitude, point.longitude] as [number, number]));
      paths.filter((coordinates) => coordinates.length > 1).forEach((coordinates) => {
        L.polyline(coordinates, { color: "#ffffff", weight: 8, opacity: 0.95 }).addTo(map!);
        L.polyline(coordinates, { color: "#71805d", weight: 5, opacity: 1 }).addTo(map!);
      });
      const bounds = L.latLngBounds(points.map((point) => [point.latitude, point.longitude]));
      if (bounds.isValid()) map.fitBounds(bounds, { padding: [18, 18], maxZoom: 15 });
      const first = [points[0].latitude, points[0].longitude] as [number, number];
      const last = [points.at(-1)!.latitude, points.at(-1)!.longitude] as [number, number];
      L.circleMarker(first, { radius: 6, color: "#ffffff", weight: 2, fillColor: "#a7c957", fillOpacity: 1 })
        .addTo(map).bindTooltip("Section start");
      L.circleMarker(last, { radius: 6, color: "#ffffff", weight: 2, fillColor: "#c07a5a", fillOpacity: 1 })
        .addTo(map).bindTooltip("Section end");
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        observer?.disconnect();
        void initialize();
      }
    }, { rootMargin: "240px" });
    observer.observe(containerRef.current);
    return () => {
      cancelled = true;
      observer?.disconnect();
      map?.remove();
    };
  }, [points]);

  return hasRenderableSectionMap(points) ? (
    <div
      ref={containerRef}
      className="mt-3 h-56 w-full min-w-0 overflow-hidden rounded-xl border border-black/10 bg-[#e7e8e2]"
      role="region"
      aria-label={`OpenStreetMap view of the GPX route section from ${startDistanceKm} to ${endDistanceKm} kilometres`}
    />
  ) : (
    <div className="mt-3 flex h-56 w-full items-center justify-center rounded-xl border border-black/10 bg-[#e7e8e2] px-4 text-center text-sm text-black/45" role="note">
      This route section does not have enough location points to draw a map.
    </div>
  );
}
