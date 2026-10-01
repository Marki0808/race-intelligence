import type { GpxRoutePointData } from "./gpxAnalysis";
import {
  DEFAULT_ROUTE_DYNAMICS_CONFIG,
  relativeSignificance,
  type RouteDominantRhythm,
  type RouteDynamicEvent,
  type RouteDynamicsConfig,
  type RouteDynamicsResult,
  type RouteRhythm,
} from "./routeDynamics.ts";

export type RouteEmbeddedEvent = Pick<
  RouteDynamicEvent,
  "id" | "rhythm" | "startKm" | "endKm" | "ascentM" | "descentM" | "significance"
> & { distanceKm: number };

/** Returns a presentation copy ordered along the route without changing analytical event priority. */
export function sortRouteEmbeddedEventsForDisplay(events: readonly RouteEmbeddedEvent[]): RouteEmbeddedEvent[] {
  return [...events].sort((left, right) => left.startKm - right.startKm || left.endKm - right.endKm);
}

export type RunnerSectionSignificanceConfig = {
  minimumScore: number;
  directionalWeights: { distance: number; vertical: number; intensity: number };
  neutralWeights: { distance: number; vertical: number; intensity: number };
  intensityRatioKeepThreshold: number;
  intenseSectionMinimumStability: number;
  minimumDirectionalStrength: number;
  minimumDirectionalDistanceShare: number;
  minimumDirectionalVerticalShare: number;
  neutralMinimumDistanceShare: number;
  neutralMinimumScore: number;
  localContextWeight: number;
  bridgeMinimumDirectionStrength: number;
  bridgeFlatMaximumIntensityMPerKm: number;
  mergeAffinityWeights: {
    sameRhythm: number;
    matchingFlanks: number;
    sameDirection: number;
    oppositeDirection: number;
    relativeNeighborSize: number;
  };
  stabilityFloor: number;
  stabilityWeight: number;
};

export const DEFAULT_RUNNER_SECTION_SIGNIFICANCE_CONFIG: RunnerSectionSignificanceConfig = {
  minimumScore: 0.17,
  directionalWeights: { distance: 0.3, vertical: 0.5, intensity: 0.2 },
  neutralWeights: { distance: 0.6, vertical: 0.25, intensity: 0.15 },
  intensityRatioKeepThreshold: 1.2,
  intenseSectionMinimumStability: 0.58,
  minimumDirectionalStrength: 0.58,
  minimumDirectionalDistanceShare: 0.05,
  minimumDirectionalVerticalShare: 0.05,
  neutralMinimumDistanceShare: 0.08,
  neutralMinimumScore: 0.14,
  localContextWeight: 0.35,
  bridgeMinimumDirectionStrength: 0.25,
  bridgeFlatMaximumIntensityMPerKm: 18,
  mergeAffinityWeights: {
    sameRhythm: 0.35,
    matchingFlanks: 0.4,
    sameDirection: 0.2,
    oppositeDirection: 0.04,
    relativeNeighborSize: 0.05,
  },
  stabilityFloor: 0.85,
  stabilityWeight: 0.15,
};

export type RunnerSectionDecision = {
  sectionId: string;
  startKm: number;
  endKm: number;
  rhythm: RouteDominantRhythm;
  distanceKm: number;
  ascentM: number;
  descentM: number;
  distanceShare: number;
  verticalShare: number;
  verticalIntensityMPerKm: number;
  verticalIntensityRatio: number;
  significanceScore: number;
  decision: "kept" | "absorbed-previous" | "absorbed-next" | "bridged";
  mergeTarget: string | null;
  reason: string;
};

export type RunnerSectionSignificanceResult = {
  sections: RouteSection[];
  decisions: RunnerSectionDecision[];
};

export type RouteSection = {
  id: string;
  startKm: number;
  endKm: number;
  distanceKm: number;
  dominantRhythm: RouteDominantRhythm;
  elevationStartM: number;
  elevationEndM: number;
  elevationMinM: number;
  elevationMaxM: number;
  ascentM: number;
  descentM: number;
  elevationProfile: Array<{ distanceM: number; elevationM: number }>;
  embeddedEvents: RouteEmbeddedEvent[];
  dynamicsSummary: {
    verticalIntensityMPerKm: number;
    directionBalance: number;
    directionStrength: number;
    stability: number;
  };
  description: string;
  terrainEvidenceCoveragePercent?: number;
  terrainEvidence?: RouteSectionTerrainEvidence[];
  mapillaryEvidence?: RouteSectionMapillaryEvidence;
  mapData?: RouteSectionMapPoint[];
};

export type RouteSectionTerrainEvidence = {
  terrain: string;
  evidenceSharePercent: number;
  provenance: "osm";
};
export type RouteSectionMapillaryEvidence = {
  availability: "available" | "not-found" | "unknown";
  imageCount: number;
};
export type RouteSectionMapPoint = { latitude: number; longitude: number; elevationM: number; distanceM: number };

type Phase = { rhythm: RouteRhythm; startIndex: number; endIndex: number };
// A stable phase contributing one fifth of the local elevation movement can change the runner's experience.
const MINIMUM_RELATIVE_VERTICAL_CONTRIBUTION = 0.2;

export function buildRouteSections(
  dynamics: RouteDynamicsResult,
  routePoints: readonly GpxRoutePointData[],
  config: RouteDynamicsConfig = DEFAULT_ROUTE_DYNAMICS_CONFIG,
): RouteSection[] {
  return buildRouteSectionsWithSignificance(dynamics, routePoints, config).sections;
}

export function buildRouteSectionsWithSignificance(
  dynamics: RouteDynamicsResult,
  routePoints: readonly GpxRoutePointData[],
  config: RouteDynamicsConfig = DEFAULT_ROUTE_DYNAMICS_CONFIG,
  significanceConfig: RunnerSectionSignificanceConfig = DEFAULT_RUNNER_SECTION_SIGNIFICANCE_CONFIG,
): RunnerSectionSignificanceResult {
  return applyRunnerFacingSectionSignificance(buildConsolidatedRouteSections(dynamics, routePoints, config), significanceConfig);
}

