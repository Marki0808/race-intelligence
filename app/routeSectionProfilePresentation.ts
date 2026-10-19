import { avoidRouteDistanceTickLabelOverlap, getNiceAxisScale } from "./routeProfilePresentation.ts";

export type SectionProfileTick = { distanceM: number; x: number; label: string };
export type SectionProfileLayout = {
  elevationScale: ReturnType<typeof getNiceAxisScale>;
  distanceTicks: SectionProfileTick[];
  xForDistance: (distanceM: number) => number;
  yForElevation: (elevationM: number) => number;
};

/** Absolute route-kilometre x-axis with a section-local viewport and legible rounded ticks. */
export function createRouteSectionProfileLayout(startDistanceM: number, endDistanceM: number, minElevationM: number, maxElevationM: number, width: number, height: number): SectionProfileLayout | null {
  const edge = { left: 62, right: 16, top: 16, bottom: 38 };
  if (![startDistanceM, endDistanceM, minElevationM, maxElevationM, width, height].every(Number.isFinite) || endDistanceM <= startDistanceM || width <= edge.left + edge.right || height <= edge.top + edge.bottom) return null;
  const plotWidth = width - edge.left - edge.right;
  const plotHeight = height - edge.top - edge.bottom;
  const elevationScale = getNiceAxisScale(minElevationM, maxElevationM, 5);
  const xForDistance = (distanceM: number) => edge.left + (distanceM - startDistanceM) / (endDistanceM - startDistanceM) * plotWidth;
  const yForElevation = (elevationM: number) => edge.top + (elevationScale.maximum - elevationM) / (elevationScale.maximum - elevationScale.minimum) * plotHeight;
  const step = getNiceAxisScale(0, endDistanceM - startDistanceM, 5).step;
  const distances = new Set<number>([startDistanceM, endDistanceM]);
  if (step > 0) for (let tick = Math.ceil(startDistanceM / step) * step; tick < endDistanceM; tick += step) distances.add(tick);
  const raw = [...distances].sort((a, b) => a - b).map((distanceM) => ({ distanceM, x: xForDistance(distanceM), label: distanceM === startDistanceM || distanceM === endDistanceM ? `${(distanceM / 1000).toFixed(2).replace(/0+$/, "").replace(/\.$/, "")} km` : `${Math.round(distanceM / 1000)} km`, isFinish: distanceM === endDistanceM }));
  const fitted = avoidRouteDistanceTickLabelOverlap(raw, 10);
  return { elevationScale, distanceTicks: fitted.map(({ distanceM, x, label }) => ({ distanceM, x, label })), xForDistance, yForElevation };
}
