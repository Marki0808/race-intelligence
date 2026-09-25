"use client";

import { useEffect, useMemo, useRef } from "react";
import type { Map as LeafletMap } from "leaflet";
import type { KeyMomentData } from "./raceTypes";
import type { RouteAnalysisData } from "./gpxAnalysis";

export default function CourseExplorer({
  selectedMoment,
  routeName,
  startLocation,
  finishLocation,
  routeAnalysis,
  keyMoments,
  loading,
  error,
  showExtendedMetrics = false,
}: {
  selectedMoment: string | null;
  routeName: string;
  startLocation?: string;
  finishLocation?: string;
  routeAnalysis: RouteAnalysisData | null;
  keyMoments: KeyMomentData[];
  loading: boolean;
  error: string;
  showExtendedMetrics?: boolean;
}) {
  const mapRef = useRef<HTMLDivElement | null>(null);
  const leafletMapRef = useRef<LeafletMap | null>(null);
  const points = useMemo(() => routeAnalysis?.points ?? [], [routeAnalysis]);

  useEffect(() => {
    if (!mapRef.current || points.length === 0) return;

    let map: LeafletMap | undefined;
    let cancelled = false;

    async function createMap() {
      const L = await import("leaflet");
      if (cancelled || !mapRef.current) return;

      map = L.map(mapRef.current, { scrollWheelZoom: false });
      leafletMapRef.current = map;
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: "&copy; OpenStreetMap contributors",
      }).addTo(map);

      const coordinates = points.map((point) => [
        point.latitude,
        point.longitude,
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
        .bindTooltip(`${startLocation ? `${startLocation} · ` : ""}Start`, {
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
        .bindTooltip(`${finishLocation ? `${finishLocation} · ` : ""}Finish`, {
          permanent: true,
          direction: "top",
          offset: [0, -8],
        });

      map.fitBounds(route.getBounds(), { padding: [30, 30] });
    }

    void createMap();
    return () => {
      cancelled = true;
      map?.remove();
      leafletMapRef.current = null;
    };
  }, [finishLocation, points, startLocation]);

  useEffect(() => {
    if (!selectedMoment || !leafletMapRef.current || points.length === 0) return;

    const moment = keyMoments.find((item) => item.title === selectedMoment);
    if (!moment) return;

    const selectedPoints = points.filter(
      (point) =>
        point.distanceM >= moment.focusStartKm * 1000 &&
        point.distanceM <= moment.focusEndKm * 1000,
    );
    if (selectedPoints.length === 0) return;

    leafletMapRef.current.fitBounds(
      selectedPoints.map((point) => [point.latitude, point.longitude]),
      { padding: [50, 50] },
    );
  }, [selectedMoment, points, keyMoments]);

  const elevations = points.map((point) => point.elevationM);
  const minimumElevation = elevations.length > 0 ? Math.min(...elevations) : 0;
  const maximumElevation = elevations.length > 0 ? Math.max(...elevations) : 0;
  const metrics = routeAnalysis?.metrics;

  return (
    <div className="mt-14 overflow-hidden rounded-[2rem] border border-black/10 bg-[#e9e6de]">
      <div className="grid lg:grid-cols-[1.2fr_0.8fr]">
        <div className="relative min-h-[520px] bg-[#dfe3d8]">
          {loading && (
            <div className="absolute inset-0 z-10 flex items-center justify-center bg-[#dfe3d8]">
              <div className="text-sm text-black/50">Loading course...</div>
            </div>
          )}
          {error && (
            <div className="absolute inset-0 z-10 flex items-center justify-center bg-[#dfe3d8] p-6">
              <div className="max-w-sm text-center text-sm leading-6 text-black/55">
                {error}
              </div>
            </div>
          )}
          <div ref={mapRef} className="absolute inset-0" />
          {!loading && !error && metrics && (
            <div className="absolute bottom-5 left-5 z-[500] max-w-[calc(100%-2.5rem)] truncate rounded-full bg-white/90 px-4 py-2 text-xs font-semibold shadow-sm backdrop-blur">
              {routeName} · GPX-derived
            </div>
          )}
        </div>

        <div className="flex flex-col justify-between bg-[#17211c] p-6 text-white sm:p-8 lg:p-10">
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-white/40">
              Course profile · GPX-derived
            </p>
            <h3 className="mt-3 text-3xl font-semibold">The shape of the route.</h3>
            <p className="mt-4 text-sm leading-6 text-white/45">
              The elevation profile and route metrics are calculated from this GPX track.
            </p>
          </div>

          <div className="mt-12">
            {points.length > 0 ? (
              <ElevationProfile
                points={points}
                minElevation={minimumElevation}
                maxElevation={maximumElevation}
              />
            ) : (
              <div className="h-48" />
            )}
            <div className="mt-5 flex justify-between text-xs text-white/30">
              <span>Start</span>
              <span>{Math.round(maximumElevation)} m</span>
              <span>Finish</span>
            </div>
          </div>

          {metrics && (
            <div className="mt-10 grid grid-cols-2 gap-6 border-t border-white/10 pt-6">
              <Metric label="GPX distance" value={`${metrics.distanceKm.toFixed(2)} km`} />
              <Metric label="Elevation gain" value={`${metrics.elevationGainM.toLocaleString("en-US")} m+`} />
              <Metric label="Highest point" value={`${Math.round(metrics.highestPointM).toLocaleString("en-US")} m`} />
              {showExtendedMetrics && (
                <>
                  <Metric label="Elevation loss" value={`${metrics.elevationLossM.toLocaleString("en-US")} m−`} />
                  <Metric label="Lowest point" value={`${Math.round(metrics.lowestPointM).toLocaleString("en-US")} m`} />
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs uppercase tracking-[0.18em] text-white/30">{label}</p>
      <p className="mt-2 text-xl font-semibold">{value}</p>
    </div>
  );
}

function ElevationProfile({
  points,
  minElevation,
  maxElevation,
}: {
  points: RouteAnalysisData["points"];
  minElevation: number;
  maxElevation: number;
}) {
  const width = 900;
  const height = 260;
  const padding = 8;
  const range = Math.max(maxElevation - minElevation, 1);
  const coordinates = points.map((point, index) => {
    const x =
      padding +
      (index / Math.max(points.length - 1, 1)) * (width - padding * 2);
    const normalized = (point.elevationM - minElevation) / range;
    const y = height - padding - normalized * (height - padding * 2);
    return `${x},${y}`;
  });
  const line = coordinates.join(" ");
  const area = [`${padding},${height}`, ...coordinates, `${width - padding},${height}`].join(" ");

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="h-auto w-full overflow-visible"
      preserveAspectRatio="none"
      aria-label="GPX-derived elevation profile"
      role="img"
    >
      <polygon points={area} fill="#a7c957" opacity="0.16" />
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
