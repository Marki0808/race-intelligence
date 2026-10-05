import type { EvidenceAvailability, GeoEnrichmentData } from "./geoEnrichment.ts";
import type { RouteAnalysisData } from "./gpxAnalysis.ts";
import { findRouteElevationExtremes, selectStructuredRouteKeyMomentEvents } from "./routeKeyMoments.ts";
import type { RouteDominantRhythm, ResampledRoutePoint } from "./routeDynamics.ts";
import { attachTerrainEvidenceToRouteSections } from "./routeEvidenceAdapter.ts";
import type { RouteSection } from "./routeSectionEngine.ts";
import type { TerrainCategory } from "./terrainAggregation.ts";

export type DirectCourseBriefFact<T> = {
  factId: string;
  value: T;
};

export type CourseBriefComponentFact = {
  factId: string;
  segmentIndex: number;
  startKm: number;
  endKm: number;
  traversedDistanceKm: number;
  hasTraversedDistance: boolean;
};

export type CourseBriefSectionFact = {
  factId: string;
  ordinal: number;
  segmentIndex: number;
  startKm: number;
  endKm: number;
  distanceKm: number;
  rhythm: RouteDominantRhythm;
  ascentM: number;
  descentM: number;
};

export type CourseBriefKeyMomentFact = {
  factId: string;
  kind: "climb" | "descent";
  roles: Array<"longest" | "largest">;
  segmentIndex: number;
  startKm: number;
  endKm: number;
  distanceKm: number;
  elevationChangeM: number;
};

export type CourseBriefProgressionBin = {
  factId: "progression.early" | "progression.middle" | "progression.late";
  gainM: number;
  lossM: number;
};

export type CourseBriefOsmInput =
  | { requestState: "not-requested" }
  | { requestState: "unavailable" }
  | { requestState: "received"; data: GeoEnrichmentData };

export type CourseBriefSurfaceSectionFact = {
  factId: string;
  sectionFactId: string;
  status: "not-requested" | "unavailable" | "missing" | "partial" | "mapped";
  classifiableCoveragePercent: number | null;
  categories: Array<{
    category: Exclude<TerrainCategory, "unknown">;
    shareOfClassifiableEvidencePercent: number;
  }>;
};

export type CourseBriefInputV1 = {
  schemaVersion: 1;
  analysisVersion: number;
  directFacts: {
    distance: DirectCourseBriefFact<{ km: number }>;
    rawGain: DirectCourseBriefFact<{ m: number }>;
    rawLoss: DirectCourseBriefFact<{ m: number }>;
    highest: DirectCourseBriefFact<{ elevationM: number; atKm: number; segmentIndex: number }>;
    lowest: DirectCourseBriefFact<{ elevationM: number; atKm: number; segmentIndex: number }>;
    components: CourseBriefComponentFact[];
  };
  derivedFacts: {
    verticalProgression: {
      basis: "route-dynamics-smoothed-profile";
      early: CourseBriefProgressionBin;
      middle: CourseBriefProgressionBin;
      late: CourseBriefProgressionBin;
    } | null;
    sections: CourseBriefSectionFact[];
    keyMoments: CourseBriefKeyMomentFact[];
  };
  evidenceScopedFacts: {
    osmSurface: {
      requestState: CourseBriefOsmInput["requestState"];
      responseAvailability: EvidenceAvailability | null;
      sections: CourseBriefSurfaceSectionFact[];
    };
  };
};

type CourseBriefAnalysisInput = Pick<
  RouteAnalysisData,
  "metrics" | "segments" | "points" | "routeDynamics" | "routeSections"
>;

type CourseBriefInputOptions = {
  analysisVersion: number;
  osm?: CourseBriefOsmInput;
};

const PROGRESSION_BINS = [
  { name: "early", factId: "progression.early" },
  { name: "middle", factId: "progression.middle" },
  { name: "late", factId: "progression.late" },
] as const;

const TERRAIN_CATEGORIES = new Set<Exclude<TerrainCategory, "unknown">>([
  "paved",
  "gravel",
  "dirt-ground",
  "rocky-rough",
  "natural-trail",
  "mixed-trail",
]);

