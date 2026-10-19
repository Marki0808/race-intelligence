import type { RouteAnalysisData } from "./gpxAnalysis.ts";

export type RouteTakeaway = { id: string; text: string; segmentIndex: number };

const rhythmText: Record<string, string> = {
  climb: "climb-led",
  descent: "descent-led",
  rolling: "rolling",
  flat: "low-vertical-change",
};

/** Summarizes only the ordered Route Section character within each GPX component. */
export function buildRouteTakeaways(analysis: Pick<RouteAnalysisData, "routeSections">): RouteTakeaway[] {
  const byComponent = new Map<number, typeof analysis.routeSections>();
  for (const section of analysis.routeSections) {
    const entries = byComponent.get(section.segmentIndex) ?? [];
    entries.push(section);
    byComponent.set(section.segmentIndex, entries);
  }
  return [...byComponent.entries()]
    .sort(([left], [right]) => left - right)
    .slice(0, 3)
    .flatMap(([segmentIndex, sections]) => {
      const ordered = [...sections].sort((a, b) => a.startPosition.distanceM - b.startPosition.distanceM);
      const rhythms = ordered.reduce<string[]>((result, section) => {
        const label = rhythmText[section.dominantRhythm] ?? "unknown";
        if (label !== "unknown" && result.at(-1) !== label) result.push(label);
        return result;
      }, []);
      if (!rhythms.length) return [];
      const componentLabel = `Track segment ${segmentIndex + 1}`;
      const text = rhythms.length === 1
        ? `Every analyzed Route Section in ${componentLabel} is classified as ${rhythms[0]}.`
        : `Within ${componentLabel}, the analyzed sections progress from ${joinRhythms(rhythms)}.`;
      return [{ id: `route-takeaway-${segmentIndex}`, text, segmentIndex }];
    });
}

function joinRhythms(values: readonly string[]) {
  if (values.length === 2) return `${values[0]} to ${values[1]}`;
  return `${values.slice(0, -1).join(", ")}, then ${values.at(-1)}`;
}
