"use client";

import type { CustomSectionBoundary, CustomSectionPlan } from "./customRouteSections";
import { MAX_CUSTOM_SECTION_BOUNDARIES } from "./customRouteSections";
import { useState } from "react";
import { useRouteUnits } from "./RouteUnitPreference";
import { distanceKmToInput, distanceUnit, distanceInputToKm, formatDistanceMeters } from "./routeUnits";

export default function CustomSectionControls({
  plan,
  routeDistanceM,
  errors,
  onChange,
  onAdd,
}: {
  plan: CustomSectionPlan;
  routeDistanceM: number;
  errors: readonly string[];
  onChange: (plan: CustomSectionPlan) => void;
  onAdd: () => void;
}) {
  const { units } = useRouteUnits();
  const [distanceDrafts, setDistanceDrafts] = useState<Record<string, { units: typeof units; value: string; canonicalValue: string }>>({});
  const updateBoundary = (id: string, patch: Partial<CustomSectionBoundary>) => onChange({
    ...plan,
    boundaries: plan.boundaries.map((boundary) => boundary.id === id ? { ...boundary, ...patch } : boundary),
  });
  const distanceInputValue = (boundary: CustomSectionBoundary) => {
    const draft = distanceDrafts[boundary.id];
    return draft?.units === units && draft.canonicalValue === boundary.distanceKm
      ? draft.value
      : distanceKmToInput(boundary.distanceKm, units);
  };
  const changeDistanceInput = (boundary: CustomSectionBoundary, value: string) => {
    const canonicalValue = distanceInputToKm(value, units);
    setDistanceDrafts((current) => ({ ...current, [boundary.id]: { units, value, canonicalValue } }));
    updateBoundary(boundary.id, { distanceKm: canonicalValue });
  };
  const removeBoundary = (id: string) => {
    setDistanceDrafts((current) => { const next = { ...current }; delete next[id]; return next; });
    onChange({ ...plan, boundaries: plan.boundaries.filter((boundary) => boundary.id !== id) });
  };

  return (
    <fieldset className="mt-4 rounded-2xl border border-black/10 bg-white p-4 sm:p-5" aria-describedby="custom-section-help custom-section-errors">
      <legend className="px-1 text-sm font-semibold text-[#17211c]">Custom section boundaries</legend>
      <p id="custom-section-help" className="mb-4 max-w-2xl text-xs leading-5 text-black/55">Set cumulative GPX {units === "metric" ? "kilometers" : "miles"} where sections change. Values are converted internally; sections cover the full measured route and names are optional.</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="grid gap-1 text-xs font-medium text-black/65">Route start name
          <input value={plan.startName} maxLength={60} onChange={(event) => onChange({ ...plan, startName: event.target.value })} className="min-h-11 rounded-xl border border-black/15 bg-[#f9f8f5] px-3 text-sm text-black focus:border-[#71805d] focus:outline-none focus:ring-2 focus:ring-[#71805d]/25" />
        </label>
        <label className="grid gap-1 text-xs font-medium text-black/65">Route finish name
          <input value={plan.finishName} maxLength={60} onChange={(event) => onChange({ ...plan, finishName: event.target.value })} className="min-h-11 rounded-xl border border-black/15 bg-[#f9f8f5] px-3 text-sm text-black focus:border-[#71805d] focus:outline-none focus:ring-2 focus:ring-[#71805d]/25" />
        </label>
      </div>
      <ol className="mt-4 space-y-2" aria-label="Custom section boundaries in route order">
        {plan.boundaries.map((boundary, index) => (
          <li key={boundary.id} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-end gap-2 sm:gap-3">
            <label className="grid min-w-0 gap-1 text-xs font-medium text-black/65">Boundary {index + 1} · {distanceUnit(units)}
              <input type="text" inputMode="decimal" value={distanceInputValue(boundary)} onChange={(event) => changeDistanceInput(boundary, event.target.value)} className="min-h-11 w-full min-w-0 rounded-xl border border-black/15 bg-[#f9f8f5] px-3 text-sm tabular-nums text-black focus:border-[#71805d] focus:outline-none focus:ring-2 focus:ring-[#71805d]/25" />
            </label>
            <label className="grid min-w-0 gap-1 text-xs font-medium text-black/65">Name · optional
              <input value={boundary.name} maxLength={60} onChange={(event) => updateBoundary(boundary.id, { name: event.target.value })} className="min-h-11 w-full min-w-0 rounded-xl border border-black/15 bg-[#f9f8f5] px-3 text-sm text-black focus:border-[#71805d] focus:outline-none focus:ring-2 focus:ring-[#71805d]/25" />
            </label>
            <button type="button" onClick={() => removeBoundary(boundary.id)} aria-label={`Remove boundary ${index + 1}`} className="min-h-11 rounded-xl border border-black/15 px-3 text-xs font-semibold text-black/65 hover:bg-[#f4f2ed] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#71805d]">Remove</button>
          </li>
        ))}
      </ol>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button type="button" onClick={onAdd} disabled={plan.boundaries.length >= MAX_CUSTOM_SECTION_BOUNDARIES} className="min-h-11 rounded-full bg-[#17211c] px-4 text-sm font-semibold text-white hover:bg-[#334238] disabled:cursor-not-allowed disabled:opacity-45 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#71805d]">Add boundary</button>
        <p className="text-xs tabular-nums text-[var(--analysis-muted)]">Finish · {routeDistanceM > 0 ? formatDistanceMeters(routeDistanceM, units) : "unavailable"} (locked)</p>
      </div>
      <div id="custom-section-errors" role={errors.length ? "alert" : undefined} aria-live="polite" className="mt-3 space-y-1 text-sm text-[#8c3d32]">
        {errors.map((error) => <p key={error}>{error}</p>)}
      </div>
    </fieldset>
  );
}