/** Exposes the accepted pre-significance V1 output for deterministic review and A/B validation. */
export function buildConsolidatedRouteSections(
  dynamics: RouteDynamicsResult,
  routePoints: readonly GpxRoutePointData[],
  config: RouteDynamicsConfig = DEFAULT_ROUTE_DYNAMICS_CONFIG,
): RouteSection[] {
  if (dynamics.samples.length === 0) return [];
  const analyticalPhases = mergeRoutePhases(createInitialPhases(dynamics, config), dynamics, config);
  const phases = consolidateRoutePhases(analyticalPhases, dynamics, config);
  return phases.flatMap((phase, index) => {
    if (phase.rhythm === "transition") return [];
    return [createSection(phase, index, dynamics, routePoints)];
  });
}

/** Final user-facing pass over consolidated sections; dynamics classification is left untouched. */
export function applyRunnerFacingSectionSignificance(
  input: readonly RouteSection[],
  config: RunnerSectionSignificanceConfig = DEFAULT_RUNNER_SECTION_SIGNIFICANCE_CONFIG,
): RunnerSectionSignificanceResult {
  const totalDistanceKm = input.reduce((sum, section) => sum + section.distanceKm, 0);
  const totalAscentM = input.reduce((sum, section) => sum + section.ascentM, 0);
  const totalDescentM = input.reduce((sum, section) => sum + section.descentM, 0);
  const totalVerticalM = totalAscentM + totalDescentM;
  const routeIntensity = totalDistanceKm > 0 ? totalVerticalM / totalDistanceKm : 0;
  const work: SignificanceWorkSection[] = input.map((section) => ({ section, originals: [section] }));
  const decisions = new Map<string, RunnerSectionDecision>();
  const initialDiagnostics = new Map(input.map((section, sectionIndex) => [section.id,
    calculateRunnerSectionDecision(section, totalDistanceKm, totalAscentM, totalDescentM, totalVerticalM, routeIntensity, config,
      input[sectionIndex - 1], input[sectionIndex + 1]),
  ]));

  let index = 0;
  while (index < work.length) {
    const candidate = work[index];
    if (candidate.originals.length !== 1) {
      index += 1;
      continue;
    }
    const previous = work[index - 1];
    const next = work[index + 1];
    const diagnostic = initialDiagnostics.get(candidate.section.id)!;
    if (isSectionSignificant(candidate.section, diagnostic, config)) {
      decisions.set(candidate.section.id, { ...diagnostic, decision: "kept", mergeTarget: null, reason: significanceReason(candidate.section, diagnostic, config) });
      index += 1;
      continue;
    }

    if (previous && next && previous.section.dominantRhythm === next.section.dominantRhythm &&
      canPreserveDominantRhythm([previous.section, candidate.section, next.section], previous.section.dominantRhythm, config)) {
      const absorbedFlanks = next.originals.flatMap((section) => {
        const flankDiagnostic = initialDiagnostics.get(section.id)!;
        return isSectionSignificant(section, flankDiagnostic, config) ? [] : [makeAbsorbedEvent(section, flankDiagnostic.significanceScore)];
      });
      const bridge = mergeSections([previous.section, candidate.section, next.section], previous.section.dominantRhythm, candidate.section, diagnostic.significanceScore, absorbedFlanks);
      previous.section = bridge;
      previous.originals.push(...candidate.originals, ...next.originals);
      work.splice(index, 2);
      decisions.set(candidate.section.id, {
        ...diagnostic,
        decision: "bridged",
        mergeTarget: `${previous.section.startKm}–${previous.section.endKm} km (same-rhythm bridge)`,
        reason: `Low relative score (${diagnostic.significanceScore.toFixed(3)}) and both neighbors are ${previous.section.dominantRhythm}; combined rhythm remains coherent.`,
      });
      for (const bridged of next.originals) {
        if (decisions.has(bridged.id)) continue;
        const flankDiagnostic = initialDiagnostics.get(bridged.id)!;
        const flankIsSignificant = isSectionSignificant(bridged, flankDiagnostic, config);
        decisions.set(bridged.id, {
          ...flankDiagnostic,
          decision: flankIsSignificant ? "kept" : "bridged",
          mergeTarget: `${previous.section.startKm}–${previous.section.endKm} km (same-rhythm bridge)`,
          reason: flankIsSignificant
            ? `Its relative significance was retained; it shares the continuous ${previous.section.dominantRhythm} rhythm on the far side of the bridged interruption.`
            : `Low relative score (${flankDiagnostic.significanceScore.toFixed(3)}); merged with the same-rhythm phase after an insignificant bridge.`,
        });
      }
      index = Math.max(0, index - 1);
      continue;
    }

    const target = chooseMergeTarget(candidate.section, previous?.section, next?.section, config);
    if (!target) {
      decisions.set(candidate.section.id, { ...diagnostic, decision: "kept", mergeTarget: null, reason: "No neighboring section is available to receive this phase." });
      index += 1;
      continue;
    }
    const targetWork = target.side === "previous" ? previous! : next!;
    const targetRange = `${targetWork.section.startKm}–${targetWork.section.endKm} km`;
    const merged = target.side === "previous"
      ? mergeSections([targetWork.section, candidate.section], targetWork.section.dominantRhythm, candidate.section, diagnostic.significanceScore)
      : mergeSections([candidate.section, targetWork.section], targetWork.section.dominantRhythm, candidate.section, diagnostic.significanceScore);
    targetWork.section = merged;
    targetWork.originals.push(...candidate.originals);
    work.splice(index, 1);
    for (const receiver of targetWork.originals) {
      if (receiver.id === candidate.section.id || decisions.has(receiver.id)) continue;
      const receiverDiagnostic = initialDiagnostics.get(receiver.id)!;
      decisions.set(receiver.id, {
        ...receiverDiagnostic,
        decision: "kept",
        mergeTarget: `${merged.startKm}–${merged.endKm} km (receiving phase)`,
        reason: `Retained as the ${targetWork.section.dominantRhythm} receiving phase; the neighboring lower-significance phase was absorbed into this coherent section.`,
      });
    }
    decisions.set(candidate.section.id, {
      ...diagnostic,
      decision: target.side === "previous" ? "absorbed-previous" : "absorbed-next",
      mergeTarget: `${targetRange} → ${merged.startKm}–${merged.endKm} km`,
      reason: `${target.reason}; candidate score ${diagnostic.significanceScore.toFixed(3)} is below ${config.minimumScore.toFixed(2)}.`,
    });
    index = Math.max(0, index - (target.side === "previous" ? 1 : 0));
  }

  const finalSections = work.map(({ section }, finalIndex) => ({ ...section, id: `route-section-${finalIndex + 1}` }));
  return {
    sections: finalSections,
    decisions: input.map((section) => decisions.get(section.id) ?? {
      ...initialDiagnostics.get(section.id)!,
      decision: "kept" as const,
      mergeTarget: null,
      reason: "Retained as a runner-facing phase.",
    }),
  };
}

