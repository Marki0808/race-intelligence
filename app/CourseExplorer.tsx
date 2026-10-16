"use client";

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { Layer, Map as LeafletMap, Polyline } from "leaflet";
import type { KeyMomentData } from "./raceTypes";
import { groupAnalyzedPointsBySegment, type RouteAnalysisData } from "./gpxAnalysis";
import type { RouteSection } from "./routeSectionEngine";
import { clipRoutePointsToKeyMoment, clipRoutePointsToSection, findSelectedRouteSection, resolveKeyMomentInterval } from "./routeSectionSelection";
import { getNiceAxisScale, getPositionedRouteDistanceTicks, getRouteDistancePosition, getRouteSectionBoundaryMarkers } from "./routeProfilePresentation";

export default function CourseExplorer({
  selectedMoment,
  selectedSectionKey = null,
  onSelectSection,
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
  onSelectSection?: (section: RouteSection | null) => void;
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
  const highlightLineRefs = useRef<Layer[]>([]);
  const points = useMemo(() => routeAnalysis?.points ?? [], [routeAnalysis]);
  const sections = routeAnalysis?.routeSections ?? [];
  const selectedSection = findSelectedRouteSection(sections, selectedSectionKey);
  const selectedSectionPoints = useMemo(
    () => selectedSection ? clipRoutePointsToSection(points, selectedSection) : [],
    [points, selectedSection],
  );
  const selectedMomentData = selectedMoment ? keyMoments.find((item) => item.id === selectedMoment) ?? null : null;
  const selectedMomentInterval = selectedMomentData ? resolveKeyMomentInterval(points, selectedMomentData) : null;
  const selectedMomentPoints = useMemo(
    () => selectedMomentData ? clipRoutePointsToKeyMoment(points, selectedMomentData) : [],
    [points, selectedMomentData],
  );
  const metrics = routeAnalysis?.metrics;
  const elevations = points.map((point) => point.elevationM);
  const minimumElevation = elevations.length > 0 ? Math.min(...elevations) : 0;
  const maximumElevation = elevations.length > 0 ? Math.max(...elevations) : 0;

  useEffect(() => {
    if (!mapRef.current || points.length === 0) return;

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
  }, [finishLocation, points, startLocation]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => leafletMapRef.current?.invalidateSize({ pan: false }));
    return () => window.cancelAnimationFrame(frame);
  }, [mapExpanded]);

  useEffect(() => {
    const map = leafletMapRef.current;
    const L = leafletRef.current;
    if (!map || !L || !mapReady) return;

    for (const line of highlightLineRefs.current) line.removeFrom(map);
    highlightLineRefs.current = [];
    for (const line of routeLineRefs.current.values()) {
      line.setStyle({ opacity: selectedSection || selectedMomentInterval ? 0.28 : 0.9, weight: selectedSection || selectedMomentInterval ? 3 : 4 });
    }

    if (selectedSection && selectedSectionPoints.length > 1) {
      const highlight = L.polyline(
        selectedSectionPoints.map(({ latitude, longitude }) => [latitude, longitude]) as [number, number][],
        { color: "#a7c957", weight: 7, opacity: 1, lineCap: "round", lineJoin: "round" },
      ).addTo(map);
      highlightLineRefs.current.push(highlight);
    }

    if (!selectedSection && selectedMomentInterval && selectedMomentPoints.length > 1) {
      const highlight = L.polyline(
        selectedMomentPoints.map(({ latitude, longitude }) => [latitude, longitude]) as [number, number][],
        { color: "#f2d675", weight: 7, opacity: 1, lineCap: "round", lineJoin: "round" },
      ).addTo(map);
      highlightLineRefs.current.push(highlight);
    }
    if (!selectedSection && selectedMomentInterval && selectedMomentPoints.length === 1) {
      const point = selectedMomentPoints[0];
      highlightLineRefs.current.push(L.circleMarker([point.latitude, point.longitude], {
        radius: 7,
        color: "#17211c",
        weight: 2,
        fillColor: "#f2d675",
        fillOpacity: 1,
      }).addTo(map));
    }

    if (selectedSection && selectedSectionPoints.length > 0) {
      map.fitBounds(selectedSectionPoints.map((point) => [point.latitude, point.longitude]), { padding: [50, 50] });
      return;
    }

    if (!selectedSection && selectedMomentInterval && selectedMomentPoints.length > 0) {
      map.fitBounds(selectedMomentPoints.map((point) => [point.latitude, point.longitude]), { padding: [50, 50] });
      return;
    }

    if (points.length > 0) {
      map.fitBounds(points.map((point) => [point.latitude, point.longitude]), { padding: [30, 30] });
    }
  }, [mapReady, points, selectedMomentInterval, selectedMomentPoints, selectedSection, selectedSectionPoints]);

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
              selectedPoints={selectedSection ? selectedSectionPoints : selectedMomentPoints}
              minElevation={minimumElevation}
              maxElevation={maximumElevation}
              selectedSection={selectedSection}
              selectedMomentInterval={selectedSection ? null : selectedMomentInterval}
              sections={sections}
              onSelectSection={onSelectSection}
            />
          ) : (
            <div className="flex h-48 items-center justify-center text-sm text-white/45">{error || (loading ? "Loading course profile…" : "Course profile unavailable.")}</div>
          )}
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
          aria-pressed={mapExpanded}
          aria-label={mapExpanded ? "Reduce map" : "Expand map"}
          aria-controls="course-explorer-map"
          onClick={() => setMapExpanded((expanded) => !expanded)}
          disabled={points.length === 0}
          className="flex min-h-14 w-full items-center justify-between gap-4 px-5 text-left text-sm font-semibold transition hover:bg-white/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-inset focus-visible:outline-[#a7c957] disabled:cursor-not-allowed disabled:opacity-50 sm:px-8"
        >
          <span>{mapExpanded ? "Reduce map" : "Expand map"} <span className="ml-2 text-xs font-normal text-white/45">{mapExpanded ? "Large view" : "Compact view"}</span></span>
          <span aria-hidden="true" className="text-lg text-[#a7c957]">{mapExpanded ? "−" : "+"}</span>
        </button>
        <div id="course-explorer-map" className={`relative border-t border-white/10 bg-[#dfe3d8] transition-[height] duration-200 ${mapExpanded ? "h-[26rem] sm:h-[32rem] lg:h-[38rem]" : "h-56 sm:h-[17.5rem] lg:h-[17.5rem]"}`}>
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
  selectedMomentInterval,
  sections,
  onSelectSection,
}: {
  points: RouteAnalysisData["points"];
  selectedPoints: RouteAnalysisData["points"];
  minElevation: number;
  maxElevation: number;
  selectedSection: RouteSection | null;
  selectedMomentInterval: ReturnType<typeof resolveKeyMomentInterval>;
  sections: readonly RouteSection[];
  onSelectSection?: (section: RouteSection | null) => void;
}) {
  const width = 1200;
  const height = 440;
  const plot = { left: 136, right: 56, top: 24, bottom: 72 };
  const plotHeight = height - plot.top - plot.bottom;
  const totalDistance = Math.max(1, points.at(-1)?.distanceM ?? 1);
  const elevationScale = getNiceAxisScale(minElevation, maxElevation, 6);
  const distanceTicks = getPositionedRouteDistanceTicks(totalDistance, plot.left, width - plot.right, 7);
  const boundaries = getRouteSectionBoundaryMarkers(sections);
  const xForDistance = (distanceM: number) => getRouteDistancePosition(distanceM, totalDistance, plot.left, width - plot.right);
  const yForElevation = (elevationM: number) => plot.top + ((elevationScale.maximum - elevationM) / (elevationScale.maximum - elevationScale.minimum)) * plotHeight;
  const toProfilePoint = (point: RouteAnalysisData["points"][number]) => {
    const x = xForDistance(point.distanceM);
    const y = yForElevation(point.elevationM);
    return `${x},${y}`;
  };
  const paths = groupAnalyzedPointsBySegment(points);
  const onSectionKeyDown = (event: KeyboardEvent<SVGRectElement>, section: RouteSection) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onSelectSection?.(section);
    }
  };

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="h-56 w-full touch-manipulation sm:h-64 lg:h-72" preserveAspectRatio="none" aria-label="GPX-derived elevation profile. Select a section interval to open its details; selected Key Moments are highlighted." role="group">
      <title>Elevation profile in meters across the route distance in kilometers</title>
      {elevationScale.ticks.map((tick) => {
        const y = yForElevation(tick);
        return <g key={`elevation-${tick}`}>
          <line x1={plot.left} x2={width - plot.right} y1={y} y2={y} stroke="white" strokeOpacity="0.12" strokeWidth="1.5" />
          <text x={plot.left - 12} y={y + 9} fill="white" fillOpacity="0.68" fontSize="28" textAnchor="end">{tick.toLocaleString("en-US", { maximumFractionDigits: Math.min(2, Math.max(0, Math.ceil(-Math.log10(elevationScale.step)))) })}</text>
        </g>;
      })}
      {distanceTicks.map(({ distanceM, label, x, isFinish }) => {
        const anchor = distanceM === 0 ? "start" : isFinish ? "end" : "middle";
        return <g key={`distance-${distanceM}`}>
          <line x1={x} x2={x} y1={height - plot.bottom} y2={height - plot.bottom + 7} stroke="white" strokeOpacity="0.45" strokeWidth="2" />
          <text x={x} y={height - 22} fill="white" fillOpacity="0.68" fontSize="22" textAnchor={anchor}>{label}</text>
        </g>;
      })}
      <line x1={plot.left} x2={plot.left} y1={plot.top} y2={height - plot.bottom} stroke="white" strokeOpacity="0.38" strokeWidth="2" />
      <line x1={plot.left} x2={width - plot.right} y1={height - plot.bottom} y2={height - plot.bottom} stroke="white" strokeOpacity="0.38" strokeWidth="2" />
      <text x="22" y={plot.top + plotHeight / 2} transform={`rotate(-90 22 ${plot.top + plotHeight / 2})`} fill="white" fillOpacity="0.66" fontSize="26" textAnchor="middle">Elevation (m)</text>
      {(selectedSection || selectedMomentInterval) && <rect
        x={xForDistance(selectedSection?.startPosition.distanceM ?? selectedMomentInterval!.startDistanceM)}
        y={plot.top}
        width={Math.max(2, xForDistance(selectedSection?.endPosition.distanceM ?? selectedMomentInterval!.endDistanceM) - xForDistance(selectedSection?.startPosition.distanceM ?? selectedMomentInterval!.startDistanceM))}
        height={plotHeight}
        fill="#f2d675"
        fillOpacity="0.12"
        pointerEvents="none"
      />}
      {boundaries.map(({ distanceM, sectionKeys }) => <line key={`boundary-${distanceM}-${sectionKeys.join("_")}`} x1={xForDistance(distanceM)} x2={xForDistance(distanceM)} y1={plot.top} y2={height - plot.bottom} stroke="white" strokeOpacity="0.24" strokeWidth="2" strokeDasharray="5 7" pointerEvents="none" />)}
      {onSelectSection && sections.filter((section) =>
        section.startPosition.segmentIndex === section.segmentIndex &&
        section.endPosition.segmentIndex === section.segmentIndex &&
        Number.isFinite(section.startPosition.distanceM) &&
        Number.isFinite(section.endPosition.distanceM) &&
        section.endPosition.distanceM >= section.startPosition.distanceM,
      ).map((section, index) => {
        const start = Math.max(0, Math.min(totalDistance, section.startPosition.distanceM));
        const end = Math.max(start, Math.min(totalDistance, section.endPosition.distanceM));
        const ordinal = index + 1;
        return <rect
          key={`${section.segmentIndex}:${section.id}:profile-hit`}
          x={xForDistance(start)}
          y={plot.top}
          width={Math.max(2, xForDistance(end) - xForDistance(start))}
          height={plotHeight}
          fill="transparent"
          pointerEvents="all"
          role="button"
          tabIndex={0}
          aria-label={`Select Route Section ${ordinal}, track segment ${section.segmentIndex + 1}, ${section.startKm} to ${section.endKm} kilometers`}
          aria-pressed={selectedSection?.id === section.id && selectedSection.segmentIndex === section.segmentIndex}
          onClick={() => onSelectSection(section)}
          onKeyDown={(event) => onSectionKeyDown(event, section)}
          className="cursor-pointer outline-none focus-visible:stroke-[#f2d675] focus-visible:stroke-[3]"
        />;
      })}
      {paths.map((segment, index) => <polyline key={index} points={segment.map(toProfilePoint).join(" ")} fill="none" stroke="#a7c957" strokeOpacity={selectedSection || selectedMomentInterval ? "0.3" : "0.9"} strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" pointerEvents="none" />)}
      {(selectedSection || selectedMomentInterval) && selectedPoints.length > 1 && <polyline points={selectedPoints.map(toProfilePoint).join(" ")} fill="none" stroke="#f2d675" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round" pointerEvents="none" />}
      {(selectedSection || selectedMomentInterval) && selectedPoints.length === 1 && <circle cx={xForDistance(selectedPoints[0].distanceM)} cy={yForElevation(selectedPoints[0].elevationM)} r="7" fill="#f2d675" pointerEvents="none" />}
    </svg>
  );
}
