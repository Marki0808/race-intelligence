"use client";

import type { GpxRoutePointData } from "./gpxAnalysis";
import { getKeyMomentProfilePoints, keyMomentProfilePolyline } from "./routeKeyMomentProfile";
import type { KeyMomentData } from "./raceTypes";

type KeyMomentProps = {
  title: string;
  distance: string;
  gain?: string;
  loss?: string;
  text: string;
  source: string;
  onSelect?: () => void;
  selected?: boolean;
  compact?: boolean;
  focusStartKm?: number;
  focusEndKm?: number;
  routePoints?: readonly GpxRoutePointData[];
  segmentIndex?: number;
  focusStartPosition?: KeyMomentData["focusStartPosition"];
  focusEndPosition?: KeyMomentData["focusEndPosition"];
};

export default function KeyMoment({
  title,
  distance,
  gain,
  loss,
  text,
  source,
  onSelect,
  selected = false,
  compact = false,
  focusStartKm,
  focusEndKm,
  routePoints = [],
  segmentIndex,
  focusStartPosition,
  focusEndPosition,
}: KeyMomentProps) {
  const profilePoints = focusStartKm !== undefined && focusEndKm !== undefined
    ? getKeyMomentProfilePoints(routePoints, { focusStartKm, focusEndKm, segmentIndex, focusStartPosition, focusEndPosition })
    : [];
  const profileLine = keyMomentProfilePolyline(profilePoints);
  return (
    <div className={selected ? "rounded-xl ring-1 ring-[#71805d]/35" : ""}>
      <h3 className={compact ? "text-xl font-semibold" : "mt-12 text-xl font-semibold"}>
        <button
          type="button"
          onClick={onSelect}
          aria-pressed={onSelect ? selected : undefined}
          className={`${onSelect ? "cursor-pointer text-left" : "cursor-default text-left"} ${selected ? "text-[#53663c] underline decoration-[#a7c957] decoration-2 underline-offset-4" : ""} focus-visible:rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#71805d]`}
        >
          {title}
        </button>
      </h3>

      <div className="mt-4 flex flex-wrap gap-x-4 gap-y-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-black/45">
        <span>{distance}</span>

        {gain && <span className="text-[#71805d]">{gain}</span>}

        {loss && <span className="text-black/45">{loss}</span>}
      </div>

      <p className="mt-4 text-sm leading-6 text-black/55">
        {text}
      </p>

      {profileLine && <svg viewBox="0 0 320 68" className="mt-4 h-16 w-full rounded-lg bg-[#f4f2ed] p-2" preserveAspectRatio="none" role="img" aria-label={`GPX elevation profile around ${distance}`}>
        <polyline points={profileLine} fill="none" stroke={selected ? "#17211c" : "#71805d"} strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>}

      <div className="mt-5 text-[10px] font-semibold uppercase tracking-[0.18em] text-[#71805d]">
        🔵 {source}
      </div>
    </div>
  );
}
