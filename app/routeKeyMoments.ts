import type { GpxRoutePointData } from "./gpxAnalysis";
import type { GpxRouteMetricsData } from "./gpxAnalysis";
import type { KeyMomentData } from "./raceTypes";
import type { KeyMomentMeasurement } from "./raceTypes";
import type { RouteDynamicEvent, RouteDynamicsResult } from "./routeDynamics";

export type RouteElevationExtreme = {
  elevationM: number;
  point: GpxRoutePointData;
};

export type StructuredRouteKeyMomentEvent = {
  factId: string;
  eventId: string;
  kind: "climb" | "descent";
  roles: Array<"longest" | "largest">;
  segmentIndex: number;
  startKm: number;
  endKm: number;
  distanceKm: number;
  elevationChangeM: number;
  startDistanceM: number;
  endDistanceM: number;
};

type RouteKeyMomentBaseFact = {
  title: string;
  startKm: number;
  endKm: number;
  segmentIndex: number;
  text: string;
  gain?: number;
  loss?: number;
  measurement?: KeyMomentMeasurement;
  exactStartDistanceM?: number;
  exactEndDistanceM?: number;
};

/** Selects first-in-route extrema, preserving the current tie behavior. */
export function findRouteElevationExtremes(points: readonly GpxRoutePointData[]): {
  highest: RouteElevationExtreme;
  lowest: RouteElevationExtreme;
} {
  if (!points.length) throw new Error("Route elevation extrema require at least one point.");
  const highest = points.reduce((selected, point) => point.elevationM > selected.elevationM ? point : selected);
  const lowest = points.reduce((selected, point) => point.elevationM < selected.elevationM ? point : selected);
  return {
    highest: { elevationM: highest.elevationM, point: highest },
    lowest: { elevationM: lowest.elevationM, point: lowest },
  };
}

/** Selects the existing longest/largest event facts once for both UI and CourseBriefInput. */
export function selectStructuredRouteKeyMomentEvents(
  dynamics: RouteDynamicsResult,
): StructuredRouteKeyMomentEvent[] {
  const selected = new Map<string, { event: RouteDynamicEvent; kind: "climb" | "descent"; roles: Array<"longest" | "largest"> }>();

  for (const kind of ["climb", "descent"] as const) {
    const events = dynamics.events.filter((event) => event.rhythm === kind);
    if (!events.length) continue;

    const longest = firstMaximum(events, (event) => event.endKm - event.startKm);
    const largest = firstMaximum(events, (event) => kind === "climb" ? event.ascentM : event.descentM);
    addSelectedEvent(selected, kind, longest, "longest");
    addSelectedEvent(selected, kind, largest, "largest");
  }

  return [...selected.values()].map(({ event, kind, roles }) => ({
    factId: `key.${kind}.s${event.segmentIndex ?? 0}.${event.id}`,
    eventId: event.id,
    kind,
    roles,
    segmentIndex: event.segmentIndex ?? 0,
    startKm: event.startKm,
    endKm: event.endKm,
    distanceKm: event.endKm - event.startKm,
    elevationChangeM: kind === "climb" ? event.ascentM : event.descentM,
    startDistanceM: event.startPosition.distanceM,
    endDistanceM: event.endPosition.distanceM,
  }));
}