type SignificanceWorkSection = { section: RouteSection; originals: RouteSection[] };

function calculateRunnerSectionDecision(
  section: RouteSection,
  totalDistanceKm: number,
  totalAscentM: number,
  totalDescentM: number,
  totalVerticalM: number,
  routeIntensity: number,
  config: RunnerSectionSignificanceConfig,
  previous?: RouteSection,
  next?: RouteSection,
): Omit<RunnerSectionDecision, "decision" | "mergeTarget" | "reason"> {
  const distanceShare = totalDistanceKm > 0 ? section.distanceKm / totalDistanceKm : 0;
  // Report directional shares as specified, but scale them by the route's overall share of that direction for scoring.
  const directionalVerticalM = section.dominantRhythm === "climb" ? section.ascentM
    : section.dominantRhythm === "descent" ? section.descentM
      : section.ascentM + section.descentM;
  const directionalTotalM = section.dominantRhythm === "climb" ? totalAscentM
    : section.dominantRhythm === "descent" ? totalDescentM
      : totalVerticalM;
  const verticalShare = directionalTotalM > 0 ? directionalVerticalM / directionalTotalM : 0;
  const routeDirectionShare = totalVerticalM > 0 ? directionalTotalM / totalVerticalM : 0;
  const routeWeightedVerticalShare = verticalShare * routeDirectionShare;
  const verticalIntensityMPerKm = section.distanceKm > 0 ? (section.ascentM + section.descentM) / section.distanceKm : 0;
  const intensityRatio = routeIntensity > 0 ? verticalIntensityMPerKm / routeIntensity : 0;
  const normalizedIntensity = intensityRatio / (1 + intensityRatio);
  const weights = section.dominantRhythm === "climb" || section.dominantRhythm === "descent"
    ? config.directionalWeights
    : config.neutralWeights;
  const rawScore = distanceShare * weights.distance + routeWeightedVerticalShare * weights.vertical + normalizedIntensity * weights.intensity;
  const localSections = [previous, section, next].filter((item): item is RouteSection => Boolean(item));
  const localDistanceKm = localSections.reduce((sum, item) => sum + item.distanceKm, 0);
  const localVerticalM = localSections.reduce((sum, item) => sum + item.ascentM + item.descentM, 0);
  const localIntensity = localDistanceKm > 0 ? localVerticalM / localDistanceKm : 0;
  const localDistanceShare = localDistanceKm > 0 ? section.distanceKm / localDistanceKm : 0;
  const localDirectionalTotalM = section.dominantRhythm === "climb"
    ? localSections.reduce((sum, item) => sum + item.ascentM, 0)
    : section.dominantRhythm === "descent"
      ? localSections.reduce((sum, item) => sum + item.descentM, 0)
      : localVerticalM;
  const localVerticalShare = localDirectionalTotalM > 0 ? directionalVerticalM / localDirectionalTotalM : 0;
  const localDirectionShare = localVerticalM > 0 ? localDirectionalTotalM / localVerticalM : 0;
  const localIntensityRatio = localIntensity > 0 ? verticalIntensityMPerKm / localIntensity : 0;
  const localScore = localDistanceShare * weights.distance + localVerticalShare * localDirectionShare * weights.vertical +
    (localIntensityRatio / (1 + localIntensityRatio)) * weights.intensity;
  const stability = Math.min(1, Math.max(0, section.dynamicsSummary.stability));
  const blendedScore = rawScore * (1 - config.localContextWeight) + localScore * config.localContextWeight;
  const significanceScore = blendedScore * (config.stabilityFloor + config.stabilityWeight * stability);
  return {
    sectionId: section.id,
    startKm: section.startKm,
    endKm: section.endKm,
    rhythm: section.dominantRhythm,
    distanceKm: section.distanceKm,
    ascentM: section.ascentM,
    descentM: section.descentM,
    distanceShare: round3(distanceShare),
    verticalShare: round3(verticalShare),
    verticalIntensityMPerKm: round1(verticalIntensityMPerKm),
    verticalIntensityRatio: round2(intensityRatio),
    significanceScore: round3(significanceScore),
  };
}

function isSectionSignificant(section: RouteSection, diagnostic: Omit<RunnerSectionDecision, "decision" | "mergeTarget" | "reason">, config: RunnerSectionSignificanceConfig) {
  if (diagnostic.significanceScore >= config.minimumScore) return true;
  const directionStrength = section.dynamicsSummary.directionStrength;
  if ((section.dominantRhythm === "climb" || section.dominantRhythm === "descent") &&
    diagnostic.verticalIntensityRatio >= config.intensityRatioKeepThreshold &&
    directionStrength >= config.minimumDirectionalStrength &&
    section.dynamicsSummary.stability >= config.intenseSectionMinimumStability) return true;
  if ((section.dominantRhythm === "climb" || section.dominantRhythm === "descent") &&
    diagnostic.distanceShare >= config.minimumDirectionalDistanceShare &&
    diagnostic.verticalShare >= config.minimumDirectionalVerticalShare &&
    directionStrength >= config.minimumDirectionalStrength &&
    section.dynamicsSummary.stability >= config.intenseSectionMinimumStability) return true;
  return (section.dominantRhythm === "flat" || section.dominantRhythm === "rolling") &&
    diagnostic.distanceShare >= config.neutralMinimumDistanceShare &&
    diagnostic.significanceScore >= config.neutralMinimumScore &&
    section.dynamicsSummary.stability >= config.intenseSectionMinimumStability;
}

