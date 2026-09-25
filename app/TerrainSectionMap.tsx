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
      const L = await import("leaflet");
      if (cancelled || !containerRef.current) return;
      map = L.map(containerRef.current, { scrollWheelZoom: false, zoomControl: false, attributionControl: true });
      mapRef.current = map;
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: "&copy; OpenStreetMap contributors",
        maxZoom: 19,
      }).addTo(map);
      const route = L.polyline(points.map((point) => [point.latitude, point.longitude] as [number, number]), {
        color: "#17211c",
        weight: 4,
        opacity: 0.9,
      }).addTo(map);
      map.fitBounds(route.getBounds(), { padding: [18, 18], maxZoom: 15 });
      markersRef.current = L.layerGroup().addTo(map);
      for (const image of imagesRef.current) {
        L.circleMarker([image.latitude, image.longitude], { radius: 7, color: "#ffffff", weight: 2, fillColor: selectedImageRef.current?.id === image.id ? "#a7c957" : "#71805d", fillOpacity: 1 })
          .addTo(markersRef.current)
          .on("click", () => onSelectImageRef.current(image))
          .bindTooltip("Open terrain photo");
      }
    }
    void initialize();
    return () => {
      cancelled = true;
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

  return (
    <div
      ref={containerRef}
      className="mt-5 h-48 overflow-hidden rounded-xl border border-black/10 bg-[#e7e8e2]"
      aria-label={`Map of terrain section from ${startDistanceKm} to ${endDistanceKm} kilometres with Mapillary image points`}
    />
  );
}
