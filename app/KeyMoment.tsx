"use client";

import type { GpxRoutePointData } from "./gpxAnalysis";
import type { KeyMomentData } from "./raceTypes";
import { presentKeyMomentCard } from "./routeKeyMomentPresentation";

export default function KeyMoment({
  moment,
  totalDistanceM,
  routePoints,
  onSelect,
  selected = false,
}: {
  moment: KeyMomentData;
  totalDistanceM: number;
  routePoints: readonly GpxRoutePointData[];
  onSelect: () => void;
  selected?: boolean;
}) {
  const card = presentKeyMomentCard(moment, routePoints, totalDistanceM);
  if (!card) return null;
  const isPoint = card.kind === "point";
  const startX = 8 + card.startPercent * 3.04;
  const endX = 8 + card.endPercent * 3.04;
  const rawWidth = Math.max(0, endX - startX);
  const markerWidth = Math.max(3, rawWidth);
  const markerX = Math.min(312 - markerWidth, startX - Math.max(0, markerWidth - rawWidth) / 2);
  return (
    <article className={`rounded-2xl border bg-white p-5 transition sm:p-6 ${selected ? "border-[#71805d] ring-2 ring-[#71805d]/25" : "border-black/10"}`}>
      <h3 className="text-base font-semibold text-[#17211c] sm:text-lg">
        <button type="button" onClick={onSelect} aria-pressed={selected} className="min-h-11 text-left focus-visible:rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#71805d]">
          {card.title}
        </button>
      </h3>
      <p className="mt-3 text-2xl font-semibold tabular-nums tracking-tight text-[#17211c] sm:text-3xl">{card.value}</p>
      {card.valueContext && <p className="mt-1 text-xs font-medium text-black/45">{card.valueContext}</p>}
      <p className="mt-3 text-sm font-semibold tabular-nums text-[#53663c]">{card.location}</p>
      <svg className="mt-3 h-8 w-full" viewBox="0 0 320 24" role="img" aria-label={`${card.title}: ${card.location} along the ${ (totalDistanceM / 1000).toFixed(2) } kilometre route${!isPoint && rawWidth < 3 ? "; marker enlarged for visibility, interval length is unchanged" : ""}`} preserveAspectRatio="none">
        <line x1="8" x2="312" y1="12" y2="12" stroke="#d4d8d1" strokeWidth="4" strokeLinecap="round" />
        {isPoint ? <circle cx={startX} cy="12" r="6" fill={selected ? "#17211c" : "#71805d"} stroke="white" strokeWidth="2" /> : (
          <rect x={markerX} y="7" width={markerWidth} height="10" rx="5" fill={selected ? "#17211c" : "#71805d"} />
        )}
      </svg>
      <p className="mt-3 text-sm leading-6 text-black/60">{moment.text}</p>
      <p className="mt-4 text-[10px] font-semibold uppercase tracking-[0.18em] text-[#71805d]">{moment.source}</p>
    </article>
  );
}
