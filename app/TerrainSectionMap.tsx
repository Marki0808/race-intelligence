"use client";

import { useEffect, useRef } from "react";
import type { Map as LeafletMap, LayerGroup } from "leaflet";
import type { MapillaryImageEvidence, MapillaryRoutePoint } from "./mapillaryTerrainProof";

export default function TerrainSectionMap({
  points,
  images,
  startDistanceKm,
  endDistanceKm,
  selectedImage,
  onSelectImage,
}: {
  points: MapillaryRoutePoint[];
  images: MapillaryImageEvidence[];
  startDistanceKm: number;
  endDistanceKm: number;
  selectedImage: MapillaryImageEvidence | null;
  onSelectImage: (image: MapillaryImageEvidence) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const markersRef = useRef<LayerGroup | null>(null);
  const imagesRef = useRef(images);
  const onSelectImageRef = useRef(onSelectImage);
  const selectedImageRef = useRef(selectedImage);

  useEffect(() => {
    imagesRef.current = images;
    onSelectImageRef.current = onSelectImage;
    selectedImageRef.current = selectedImage;
  }, [images, onSelectImage, selectedImage]);

  useEffect(() => {
    if (!containerRef.current || points.length < 2) return;
    let cancelled = false;
    let map: LeafletMap | undefined;
    async function initialize() {
      if (map || cancelled) return;
      const L = await import("leaflet");
      if (cancelled || !containerRef.current) return;
      map = L.map(containerRef.current, { scrollWheelZoom: false, zoomControl: false, attributionControl: true });
      mapRef.current = map;
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: "&copy; OpenStreetMap contributors",
        maxZoom: 19,
      }).addTo(map);
      const coordinates = points.map((point) => [point.latitude, point.longitude] as [number, number]);
      L.polyline(coordinates, { color: "#ffffff", weight: 8, opacity: 0.95 }).addTo(map);
      const route = L.polyline(coordinates, { color: "#71805d", weight: 5, opacity: 1 }).addTo(map);
      map.fitBounds(route.getBounds(), { padding: [18, 18], maxZoom: 15 });
      L.circleMarker(coordinates[0], { radius: 6, color: "#ffffff", weight: 2, fillColor: "#a7c957", fillOpacity: 1 })
        .addTo(map).bindTooltip("Section start");
      L.circleMarker(coordinates.at(-1)!, { radius: 6, color: "#ffffff", weight: 2, fillColor: "#c07a5a", fillOpacity: 1 })
        .addTo(map).bindTooltip("Section end");
      markersRef.current = L.layerGroup().addTo(map);
      for (const image of imagesRef.current) {
        L.circleMarker([image.latitude, image.longitude], { radius: 7, color: "#ffffff", weight: 2, fillColor: selectedImageRef.current?.id === image.id ? "#a7c957" : "#71805d", fillOpacity: 1 })
          .addTo(markersRef.current)
          .on("click", () => onSelectImageRef.current(image))
          .bindTooltip("Open terrain photo");
      }
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
      mapRef.current = null;
      markersRef.current = null;
    };
  }, [points]);

  useEffect(() => {
    let cancelled = false;
    async function updateMarkers() {
      const map = mapRef.current;
      const layer = markersRef.current;
      if (!map || !layer) return;
      const L = await import("leaflet");
      if (cancelled) return;
      layer.clearLayers();
      for (const image of images) {
        L.circleMarker([image.latitude, image.longitude], {
          radius: 7,
          color: "#ffffff",
          weight: 2,
          fillColor: selectedImage?.id === image.id ? "#a7c957" : "#71805d",
          fillOpacity: 1,
        })
          .addTo(layer)
          .on("click", () => onSelectImage(image))
          .bindTooltip("Open terrain photo");
      }
    }
    void updateMarkers();
    return () => { cancelled = true; };
  }, [images, onSelectImage, selectedImage]);

  return points.length >= 2 ? (
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
