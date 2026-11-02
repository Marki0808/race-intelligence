"use client";

import { useMemo, useState } from "react";
import { calculateGradientDistribution, type GradientDistributionDirection } from "./climbingProfileModel";
import type { RouteDynamicsResult } from "./routeDynamics";
import { useRouteUnits } from "./RouteUnitPreference";
import { formatDistanceMeters, type RouteUnitSystem } from "./routeUnits";

const categories = [
  { key: "gentle", label: "Gentle", definition: ">0–10%" },
  { key: "moderate", label: "Moderate", definition: ">10–20%" },
  { key: "steep", label: "Steep", definition: ">20%" },
] as const;

const directions: Array<{ value: GradientDistributionDirection; label: string }> = [
  { value: "uphill", label: "Uphill" },
  { value: "downhill", label: "Downhill" },
];

export default function ClimbingProfile({ routeDynamics }: { routeDynamics: RouteDynamicsResult }) {
  const { units } = useRouteUnits();
  const [direction, setDirection] = useState<GradientDistributionDirection>("uphill");
  const profiles = useMemo(() => ({
    uphill: calculateGradientDistribution(routeDynamics, "uphill"),
    downhill: calculateGradientDistribution(routeDynamics, "downhill"),
  }), [routeDynamics]);
  const profile = profiles[direction];
  const directionName = direction === "uphill" ? "uphill" : "downhill";
  const barColor = direction === "uphill" ? "bg-[#486449]" : "bg-[#397477]";

  return (
    <section aria-labelledby="gradient-distribution-title" className="mt-6 rounded-2xl border border-[#17211c]/10 bg-white p-5 shadow-sm sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="max-w-3xl">
          <h2 id="gradient-distribution-title" className="text-xl font-semibold tracking-[-0.02em] text-[#17211c]">Gradient Distribution</h2>
          <p className="mt-1 text-sm text-[#4e5a50]">Understand how steep the climbs and descents are.</p>
        </div>
        <div className="inline-flex rounded-full border border-[#17211c]/10 bg-[#f4f2ed] p-1" role="group" aria-label="Gradient direction">
          {directions.map(({ value, label }) => (
            <button
              key={value}
              type="button"
              aria-pressed={direction === value}
              onClick={() => setDirection(value)}
              className={`min-h-10 rounded-full px-4 text-sm font-semibold transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#486449] ${direction === value ? "bg-[#17211c] text-white" : "text-[#4e5a50] hover:bg-white"}`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {profile.status === "unavailable" ? (
        <p className="mt-4 rounded-xl bg-[#f4f2ed] px-4 py-3 text-sm leading-6 text-[#4e5a50]" role="status">
          {profile.reason === "insufficient-uphill-distance" || profile.reason === "insufficient-downhill-distance"
            ? `There is not enough measured ${directionName} distance to summarize gradient distribution.`
            : `A reliable ${directionName} gradient distribution is not available from this GPX elevation data.`}
        </p>
      ) : (
        <>
          <div className="mt-5 space-y-4">
            {categories.map(({ key, label, definition }) => {
              const percent = profile.categories[key].percent;
              const distance = formatDistanceMeters(profile.categories[key].distanceM, units, 1);
              return (
                <div key={key}>
                  <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                    <span className="text-sm font-medium text-[#17211c]">{label} <span className="font-normal text-[#65715f]">({definition})</span></span>
                    <span className="ml-auto shrink-0 text-sm font-semibold tabular-nums text-[#17211c]">{percent}% · {distance}</span>
                  </div>
                  <div className="h-3 overflow-hidden rounded-full bg-[#e8e9e2]" role="progressbar" aria-label={`${label} ${directionName} distance`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-valuetext={`${percent}% and ${distance} cumulative ${directionName} distance`}>
                    <div className={`h-full rounded-full ${barColor}`} style={{ width: `${percent}%` }} />
                  </div>
                </div>
              );
            })}
          </div>
          <p className="mt-4 text-xs leading-5 text-[#65715f]">
            Percentages show the share of {directionName} distance in each gradient category; distances are cumulative across the route.
          </p>
        </>
      )}

      <details className="mt-4 rounded-xl border border-[#17211c]/10 bg-[#f8f7f3] px-4 py-3 text-[#4e5a50]">
        <summary className="min-h-7 cursor-pointer text-sm font-semibold text-[#17211c] marker:text-[#486449] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#486449]">
          How gradients are calculated
        </summary>
        <p className="mt-3 text-xs leading-5">
          Gradient bands use the smoothed GPX elevation profile, resampled every {formatMethodDistance(100, units)} with a {formatMethodDistance(150, units)}-radius median filter and a {formatMethodDistance(250, units)}-radius moving average. Uphill distribution counts intervals with positive gradients; downhill distribution uses the absolute grade of intervals with negative gradients. Flat intervals and intervals in the opposite direction are excluded. Each direction requires at least {formatMethodDistance(500, units)} across five qualifying intervals and sufficiently complete samples; otherwise its distribution is unavailable. Smoothing can reduce or remove short, steep features, so a brief ramp may not appear in its steepest category.
        </p>
      </details>
    </section>
  );
}

function formatMethodDistance(distanceM: number, units: RouteUnitSystem): string {
  if (units === "metric") return `${distanceM} m`;
  return `${new Intl.NumberFormat("en-US").format(Math.round(distanceM / 0.3048))} ft`;
}
