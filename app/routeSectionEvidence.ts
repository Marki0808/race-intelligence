import type { MapillarySectionEvidence, MapillaryTerrainProofData } from "./mapillaryTerrainProof";
import type { RouteSection } from "./routeSectionEngine";
import { routeSectionSelectionKey } from "./routeSectionSelection";

/** Associates imagery only when its component and precise section range can be established. */
export function mapillaryEvidenceByRouteSection(
  sections: readonly RouteSection[],
  evidence: MapillaryTerrainProofData | null,
): ReadonlyMap<string, MapillarySectionEvidence | null> {
  const result = new Map<string, MapillarySectionEvidence | null>();
  const idCounts = new Map<string, number>();
  for (const section of sections) idCounts.set(section.id, (idCounts.get(section.id) ?? 0) + 1);

  for (const section of sections) {
    const startKm = section.startPosition.distanceM / 1000;
    const endKm = section.endPosition.distanceM / 1000;
    const matches = evidence?.sections
      .filter((item) => item.id === section.id)
      .flatMap((item) => {
        if (item.images.length === 0) return idCounts.get(section.id) === 1 ? [item] : [];
        const images = item.images.filter((image) =>
          (image.segmentIndex ?? 0) === section.segmentIndex &&
          image.distanceAlongRouteKm >= startKm && image.distanceAlongRouteKm <= endKm,
        );
        return images.length ? [{ ...item, images }] : [];
      }) ?? [];
    result.set(routeSectionSelectionKey(section), matches.length === 1 ? matches[0] : null);
  }
  return result;
}
