import type { RouteSection } from "./routeSectionEngine";
import { routeSectionSelectionKey } from "./routeSectionSelection";

export type NiceAxisScale = {
  minimum: number;
  maximum: number;
  step: number;
  ticks: number[];
};

/** Produces rounded, evenly spaced presentation ticks without changing route measurements. */
export function getNiceAxisScale(minimum: number, maximum: number, desiredTickCount = 6): NiceAxisScale {
  if (!Number.isFinite(minimum) || !Number.isFinite(maximum)) {
    return { minimum: 0, maximum: 1, step: 0.2, ticks: [0, 0.2, 0.4, 0.6, 0.8, 1] };
  }

  const lower = Math.min(minimum, maximum);
  const upper = Math.max(minimum, maximum);
  const rawRange = upper - lower;
  const range = rawRange > 0 ? rawRange : Math.max(Math.abs(lower) * 0.1, 1);
  const roughStep = range / Math.max(1, desiredTickCount - 1);
  const magnitude = 10 ** Math.floor(Math.log10(roughStep));
  const normalized = roughStep / magnitude;
  const factor = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  const step = factor * magnitude;
  const scaleInputMinimum = rawRange > 0 ? lower : lower - range / 2;
  const scaleInputMaximum = rawRange > 0 ? upper : upper + range / 2;
  const scaleMinimum = Math.floor(scaleInputMinimum / step) * step;
  const scaleMaximum = Math.ceil(scaleInputMaximum / step) * step;
  const ticks: number[] = [];
  const count = Math.min(100, Math.round((scaleMaximum - scaleMinimum) / step));
  for (let index = 0; index <= count; index += 1) {
    ticks.push(Number((scaleMinimum + index * step).toPrecision(12)));
  }
  return { minimum: scaleMinimum, maximum: scaleMaximum, step, ticks };
}

export type RouteSectionBoundaryMarker = {
  distanceM: number;
  componentIndices: number[];
  sectionKeys: string[];
};

/** Visual markers may share a cumulative distance; their source section/component identities remain intact. */
export function getRouteSectionBoundaryMarkers(sections: readonly RouteSection[]): RouteSectionBoundaryMarker[] {
  const markers = new Map<number, RouteSectionBoundaryMarker>();
  for (const section of sections) {
    for (const position of [section.startPosition, section.endPosition]) {
      if (position.segmentIndex !== section.segmentIndex || !Number.isFinite(position.distanceM)) continue;
      const marker = markers.get(position.distanceM) ?? { distanceM: position.distanceM, componentIndices: [], sectionKeys: [] };
      if (!marker.componentIndices.includes(section.segmentIndex)) marker.componentIndices.push(section.segmentIndex);
      const key = routeSectionSelectionKey(section);
      if (!marker.sectionKeys.includes(key)) marker.sectionKeys.push(key);
      markers.set(position.distanceM, marker);
    }
  }
  return [...markers.values()]
    .map((marker) => ({
      ...marker,
      componentIndices: marker.componentIndices.sort((left, right) => left - right),
      sectionKeys: marker.sectionKeys.sort(),
    }))
    .sort((left, right) => left.distanceM - right.distanceM);
}

/** Uses bounded readable distance intervals; section hits still select by full component-aware section identity. */
export function getRouteDistanceTicks(totalDistanceM: number, desiredTickCount = 7): number[] {
  const scale = getNiceAxisScale(0, Math.max(0, totalDistanceM), desiredTickCount);
  const ticks = scale.ticks.filter((tick) => tick >= 0 && tick <= totalDistanceM);
  if (!ticks.includes(0)) ticks.unshift(0);
  if (Number.isFinite(totalDistanceM) && totalDistanceM > 0 && !ticks.includes(totalDistanceM)) {
    while (ticks.length > 1 && totalDistanceM - ticks.at(-1)! < scale.step * 0.8) ticks.pop();
    ticks.push(totalDistanceM);
  }
  return [...new Set(ticks)].sort((left, right) => left - right);
}

export function formatRouteDistanceTick(distanceM: number, totalDistanceM: number): string {
  const stepKm = getNiceAxisScale(0, Math.max(0, totalDistanceM), 7).step / 1000;
  const digits = Math.min(4, Math.max(0, Math.ceil(-Math.log10(stepKm))));
  const formatted = (distanceM / 1000).toFixed(digits).replace(/\.?0+$/, "");
  return `${formatted || "0"} km`;
}