/** GPX facts remembered independently of the primary Route Section boundaries. */
export function createRouteKeyMoments(
  points: readonly GpxRoutePointData[],
  metrics: GpxRouteMetricsData,
  dynamics: RouteDynamicsResult,
): KeyMomentData[] {
  if (points.length < 2) return [];
  const extrema = findRouteElevationExtremes(points);
  const facts: RouteKeyMomentBaseFact[] = [
    {
      title: "Highest point",
      startKm: extrema.highest.point.distanceM / 1000,
      endKm: extrema.highest.point.distanceM / 1000,
      segmentIndex: extrema.highest.point.segmentIndex,
      text: `The GPX records its highest elevation here: ${Math.round(metrics.highestPointM)} m.`,
      measurement: { kind: "point", distanceM: extrema.highest.point.distanceM, elevationM: extrema.highest.point.elevationM, segmentIndex: extrema.highest.point.segmentIndex },
    },
    {
      title: "Lowest point",
      startKm: extrema.lowest.point.distanceM / 1000,
      endKm: extrema.lowest.point.distanceM / 1000,
      segmentIndex: extrema.lowest.point.segmentIndex,
      text: `The GPX records its lowest elevation here: ${Math.round(metrics.lowestPointM)} m.`,
      measurement: { kind: "point", distanceM: extrema.lowest.point.distanceM, elevationM: extrema.lowest.point.elevationM, segmentIndex: extrema.lowest.point.segmentIndex },
    },
    ...selectStructuredRouteKeyMomentEvents(dynamics).map(toDisplayFact),
  ];

  const rolling = dynamics.events
    .filter((event) => event.rhythm === "rolling")
    .reduce<RouteDynamicEvent | null>((selected, event) => {
      if (!selected || event.endKm - event.startKm > selected.endKm - selected.startKm) return event;
      return selected;
    }, null);
  if (rolling && facts.length < 7) {
    facts.push({
      title: "Most rolling stretch",
      startKm: rolling.startKm,
      endKm: rolling.endKm,
      segmentIndex: rolling.segmentIndex ?? 0,
      text: "Repeated climbs and descents create a rolling elevation pattern.",
      exactStartDistanceM: rolling.startPosition.distanceM,
      exactEndDistanceM: rolling.endPosition.distanceM,
      measurement: { kind: "rolling", startDistanceM: rolling.startPosition.distanceM, endDistanceM: rolling.endPosition.distanceM, distanceM: rolling.endPosition.distanceM - rolling.startPosition.distanceM, segmentIndex: rolling.segmentIndex ?? 0 },
    });
  }

  return facts.slice(0, 8).map((fact, index) => {
    const exactStart = fact.exactStartDistanceM ?? fact.startKm * 1000;
    const exactEnd = fact.exactEndDistanceM ?? fact.endKm * 1000;
    const startKm = round1(exactStart / 1000);
    const endKm = round1(exactEnd / 1000);
    const boundedStartKm = Math.min(metrics.distanceKm, startKm);
    const boundedEndKm = Math.min(metrics.distanceKm, endKm);
    const pointFact = fact.measurement?.kind === "point";
    return {
      id: `route-fact-${index + 1}`,
      number: String(index + 1).padStart(2, "0"),
      title: fact.title,
      distance: pointFact ? `~${startKm} km` : `${startKm}–${endKm} km`,
      focusStartKm: boundedStartKm,
      focusEndKm: boundedEndKm,
      segmentIndex: fact.segmentIndex,
      focusStartPosition: { distanceM: exactStart, segmentIndex: fact.segmentIndex },
      focusEndPosition: { distanceM: exactEnd, segmentIndex: fact.segmentIndex },
      ...(fact.gain !== undefined ? { gain: `+${Math.round(fact.gain).toLocaleString("en-US")} m` } : {}),
      ...(fact.loss !== undefined ? { loss: `−${Math.round(fact.loss).toLocaleString("en-US")} m` } : {}),
      text: fact.text,
      source: "GPX-derived",
      ...(fact.measurement ? { measurement: fact.measurement } : {}),
    };
  });
}

function addSelectedEvent(
  selected: Map<string, { event: RouteDynamicEvent; kind: "climb" | "descent"; roles: Array<"longest" | "largest"> }>,
  kind: "climb" | "descent",
  event: RouteDynamicEvent,
  role: "longest" | "largest",
) {
  const key = `${kind}:${event.id}`;
  const existing = selected.get(key);
  if (existing) existing.roles.push(role);
  else selected.set(key, { event, kind, roles: [role] });
}

function firstMaximum<T>(values: readonly T[], score: (value: T) => number): T {
  return values.reduce((selected, value) => score(value) > score(selected) ? value : selected);
}

function toDisplayFact(fact: StructuredRouteKeyMomentEvent): RouteKeyMomentBaseFact {
  const kindLabel = fact.kind === "climb" ? "climb" : "descent";
  const roleTitle = fact.roles.length === 2
    ? "Longest and biggest"
    : fact.roles[0] === "longest" ? "Longest" : "Biggest";
  const title = `${roleTitle} ${kindLabel}`;
  const text = fact.roles.length === 2
    ? `This detected ${kindLabel} is both the longest and largest by elevation change.`
    : fact.roles[0] === "longest"
      ? `The longest detected ${kindLabel} event spans ${fact.distanceKm.toFixed(1)} km.`
      : fact.kind === "climb"
        ? `The GPX-derived smoothed profile gains about ${fact.elevationChangeM} m during this climb.`
        : `The GPX-derived smoothed profile loses about ${fact.elevationChangeM} m during this descent.`;
  return {
    title,
    startKm: fact.startKm,
    endKm: fact.endKm,
    segmentIndex: fact.segmentIndex,
    exactStartDistanceM: fact.startDistanceM,
    exactEndDistanceM: fact.endDistanceM,
    measurement: { kind: "event", direction: fact.kind, startDistanceM: fact.startDistanceM, endDistanceM: fact.endDistanceM, distanceM: fact.endDistanceM - fact.startDistanceM, elevationChangeM: fact.elevationChangeM, segmentIndex: fact.segmentIndex, roles: fact.roles },
    text,
    ...(fact.kind === "climb" ? { gain: fact.elevationChangeM } : { loss: fact.elevationChangeM }),
  };
}

function round1(value: number) { return Number(value.toFixed(1)); }
