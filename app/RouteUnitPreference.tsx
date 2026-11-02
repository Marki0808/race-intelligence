"use client";

import { createContext, useCallback, useContext, useSyncExternalStore, type ReactNode } from "react";
import { readStoredRouteUnits, writeStoredRouteUnits, type RouteUnitSystem } from "./routeUnits";

type RouteUnitContextValue = { units: RouteUnitSystem; setUnits: (units: RouteUnitSystem) => void };
const RouteUnitContext = createContext<RouteUnitContextValue>({ units: "metric", setUnits: () => undefined });
const listeners = new Set<() => void>();
let fallbackUnits: RouteUnitSystem = "metric";
let volatileOverride: RouteUnitSystem | null = null;

function getSnapshot(): RouteUnitSystem {
  try { return typeof window === "undefined" ? "metric" : volatileOverride ?? readStoredRouteUnits(window.localStorage); }
  catch { return fallbackUnits; }
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (typeof window !== "undefined") window.addEventListener("storage", listener);
  return () => {
    listeners.delete(listener);
    if (typeof window !== "undefined") window.removeEventListener("storage", listener);
  };
}

function notifyPreferenceChanged() {
  listeners.forEach((listener) => listener());
}

export function RouteUnitPreferenceProvider({ children }: { children: ReactNode }) {
  const units = useSyncExternalStore(subscribe, getSnapshot, () => "metric" as const);
  const setUnits = useCallback((next: RouteUnitSystem) => {
    fallbackUnits = next;
    try { volatileOverride = typeof window === "undefined" || !writeStoredRouteUnits(window.localStorage, next) ? next : null; }
    catch { volatileOverride = next; /* Storage getter may itself be blocked; this session still updates. */ }
    notifyPreferenceChanged();
  }, []);

  return <RouteUnitContext.Provider value={{ units, setUnits }}>{children}</RouteUnitContext.Provider>;
}

export function useRouteUnits(): RouteUnitContextValue {
  return useContext(RouteUnitContext);
}

export function RouteUnitToggle() {
  const { units, setUnits } = useRouteUnits();
  return (
    <div className="mt-5 flex flex-wrap items-center gap-2" role="group" aria-label="Distance and elevation units">
      <span className="mr-1 text-xs font-medium text-white/65">Units</span>
      <button type="button" aria-pressed={units === "metric"} onClick={() => setUnits("metric")} className={`min-h-10 rounded-full border px-4 text-xs font-semibold transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#d8eea5] ${units === "metric" ? "border-[#a7c957] bg-[#a7c957] text-[#17211c]" : "border-white/25 text-white/80 hover:bg-white/10"}`}>Metric</button>
      <button type="button" aria-pressed={units === "us-customary"} onClick={() => setUnits("us-customary")} className={`min-h-10 rounded-full border px-4 text-xs font-semibold transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#d8eea5] ${units === "us-customary" ? "border-[#a7c957] bg-[#a7c957] text-[#17211c]" : "border-white/25 text-white/80 hover:bg-white/10"}`}>US Customary</button>
    </div>
  );
}
