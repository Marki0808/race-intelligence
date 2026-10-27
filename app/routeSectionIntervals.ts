import type { RouteAnalysisData } from "./gpxAnalysis.ts";
import { DEFAULT_ROUTE_DYNAMICS_CONFIG, type RouteDominantRhythm } from "./routeDynamics.ts";
import type { RouteSection } from "./routeSectionEngine.ts";

const MAX_PROFILE_INTERPOLATION_GAP_M = 250;

export type RouteSectionIntervalDefinition = {
  id: string;
  segmentIndex: number;
  startDistanceM: number;
  endDistanceM: number;
  fromLabel: string;
  toLabel: string;
};

/** Builds presentation sections from component-scoped bounds using existing, smoothed route dynamics. */
export function buildRouteSectionsFromIntervals(
  analysis: Pick<RouteAnalysisData, "points" | "routeDynamics">,
  definitions: readonly RouteSectionIntervalDefinition[],
): { sections: RouteSection[]; labels: ReadonlyMap<string, { from: string; to: string }> } | null {
  const sections: RouteSection[] = [];
  const labels = new Map<string, { from: string; to: string }>();
  for (const definition of definitions) {
    const { id, segmentIndex, startDistanceM, endDistanceM, fromLabel, toLabel } = definition;
    if (!id || !Number.isInteger(segmentIndex) || !Number.isFinite(startDistanceM) || !Number.isFinite(endDistanceM) || endDistanceM <= startDistanceM) return null;
    const componentProfile = analysis.routeDynamics.resampledPoints.filter((point) => point.segmentIndex === segmentIndex);
    const componentSamples = analysis.routeDynamics.samples.filter((sample) => sample.segmentIndex === segmentIndex);
    const profile = profileBetween(componentProfile, startDistanceM, endDistanceM);
    const samples = intervalSamples(componentSamples, startDistanceM, endDistanceM);
    if (!profile || profile.length < 2 || samples.length === 0) return null;

    let ascentM = 0;
    let descentM = 0;
    for (let index = 1; index < profile.length; index += 1) {
      const delta = profile[index].elevationM - profile[index - 1].elevationM;
      if (delta > 0) ascentM += delta;
      else descentM += Math.abs(delta);
    }
    const distanceKm = (endDistanceM - startDistanceM) / 1000;
    const verticalM = ascentM + descentM;
    const directionStrength = verticalM > 0 ? Math.abs(ascentM - descentM) / verticalM : 0;
    const intensity = distanceKm > 0 ? verticalM / distanceKm : 0;
    const dominantRhythm: RouteDominantRhythm = intensity <= DEFAULT_ROUTE_DYNAMICS_CONFIG.flatMaximumIntensityMPerKm ? "flat"
      : intensity >= DEFAULT_ROUTE_DYNAMICS_CONFIG.minimumDirectionalIntensityMPerKm && directionStrength >= DEFAULT_ROUTE_DYNAMICS_CONFIG.minimumDirectionStrength
        ? ascentM >= descentM ? "climb" : "descent"
        : "rolling";
    const embeddedEvents = analysis.routeDynamics.events
      .filter((event) => event.segmentIndex === segmentIndex && event.rhythm !== dominantRhythm &&
        event.startPosition.distanceM >= startDistanceM && event.endPosition.distanceM <= endDistanceM)
      .map((event) => ({ ...event, distanceKm: round2(event.endKm - event.startKm) }));
    const section: RouteSection = {
      id,
      segmentIndex,
      startPosition: { distanceM: startDistanceM, segmentIndex },
      endPosition: { distanceM: endDistanceM, segmentIndex },
      startKm: round2(startDistanceM / 1000),
      endKm: round2(endDistanceM / 1000),
      distanceKm: round2(distanceKm),
      dominantRhythm,
      elevationStartM: Math.round(profile[0].elevationM),
      elevationEndM: Math.round(profile.at(-1)!.elevationM),
      elevationMinM: Math.round(Math.min(...profile.map((point) => point.elevationM))),
      elevationMaxM: Math.round(Math.max(...profile.map((point) => point.elevationM))),
      ascentM: Math.round(ascentM),
      descentM: Math.round(descentM),
      elevationProfile: profile,
      embeddedEvents,
      dynamicsSummary: {
        verticalIntensityMPerKm: round1(intensity),
        directionBalance: round2(verticalM ? (ascentM - descentM) / verticalM : 0),
        directionStrength: round2(directionStrength),
        stability: round2(samples.reduce((sum, sample) => sum + sample.stability, 0) / samples.length),
      },
      description: intervalDescription(dominantRhythm, embeddedEvents),
      mapData: analysis.points.filter((point) => point.segmentIndex === segmentIndex && point.distanceM >= startDistanceM && point.distanceM <= endDistanceM)
        .map(({ latitude, longitude, elevationM, distanceM }) => ({ latitude, longitude, elevationM, distanceM, segmentIndex })),
    };
    sections.push(section);
    labels.set(`${segmentIndex}:${id}`, { from: fromLabel, to: toLabel });
  }
  return { sections, labels };
}

