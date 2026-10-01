import type { GpxRoutePointData } from "./gpxAnalysis";
import type { GpxRouteMetricsData } from "./gpxAnalysis";
import type { KeyMomentData } from "./raceTypes";
import type { RouteDynamicEvent, RouteDynamicsResult } from "./routeDynamics";

/** GPX facts that can be remembered independently of the primary Route Section boundaries. */
export function createRouteKeyMoments(
  points: readonly GpxRoutePointData[],
  metrics: GpxRouteMetricsData,
  dynamics: RouteDynamicsResult,
): KeyMomentData[] {
  if (points.length < 2) return [];
  const facts: Array<{ title: string; startKm: number; endKm: number; text: string; gain?: number; loss?: number }> = [];
  const high = extremePoint(points, "high");
  const low = extremePoint(points, "low");
  facts.push({ title: "Highest point", startKm: high.distanceM / 1000, endKm: high.distanceM / 1000, text: `The GPX records its highest elevation here: ${Math.round(metrics.highestPointM)} m.` });
  facts.push({ title: "Lowest point", startKm: low.distanceM / 1000, endKm: low.distanceM / 1000, text: `The GPX records its lowest elevation here: ${Math.round(metrics.lowestPointM)} m.` });

  const climbs = dynamics.events.filter((event) => event.rhythm === "climb");
  const descents = dynamics.events.filter((event) => event.rhythm === "descent");
  addExtremes(facts, climbs, "climb");
  addExtremes(facts, descents, "descent");
  const rolling = dynamics.events.filter((event) => event.rhythm === "rolling").sort((a, b) => (b.endKm - b.startKm) - (a.endKm - a.startKm))[0];
  if (rolling && facts.length < 7) facts.push(eventFact("Most rolling stretch", rolling, "Repeated climbs and descents create a rolling elevation pattern."));

  return facts.slice(0, 8).map((fact, index) => {
    const startKm = round1(fact.startKm);
    const endKm = round1(fact.endKm);
    const pointFact = Math.abs(endKm - startKm) < 0.05;
    return {
      id: `route-fact-${index + 1}`,
      number: String(index + 1).padStart(2, "0"),
      title: fact.title,
      distance: pointFact ? `~${startKm} km` : `${startKm}–${endKm} km`,
      focusStartKm: pointFact ? Math.max(0, startKm - 0.5) : startKm,
      focusEndKm: pointFact ? Math.min(metrics.distanceKm, endKm + 0.5) : endKm,
      ...(fact.gain !== undefined ? { gain: `+${Math.round(fact.gain).toLocaleString("en-US")} m` } : {}),
      ...(fact.loss !== undefined ? { loss: `−${Math.round(fact.loss).toLocaleString("en-US")} m` } : {}),
      text: fact.text,
      source: "GPX-derived",
    };
  });
}

function addExtremes(
  facts: Array<{ title: string; startKm: number; endKm: number; text: string; gain?: number; loss?: number }>,
  events: RouteDynamicEvent[],
  direction: "climb" | "descent",
) {
  if (!events.length) return;
  const byLength = [...events].sort((a, b) => (b.endKm - b.startKm) - (a.endKm - a.startKm));
  const byMagnitude = [...events].sort((a, b) =>
    (direction === "climb" ? b.ascentM - a.ascentM : b.descentM - a.descentM),
  );
  facts.push(eventFact(direction === "climb" ? "Longest climb" : "Longest descent", byLength[0], `The longest detected ${direction} event spans ${(byLength[0].endKm - byLength[0].startKm).toFixed(1)} km.`));
  facts.push(eventFact(direction === "climb" ? "Biggest climb" : "Biggest descent", byMagnitude[0], direction === "climb"
    ? `The GPX-derived smoothed profile gains about ${byMagnitude[0].ascentM} m during this climb.`
    : `The GPX-derived smoothed profile loses about ${byMagnitude[0].descentM} m during this descent.`));
}

function eventFact(title: string, event: RouteDynamicEvent, text: string) {
  return {
    title,
    startKm: event.startKm,
    endKm: event.endKm,
    text,
    ...(event.rhythm === "climb" ? { gain: event.ascentM } : {}),
    ...(event.rhythm === "descent" ? { loss: event.descentM } : {}),
  };
}

function extremePoint(points: readonly GpxRoutePointData[], kind: "high" | "low") {
  return points.reduce((selected, point) => kind === "high"
    ? point.elevationM > selected.elevationM ? point : selected
    : point.elevationM < selected.elevationM ? point : selected);
}

function round1(value: number) { return Number(value.toFixed(1)); }
