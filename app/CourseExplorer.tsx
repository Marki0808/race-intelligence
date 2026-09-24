"use client";

import { useEffect, useRef, useState } from "react";
import type { Map as LeafletMap } from "leaflet";
import type { KeyMomentData, RaceData, RaceEditionData } from "./raceTypes";

type Point = {
  lat: number;
  lon: number;
  ele: number;
  distance: number;
};

export default function CourseExplorer({
  selectedMoment,
  race,
  edition,
  keyMoments,
}: {
  selectedMoment: string | null;
  race: RaceData;
  edition: RaceEditionData;
  keyMoments: KeyMomentData[];
}) {
  const mapRef = useRef<HTMLDivElement | null>(null);
  const leafletMapRef = useRef<LeafletMap | null>(null);
  const [points, setPoints] = useState<Point[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  console.log("Selected moment:", selectedMoment);

  useEffect(() => {
    async function loadGPX() {
      try {
        const response = await fetch(edition.gpxPath);

        if (!response.ok) {
          throw new Error("GPX file could not be loaded.");
        }

        const text = await response.text();

        const parser = new DOMParser();
        const xml = parser.parseFromString(text, "application/xml");

        const trackPoints = Array.from(xml.querySelectorAll("trkpt"));

        const parsed: Point[] = [];
        let totalDistance = 0;

        for (let i = 0; i < trackPoints.length; i++) {
          const point = trackPoints[i];

          const lat = Number(point.getAttribute("lat"));
          const lon = Number(point.getAttribute("lon"));
          const ele = Number(point.querySelector("ele")?.textContent ?? 0);

          if (Number.isNaN(lat) || Number.isNaN(lon)) {
            continue;
          }

          if (parsed.length > 0) {
            const previous = parsed[parsed.length - 1];

            totalDistance += haversineDistance(
              previous.lat,
              previous.lon,
              lat,
              lon
            );
          }

          parsed.push({
            lat,
            lon,
            ele,
            distance: totalDistance,
          });
        }

        setPoints(parsed);
        setLoading(false);
      } catch (err) {
        console.error(err);
        setError("Could not load the course GPX.");
        setLoading(false);
      }
    }

    loadGPX();
  }, [edition.gpxPath]);

  useEffect(() => {
    if (!mapRef.current || points.length === 0) return;

    let map: LeafletMap | undefined;
    let cancelled = false;

    async function createMap() {
      const L = await import("leaflet");
      if (cancelled) return;

      if (!mapRef.current) return;

      map = L.map(mapRef.current, {
        scrollWheelZoom: false,
      });
      leafletMapRef.current = map;

      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: "&copy; OpenStreetMap contributors",
      }).addTo(map);

      const coordinates = points.map((point) => [
        point.lat,
        point.lon,
      ]) as [number, number][];

      const route = L.polyline(coordinates, {
        color: "#17211c",
        weight: 4,
        opacity: 0.9,
      }).addTo(map);
      L.circleMarker(coordinates[0], {
  radius: 7,
  color: "#17211c",
  weight: 3,
  fillColor: "#a7c957",
  fillOpacity: 1,
})
  .addTo(map)
  .bindTooltip(`${edition.startLocation ?? "Start"} · Start`, {
    permanent: true,
    direction: "top",
    offset: [0, -8],
  });

L.circleMarker(coordinates[coordinates.length - 1], {
  radius: 7,
  color: "#17211c",
  weight: 3,
  fillColor: "#ffffff",
  fillOpacity: 1,
})
  .addTo(map)
  .bindTooltip(`${edition.finishLocation ?? "Finish"} · Finish`, {
    permanent: true,
    direction: "top",
    offset: [0, -8],
  });

      map.fitBounds(route.getBounds(), {
        padding: [30, 30],
      });
    }

    createMap();

    return () => {
  cancelled = true;

  if (map) {
    map.remove();
  }
};
  }, [points, edition.startLocation, edition.finishLocation]);
  useEffect(() => {
  if (!selectedMoment || !leafletMapRef.current || points.length === 0) {
    return;
  }
if (!selectedMoment) return;

const selectedKeyMoment = keyMoments.find(
  (moment) => moment.title === selectedMoment
);

if (!selectedKeyMoment) return;

const startDistance = selectedKeyMoment.focusStartKm * 1000;
const endDistance = selectedKeyMoment.focusEndKm * 1000;

const momentPoints = points.filter(
  (point) =>
    point.distance >= startDistance &&
    point.distance <= endDistance
);

if (momentPoints.length === 0) return;

const coordinates = momentPoints.map((point) => [
  point.lat,
  point.lon,
]) as [number, number][];

leafletMapRef.current.fitBounds(coordinates, {
  padding: [50, 50],
});
  
}, [selectedMoment, points, keyMoments]);

  const elevation = points.map((point) => point.ele);
  const elevationGain = points.reduce((total, point, index) => {
  if (index === 0) return total;

  const previous = points[index - 1];
  const difference = point.ele - previous.ele;

  return total + (difference > 0 ? difference : 0);
}, 0);

  const minElevation =
    elevation.length > 0 ? Math.min(...elevation) : 0;

  const maxElevation =
    elevation.length > 0 ? Math.max(...elevation) : 0;

  const totalDistance =
    points.length > 0
      ? points[points.length - 1].distance
      : 0;

  return (
    <div className="mt-14 overflow-hidden rounded-[2rem] border border-black/10 bg-[#e9e6de]">
      <div className="grid lg:grid-cols-[1.2fr_0.8fr]">
        {/* MAP */}
        <div className="relative min-h-[520px] bg-[#dfe3d8]">
          {loading && (
            <div className="absolute inset-0 z-10 flex items-center justify-center bg-[#dfe3d8]">
              <div className="text-sm text-black/50">
                Loading course...
              </div>
            </div>
          )}

          {error && (
            <div className="absolute inset-0 z-10 flex items-center justify-center bg-[#dfe3d8]">
              <div className="text-sm text-red-700">
                {error}
              </div>
            </div>
          )}

          <div ref={mapRef} className="absolute inset-0" />

          {!loading && !error && (
            <div className="absolute bottom-5 left-5 z-[500] rounded-full bg-white/90 px-4 py-2 text-xs font-semibold shadow-sm backdrop-blur">
              {race.name} · {edition.year}
            </div>
          )}
        </div>

        {/* PROFILE */}
        <div className="flex flex-col justify-between bg-[#17211c] p-8 text-white lg:p-10">
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-white/40">
              Course profile
            </p>

            <h3 className="mt-3 text-3xl font-semibold">
              The shape of the race.
            </h3>

            <p className="mt-4 text-sm leading-6 text-white/45">
              The elevation profile is calculated directly from the official
              GPX track.
            </p>
          </div>

          <div className="mt-12">
            {points.length > 0 ? (
              <ElevationProfile
                points={points}
                minElevation={minElevation}
                maxElevation={maxElevation}
              />
            ) : (
              <div className="h-48" />
            )}

            <div className="mt-5 flex justify-between text-xs text-white/30">
              <span>Start</span>
              <span>
                {Math.round(maxElevation)} m
              </span>
              <span>Finish</span>
            </div>
          </div>

          <div className="mt-10 grid grid-cols-2 gap-6 border-t border-white/10 pt-6">
            <div>
              <p className="text-xs uppercase tracking-[0.18em] text-white/30">
                GPX distance
              </p>

              <p className="mt-2 text-xl font-semibold">
                {(totalDistance / 1000).toFixed(2)} km
              </p>
            </div>
            <div>
              <p className="text-xs uppercase tracking-[0.18em] text-white/30">
                Elevation gain
              </p>

               <p className="mt-2 text-xl font-semibold">
                {Math.round(elevationGain)} m+
              </p>
            </div>

            <div>
              <p className="text-xs uppercase tracking-[0.18em] text-white/30">
                Highest point
              </p>

              <p className="mt-2 text-xl font-semibold">
                {Math.round(maxElevation)} m
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function ElevationProfile({
  points,
  minElevation,
  maxElevation,
}: {
  points: Point[];
  minElevation: number;
  maxElevation: number;
}) {
  const width = 900;
  const height = 260;
  const padding = 8;

  const range = Math.max(maxElevation - minElevation, 1);

  const coords = points.map((point, index) => {
    const x =
      padding +
      (index / Math.max(points.length - 1, 1)) *
        (width - padding * 2);

    const normalized =
      (point.ele - minElevation) / range;

    const y =
      height -
      padding -
      normalized * (height - padding * 2);

    return `${x},${y}`;
  });

  const line = coords.join(" ");

  const area = [
    `${padding},${height}`,
    ...coords,
    `${width - padding},${height}`,
  ].join(" ");

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="h-auto w-full overflow-visible"
      preserveAspectRatio="none"
    >
      <polygon
        points={area}
        fill="#a7c957"
        opacity="0.16"
      />

      <polyline
        points={line}
        fill="none"
        stroke="#a7c957"
        strokeWidth="4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function haversineDistance(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
) {
  const earthRadius = 6371000;

  const toRadians = (value: number) =>
    (value * Math.PI) / 180;

  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(lat1)) *
      Math.cos(toRadians(lat2)) *
      Math.sin(dLon / 2) ** 2;

  return (
    2 *
    earthRadius *
    Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
  );
}
