"use client";

import type { GpxRoutePointData } from "./gpxAnalysis";
import type { KeyMomentData } from "./raceTypes";
import KeyMoment from "./KeyMoment";
import { orderKeyMomentsForDisplay, presentKeyMomentCard } from "./routeKeyMomentPresentation";

export default function KeyRouteMoments({ moments, routePoints, totalDistanceM, selectedMoment, onSelect }: {
  moments: readonly KeyMomentData[];
  routePoints: readonly GpxRoutePointData[];
  totalDistanceM: number;
  selectedMoment: string | null;
  onSelect: (momentId: string) => void;
}) {
  const displayable = orderKeyMomentsForDisplay(moments).filter((moment) => presentKeyMomentCard(moment, routePoints, totalDistanceM));
  if (!displayable.length) return null;
  return <section className="bg-[#f4f2ed]" aria-labelledby="key-route-moments-title">
    <div className="mx-auto max-w-7xl px-6 py-16 lg:px-10 lg:py-20">
      <p className="text-xs font-semibold uppercase tracking-[0.25em] text-[#71805d]">GPX-derived facts · independent of section boundaries</p>
      <h2 id="key-route-moments-title" className="mt-3 mb-8 text-3xl font-semibold tracking-[-0.035em] sm:text-4xl">Key Route Moments</h2>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {displayable.map((moment) => <KeyMoment key={moment.id} moment={moment} totalDistanceM={totalDistanceM} routePoints={routePoints} selected={selectedMoment === moment.id} onSelect={() => onSelect(moment.id)} />)}
      </div>
    </div>
  </section>;
}