function significanceReason(section: RouteSection, diagnostic: Omit<RunnerSectionDecision, "decision" | "mergeTarget" | "reason">, config: RunnerSectionSignificanceConfig) {
  if (diagnostic.significanceScore >= config.minimumScore) return `Relative score ${diagnostic.significanceScore.toFixed(3)} meets the ${config.minimumScore.toFixed(2)} threshold.`;
  if ((section.dominantRhythm === "climb" || section.dominantRhythm === "descent") &&
    diagnostic.verticalIntensityRatio >= config.intensityRatioKeepThreshold &&
    section.dynamicsSummary.directionStrength >= config.minimumDirectionalStrength &&
    section.dynamicsSummary.stability >= config.intenseSectionMinimumStability) return "High relative vertical intensity and directional stability preserve this phase.";
  if ((section.dominantRhythm === "climb" || section.dominantRhythm === "descent") &&
    diagnostic.distanceShare >= config.minimumDirectionalDistanceShare &&
    diagnostic.verticalShare >= config.minimumDirectionalVerticalShare &&
    section.dynamicsSummary.directionStrength >= config.minimumDirectionalStrength &&
    section.dynamicsSummary.stability >= config.intenseSectionMinimumStability) return "Its distance and vertical contributions are both meaningful within this route.";
  if (diagnostic.distanceShare >= config.neutralMinimumDistanceShare && diagnostic.significanceScore >= config.neutralMinimumScore) return "Its stable distance share and combined evidence score make the neutral phase substantial enough to stand alone.";
  return "Retained as a runner-facing phase.";
}

function chooseMergeTarget(candidate: RouteSection, previous: RouteSection | undefined, next: RouteSection | undefined, config: RunnerSectionSignificanceConfig) {
  if (!previous) return next ? { side: "next" as const, reason: mergeAffinityReason(candidate, next, previous, next) } : null;
  if (!next) return { side: "previous" as const, reason: mergeAffinityReason(candidate, previous, previous, next) };
  const previousAffinity = mergeAffinity(candidate, previous, previous, next, config);
  const nextAffinity = mergeAffinity(candidate, next, previous, next, config);
  return previousAffinity >= nextAffinity
    ? { side: "previous" as const, reason: mergeAffinityReason(candidate, previous, previous, next) }
    : { side: "next" as const, reason: mergeAffinityReason(candidate, next, previous, next) };
}

function mergeAffinity(candidate: RouteSection, target: RouteSection, previous: RouteSection | undefined, next: RouteSection | undefined, config: RunnerSectionSignificanceConfig) {
  const weights = config.mergeAffinityWeights;
  const sameRhythm = candidate.dominantRhythm === target.dominantRhythm ? weights.sameRhythm : 0;
  const matchingFlanks = previous && next && previous.dominantRhythm === next.dominantRhythm && target.dominantRhythm === previous.dominantRhythm ? weights.matchingFlanks : 0;
  const candidateDirection = candidate.ascentM - candidate.descentM;
  const targetDirection = target.ascentM - target.descentM;
  const directionContinuity = candidateDirection === 0 || targetDirection === 0 ? 0
    : Math.sign(candidateDirection) === Math.sign(targetDirection) ? weights.sameDirection : weights.oppositeDirection;
  const combinedDistance = candidate.distanceKm + target.distanceKm;
  const relativeSize = combinedDistance > 0 ? target.distanceKm / combinedDistance * weights.relativeNeighborSize : 0;
  return sameRhythm + matchingFlanks + directionContinuity + relativeSize;
}

function mergeAffinityReason(candidate: RouteSection, target: RouteSection, previous?: RouteSection, next?: RouteSection) {
  if (previous && next && previous.dominantRhythm === next.dominantRhythm && target.dominantRhythm === previous.dominantRhythm) return `Both flanks share ${target.dominantRhythm}; the candidate is an interruption in that larger rhythm`;
  if (candidate.dominantRhythm === target.dominantRhythm) return `The candidate and neighbor share ${target.dominantRhythm} rhythm`;
  const candidateDirection = candidate.ascentM - candidate.descentM;
  const targetDirection = target.ascentM - target.descentM;
  return candidateDirection !== 0 && Math.sign(candidateDirection) === Math.sign(targetDirection)
    ? `Elevation direction is more continuous with the ${target.dominantRhythm} neighbor`
    : `Merging into the longer adjacent ${target.dominantRhythm} phase gives the more coherent runner-facing section`;
}

function canPreserveDominantRhythm(sections: readonly RouteSection[], rhythm: RouteDominantRhythm, config: RunnerSectionSignificanceConfig) {
  const ascentM = sections.reduce((sum, section) => sum + section.ascentM, 0);
  const descentM = sections.reduce((sum, section) => sum + section.descentM, 0);
  const distanceKm = sections.reduce((sum, section) => sum + section.distanceKm, 0);
  const vertical = ascentM + descentM;
  if (rhythm === "climb") return ascentM > descentM && (ascentM - descentM) / Math.max(1, vertical) >= config.bridgeMinimumDirectionStrength;
  if (rhythm === "descent") return descentM > ascentM && (descentM - ascentM) / Math.max(1, vertical) >= config.bridgeMinimumDirectionStrength;
  if (rhythm === "flat") return distanceKm > 0 && vertical / distanceKm <= config.bridgeFlatMaximumIntensityMPerKm;
  return true;
}