/** Projects deterministic analysis and optional OSM evidence to the compact Course Brief contract. */
export function buildCourseBriefInput(
  analysis: CourseBriefAnalysisInput,
  options: CourseBriefInputOptions,
): CourseBriefInputV1 {
  if (analysis.points.length === 0) {
    throw new Error("CourseBriefInput requires a successfully analyzed route with points.");
  }

  const extrema = findRouteElevationExtremes(analysis.points);
  const sections = analysis.routeSections.map((section, index) => toSectionFact(section, index + 1));
  const osm = options.osm ?? { requestState: "not-requested" as const };

  return {
    schemaVersion: 1,
    analysisVersion: options.analysisVersion,
    directFacts: {
      distance: { factId: "route.distance", value: { km: analysis.metrics.distanceKm } },
      rawGain: { factId: "route.raw-gain", value: { m: analysis.metrics.elevationGainM } },
      rawLoss: { factId: "route.raw-loss", value: { m: analysis.metrics.elevationLossM } },
      highest: {
        factId: "route.highest",
        value: {
          elevationM: analysis.metrics.highestPointM,
          atKm: analysis.metrics.highestPointDistanceKm,
          segmentIndex: extrema.highest.point.segmentIndex,
        },
      },
      lowest: {
        factId: "route.lowest",
        value: {
          elevationM: analysis.metrics.lowestPointM,
          atKm: roundToTenthKm(extrema.lowest.point.distanceM / 1000),
          segmentIndex: extrema.lowest.point.segmentIndex,
        },
      },
      components: analysis.segments.map((segment) => {
        const traversedDistanceKm = (segment.endDistanceM - segment.startDistanceM) / 1000;
        return {
          factId: `route.component.${segment.segmentIndex}`,
          segmentIndex: segment.segmentIndex,
          startKm: segment.startDistanceM / 1000,
          endKm: segment.endDistanceM / 1000,
          traversedDistanceKm,
          hasTraversedDistance: traversedDistanceKm > 0,
        };
      }),
    },
    derivedFacts: {
      verticalProgression: buildVerticalProgression(analysis),
      sections,
      keyMoments: selectStructuredRouteKeyMomentEvents(analysis.routeDynamics).map((fact) => ({
        factId: fact.factId,
        kind: fact.kind,
        roles: fact.roles,
        segmentIndex: fact.segmentIndex,
        startKm: fact.startKm,
        endKm: fact.endKm,
        distanceKm: fact.distanceKm,
        elevationChangeM: fact.elevationChangeM,
      })),
    },
    evidenceScopedFacts: {
      osmSurface: buildOsmSurfaceFacts(sections, analysis.routeSections, osm),
    },
  };
}

function buildVerticalProgression(analysis: CourseBriefAnalysisInput): CourseBriefInputV1["derivedFacts"]["verticalProgression"] {
  const profile = analysis.routeDynamics.resampledPoints;
  const totalDistanceM = analysis.points.at(-1)?.distanceM ?? 0;
  if (totalDistanceM <= 0 || profile.length < 2 || profile.some((point) =>
    !Number.isFinite(point.distanceM) || !Number.isFinite(point.smoothedElevationM) || !Number.isInteger(point.segmentIndex)
  )) return null;

  const grouped = new Map<number, ResampledRoutePoint[]>();
  for (const point of profile) {
    const points = grouped.get(point.segmentIndex) ?? [];
    points.push(point);
    grouped.set(point.segmentIndex, points);
  }

  const bins = PROGRESSION_BINS.map(() => ({ gainM: 0, lossM: 0 }));
  let usableEdgeCount = 0;
  for (const points of grouped.values()) {
    const ordered = [...points].sort((left, right) => left.distanceM - right.distanceM);
    for (let index = 1; index < ordered.length; index += 1) {
      const start = ordered[index - 1];
      const end = ordered[index];
      const edgeLengthM = end.distanceM - start.distanceM;
      if (edgeLengthM <= 0) continue;
      usableEdgeCount += 1;
      const elevationChangeM = end.smoothedElevationM - start.smoothedElevationM;
      if (elevationChangeM === 0) continue;

      for (let binIndex = 0; binIndex < bins.length; binIndex += 1) {
        const binStartM = totalDistanceM * binIndex / bins.length;
        const binEndM = totalDistanceM * (binIndex + 1) / bins.length;
        const overlapM = Math.max(0, Math.min(end.distanceM, binEndM) - Math.max(start.distanceM, binStartM));
        if (overlapM === 0) continue;
        const contributionM = Math.abs(elevationChangeM) * overlapM / edgeLengthM;
        if (elevationChangeM > 0) bins[binIndex].gainM += contributionM;
        else bins[binIndex].lossM += contributionM;
      }
    }
  }
  if (usableEdgeCount === 0) return null;

  return {
    basis: "route-dynamics-smoothed-profile",
    early: { factId: "progression.early", ...bins[0] },
    middle: { factId: "progression.middle", ...bins[1] },
    late: { factId: "progression.late", ...bins[2] },
  };
}

