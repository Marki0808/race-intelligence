"use client";

import { useMemo, useState } from "react";
import { calculateSectionGradientDistribution, defaultSectionGradientDirection, type GradientDistributionDirection } from "./climbingProfileModel";
import type { RouteSection } from "./routeSectionEngine";
import { useRouteUnits } from "./RouteUnitPreference";
import { formatDistanceMeters } from "./routeUnits";

const categories = [
  { key: "gentle", label: "Gentle", range: "0–<5%" },
  { key: "moderate", label: "Moderate", range: "5–<10%" },
  { key: "steep", label: "Steep", range: "10–<15%" },
  { key: "very-steep", label: "Very steep", range: "15–<20%" },
  { key: "extreme", label: "Extreme", range: "20%+" },
] as const;

const directions: Array<{ value: GradientDistributionDirection; label: string }> = [
  { value: "uphill", label: "Uphill" },
  { value: "downhill", label: "Downhill" },
];

export default function SectionGradientDistribution({ section }: { section: RouteSection }) {
  const { units } = useRouteUnits();
  const sectionIdentity = `${section.segmentIndex}:${section.id}:${section.startPosition.distanceM}:${section.endPosition.distanceM}`;
  const preferredDirection = defaultSectionGradientDirection(section.dominantRhythm);
  const [directionSelection, setDirectionSelection] = useState<{ sectionIdentity: string; direction: GradientDistributionDirection }>(() => ({
    sectionIdentity,
    direction: preferredDirection,
  }));
  const direction = directionSelection.sectionIdentity === sectionIdentity ? directionSelection.direction : preferredDirection;
  const profile = useMemo(() => calculateSectionGradientDistribution(section, direction), [section, direction]);
  const directionName = direction;
  const barColor = direction === "uphill" ? "bg-[#486449]" : "bg-[#397477]";

  return (
    <section className="mt-5 rounded-2xl border border-black/10 bg-white/75 p-4 sm:p-5" aria-label="Section gradient distribution">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h4 className="text-sm font-semibold text-[#17211c]">Gradient Distribution</h4>
          <p className="mt-1 text-xs text-[var(--analysis-muted)]">Share of {directionName} distance within this section.</p>
        </div>
        <div className="inline-flex rounded-full border border-[#17211c]/10 bg-[#f4f2ed] p-1" role="group" aria-label="Section gradient direction">
          {directions.map(({ value, label }) => (
            <button key={value} type="button" aria-pressed={direction === value} onClick={() => setDirectionSelection({ sectionIdentity, direction: value })}
              className={`min-h-9 rounded-full px-3 text-xs font-semibold transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#486449] ${direction === value ? "bg-[#17211c] text-white" : "text-[#4e5a50] hover:bg-white"}`}>
              {label}
            </button>
          ))}
        </div>
      </div>
      {profile.status === "unavailable" ? (
        <p className="mt-3 rounded-xl bg-[#f4f2ed] px-3 py-2.5 text-xs leading-5 text-[var(--analysis-muted)]" role="status">
          {profile.reason === "insufficient-uphill-distance" || profile.reason === "insufficient-downhill-distance"
            ? `There is not enough measured ${directionName} distance in this section.`
            : "A complete smoothed elevation profile is not available for this section."}
        </p>
      ) : (
        <div className="mt-4 space-y-3">
          {categories.map(({ key, label, range }) => {
            const category = profile.categories[key];
            const distance = formatDistanceMeters(category.distanceM, units, 1);
            return <div key={key}>
              <div className="mb-1 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <span className="text-xs font-medium text-[#17211c]">{label} <span className="font-normal text-[var(--analysis-muted)]">({range})</span></span>
                <span className="ml-auto shrink-0 text-xs font-semibold tabular-nums text-[#17211c]">{category.percent}% · {distance}</span>
              </div>
              <div className="h-2.5 overflow-hidden rounded-full bg-[#e8e9e2]" role="progressbar" aria-label={`${label} ${directionName} distance in section`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={category.percent} aria-valuetext={`${category.percent}% and ${distance} cumulative ${directionName} distance in this section`}>
                <div className={`h-full rounded-full ${barColor}`} style={{ width: `${category.percent}%` }} />
              </div>
            </div>;
          })}
          <p className="pt-1 text-[11px] leading-5 text-[var(--analysis-muted)]">Distances are cumulative within this section and based on smoothed GPX elevation. Flat intervals are excluded.</p>
        </div>
      )}
    </section>
  );
}