function mergeSections(sections: readonly RouteSection[], rhythm: RouteDominantRhythm, absorbed: RouteSection, significance: number, additionalAbsorbedEvents: readonly RouteEmbeddedEvent[] = []): RouteSection {
  const sorted = [...sections].sort((left, right) => left.startKm - right.startKm);
  const first = sorted[0];
  const last = sorted.at(-1)!;
  const profile = uniqueByDistance(sorted.flatMap((section) => section.elevationProfile));
  const mapData = uniqueByDistance(sorted.flatMap((section) => section.mapData ?? []));
  const sectionEvents = uniqueEvents([
    ...sorted.flatMap((section) => section.embeddedEvents),
    makeAbsorbedEvent(absorbed, significance),
    ...additionalAbsorbedEvents,
  ]);
  const distanceKm = roundKm(last.endKm - first.startKm);
  const ascentM = sorted.reduce((sum, section) => sum + section.ascentM, 0);
  const descentM = sorted.reduce((sum, section) => sum + section.descentM, 0);
  const vertical = ascentM + descentM;
  const embeddedEvents = sectionEvents.map((event) => {
    if (event.id.startsWith("absorbed-")) return event;
    const eventVertical = event.ascentM + event.descentM;
    return {
      ...event,
      significance: round3(relativeSignificance(
        event.distanceKm,
        Math.max(0, distanceKm - event.distanceKm),
        eventVertical,
        Math.max(0, vertical - eventVertical),
      )),
    };
  }).sort((left, right) => right.significance - left.significance || right.ascentM + right.descentM - left.ascentM - left.descentM);
  const weightedStability = sorted.reduce((sum, section) => sum + section.dynamicsSummary.stability * section.distanceKm, 0) / Math.max(0.1, sorted.reduce((sum, section) => sum + section.distanceKm, 0));
  return {
    ...first,
    startKm: first.startKm,
    endKm: last.endKm,
    distanceKm,
    dominantRhythm: rhythm,
    elevationStartM: first.elevationStartM,
    elevationEndM: last.elevationEndM,
    elevationMinM: Math.min(...sorted.map((section) => section.elevationMinM)),
    elevationMaxM: Math.max(...sorted.map((section) => section.elevationMaxM)),
    ascentM,
    descentM,
    elevationProfile: profile,
    embeddedEvents,
    dynamicsSummary: {
      verticalIntensityMPerKm: round1(vertical / Math.max(0.1, distanceKm)),
      directionBalance: round2(vertical > 0 ? (ascentM - descentM) / vertical : 0),
      directionStrength: round2(vertical > 0 ? Math.abs(ascentM - descentM) / vertical : 0),
      stability: round2(weightedStability),
    },
    description: describeSection(rhythm, embeddedEvents),
    mapData: mapData.length ? mapData : undefined,
  };
}

function makeAbsorbedEvent(section: RouteSection, significance: number): RouteEmbeddedEvent {
  return {
    id: `absorbed-${section.id}`,
    rhythm: section.dominantRhythm,
    startKm: section.startKm,
    endKm: section.endKm,
    distanceKm: section.distanceKm,
    ascentM: section.ascentM,
    descentM: section.descentM,
    significance: round3(significance),
  };
}

function uniqueByDistance<T extends { distanceM: number }>(points: readonly T[]) {
  return [...new Map(points.map((point) => [point.distanceM, point])).values()].sort((a, b) => a.distanceM - b.distanceM);
}

function uniqueEvents(events: readonly RouteEmbeddedEvent[]) {
  return [...new Map(events.map((event) => [`${event.startKm}-${event.endKm}-${event.rhythm}`, event])).values()]
    .sort((a, b) => b.significance - a.significance || a.startKm - b.startKm);
}

export function createInitialPhases(dynamics: RouteDynamicsResult, config: RouteDynamicsConfig = DEFAULT_ROUTE_DYNAMICS_CONFIG): Phase[] {
  const phases: Phase[] = [];
  dynamics.samples.forEach((sample, index) => {
    const rhythm = sample.rhythm;
    const previous = phases.at(-1);
    if (previous?.rhythm === rhythm) previous.endIndex = index;
    else phases.push({ rhythm, startIndex: index, endIndex: index });
  });
  return phases.map((phase, index) => {
    if (phase.rhythm !== "transition") return phase;
    const before = phases[index - 1];
    const after = phases[index + 1];
    if (before?.rhythm === after?.rhythm) return { ...phase, rhythm: before.rhythm };
    if (phaseLengthKm(phase, dynamics) < config.minimumConfirmedPhaseKm) {
      const selected = (before && after)
        ? phaseLengthKm(before, dynamics) >= phaseLengthKm(after, dynamics) ? before : after
        : before ?? after;
      if (selected) return { ...phase, rhythm: selected.rhythm };
    }
    const medium = dynamics.samples[Math.floor((phase.startIndex + phase.endIndex) / 2)].medium.rhythm;
    return { ...phase, rhythm: medium === "transition" ? before?.rhythm ?? after?.rhythm ?? "flat" : medium };
  });
}

