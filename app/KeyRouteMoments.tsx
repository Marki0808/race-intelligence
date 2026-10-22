"use client";

import type { GpxRoutePointData } from "./gpxAnalysis";
import type { KeyMomentData } from "./raceTypes";
import KeyMoment from "./KeyMoment";
import { orderKeyMomentsForDisplay, presentKeyMomentCard } from "./routeKeyMomentPresentation";
import { ElevationProfile } from "./CourseExplorer";
import { clipRoutePointsToKeyMoment, resolveKeyMomentInterval } from "./routeSectionSelection";

export default function KeyRouteMoments({ moments, routePoints, totalDistanceM, selectedMoment, onSelect }: {
  moments: readonly KeyMomentData[];
  routePoints: readonly GpxRoutePointData[];
  totalDistanceM: number;
  selectedMoment: string | null;
  onSelect: (momentId: string) => void;
}) {
  const displayable = orderKeyMomentsForDisplay(moments).flatMap((moment) => {
    const card = presentKeyMomentCard(moment, routePoints, totalDistanceM);
    return card ? [{ moment, card }] : [];
  }).map((item, index) => ({ ...item, number: String(index + 1).padStart(2, "0") }));
  if (!displayable.length) return null;
  const selectedMomentData = selectedMoment ? displayable.find((item) => item.moment.id === selectedMoment)?.moment ?? null : null;
  const selectedMomentInterval = selectedMomentData ? resolveKeyMomentInterval(routePoints, selectedMomentData) : null;
  const selectedPoints = selectedMomentData ? clipRoutePointsToKeyMoment(routePoints, selectedMomentData) : [];
  const elevations = routePoints.map((point) => point.elevationM).filter(Number.isFinite);
  const markerInputs = displayable.map(({ moment, card, number }) => ({ moment, card, number }));
  return <section className="bg-[#f4f2ed]" aria-labelledby="key-route-moments-title">
    <div className="mx-auto max-w-7xl px-6 py-16 lg:px-10 lg:py-20">
      <p className="text-xs font-semibold uppercase tracking-[0.25em] text-[#71805d]">GPX-derived facts · independent of section boundaries</p>
      <h2 id="key-route-moments-title" className="mt-3 mb-8 text-3xl font-semibold tracking-[-0.035em] sm:text-4xl">Key Route Moments</h2>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {displayable.map(({ moment, card, number }) => <KeyMoment key={moment.id} number={number} card={card} selected={selectedMoment === moment.id} onSelect={() => onSelect(moment.id)} />)}
      </div>
      <div className="mt-8 rounded-2xl bg-[#202c26] p-3 sm:p-5" aria-label="Key Moment locations on the complete route">
        <p className="mb-2 px-2 text-xs font-semibold uppercase tracking-[0.16em] text-white/60">Key Moments along the full route</p>
        <ElevationProfile points={routePoints} selectedPoints={selectedPoints} minElevation={elevations.length ? Math.min(...elevations) : 0} maxElevation={elevations.length ? Math.max(...elevations) : 0}
          selectedSection={null} selectedMomentInterval={selectedMomentInterval} sections={[]} momentMarkers={markerInputs} selectedMoment={selectedMoment} onSelectMoment={onSelect} />
      </div>
    </div>
  </section>;
}
