import { buildCourseBriefCandidates, renderCourseBriefV2, selectCourseBriefCandidates } from "./courseBriefCandidates.ts";
import type { CourseBriefCandidate, CourseBriefOutputV2, CourseBriefSelectionResult } from "./courseBriefCandidates.ts";
import { buildCourseBriefInputV2, type CourseBriefInputV2 } from "./courseBriefNarrativeFacts.ts";
import type { CourseBriefGeographicPresentationV1 } from "./courseBriefGeographicRendering.ts";
import type { RouteAnalysisData } from "./gpxAnalysis.ts";
import type { RaceRecordData } from "./raceTypes.ts";
import type { RouteAnchorEvidenceV2, RouteAnchorOrderingConstraint, RaceContextV1 } from "./routeAnchors.ts";

export type CourseBriefEditionEvidence = {
  /** Edition metadata for the anchors. This does not attest the supplied RouteAnalysisData source. */
  raceRecord: RaceRecordData;
  context: RaceContextV1;
  evidence: RouteAnchorEvidenceV2[];
  orderingConstraints?: RouteAnchorOrderingConstraint[];
};

export type CourseBriefCompositionDiagnostic =
  | "geographic_evidence_not_supplied"
  | "edition_binding_invalid"
  | "edition_route_provenance_unavailable";

type CourseBriefStructuralContent = {
  input: CourseBriefInputV2;
  candidates: CourseBriefCandidate[];
  selection: Extract<CourseBriefSelectionResult, { ok: true }>;
  structuralOutput: CourseBriefOutputV2;
};

export type CourseBriefCompositionResult =
  | ({ ok: true; kind: "structural"; geographicPresentation: null; geographicDiagnostic: CourseBriefCompositionDiagnostic } & CourseBriefStructuralContent)
  | ({ ok: true; kind: "geographic"; geographicPresentation: CourseBriefGeographicPresentationV1; geographicDiagnostic: null } & CourseBriefStructuralContent)
  | { ok: false; error: "invalid_route_analysis" | "insufficient_route_facts" | "structural_render_failed" };

const sourceProvenance: Record<RaceRecordData["sources"][number]["type"], RouteAnchorEvidenceV2["provenance"]> = {
  official: "official",
  gpx: "gpx-derived",
  "previous-edition": "previous-edition",
  estimated: "estimated",
  unknown: "unknown",
};

/** Compose existing deterministic engines over one already-computed analysis. This function has no I/O. */
export async function composeCourseBrief(
  routeAnalysis: RouteAnalysisData,
  editionEvidence?: CourseBriefEditionEvidence,
): Promise<CourseBriefCompositionResult> {
  let structural: CourseBriefStructuralContent;
  try {
    const input = buildCourseBriefInputV2(routeAnalysis);
    const built = buildCourseBriefCandidates(input);
    if (!built.ok) return { ok: false, error: "invalid_route_analysis" };
    const selection = selectCourseBriefCandidates(input, built.candidates);
    if (!selection.ok) {
      return { ok: false, error: selection.error === "insufficient_route_facts" ? "insufficient_route_facts" : "invalid_route_analysis" };
    }
    const structuralOutput = renderCourseBriefV2(input, built.candidates, selection);
    structural = { input, candidates: built.candidates, selection, structuralOutput };
  } catch {
    return { ok: false, error: "structural_render_failed" };
  }

  if (!editionEvidence) return structuralOnly(structural, "geographic_evidence_not_supplied");

  if (!isEditionEvidenceInternallyConsistent(editionEvidence)) return structuralOnly(structural, "edition_binding_invalid");

  // The current Race Mode loader does not attach source provenance to RouteAnalysisData.
  // Fingerprints computed here would only identify the supplied values, not prove their GPX origin.
  return structuralOnly(structural, "edition_route_provenance_unavailable");
}

function structuralOnly(
  structural: CourseBriefStructuralContent,
  geographicDiagnostic: CourseBriefCompositionDiagnostic,
): CourseBriefCompositionResult {
  return { ...structural, ok: true, kind: "structural", geographicPresentation: null, geographicDiagnostic };
}

function isEditionEvidenceInternallyConsistent(value: CourseBriefEditionEvidence): boolean {
  const { raceRecord, context, evidence } = value;
  if (!raceRecord?.race || !raceRecord.edition || !Array.isArray(raceRecord.sources)
    || !Array.isArray(raceRecord.race.editions)
    || !Array.isArray(evidence) || !Array.isArray(context?.sourceIds) || !Array.isArray(context?.locations)) return false;
  const selectedEdition = raceRecord.race.editions.find((edition) => edition.year === raceRecord.edition.year
    && edition.gpxPath === raceRecord.edition.gpxPath);
  if (!selectedEdition || context.raceId !== raceRecord.race.id || context.editionYear !== selectedEdition.year
    || (context.raceName !== undefined && context.raceName !== raceRecord.race.name)) return false;

  const sources = new Map(raceRecord.sources.map((source) => [source.id, source]));
  if (sources.size !== raceRecord.sources.length || context.sourceIds.some((sourceId) => !sources.has(sourceId))) return false;
  return evidence.every((item) => {
    if (item.raceId !== raceRecord.race.id || item.editionYear !== selectedEdition.year || item.sourceId === null) return false;
    const source = sources.get(item.sourceId);
    return source !== undefined && sourceProvenance[source.type] === item.provenance && context.sourceIds.includes(item.sourceId);
  });
}