/** Explicit cleanup pass: absorb brief, low-significance phases and combine compatible neighbors. */
export function mergeRoutePhases(
  input: Phase[],
  dynamics: RouteDynamicsResult,
  config: RouteDynamicsConfig = DEFAULT_ROUTE_DYNAMICS_CONFIG,
): Phase[] {
  const phases: Phase[] = [];
  for (const phase of input) {
    const previous = phases.at(-1);
    if (previous?.rhythm === phase.rhythm) previous.endIndex = phase.endIndex;
    else phases.push({ ...phase });
  }
  const resolvedRhythms = phases.map((phase, index) => {
    const previous = phases[index - 1];
    const next = phases[index + 1];
    if (phase.rhythm === "transition") return chooseNeighbor(phase, previous, next, dynamics)?.rhythm ?? "flat";
    const significance = phaseSignificance(phase, previous, next, dynamics);
    if (phaseLengthKm(phase, dynamics) < config.minimumSectionPersistenceKm) {
      return chooseNeighbor(phase, previous, next, dynamics)?.rhythm ?? phase.rhythm;
    }
    const confirmedDirectional = isConfirmedDirectionalPhase(phase, dynamics, config);
    if (previous && next && previous.rhythm === next.rhythm && previous.rhythm !== phase.rhythm &&
      significance < config.minimumRelativeSignificance && !confirmedDirectional) {
      return previous.rhythm;
    }
    if (phaseLengthKm(phase, dynamics) < config.minimumConfirmedPhaseKm &&
      (significance < config.minimumRelativeSignificance || phaseStability(phase, dynamics) < config.minimumPhaseStability)) {
      return chooseNeighbor(phase, previous, next, dynamics)?.rhythm ?? phase.rhythm;
    }
    return phase.rhythm;
  });
  const reconciledRhythms = resolvedRhythms.map((rhythm, index) =>
    normalizePhaseRhythm({ ...phases[index], rhythm }, dynamics, config).rhythm,
  );
  let merged: Phase[] = [];
  phases.forEach((phase, index) => {
    const rhythm = reconciledRhythms[index];
    const previous = merged.at(-1);
    if (previous?.rhythm === rhythm) previous.endIndex = phase.endIndex;
    else merged.push({ ...phase, rhythm });
  });
  let pruned = true;
  while (pruned && merged.length > 1) {
    pruned = false;
    for (let index = 0; index < merged.length; index += 1) {
      const phase = merged[index];
      if (phaseLengthKm(phase, dynamics) >= config.minimumSectionPersistenceKm) continue;
      const target = chooseNeighbor(phase, merged[index - 1], merged[index + 1], dynamics);
      if (!target) continue;
      phase.rhythm = target.rhythm;
      const compacted: Phase[] = [];
      for (const item of merged) {
        const previous = compacted.at(-1);
        if (previous?.rhythm === item.rhythm) previous.endIndex = item.endIndex;
        else compacted.push({ ...item });
      }
      merged = compacted;
      pruned = true;
      break;
    }
  }
  return merged;
}

/** Consolidate analytical phases into larger, runner-meaningful Route Sections. */
export function consolidateRoutePhases(
  input: Phase[],
  dynamics: RouteDynamicsResult,
  config: RouteDynamicsConfig = DEFAULT_ROUTE_DYNAMICS_CONFIG,
): Phase[] {
  const phases = coalescePhases(input);
  let changed = true;
  while (changed && phases.length > 1) {
    changed = false;
    for (let index = 1; index < phases.length - 1; index += 1) {
      const candidate = phases[index];
      const previous = phases[index - 1];
      const next = phases[index + 1];
      const significance = phaseSignificance(candidate, previous, next, dynamics);
      if (isRunnerMeaningfulPhase(candidate, previous, next, significance, dynamics, config)) continue;

      const sameDominantFlanks = previous.rhythm === next.rhythm;
      const shortBridge = phaseLengthKm(candidate, dynamics) < config.minimumConfirmedPhaseKm;
      if (!sameDominantFlanks && !(shortBridge && significance < config.minimumRelativeSignificance)) continue;
      if (!sameDominantFlanks && significance >= config.minimumRelativeSignificance) continue;

      if (sameDominantFlanks) {
        if (!combinedWindowKeepsRhythm(previous, next, previous.rhythm, dynamics, config)) continue;
        previous.endIndex = next.endIndex;
        phases.splice(index, 2);
      } else {
        const target = chooseNeighbor(candidate, previous, next, dynamics);
        if (!target) continue;
        const targetStart = target === previous ? previous : candidate;
        const targetEnd = target === previous ? candidate : next;
        if (!combinedWindowKeepsRhythm(targetStart, targetEnd, target.rhythm, dynamics, config)) continue;
        if (target === previous) previous.endIndex = candidate.endIndex;
        else next.startIndex = candidate.startIndex;
        phases.splice(index, 1);
      }
      const compacted = coalescePhases(phases);
      phases.splice(0, phases.length, ...compacted);
      changed = true;
      break;
    }
  }
  return phases;
}

function coalescePhases(input: Phase[]) {
  const phases: Phase[] = [];
  for (const phase of input) {
    const previous = phases.at(-1);
    if (previous?.rhythm === phase.rhythm) previous.endIndex = phase.endIndex;
    else phases.push({ ...phase });
  }
  return phases;
}

function isRunnerMeaningfulPhase(
  phase: Phase,
  previous: Phase,
  next: Phase,
  significance: number,
  dynamics: RouteDynamicsResult,
  config: RouteDynamicsConfig,
) {
  if (significance >= config.minimumRelativeSignificance) return true;
  const lengthKm = phaseLengthKm(phase, dynamics);
  if (lengthKm < config.minimumConfirmedPhaseKm || phaseStability(phase, dynamics) < config.minimumPhaseStability) return false;

  const candidate = phaseSummary(phase, dynamics);
  const surrounding = phaseSummary(previous, dynamics);
  const after = phaseSummary(next, dynamics);
  const contextDistance = candidate.distanceKm + surrounding.distanceKm + after.distanceKm;
  const candidateVertical = candidate.ascentM + candidate.descentM;
  const contextVertical = candidateVertical + surrounding.ascentM + surrounding.descentM + after.ascentM + after.descentM;
  const distanceShare = contextDistance > 0 ? candidate.distanceKm / contextDistance : 0;
  const verticalShare = contextVertical > 0 ? candidateVertical / contextVertical : 0;

  if (phase.rhythm === "rolling") {
    return distanceShare >= config.minimumRelativeSignificance && hasRepeatedDirectionChanges(phase, dynamics, config);
  }
  if (phase.rhythm !== "climb" && phase.rhythm !== "descent") return false;
  const directionStrength = candidateVertical === 0 ? 0 : Math.abs(candidate.ascentM - candidate.descentM) / candidateVertical;
  const intensity = candidate.distanceKm > 0 ? candidateVertical / candidate.distanceKm : 0;
  return (distanceShare >= config.minimumRelativeSignificance || verticalShare >= MINIMUM_RELATIVE_VERTICAL_CONTRIBUTION) &&
    directionStrength >= config.minimumDirectionStrength &&
    intensity >= config.minimumDirectionalIntensityMPerKm;
}

