"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Map as LeafletMap, Polyline } from "leaflet";
import type { KeyMomentData } from "./raceTypes";
import { groupAnalyzedPointsBySegment, type RouteAnalysisData } from "./gpxAnalysis";
import type { RouteSection } from "./routeSectionEngine";
import { clipRoutePointsToSection, findSelectedRouteSection } from "./routeSectionSelection";

export default function CourseExplorer({
  selectedMoment,
  selectedSectionKey = null,
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
  selectedSectionKey?: string | null;
  routeName: string;
  startLocation?: string;
  finishLocation?: string;
  routeAnalysis: RouteAnalysisData | null;
  keyMoments: KeyMomentData[];
  loading: boolean;
  error: string;
  showExtendedMetrics?: boolean;
}) {
  const [mapExpanded, setMapExpanded] = useState(false);
  const [mapReady, setMapReady] = useState(false);
  const mapRef = useRef<HTMLDivElement | null>(null);
  const leafletMapRef = useRef<LeafletMap | null>(null);
  const leafletRef = useRef<typeof import("leaflet") | null>(null);
  const routeLineRefs = useRef<Map<number, Polyline>>(new Map());
  const highlightLineRefs = useRef<Polyline[]>([]);
  const points = useMemo(() => routeAnalysis?.points ?? [], [routeAnalysis]);
  const sections = routeAnalysis?.routeSections ?? [];
  const selectedSection = findSelectedRouteSection(sections, selectedSectionKey);
  const selectedSectionPoints = useMemo(
    () => selectedSection ? clipRoutePointsToSection(points, selectedSection) : [],
    [points, selectedSection],
  );
  const metrics = routeAnalysis?.metrics;
  const elevations = points.map((point) => point.elevationM);
  const minimumElevation = elevations.length > 0 ? Math.min(...elevations) : 0;
  const maximumElevation = elevations.length > 0 ? Math.max(...elevations) : 0;

  useEffect(() => {
    if (!mapExpanded || !mapRef.current || points.length === 0) return;

    let map: LeafletMap | undefined;
    let cancelled = false;
    let resizeObserver: ResizeObserver | undefined;

    async function createMap() {
      const L = await import("leaflet");
      if (cancelled || !mapRef.current) return;

      leafletRef.current = L;
      map = L.map(mapRef.current, { scrollWheelZoom: false });
      leafletMapRef.current = map;
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: "&copy; OpenStreetMap contributors",
      }).addTo(map);

      const segmentLines = new Map<number, Polyline>();
      groupAnalyzedPointsBySegment(points).filter((segment) => segment.length > 1).forEach((segment) => {
        const segmentIndex = segment[0].segmentIndex ?? 0;
        const line = L.polyline(
          segment.map(({ latitude, longitude }) => [latitude, longitude]) as [number, number][],
          { color: "#17211c", weight: 4, opacity: 0.9 },
        ).addTo(map!);
        segmentLines.set(segmentIndex, line);
      });
      routeLineRefs.current = segmentLines;

      const bounds = L.latLngBounds(points.map(({ latitude, longitude }) => [latitude, longitude]));
      const traversedPoints = groupAnalyzedPointsBySegment(points).flatMap((segment) => segment.length > 1 ? segment : []);
      const start = traversedPoints[0] ?? points[0];
      const finish = traversedPoints.at(-1) ?? points.at(-1)!;

      L.circleMarker([start.latitude, start.longitude], {
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

      L.circleMarker([finish.latitude, finish.longitude], {
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

      if (bounds.isValid()) map.fitBounds(bounds, { padding: [30, 30] });
      resizeObserver = new ResizeObserver(() => map?.invalidateSize({ pan: false }));
      resizeObserver.observe(mapRef.current);
      window.requestAnimationFrame(() => map?.invalidateSize({ pan: false }));
      setMapReady(true);
    }

    void createMap();
    return () => {
      cancelled = true;
      resizeObserver?.disconnect();
      map?.remove();
      leafletMapRef.current = null;
      leafletRef.current = null;
      routeLineRefs.current.clear();
      highlightLineRefs.current = [];
      setMapReady(false);
    };
  }, [finishLocation, mapExpanded, points, startLocation]);

  useEffect(() => {
    const map = leafletMapRef.current;
    const L = leafletRef.current;
    if (!map || !L || !mapReady) return;

    for (const line of highlightLineRefs.current) line.removeFrom(map);
    highlightLineRefs.current = [];
    for (const line of routeLineRefs.current.values()) {
      line.setStyle({ opacity: selectedSection ? 0.28 : 0.9, weight: selectedSection ? 3 : 4 });
    }

    if (selectedSection && selectedSectionPoints.length > 1) {
      const highlight = L.polyline(
        selectedSectionPoints.map(({ latitude, longitude }) => [latitude, longitude]) as [number, number][],
        { color: "#a7c957", weight: 7, opacity: 1, lineCap: "round", lineJoin: "round" },
      ).addTo(map);
      highlightLineRefs.current.push(highlight);
    }

    if (selectedSection && selectedSectionPoints.length > 0) {
      map.fitBounds(selectedSectionPoints.map((point) => [point.latitude, point.longitude]), { padding: [50, 50] });
      return;
    }

    if (selectedMoment) {
      const moment = keyMoments.find((item) => item.title === selectedMoment);
      if (moment) {
        const momentPoints = points.filter(
          (point) =>
            (moment.segmentIndex === undefined || point.segmentIndex === moment.segmentIndex) &&
            point.distanceM >= (moment.focusStartPosition?.distanceM ?? moment.focusStartKm * 1000) &&
            point.distanceM <= (moment.focusEndPosition?.distanceM ?? moment.focusEndKm * 1000),
        );
        if (momentPoints.length > 0) {
          map.fitBounds(momentPoints.map((point) => [point.latitude, point.longitude]), { padding: [50, 50] });
          return;
        }
      }
    }

    if (points.length > 0) {
      map.fitBounds(points.map((point) => [point.latitude, point.longitude]), { padding: [30, 30] });
    }
  }, [keyMoments, mapReady, points, selectedMoment, selectedSection, selectedSectionPoints]);

  return (
    <div className="mt-10 overflow-hidden rounded-[2rem] border border-black/10 bg-[#17211c] text-white sm:mt-14">
      <div className="p-5 sm:p-8 lg:p-10">
        <div className="max-w-3xl">
          <p className="text-xs uppercase tracking-[0.2em] text-white/45">Course profile · GPX-derived</p>
          <h3 className="mt-3 text-3xl font-semibold sm:text-4xl">The shape of the route.</h3>
          <p className="mt-3 text-sm leading-6 text-white/60">The elevation profile and route metrics are calculated from this GPX track.</p>
        </div>

        <div className="mt-7 rounded-2xl bg-[#202c26] px-3 py-5 sm:mt-9 sm:px-6 sm:py-7">
          {points.length > 0 ? (
            <ElevationProfile
              points={points}
              selectedPoints={selectedSectionPoints}
              minElevation={minimumElevation}
              maxElevation={maximumElevation}
              selectedSection={selectedSection}
            />
          ) : (
            <div className="flex h-48 items-center justify-center text-sm text-white/45">{error || (loading ? "Loading course profile…" : "Course profile unavailable.")}</div>
          )}
          <div className="mt-4 flex justify-between text-xs text-white/45"><span>Start</span><span>{Math.round(maximumElevation)} m</span><span>Finish</span></div>
        </div>

        {metrics && (
          <div className="mt-7 grid grid-cols-2 gap-4 border-t border-white/10 pt-6 sm:grid-cols-3 lg:grid-cols-5">
            <Metric label="GPX distance" value={`${metrics.distanceKm.toFixed(2)} km`} />
            <Metric label="Elevation gain" value={`${metrics.elevationGainM.toLocaleString("en-US")} m+`} />
            {showExtendedMetrics && <Metric label="Elevation loss" value={`${metrics.elevationLossM.toLocaleString("en-US")} m−`} />}
            <Metric label="Highest point" value={`${Math.round(metrics.highestPointM).toLocaleString("en-US")} m`} />
            {showExtendedMetrics && <Metric label="Lowest point" value={`${Math.round(metrics.lowestPointM).toLocaleString("en-US")} m`} />}
          </div>
        )}
      </div>

      <div className="border-t border-white/10 bg-[#202c26]">
        <button
          type="button"
          aria-expanded={mapExpanded}
          aria-controls="course-explorer-map"
          onClick={() => setMapExpanded((expanded) => !expanded)}
          disabled={points.length === 0}
          className="flex min-h-14 w-full items-center justify-between gap-4 px-5 text-left text-sm font-semibold transition hover:bg-white/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-inset focus-visible:outline-[#a7c957] disabled:cursor-not-allowed disabled:opacity-50 sm:px-8"
        >
          <span>Route map <span className="ml-2 text-xs font-normal text-white/45">{mapExpanded ? "Expanded" : "Collapsed"}</span></span>
          <span aria-hidden="true" className="text-lg text-[#a7c957]">{mapExpanded ? "−" : "+"}</span>
        </button>
        <div id="course-explorer-map" hidden={!mapExpanded} className="relative h-64 border-t border-white/10 bg-[#dfe3d8] sm:h-80 lg:h-[26rem]">
          {(loading || error) && (
            <div className="absolute inset-0 z-10 flex items-center justify-center bg-[#dfe3d8] p-6">
              <div className="max-w-sm text-center text-sm leading-6 text-black/55">{loading ? "Loading course map…" : error}</div>
            </div>
          )}
          <div ref={mapRef} className="absolute inset-0" />
          {!loading && !error && metrics && (
            <div className="pointer-events-none absolute bottom-4 left-4 z-[500] max-w-[calc(100%-2rem)] truncate rounded-full bg-white/90 px-4 py-2 text-xs font-semibold text-black shadow-sm backdrop-blur sm:bottom-5 sm:left-5">
              {routeName} · GPX-derived
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div><p className="text-[10px] uppercase tracking-[0.16em] text-white/40 sm:text-xs">{label}</p><p className="mt-2 text-lg font-semibold sm:text-xl">{value}</p></div>;
}

function ElevationProfile({
  points,
  selectedPoints,
  minElevation,
  maxElevation,
  selectedSection,
}: {
  points: RouteAnalysisData["points"];
  selectedPoints: RouteAnalysisData["points"];
  minElevation: number;
  maxElevation: number;
  selectedSection: RouteSection | null;
}) {
  const width = 1200;
  const height = 320;
  const padding = 8;
  const range = Math.max(maxElevation - minElevation, 1);
  const totalDistance = Math.max(1, points.at(-1)?.distanceM ?? 1);
  const toProfilePoint = (point: RouteAnalysisData["points"][number]) => {
    const x = padding + (point.distanceM / totalDistance) * (width - padding * 2);
    const normalized = (point.elevationM - minElevation) / range;
    const y = height - padding - normalized * (height - padding * 2);
    return `${x},${y}`;
  };
  const paths = groupAnalyzedPointsBySegment(points);

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="h-52 w-full overflow-visible sm:h-64 lg:h-72" preserveAspectRatio="none" aria-label="GPX-derived elevation profile" role="img">
      {paths.map((segment, index) => <polyline key={index} points={segment.map(toProfilePoint).join(" ")} fill="none" stroke="#a7c957" strokeOpacity={selectedSection ? "0.3" : "0.9"} strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />)}
      {selectedSection && selectedPoints.length > 1 && <polyline points={selectedPoints.map(toProfilePoint).join(" ")} fill="none" stroke="#f2d675" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round" />}
      {selectedSection && selectedPoints.length === 1 && <circle cx={toProfilePoint(selectedPoints[0]).split(",")[0]} cy={toProfilePoint(selectedPoints[0]).split(",")[1]} r="7" fill="#f2d675" />}
      {selectedSection && <title>Route Section {selectedSection.id} profile interval highlighted</title>}
    </svg>
  );
}