function profileBetween(points: readonly { distanceM: number; smoothedElevationM: number }[], startM: number, endM: number) {
  const start = interpolate(points, startM);
  const end = interpolate(points, endM);
  if (!start || !end) return null;
  return [start, ...points.filter((point) => point.distanceM > startM && point.distanceM < endM)
    .map((point) => ({ distanceM: point.distanceM, elevationM: point.smoothedElevationM })), end];
}

function intervalSamples<T extends { distanceM: number }>(samples: readonly T[], startM: number, endM: number) {
  const within = samples.filter((sample) => sample.distanceM >= startM && sample.distanceM <= endM);
  if (within.length) return within;
  const midpoint = (startM + endM) / 2;
  const closest = [...samples].sort((left, right) => Math.abs(left.distanceM - midpoint) - Math.abs(right.distanceM - midpoint)).slice(0, 2);
  return closest;
}

function interpolate(points: readonly { distanceM: number; smoothedElevationM: number }[], distanceM: number) {
  const exact = points.find((point) => Math.abs(point.distanceM - distanceM) < 0.001);
  if (exact) return { distanceM, elevationM: exact.smoothedElevationM };
  const rightIndex = points.findIndex((point) => point.distanceM > distanceM);
  if (rightIndex <= 0) return null;
  const left = points[rightIndex - 1];
  const right = points[rightIndex];
  const span = right.distanceM - left.distanceM;
  if (span <= 0 || span > MAX_PROFILE_INTERPOLATION_GAP_M || distanceM < left.distanceM || distanceM > right.distanceM) return null;
  const ratio = (distanceM - left.distanceM) / span;
  return { distanceM, elevationM: left.smoothedElevationM + (right.smoothedElevationM - left.smoothedElevationM) * ratio };
}

function intervalDescription(rhythm: RouteDominantRhythm, events: RouteSection["embeddedEvents"]) {
  const character = rhythm === "climb" ? "mainly climbing" : rhythm === "descent" ? "mainly descending"
    : rhythm === "rolling" ? "rolling between climbs and descents" : "showing limited elevation change";
  const notable = [...events].sort((left, right) => right.significance - left.significance).slice(0, 2);
  const details = notable.map((event) => {
    const direction = event.rhythm === "climb" ? "climb" : event.rhythm === "descent" ? "descent" : "mixed elevation change";
    return `A ${direction} spans about ${event.distanceKm.toFixed(1)} km around km ${event.startKm.toFixed(1)}–${event.endKm.toFixed(1)}`;
  });
  const change = details.length ? ` ${details.join("; ")}${events.length > details.length ? `, with ${events.length - details.length} other measured change${events.length - details.length === 1 ? "" : "s"}` : ""}.` : "";
  return `The smoothed GPX profile is ${character}.${change}`;
}

function round1(value: number) { return Number(value.toFixed(1)); }
function round2(value: number) { return Number(value.toFixed(2)); }