function hasRepeatedDirectionChanges(phase: Phase, dynamics: RouteDynamicsResult, config: RouteDynamicsConfig) {
  const points = dynamics.resampledPoints.filter((point) =>
    point.distanceM >= dynamics.samples[phase.startIndex].distanceM &&
    point.distanceM <= dynamics.samples[phase.endIndex].distanceM,
  );
  let previousDirection = 0;
  let changes = 0;
  for (let index = 1; index < points.length; index += 1) {
    const delta = points[index].smoothedElevationM - points[index - 1].smoothedElevationM;
    const direction = delta >= config.meaningfulElevationStepM ? 1 : delta <= -config.meaningfulElevationStepM ? -1 : 0;
    if (direction && previousDirection && direction !== previousDirection) changes += 1;
    if (direction) previousDirection = direction;
  }
  return changes >= config.rollingMinimumDirectionChanges;
}

function combinedWindowKeepsRhythm(startPhase: Phase, endPhase: Phase, rhythm: RouteRhythm, dynamics: RouteDynamicsResult, config: RouteDynamicsConfig) {
  const combined: Phase = { rhythm, startIndex: startPhase.startIndex, endIndex: endPhase.endIndex };
  const { distanceKm, ascentM, descentM } = phaseSummary(combined, dynamics);
  const verticalM = ascentM + descentM;
  const intensityMPerKm = distanceKm > 0 ? verticalM / distanceKm : 0;
  const directionStrength = verticalM > 0 ? Math.abs(ascentM - descentM) / verticalM : 0;
  switch (rhythm) {
    case "climb":
      return ascentM > descentM && intensityMPerKm >= config.minimumDirectionalIntensityMPerKm && directionStrength >= config.minimumDirectionStrength;
    case "descent":
      return descentM > ascentM && intensityMPerKm >= config.minimumDirectionalIntensityMPerKm && directionStrength >= config.minimumDirectionStrength;
    case "rolling":
      return intensityMPerKm >= config.rollingMinimumIntensityMPerKm &&
        directionStrength <= config.rollingMaximumDirectionStrength &&
        ascentM / Math.max(1, verticalM) >= config.rollingMinimumContributionShare &&
        descentM / Math.max(1, verticalM) >= config.rollingMinimumContributionShare &&
        hasRepeatedDirectionChanges(combined, dynamics, config);
    case "flat":
      return intensityMPerKm <= config.flatMaximumIntensityMPerKm;
    case "transition":
      return false;
  }
}

/** Reconcile locally detected rolling phases with their whole-phase elevation profile. */
function normalizePhaseRhythm(phase: Phase, dynamics: RouteDynamicsResult, config: RouteDynamicsConfig): Phase {
  if (phase.rhythm !== "rolling") return phase;
  const { distanceKm, ascentM, descentM } = phaseSummary(phase, dynamics);
  if (distanceKm <= 0) return phase;
  const verticalM = ascentM + descentM;
  const intensityMPerKm = verticalM / distanceKm;
  const directionStrength = verticalM === 0 ? 0 : Math.abs(ascentM - descentM) / verticalM;
  if (intensityMPerKm <= config.flatMaximumIntensityMPerKm) return { ...phase, rhythm: "flat" };
  if (intensityMPerKm >= config.minimumDirectionalIntensityMPerKm && directionStrength > config.rollingMaximumDirectionStrength) {
    return { ...phase, rhythm: ascentM >= descentM ? "climb" : "descent" };
  }
  return phase;
}

function isConfirmedDirectionalPhase(phase: Phase, dynamics: RouteDynamicsResult, config: RouteDynamicsConfig) {
  if (phase.rhythm !== "climb" && phase.rhythm !== "descent") return false;
  const { distanceKm, ascentM, descentM } = phaseSummary(phase, dynamics);
  const verticalM = ascentM + descentM;
  const directionStrength = verticalM === 0 ? 0 : Math.abs(ascentM - descentM) / verticalM;
  const intensityMPerKm = distanceKm > 0 ? verticalM / distanceKm : 0;
  return distanceKm >= config.minimumConfirmedPhaseKm &&
    directionStrength >= config.minimumDirectionStrength &&
    intensityMPerKm >= config.minimumDirectionalIntensityMPerKm &&
    phaseStability(phase, dynamics) >= config.minimumPhaseStability;
}

function chooseNeighbor(phase: Phase, previous: Phase | undefined, next: Phase | undefined, dynamics: RouteDynamicsResult) {
  if (previous && next && previous.rhythm === next.rhythm) return previous;
  if (!previous) return next;
  if (!next) return previous;
  return phaseStrength(previous, dynamics) >= phaseStrength(next, dynamics) ? previous : next;
}

function phaseSignificance(phase: Phase, previous: Phase | undefined, next: Phase | undefined, dynamics: RouteDynamicsResult) {
  const phaseStats = phaseSummary(phase, dynamics);
  const neighbors = [previous, next].filter((value): value is Phase => Boolean(value));
  const contextDistanceKm = neighbors.reduce((sum, neighbor) => sum + phaseLengthKm(neighbor, dynamics), 0);
  const contextVertical = neighbors.reduce((sum, neighbor) => sum + phaseSummary(neighbor, dynamics).ascentM + phaseSummary(neighbor, dynamics).descentM, 0);
  return relativeSignificance(phaseStats.distanceKm, contextDistanceKm, phaseStats.ascentM + phaseStats.descentM, contextVertical);
}

function phaseStrength(phase: Phase, dynamics: RouteDynamicsResult) {
  const samples = dynamics.samples.slice(phase.startIndex, phase.endIndex + 1);
  return samples.reduce((sum, sample) => sum + sample.medium.verticalIntensityMPerKm * sample.medium.directionStrength, 0) / Math.max(1, samples.length);
}

function phaseStability(phase: Phase, dynamics: RouteDynamicsResult) {
  const samples = dynamics.samples.slice(phase.startIndex, phase.endIndex + 1);
  return samples.reduce((sum, sample) => sum + sample.stability, 0) / Math.max(1, samples.length);
}

function phaseLengthKm(phase: Phase, dynamics: RouteDynamicsResult) {
  const start = dynamics.samples[phase.startIndex]?.distanceM ?? 0;
  const end = dynamics.samples[phase.endIndex]?.distanceM ?? start;
  return Math.max(0, (end - start) / 1000);
}

