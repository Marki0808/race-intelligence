"use client";

import type { RouteMapMode } from "./route-map-mode";
export type { RouteMapMode } from "./route-map-mode";

export function RouteMapModeSelector({ mode, onChange, label = "Map view" }: {
  mode: RouteMapMode;
  onChange: (mode: RouteMapMode) => void;
  label?: string;
}) {
  return <div className="inline-flex rounded-full border border-black/10 bg-white/90 p-1 shadow-sm" role="group" aria-label={label}>
    <button type="button" aria-pressed={mode === "3d"} onClick={() => onChange("3d")} className={`min-h-9 rounded-full px-3 text-xs font-semibold transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#315b43] ${mode === "3d" ? "bg-[#17211c] text-white" : "text-[#46514d] hover:bg-[#f2f2eb]"}`}>3D Terrain</button>
    <button type="button" aria-pressed={mode === "2d"} onClick={() => onChange("2d")} className={`min-h-9 rounded-full px-3 text-xs font-semibold transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#315b43] ${mode === "2d" ? "bg-[#17211c] text-white" : "text-[#46514d] hover:bg-[#f2f2eb]"}`}>2D Map</button>
  </div>;
}
