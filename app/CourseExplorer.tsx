"use client";

import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent } from "react";
import type { Layer, Map as LeafletMap, Polyline } from "leaflet";
import type { KeyMomentData } from "./raceTypes";
import { groupAnalyzedPointsBySegment, type RouteAnalysisData } from "./gpxAnalysis";
import type { RouteSection } from "./routeSectionEngine";
import { clipRoutePointsToKeyMoment, clipRoutePointsToSection, findSelectedRouteSection, resolveKeyMomentInterval } from "./routeSectionSelection";
import { avoidRouteDistanceTickLabelOverlap, getNiceAxisScale, getPositionedRouteDistanceTicks, getRouteDistancePosition, getRouteSectionBoundaryMarkers } from "./routeProfilePresentation";
import { nearestRouteProfilePoint } from "./routeProfileInspection";

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
  onRetry,
  heading = "The shape of the route.",
  eyebrow = "Course profile · GPX-derived",
  supportingText = "The elevation profile and route metrics are calculated from this GPX track.",
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
  onRetry?: () => void;
  heading?: string;
  eyebrow?: string;
  supportingText?: string;
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
  const selectedSectionOrdinal = selectedSection ? sections.findIndex((section) => section.id === selectedSection.id && section.segmentIndex === selectedSection.segmentIndex) + 1 : 0;
  const displayedMetrics = selectedSection ? {
    distanceKm: selectedSection.distanceKm,
    elevationGainM: selectedSection.ascentM,
    elevationLossM: selectedSection.descentM,
    highestPointM: selectedSection.elevationMaxM,
    lowestPointM: selectedSection.elevationMinM,
  } : metrics;
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
          { color: "#718078", weight: 4, opacity: 0.78 },
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
      line.setStyle({ opacity: selectedSection || selectedMomentInterval ? 0.28 : 0.78, weight: selectedSection || selectedMomentInterval ? 3 : 4 });
    }

    if (selectedSection && selectedSectionPoints.length > 1) {
      const highlight = L.polyline(
        selectedSectionPoints.map(({ latitude, longitude }) => [latitude, longitude]) as [number, number][],
        { color: "#17211c", weight: 8, opacity: 1, lineCap: "round", lineJoin: "round" },
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
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-white/55">{eyebrow}</p>
          <h2 className="mt-3 break-words text-3xl font-semibold sm:text-4xl">{heading}</h2>
          <p className="mt-3 text-sm leading-6 text-white/60">{supportingText}</p>
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
            <div className="flex min-h-48 flex-col items-center justify-center gap-4 px-3 text-center text-sm text-white/65" aria-live={loading ? "polite" : undefined}>
              <p role={error ? "alert" : undefined}>{error || (loading ? "Loading course profile…" : "Course profile unavailable.")}</p>
              {error && onRetry && <button
                type="button"
                onClick={onRetry}
                className="min-h-11 rounded-full bg-[#a7c957] px-5 py-2 text-sm font-semibold text-[#17211c] transition hover:bg-[#b8d86b] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
              >Try again</button>}
            </div>
          )}
        </div>

        {displayedMetrics && (
          <div className="mt-7 border-t border-white/10 pt-5">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-white/55" aria-live="polite">
                {selectedSection ? `Metrics · Route Section ${selectedSectionOrdinal}` : "Full-route metrics"}
              </p>
              {selectedSection && onSelectSection && <button type="button" onClick={() => onSelectSection(null)} className="min-h-11 rounded-full border border-white/20 px-4 py-2 text-xs font-semibold text-white/80 transition hover:bg-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#a7c957]" aria-label="Clear Route Section selection">
                Clear selection
              </button>}
            </div>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
              <Metric label="Distance" value={`${displayedMetrics.distanceKm.toFixed(2)} km`} />
              <Metric label="Elevation gain" value={`${displayedMetrics.elevationGainM.toLocaleString("en-US")} m+`} />
              {showExtendedMetrics && <Metric label="Elevation loss" value={`${displayedMetrics.elevationLossM.toLocaleString("en-US")} m−`} />}
              <Metric label="Highest point" value={`${Math.round(displayedMetrics.highestPointM).toLocaleString("en-US")} m`} />
              {showExtendedMetrics && <Metric label="Lowest point" value={`${Math.round(displayedMetrics.lowestPointM).toLocaleString("en-US")} m`} />}
            </div>
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
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [chartSize, setChartSize] = useState({ width: 1200, height: 288 });
  const pointerGesture = useRef<{ pointerId: number; startX: number; startY: number; moved: boolean; longPressed: boolean } | null>(null);
  const longPressTimer = useRef<number | null>(null);
  const touchInspection = useRef(false);
  const [inspectedPoint, setInspectedPoint] = useState<RouteAnalysisData["points"][number] | null>(null);
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const measure = () => {
      const bounds = svg.getBoundingClientRect();
      if (bounds.width > 0 && bounds.height > 0) {
        const next = { width: Math.round(bounds.width), height: Math.round(bounds.height) };
        setChartSize((current) => current.width === next.width && current.height === next.height ? current : next);
      }
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(svg);
    return () => observer.disconnect();
  }, []);
  const { width, height } = chartSize;
  const plot = { left: 56, right: 20, top: 16, bottom: 38 };
  const plotHeight = height - plot.top - plot.bottom;
  const totalDistance = Math.max(1, points.at(-1)?.distanceM ?? 1);
  const elevationScale = getNiceAxisScale(minElevation, maxElevation, 6);
  const desiredDistanceTickCount = Math.min(7, Math.max(3, Math.floor((width - plot.left - plot.right) / 48)));
  const distanceTicks = avoidRouteDistanceTickLabelOverlap(getPositionedRouteDistanceTicks(totalDistance, plot.left, width - plot.right, desiredDistanceTickCount));
  const boundaries = getRouteSectionBoundaryMarkers(sections);
  const xForDistance = (distanceM: number) => getRouteDistancePosition(distanceM, totalDistance, plot.left, width - plot.right);
  const yForElevation = (elevationM: number) => plot.top + ((elevationScale.maximum - elevationM) / (elevationScale.maximum - elevationScale.minimum)) * plotHeight;
  const toProfilePoint = (point: RouteAnalysisData["points"][number]) => {
    const x = xForDistance(point.distanceM);
    const y = yForElevation(point.elevationM);
    return `${x},${y}`;
  };
  const paths = groupAnalyzedPointsBySegment(points);
  const inspectAt = (clientX: number, clientY: number) => {
    const box = svgRef.current?.getBoundingClientRect();
    if (!box || box.width <= 0 || box.height <= 0) return;
    const viewX = ((clientX - box.left) / box.width) * width;
    const viewY = ((clientY - box.top) / box.height) * height;
    if (viewX < plot.left || viewX > width - plot.right || viewY < plot.top || viewY > height - plot.bottom) {
      setInspectedPoint(null);
      return;
    }
    const distanceM = ((viewX - plot.left) / (width - plot.left - plot.right)) * totalDistance;
    const elevationM = elevationScale.maximum - ((viewY - plot.top) / plotHeight) * (elevationScale.maximum - elevationScale.minimum);
    setInspectedPoint(nearestRouteProfilePoint(points, distanceM, elevationM));
  };
  const onPointerDown = (event: PointerEvent<SVGSVGElement>) => {
    if (longPressTimer.current !== null) window.clearTimeout(longPressTimer.current);
    touchInspection.current = false;
    setInspectedPoint(null);
    pointerGesture.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, moved: false, longPressed: false };
    if (event.pointerType === "touch") {
      longPressTimer.current = window.setTimeout(() => {
        const gesture = pointerGesture.current;
        if (gesture?.pointerId !== event.pointerId || gesture.moved) return;
        gesture.longPressed = true;
        touchInspection.current = true;
        inspectAt(event.clientX, event.clientY);
      }, 450);
    }
  };
  const onPointerMove = (event: PointerEvent<SVGSVGElement>) => {
    const gesture = pointerGesture.current;
    if (gesture?.pointerId === event.pointerId && Math.hypot(event.clientX - gesture.startX, event.clientY - gesture.startY) > 8) {
      gesture.moved = true;
      if (longPressTimer.current !== null) {
        window.clearTimeout(longPressTimer.current);
        longPressTimer.current = null;
      }
    }
    if (event.pointerType === "mouse" || gesture?.longPressed) inspectAt(event.clientX, event.clientY);
  };
  const onPointerUp = () => {
    if (longPressTimer.current !== null) window.clearTimeout(longPressTimer.current);
    longPressTimer.current = null;
  };
  const onPointerLeave = () => {
    onPointerUp();
    if (touchInspection.current) return;
    setInspectedPoint(null);
    pointerGesture.current = null;
  };
  const ignorePointerSelection = (event: ReactMouseEvent<SVGRectElement>) => {
    if (event.detail <= 0) return false;
    const gesture = pointerGesture.current;
    pointerGesture.current = null;
    return Boolean(gesture?.moved || gesture?.longPressed);
  };
  const onSectionKeyDown = (event: KeyboardEvent<SVGRectElement>, section: RouteSection) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      const isSelected = selectedSection?.id === section.id && selectedSection.segmentIndex === section.segmentIndex;
      onSelectSection?.(isSelected ? null : section);
    }
  };

  return (
    <div className="relative">
    <svg ref={svgRef} viewBox={`0 0 ${width} ${height}`} className="h-56 w-full touch-pan-y sm:h-64 lg:h-72" preserveAspectRatio="none" aria-label="GPX-derived elevation profile. Hover to inspect elevation, or press and hold on touch. Select a section interval to update its metrics; selected Key Moments are highlighted." role="group" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerLeave} onPointerLeave={onPointerLeave}>
      <title>Elevation profile in meters across the route distance in kilometers</title>
      {elevationScale.ticks.map((tick) => {
        const y = yForElevation(tick);
        return <g key={`elevation-${tick}`}>
          <line x1={plot.left} x2={width - plot.right} y1={y} y2={y} stroke="white" strokeOpacity="0.12" strokeWidth="1.5" />
          <text x={plot.left - 6} y={y + 4} fill="white" fillOpacity="0.68" fontSize="11" textAnchor="end">{tick.toLocaleString("en-US", { maximumFractionDigits: Math.min(2, Math.max(0, Math.ceil(-Math.log10(elevationScale.step)))) })}</text>
        </g>;
      })}
      {distanceTicks.map(({ distanceM, label, x, isFinish }) => {
        const anchor = distanceM === 0 ? "start" : isFinish ? "end" : "middle";
        return <g key={`distance-${distanceM}`}>
          <line x1={x} x2={x} y1={height - plot.bottom} y2={height - plot.bottom + 4} stroke="white" strokeOpacity="0.45" strokeWidth="1" />
          <text x={x} y={height - 8} fill="white" fillOpacity="0.68" fontSize="10" textAnchor={anchor}>{label}</text>
        </g>;
      })}
      <line x1={plot.left} x2={plot.left} y1={plot.top} y2={height - plot.bottom} stroke="white" strokeOpacity="0.38" strokeWidth="2" />
      <line x1={plot.left} x2={width - plot.right} y1={height - plot.bottom} y2={height - plot.bottom} stroke="white" strokeOpacity="0.38" strokeWidth="2" />
      <text x="12" y={plot.top + plotHeight / 2} transform={`rotate(-90 12 ${plot.top + plotHeight / 2})`} fill="white" fillOpacity="0.66" fontSize="11" textAnchor="middle">Elevation (m)</text>
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
      {onSelectSection && <rect
        x={plot.left}
        y={plot.top}
        width={width - plot.left - plot.right}
        height={plotHeight}
        fill="transparent"
        pointerEvents="all"
        onClick={(event) => {
          if (event.detail > 0) {
            if (ignorePointerSelection(event)) return;
          }
          onSelectSection(null);
        }}
      />}
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
          onClick={(event) => {
            if (event.detail > 0) {
              if (ignorePointerSelection(event)) return;
            }
            const isSelected = selectedSection?.id === section.id && selectedSection.segmentIndex === section.segmentIndex;
            onSelectSection(isSelected ? null : section);
          }}
          onKeyDown={(event) => onSectionKeyDown(event, section)}
          className="cursor-pointer outline-none focus-visible:stroke-[#f2d675] focus-visible:stroke-[3]"
        />;
      })}
      {paths.map((segment, index) => <polyline key={index} points={segment.map(toProfilePoint).join(" ")} fill="none" stroke="#a7c957" strokeOpacity={selectedSection || selectedMomentInterval ? "0.3" : "0.9"} strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" pointerEvents="none" />)}
      {(selectedSection || selectedMomentInterval) && selectedPoints.length > 1 && <polyline points={selectedPoints.map(toProfilePoint).join(" ")} fill="none" stroke="#f2d675" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round" pointerEvents="none" />}
      {(selectedSection || selectedMomentInterval) && selectedPoints.length === 1 && <circle cx={xForDistance(selectedPoints[0].distanceM)} cy={yForElevation(selectedPoints[0].elevationM)} r="7" fill="#f2d675" pointerEvents="none" />}
      {inspectedPoint && <g pointerEvents="none">
        <line x1={xForDistance(inspectedPoint.distanceM)} x2={xForDistance(inspectedPoint.distanceM)} y1={plot.top} y2={height - plot.bottom} stroke="white" strokeOpacity="0.6" strokeWidth="2" strokeDasharray="5 6" />
        <circle cx={xForDistance(inspectedPoint.distanceM)} cy={yForElevation(inspectedPoint.elevationM)} r="8" fill="#f2d675" stroke="#17211c" strokeWidth="3" />
      </g>}
    </svg>
    {inspectedPoint && <div aria-live="polite" className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-1/2 whitespace-nowrap rounded-lg bg-white px-3 py-2 text-xs font-semibold text-[#17211c] shadow-lg" style={{ left: `${Math.max(30, Math.min(70, (xForDistance(inspectedPoint.distanceM) / width) * 100))}%`, top: `${Math.max(18, Math.min(86, (yForElevation(inspectedPoint.elevationM) / height) * 100))}%` }}>
      {`${(inspectedPoint.distanceM / 1000).toFixed(2)} km · ${Math.round(inspectedPoint.elevationM)} m`}
    </div>}
    </div>
  );
}