function createSection(
  phase: Phase,
  index: number,
  dynamics: RouteDynamicsResult,
  routePoints: readonly GpxRoutePointData[],
): RouteSection {
  const startM = phase.startIndex === 0
    ? 0
    : (dynamics.samples[phase.startIndex - 1].distanceM + dynamics.samples[phase.startIndex].distanceM) / 2;
  const endM = phase.endIndex === dynamics.samples.length - 1
    ? dynamics.totalDistanceKm * 1000
    : (dynamics.samples[phase.endIndex].distanceM + dynamics.samples[phase.endIndex + 1].distanceM) / 2;
  const route = dynamics.resampledPoints.filter((point) => point.distanceM >= startM && point.distanceM <= endM);
  const elevations = route.map((point) => point.smoothedElevationM);
  let ascentM = 0;
  let descentM = 0;
  for (let pointIndex = 1; pointIndex < route.length; pointIndex += 1) {
    const delta = route[pointIndex].smoothedElevationM - route[pointIndex - 1].smoothedElevationM;
    if (delta > 0) ascentM += delta;
    else descentM += Math.abs(delta);
  }
  const distanceKm = Math.max(0, (endM - startM) / 1000);
  const samples = dynamics.samples.slice(phase.startIndex, phase.endIndex + 1);
  const verticalIntensityMPerKm = average(samples.map((sample) => sample.medium.verticalIntensityMPerKm));
  const directionBalance = average(samples.map((sample) => sample.medium.directionBalance));
  const stability = average(samples.map((sample) => sample.stability));
  const sectionVerticalM = ascentM + descentM;
  const embeddedEvents = dynamics.events
    .filter((event) => event.startKm * 1000 >= startM && event.endKm * 1000 <= endM && event.rhythm !== phase.rhythm)
    .map(({ id, rhythm, startKm: eventStartKm, endKm: eventEndKm, ascentM: gain, descentM: loss }) => {
      const eventDistanceKm = roundKm(Math.max(0, eventEndKm - eventStartKm));
      const eventVerticalM = gain + loss;
      const significance = relativeSignificance(
        eventDistanceKm,
        Math.max(0, distanceKm - eventDistanceKm),
        eventVerticalM,
        Math.max(0, sectionVerticalM - eventVerticalM),
      );
      return {
        id, rhythm, startKm: eventStartKm, endKm: eventEndKm, distanceKm: eventDistanceKm, ascentM: gain, descentM: loss,
        significance: round2(significance),
      };
    });
  const startKm = roundKm(startM / 1000);
  const endKm = roundKm(endM / 1000);
  return {
    id: `route-section-${index + 1}`,
    startKm,
    endKm,
    distanceKm: roundKm(distanceKm),
    dominantRhythm: phase.rhythm as RouteDominantRhythm,
    elevationStartM: Math.round(route[0]?.smoothedElevationM ?? 0),
    elevationEndM: Math.round(route.at(-1)?.smoothedElevationM ?? 0),
    elevationMinM: Math.round(Math.min(...elevations)),
    elevationMaxM: Math.round(Math.max(...elevations)),
    ascentM: Math.round(ascentM),
    descentM: Math.round(descentM),
    elevationProfile: route.map((point) => ({ distanceM: point.distanceM, elevationM: point.smoothedElevationM })),
    embeddedEvents,
    dynamicsSummary: {
      verticalIntensityMPerKm: round1(verticalIntensityMPerKm),
      directionBalance: round2(directionBalance),
      directionStrength: round2(Math.abs(directionBalance)),
      stability: round2(stability),
    },
    description: describeSection(phase.rhythm as RouteDominantRhythm, embeddedEvents),
    mapData: routePoints.filter((point) => point.distanceM >= startM && point.distanceM <= endM)
      .map(({ latitude, longitude, elevationM, distanceM }) => ({ latitude, longitude, elevationM, distanceM })),
  };
}

function phaseSummary(phase: Phase, dynamics: RouteDynamicsResult) {
  const distanceKm = phaseLengthKm(phase, dynamics);
  const startM = dynamics.samples[phase.startIndex].distanceM;
  const endM = dynamics.samples[phase.endIndex].distanceM;
  const points = dynamics.resampledPoints.filter((point) => point.distanceM >= startM && point.distanceM <= endM);
  let ascentM = 0;
  let descentM = 0;
  for (let index = 1; index < points.length; index += 1) {
    const change = points[index].smoothedElevationM - points[index - 1].smoothedElevationM;
    if (change > 0) ascentM += change;
    else descentM += Math.abs(change);
  }
  return { distanceKm, ascentM, descentM };
}

function describeSection(rhythm: RouteDominantRhythm, events: RouteEmbeddedEvent[]) {
  const base: Record<RouteDominantRhythm, string> = {
    climb: "Predominantly climbing section",
    descent: "Predominantly descending section",
    rolling: "Rolling terrain with repeated climbs and descents",
    flat: "Relatively flat section with limited vertical movement",
  };
  const notable = [...events]
    .sort((left, right) => right.significance - left.significance || right.ascentM + right.descentM - left.ascentM - left.descentM)
    .slice(0, 2);
  if (!notable.length) return base[rhythm];
  const details = notable.map((event) => {
    const direction = event.rhythm === "climb" ? `+${event.ascentM} m climb`
      : event.rhythm === "descent" ? `−${event.descentM} m descent`
        : event.rhythm === "flat" ? "flat interruption" : "rolling interruption";
    return `${direction} from km ${event.startKm}–${event.endKm}`;
  });
  const remainingCount = events.length - notable.length;
  const additional = remainingCount > 0 ? `, plus ${remainingCount} shorter change${remainingCount === 1 ? "" : "s"}` : "";
  return `${base[rhythm]} with ${details.join(" and ")}${additional}.`;
}

function average(values: number[]) { return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0; }
function roundKm(value: number) { return Number(value.toFixed(2)); }
function round1(value: number) { return Number(value.toFixed(1)); }
function round2(value: number) { return Number(value.toFixed(2)); }
function round3(value: number) { return Number(value.toFixed(3)); }
