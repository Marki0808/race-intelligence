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
>;

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
  terrainEvidence?: RouteSectionTerrainEvidence[];
  mapillaryEvidence?: RouteSectionMapillaryEvidence;
  mapData?: RouteSectionMapPoint[];
};

export type RouteSectionTerrainEvidence = {
  terrain: string;
  coveragePercent: number;
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
  if (dynamics.samples.length === 0) return [];
  const analyticalPhases = mergeRoutePhases(createInitialPhases(dynamics, config), dynamics, config);
  const phases = consolidateRoutePhases(analyticalPhases, dynamics, config);
  return phases.flatMap((phase, index) => {
    if (phase.rhythm === "transition") return [];
    return [createSection(phase, index, dynamics, routePoints)];
  });
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
      const eventDistanceKm = Math.max(0, eventEndKm - eventStartKm);
      const eventVerticalM = gain + loss;
      const significance = relativeSignificance(
        eventDistanceKm,
        Math.max(0, distanceKm - eventDistanceKm),
        eventVerticalM,
        Math.max(0, sectionVerticalM - eventVerticalM),
      );
      return {
        id, rhythm, startKm: eventStartKm, endKm: eventEndKm, ascentM: gain, descentM: loss,
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
  const opposite = events.filter((event) => (rhythm === "climb" && event.rhythm === "descent") || (rhythm === "descent" && event.rhythm === "climb"));
  if (!opposite.length) return base[rhythm];
  const minor = opposite.filter((event) => event.significance < DEFAULT_ROUTE_DYNAMICS_CONFIG.minimumRelativeSignificance);
  if (minor.length === opposite.length && minor.length === 1) {
    const event = minor[0];
    return `${base[rhythm]} with a short ${event.rhythm} interruption around ${event.startKm}–${event.endKm} km.`;
  }
  return `${base[rhythm]} with ${opposite.length} embedded ${opposite.length === 1 ? "counter-rhythm phase" : "counter-rhythm phases"}.`;
}

function average(values: number[]) { return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0; }
function roundKm(value: number) { return Number(value.toFixed(2)); }
function round1(value: number) { return Number(value.toFixed(1)); }
function round2(value: number) { return Number(value.toFixed(2)); }
