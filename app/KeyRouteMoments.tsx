"use client";

import type { GpxRoutePointData } from "./gpxAnalysis";
import type { KeyMomentData } from "./raceTypes";
import { useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import KeyMoment from "./KeyMoment";
import { orderKeyMomentsForDisplay, presentKeyMomentCard } from "./routeKeyMomentPresentation";
import { buildKeyMomentMapMarkers } from "./routeKeyMomentMapMarkers";
import { ElevationProfile } from "./CourseExplorer";
import { clipRoutePointsToKeyMoment, resolveKeyMomentInterval } from "./routeSectionSelection";
import { getElevationRange } from "./routeElevationMetrics";
import { useRouteUnits } from "./RouteUnitPreference";

const MapLibreRouteMap = dynamic(() => import("./MapLibreRouteMap"), {
  ssr: false,
  loading: () => <div className="flex h-64 items-center justify-center bg-[#dfe3d8] text-sm text-[#46514d] sm:h-72" role="status">Loading 3D terrain map…</div>,
});

export default function KeyRouteMoments({ moments, routePoints, totalDistanceM, selectedMoment, onSelect }: {
  moments: readonly KeyMomentData[];
  routePoints: readonly GpxRoutePointData[];
  totalDistanceM: number;
  selectedMoment: string | null;
  onSelect: (momentId: string) => void;
}) {
  const { units } = useRouteUnits();
  const displayable = orderKeyMomentsForDisplay(moments).flatMap((moment) => {
    const card = presentKeyMomentCard(moment, routePoints, totalDistanceM, units);
    return card ? [{ moment, card }] : [];
  }).map((item, index) => ({ ...item, number: String(index + 1).padStart(2, "0") }));
  const selectedMomentData = selectedMoment ? displayable.find((item) => item.moment.id === selectedMoment)?.moment ?? null : null;
  const selectedMomentInterval = selectedMomentData ? resolveKeyMomentInterval(routePoints, selectedMomentData) : null;
  const selectedPoints = selectedMomentData ? clipRoutePointsToKeyMoment(routePoints, selectedMomentData) : [];
  const selectedRangePoints = selectedMomentData?.measurement?.kind !== "point" ? selectedPoints : [];
  const elevations = routePoints.map((point) => point.elevationM).filter(Number.isFinite);
  const elevationRange = getElevationRange(elevations);
  const markerInputs = displayable.map(({ moment, card, number }) => ({ moment, card, number }));
  const mapMarkers = useMemo(() => buildKeyMomentMapMarkers(displayable, routePoints, totalDistanceM, units), [displayable, routePoints, totalDistanceM, units]);
  const mapSectionRef = useRef<HTMLDivElement | null>(null);
  const [mapVisible, setMapVisible] = useState(false);
  useEffect(() => {
    const element = mapSectionRef.current;
    if (!element || mapVisible) return;
    if (typeof IntersectionObserver === "undefined") {
      const fallbackFrame = requestAnimationFrame(() => setMapVisible(true));
      return () => cancelAnimationFrame(fallbackFrame);
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setMapVisible(true);
        observer.disconnect();
      }
    }, { rootMargin: "300px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, [displayable.length, mapVisible]);
  if (!displayable.length) return null;
  const selectedMapMarker = mapMarkers.find((marker) => marker.id === selectedMoment) ?? null;
  const selectedFocusPoints = selectedMapMarker?.focusPoints ?? [];
  return <section className="bg-transparent" aria-labelledby="key-route-moments-title">
    <div className="route-analysis-content py-3 sm:py-4 lg:py-5">
      <div className="rounded-3xl bg-[#f4f2ed] px-4 py-8 sm:px-6 sm:py-10 lg:px-8 lg:py-12">
      <p className="text-xs font-semibold uppercase tracking-[0.25em] text-[#536b3e]">GPX-derived facts · independent of section boundaries</p>
      <h2 id="key-route-moments-title" className="mt-3 mb-8 text-3xl font-semibold tracking-[-0.035em] text-[#17211c] sm:text-4xl">Key Route Moments</h2>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {displayable.map(({ moment, card, number }) => <KeyMoment key={moment.id} number={number} card={card} selected={selectedMoment === moment.id} onSelect={() => onSelect(moment.id)} />)}
      </div>
      <div className="mt-8 rounded-2xl bg-[#202c26] p-3 sm:p-5" aria-label="Key Moment locations on the complete route">
        <p className="mb-2 px-2 text-xs font-semibold uppercase tracking-[0.16em] text-white/60">Key Moments along the full route</p>
      <ElevationProfile points={routePoints} selectedPoints={selectedPoints} minElevation={elevationRange?.minimum ?? 0} maxElevation={elevationRange?.maximum ?? 0} units={units}
          selectedSection={null} selectedMomentInterval={selectedMomentInterval} sections={[]} momentMarkers={markerInputs} selectedMoment={selectedMoment} onSelectMoment={onSelect} />
      </div>
      <div ref={mapSectionRef} className="mt-6 overflow-hidden rounded-2xl border border-[#d9d8ce] bg-white shadow-sm" aria-label="Key Moments 3D terrain map">
        <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 sm:px-5">
          <div>
            <h3 className="text-sm font-semibold text-[#17211c] sm:text-base">Key Moments in 3D Terrain</h3>
            <p className="mt-0.5 text-xs text-[#59635d]">Select a numbered marker or a Key Moment card to focus the map.</p>
          </div>
        </div>
        {mapVisible ? <MapLibreRouteMap
          points={routePoints}
          selectedPoints={selectedRangePoints}
          focusPoints={selectedFocusPoints}
          focusKey={selectedMapMarker?.id ?? null}
          keyMomentMarkers={mapMarkers}
          selectedKeyMomentId={selectedMoment}
          onSelectKeyMoment={onSelect}
          enableFlyover={false}
          allow2dFallback={false}
          onFallbackTo2d={() => undefined}
          label="Key Moments full-route 3D terrain map"
          frameClassName="relative h-64 w-full min-w-0 overflow-hidden bg-[#dfe3d8] sm:h-72"
        /> : <div className="flex h-64 items-center justify-center bg-[#dfe3d8] text-sm text-[#46514d] sm:h-72">3D terrain map loads as you reach this section.</div>}
        {selectedMapMarker && <p className="border-t border-[#e5e3da] bg-[#f8f7f2] px-4 py-2 text-xs font-medium text-[#34423a]" role="status" aria-live="polite">Selected: {selectedMapMarker.title} · {selectedMapMarker.distanceLabel} along the route</p>}
        <div className="flex flex-wrap gap-2 border-t border-[#e5e3da] px-3 py-3 sm:px-4" aria-label="Select a Key Moment marker">
          {mapMarkers.map((marker) => <button key={marker.id} type="button" aria-pressed={selectedMoment === marker.id} onClick={() => onSelect(marker.id)} className={`min-h-10 rounded-full border px-3 text-xs font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#315b43] ${selectedMoment === marker.id ? "border-[#315b43] bg-[#315b43] text-white" : "border-[#d4d7cd] bg-[#f8f7f2] text-[#17211c] hover:bg-[#eeefe6]"}`}>
            <span className="mr-1.5 inline-flex h-5 w-5 items-center justify-center rounded-full bg-[#f2a23a] text-[10px] text-[#17211c]">{marker.number}</span>{marker.title} · {marker.distanceLabel}
          </button>)}
        </div>
        {selectedMapMarker && <p className="sr-only" aria-live="polite">Selected Key Moment: {selectedMapMarker.title} at {selectedMapMarker.distanceLabel}.</p>}
      </div>
      </div>
    </div>
  </section>;
}
