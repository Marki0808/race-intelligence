"use client";

import type { GpxRoutePointData } from "./gpxAnalysis";
import type { KeyMomentData } from "./raceTypes";
import KeyMoment from "./KeyMoment";
import { orderKeyMomentsForDisplay, presentKeyMomentCard } from "./routeKeyMomentPresentation";
import { ElevationProfile } from "./CourseExplorer";
import { clipRoutePointsToKeyMoment, resolveKeyMomentInterval } from "./routeSectionSelection";
import { getElevationRange } from "./routeElevationMetrics";
import { useRouteUnits } from "./RouteUnitPreference";

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
  if (!displayable.length) return null;
  const selectedMomentData = selectedMoment ? displayable.find((item) => item.moment.id === selectedMoment)?.moment ?? null : null;
  const selectedMomentInterval = selectedMomentData ? resolveKeyMomentInterval(routePoints, selectedMomentData) : null;
  const selectedPoints = selectedMomentData ? clipRoutePointsToKeyMoment(routePoints, selectedMomentData) : [];
  const elevations = routePoints.map((point) => point.elevationM).filter(Number.isFinite);
  const elevationRange = getElevationRange(elevations);
  const markerInputs = displayable.map(({ moment, card, number }) => ({ moment, card, number }));
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
      </div>
    </div>
  </section>;
}
