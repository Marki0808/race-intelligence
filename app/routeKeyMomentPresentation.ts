import type { GpxRoutePointData } from "./gpxAnalysis.ts";
import type { KeyMomentData, KeyMomentMeasurement } from "./raceTypes.ts";

export type KeyMomentCardPresentation = {
  kind: KeyMomentMeasurement["kind"];
  title: string;
  value: string;
  valueContext?: string;
  location: string;
  startPercent: number;
  endPercent: number;
  exactDistanceM: number;
};

/** Fails closed unless measured values, bounds, component identity, and GPX point ownership agree. */
export function presentKeyMomentCard(
  moment: KeyMomentData,
  points: readonly GpxRoutePointData[],
  totalDistanceM: number,
): KeyMomentCardPresentation | null {
  const measurement = moment.measurement;
  if (!measurement || !Number.isFinite(totalDistanceM) || totalDistanceM <= 0) return null;
  if (moment.segmentIndex !== undefined && moment.segmentIndex !== measurement.segmentIndex) return null;

  let start: number;
  let end: number;
  let title = moment.title;
  let value: string;
  let valueContext: string | undefined;
  let location: string;
  if (measurement.kind === "point") {
    if (![measurement.distanceM, measurement.elevationM].every(Number.isFinite) || measurement.distanceM < 0 || measurement.distanceM > totalDistanceM) return null;
    const sourcePoint = points.find((point) => point.segmentIndex === measurement.segmentIndex && point.distanceM === measurement.distanceM);
    if (!sourcePoint || sourcePoint.elevationM !== measurement.elevationM) return null;
    start = end = measurement.distanceM;
    title = moment.title;
    value = `${Math.round(measurement.elevationM).toLocaleString("en-US")} m`;
    location = `At ${formatKm(start)} km`;
  } else {
    start = measurement.startDistanceM;
    end = measurement.endDistanceM;
    if (![start, end, measurement.distanceM].every(Number.isFinite) || start < 0 || end <= start || end > totalDistanceM || Math.abs(end - start - measurement.distanceM) > 1) return null;
    const component = points.filter((point) => point.segmentIndex === measurement.segmentIndex);
    if (!component.length || start < component[0].distanceM || end > component.at(-1)!.distanceM) return null;
    if (measurement.kind === "event") {
      if (!Number.isFinite(measurement.elevationChangeM) || measurement.elevationChangeM < 0 || !measurement.roles.length) return null;
      const largest = measurement.roles.includes("largest");
      title = `${largest ? "Biggest" : "Longest"}${largest && measurement.roles.includes("longest") ? " and longest" : ""} ${measurement.direction}`;
      if (largest) {
        value = `${measurement.direction === "climb" ? "+" : "−"}${Math.round(measurement.elevationChangeM).toLocaleString("en-US")} m`;
        valueContext = measurement.roles.includes("longest") ? `${(measurement.distanceM / 1000).toFixed(1)} km event` : "elevation change";
      } else {
        value = `${(measurement.distanceM / 1000).toFixed(1)} km`;
        valueContext = "detected event length";
      }
      location = `${formatKm(start)}–${formatKm(end)} km`;
    } else if (measurement.kind === "gradient") {
      if (!Number.isFinite(measurement.averageNetGradientPct) || (measurement.direction === "climb" ? measurement.averageNetGradientPct <= 0 : measurement.averageNetGradientPct >= 0)) return null;
      title = `Sustained steep ${measurement.direction}`;
      value = `${measurement.averageNetGradientPct > 0 ? "+" : "−"}${Math.abs(measurement.averageNetGradientPct).toFixed(1)}%`;
      valueContext = `average net grade over ${(measurement.distanceM / 1000).toFixed(1)} km ${measurement.direction === "climb" ? "uphill" : "downhill"}`;
      location = `${formatKm(start)}–${formatKm(end)} km`;
    } else {
      title = moment.title;
      value = `${(measurement.distanceM / 1000).toFixed(1)} km`;
      valueContext = "detected rolling stretch";
      location = `${formatKm(start)}–${formatKm(end)} km`;
    }
  }

  return {
    kind: measurement.kind,
    title,
    value,
    ...(valueContext ? { valueContext } : {}),
    location,
    startPercent: clampPercent(start / totalDistanceM * 100),
    endPercent: clampPercent(end / totalDistanceM * 100),
    exactDistanceM: end - start,
  };
}

/** Stable category order; within a category, positions remain in route order. */
export function orderKeyMomentsForDisplay(moments: readonly KeyMomentData[]): KeyMomentData[] {
  const rank = (moment: KeyMomentData) => {
    const measurement = moment.measurement;
    if (measurement?.kind === "event") {
      if (measurement.roles.includes("largest")) return measurement.direction === "climb" ? 0 : 1;
      return measurement.direction === "climb" ? 2 : 3;
    }
    if (measurement?.kind === "gradient") return measurement.direction === "climb" ? 4 : 5;
    if (measurement?.kind === "point") return /highest/i.test(moment.title) ? 6 : /lowest/i.test(moment.title) ? 7 : 8;
    if (measurement?.kind === "rolling") return 9;
    return 10;
  };
  return [...moments].sort((left, right) => rank(left) - rank(right) ||
    measuredStart(left) - measuredStart(right) || left.id.localeCompare(right.id));
}

function measuredStart(moment: KeyMomentData) {
  const measurement = moment.measurement;
  return measurement?.kind === "point" ? measurement.distanceM : measurement?.kind === "event" || measurement?.kind === "gradient" || measurement?.kind === "rolling" ? measurement.startDistanceM : moment.focusStartPosition?.distanceM ?? moment.focusStartKm * 1000;
}

function formatKm(distanceM: number) { return (distanceM / 1000).toFixed(2).replace(/0+$/, "").replace(/\.$/, ""); }
function clampPercent(value: number) { return Math.max(0, Math.min(100, value)); }