function toSectionFact(section: RouteSection, ordinal: number): CourseBriefSectionFact {
  const segmentIndex = section.segmentIndex;
  const startDistanceM = section.startPosition.distanceM;
  const endDistanceM = section.endPosition.distanceM;
  const factId = `section.s${segmentIndex}.m${stableNumberToken(startDistanceM)}-${stableNumberToken(endDistanceM)}.${section.dominantRhythm}`;
  return {
    factId,
    ordinal,
    segmentIndex,
    startKm: section.startKm,
    endKm: section.endKm,
    distanceKm: section.distanceKm,
    rhythm: section.dominantRhythm,
    ascentM: section.ascentM,
    descentM: section.descentM,
  };
}

function buildOsmSurfaceFacts(
  sectionFacts: readonly CourseBriefSectionFact[],
  routeSections: readonly RouteSection[],
  osm: CourseBriefOsmInput,
): CourseBriefInputV1["evidenceScopedFacts"]["osmSurface"] {
  const responseAvailability = osm.requestState === "received" ? osm.data.availability : null;
  if (osm.requestState !== "received") {
    return {
      requestState: osm.requestState,
      responseAvailability,
      sections: sectionFacts.map((section) => ({
        factId: `surface.${section.factId}`,
        sectionFactId: section.factId,
        status: osm.requestState,
        classifiableCoveragePercent: null,
        categories: [],
      })),
    };
  }

  const groupedSections = new Map<number, RouteSection[]>();
  for (const section of routeSections) {
    const group = groupedSections.get(section.segmentIndex) ?? [];
    group.push(section);
    groupedSections.set(section.segmentIndex, group);
  }
  const attachedBySegment = new Map<number, RouteSection[]>();
  for (const [segmentIndex, componentSections] of groupedSections) {
    const componentEvidence = {
      ...osm.data,
      segments: osm.data.segments.filter((segment) => (segment.segmentIndex ?? 0) === segmentIndex),
    };
    attachedBySegment.set(segmentIndex, attachTerrainEvidenceToRouteSections(componentSections, componentEvidence));
  }
  const attachedIndexes = new Map<number, number>();
  return {
    requestState: osm.requestState,
    responseAvailability,
    sections: sectionFacts.map((sectionFact, index) => {
      const segmentIndex = routeSections[index].segmentIndex;
      const componentIndex = attachedIndexes.get(segmentIndex) ?? 0;
      const section = attachedBySegment.get(segmentIndex)?.[componentIndex];
      attachedIndexes.set(segmentIndex, componentIndex + 1);
      if (!section) throw new Error("CourseBriefInput could not map OSM evidence to its Route Section.");
      const exactCoverage = section.terrainEvidenceExactCoveragePercent ?? 0;
      const status = exactCoverage <= 0 ? "missing" : exactCoverage < 100 ? "partial" : "mapped";
      const categories = exactCoverage <= 0
        ? []
        : (section.terrainEvidence ?? []).flatMap((evidence) => {
          if (!TERRAIN_CATEGORIES.has(evidence.terrain as Exclude<TerrainCategory, "unknown">)) return [];
          return [{
            category: evidence.terrain as Exclude<TerrainCategory, "unknown">,
            shareOfClassifiableEvidencePercent: evidence.evidenceSharePercent,
          }];
        });
      return {
        factId: `surface.${sectionFact.factId}`,
        sectionFactId: sectionFact.factId,
        status,
        classifiableCoveragePercent: exactCoverage,
        categories,
      };
    }),
  };
}

function stableNumberToken(value: number): string {
  if (!Number.isFinite(value)) throw new Error("CourseBriefInput section positions must be finite.");
  return (Object.is(value, -0) ? "0" : String(value)).replaceAll(".", "p");
}

function roundToTenthKm(value: number): number {
  return Number(value.toFixed(1));
}
