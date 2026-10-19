import type { RouteAnalysisData } from "./gpxAnalysis.ts";

export type RouteTakeaway = { id: string; text: string; segmentIndex: number; sectionId: string };

/** Emits only a route-level concentration insight when one section contains a strict majority of measured vertical change. */
export function buildRouteTakeaways(analysis: Pick<RouteAnalysisData, "routeSections">): RouteTakeaway[] {
  const sections = analysis.routeSections.filter((section) => Number.isFinite(section.ascentM) && Number.isFinite(section.descentM) && section.ascentM >= 0 && section.descentM >= 0);
  if (sections.length < 2) return [];
  const totalAscent = sections.reduce((sum, section) => sum + section.ascentM, 0);
  const totalDescent = sections.reduce((sum, section) => sum + section.descentM, 0);
  const majorityClimb = totalAscent > 0 ? sections.filter((section) => section.ascentM / totalAscent > 0.5).sort((a, b) => b.ascentM - a.ascentM || a.startPosition.distanceM - b.startPosition.distanceM)[0] : undefined;
  const majorityDescent = totalDescent > 0 ? sections.filter((section) => section.descentM / totalDescent > 0.5).sort((a, b) => b.descentM - a.descentM || a.startPosition.distanceM - b.startPosition.distanceM)[0] : undefined;
  const insights: RouteTakeaway[] = [];
  if (majorityClimb && majorityClimb.id === majorityDescent?.id) {
    insights.push({
      id: `route-takeaway-${majorityClimb.segmentIndex}-${majorityClimb.id}-vertical`,
      sectionId: majorityClimb.id,
      segmentIndex: majorityClimb.segmentIndex,
      text: `More than half of the climbing and descending measured across the Route Sections is concentrated within ${formatKm(majorityClimb.startKm)}–${formatKm(majorityClimb.endKm)} km.`,
    });
  } else {
    if (majorityClimb) insights.push({ id: `route-takeaway-${majorityClimb.segmentIndex}-${majorityClimb.id}-climb`, sectionId: majorityClimb.id, segmentIndex: majorityClimb.segmentIndex, text: `More than half of the climbing measured across the route sections falls within ${formatKm(majorityClimb.startKm)}–${formatKm(majorityClimb.endKm)} km.` });
    if (majorityDescent) insights.push({ id: `route-takeaway-${majorityDescent.segmentIndex}-${majorityDescent.id}-descent`, sectionId: majorityDescent.id, segmentIndex: majorityDescent.segmentIndex, text: `More than half of the descending measured across the route sections falls within ${formatKm(majorityDescent.startKm)}–${formatKm(majorityDescent.endKm)} km.` });
  }
  return insights.slice(0, 3);
}

function formatKm(value: number) { return Number(value.toFixed(2)).toString(); }
