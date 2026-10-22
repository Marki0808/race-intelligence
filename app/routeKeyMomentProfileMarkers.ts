import type { GpxRoutePointData } from "./gpxAnalysis.ts";
import type { KeyMomentData } from "./raceTypes.ts";
import type { KeyMomentCardPresentation } from "./routeKeyMomentPresentation.ts";
import { getNiceAxisScale } from "./routeProfilePresentation.ts";

export type KeyMomentProfileMarkerInput = {
  moment: KeyMomentData;
  card: KeyMomentCardPresentation;
  number: string;
};

export type KeyMomentProfileMarker = {
  id: string;
  number: string;
  title: string;
  description: string;
  segmentIndex: number;
  anchorX: number;
  anchorY: number;
  markerX: number;
  markerY: number;
};

/** Places every validated moment marker on the same full-route axes, moving labels vertically only to resolve collisions. */
export function layoutKeyMomentProfileMarkers(
  inputs: readonly KeyMomentProfileMarkerInput[],
  points: readonly GpxRoutePointData[],
  totalDistanceM: number,
  width: number,
  height: number,
): KeyMomentProfileMarker[] {
  if (!inputs.length || !points.length || !(totalDistanceM > 0) || !(width > 76) || !(height > 70)) return [];
  const plot = { left: 56, right: 20, top: 16, bottom: 38 };
  const plotHeight = height - plot.top - plot.bottom;
  const scale = getNiceAxisScale(Math.min(...points.map((point) => point.elevationM)), Math.max(...points.map((point) => point.elevationM)), 6);
  const placed: KeyMomentProfileMarker[] = [];

  for (const input of inputs) {
    const measurement = input.moment.measurement;
    if (!measurement) continue;
    const segmentIndex = measurement.segmentIndex;
    let distanceM: number;
    let elevationM: number;
    if (measurement.kind === "point") {
      distanceM = measurement.distanceM;
      const point = points.find((candidate) => candidate.segmentIndex === segmentIndex && candidate.distanceM === distanceM && candidate.elevationM === measurement.elevationM);
      if (!point) continue;
      elevationM = point.elevationM;
    } else if (measurement.kind === "event" || measurement.kind === "gradient") {
      if (!Number.isFinite(measurement.startDistanceM) || !Number.isFinite(measurement.endDistanceM) || measurement.endDistanceM <= measurement.startDistanceM) continue;
      distanceM = (measurement.startDistanceM + measurement.endDistanceM) / 2;
      const component = points.filter((candidate) => candidate.segmentIndex === segmentIndex).sort((left, right) => left.distanceM - right.distanceM);
      const position = interpolateComponentElevation(component, distanceM);
      if (position === null) continue;
      elevationM = position;
    } else {
      continue;
    }
    if (!Number.isFinite(distanceM) || distanceM < 0 || distanceM > totalDistanceM || !Number.isFinite(elevationM)) continue;
    const anchorX = plot.left + Math.max(0, Math.min(1, distanceM / totalDistanceM)) * (width - plot.left - plot.right);
    const anchorY = plot.top + ((scale.maximum - elevationM) / (scale.maximum - scale.minimum)) * plotHeight;
    let lane = 0;
    while (placed.some((marker) => Math.abs(marker.markerY - (plot.top + 17 + lane * 28)) < 1 && Math.abs(marker.markerX - anchorX) < 31)) lane += 1;
    placed.push({
      id: input.moment.id,
      number: input.number,
      title: input.card.title,
      description: `${input.card.title}, ${input.card.locationSentence}`,
      segmentIndex,
      anchorX,
      anchorY,
      markerX: anchorX,
      markerY: plot.top + 17 + lane * 28,
    });
  }
  return placed;
}

function interpolateComponentElevation(component: readonly GpxRoutePointData[], distanceM: number): number | null {
  if (!component.length || distanceM < component[0].distanceM || distanceM > component.at(-1)!.distanceM) return null;
  for (let index = 1; index < component.length; index += 1) {
    const before = component[index - 1];
    const after = component[index];
    if (distanceM < before.distanceM || distanceM > after.distanceM) continue;
    const span = after.distanceM - before.distanceM;
    if (span <= 0) return before.elevationM;
    const fraction = (distanceM - before.distanceM) / span;
    return before.elevationM + fraction * (after.elevationM - before.elevationM);
  }
  return component.at(-1)!.elevationM;
}
