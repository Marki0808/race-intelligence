import type { GpxRoutePointData } from "./gpxAnalysis";

export type RouteRhythm = "climb" | "descent" | "rolling" | "flat" | "transition";
export type RouteDominantRhythm = Exclude<RouteRhythm, "transition">;

export type RouteDynamicsConfig = {
  resampleIntervalM: number;
  medianFilterRadiusM: number;
  movingAverageRadiusM: number;
  trendScalesM: readonly [number, number, number];
  minimumDirectionalIntensityMPerKm: number;
  minimumDirectionStrength: number;
  flatMaximumIntensityMPerKm: number;
  rollingMinimumIntensityMPerKm: number;
  rollingMaximumDirectionStrength: number;
  rollingMinimumDirectionChanges: number;
  rollingMinimumContributionShare: number;
  meaningfulElevationStepM: number;
  minimumMicroEventDistanceKm: number;
  minimumSectionPersistenceKm: number;
  minimumConfirmedPhaseKm: number;
  minimumPhaseStability: number;
  minimumRelativeSignificance: number;
};

export const DEFAULT_ROUTE_DYNAMICS_CONFIG: RouteDynamicsConfig = {
  resampleIntervalM: 100,
  medianFilterRadiusM: 150,
  movingAverageRadiusM: 250,
  trendScalesM: [500, 1500, 3000],
  minimumDirectionalIntensityMPerKm: 18,
  minimumDirectionStrength: 0.32,
  flatMaximumIntensityMPerKm: 12,
  rollingMinimumIntensityMPerKm: 24,
  rollingMaximumDirectionStrength: 0.55,
  rollingMinimumDirectionChanges: 2,
  rollingMinimumContributionShare: 0.2,
  meaningfulElevationStepM: 1.2,
  minimumMicroEventDistanceKm: 0.2,
  minimumSectionPersistenceKm: 0.5,
  minimumConfirmedPhaseKm: 0.9,
  minimumPhaseStability: 0.58,
  minimumRelativeSignificance: 0.32,
};

export type ResampledRoutePoint = {
  distanceM: number;
  segmentIndex: number;
  elevationM: number;
  smoothedElevationM: number;
};

export type RouteTrendMetrics = {
  scaleM: number;
  startDistanceM: number;
  endDistanceM: number;
  startElevationM: number;
  endElevationM: number;
  ascentM: number;
  descentM: number;
  netElevationM: number;
  gradientPct: number;
  verticalIntensityMPerKm: number;
  directionBalance: number;
  directionStrength: number;
  directionChanges: number;
  rhythm: RouteRhythm;
};

export type RouteDynamicSample = {
  distanceM: number;
  segmentIndex: number;
  elevationM: number;
  smoothedElevationM: number;
  short: RouteTrendMetrics;
  medium: RouteTrendMetrics;
  long: RouteTrendMetrics;
  rhythm: RouteRhythm;
  stability: number;
};

export type RouteDynamicEvent = {
  id: string;
  segmentIndex: number;
  startKm: number;
  endKm: number;
  startPosition: { distanceM: number; segmentIndex: number };
  endPosition: { distanceM: number; segmentIndex: number };
  rhythm: RouteRhythm;
  ascentM: number;
  descentM: number;
  netElevationM: number;
  gradientPct: number;
  verticalIntensity: number;
  directionBalance: number;
  directionStrength: number;
  persistence: number;
  significance: number;
  confidence: number;
};

export type RouteDynamicsResult = {
  totalDistanceKm: number;
  resampledPoints: ResampledRoutePoint[];
  samples: RouteDynamicSample[];
  events: RouteDynamicEvent[];
};

export function analyzeRouteDynamics(
  points: readonly GpxRoutePointData[],
  config: RouteDynamicsConfig = DEFAULT_ROUTE_DYNAMICS_CONFIG,
): RouteDynamicsResult {
  if (points.length < 2 || config.resampleIntervalM <= 0) {
    return { totalDistanceKm: 0, resampledPoints: [], samples: [], events: [] };
  }
  const groups = new Map<number, GpxRoutePointData[]>();
  for (const point of points) {
    const group = groups.get(point.segmentIndex ?? 0) ?? [];
    group.push(point);
    groups.set(point.segmentIndex ?? 0, group);
  }
  const combined: RouteDynamicsResult = { totalDistanceKm: points.at(-1)!.distanceM / 1000, resampledPoints: [], samples: [], events: [] };
  for (const [segmentIndex, segmentPoints] of groups) {
    if (segmentPoints.length < 2) continue;
    const offsetM = segmentPoints[0].distanceM;
    const localPoints = segmentPoints.map((point) => ({ ...point, distanceM: point.distanceM - offsetM }));
    const segmentResult = analyzeSingleSegment(localPoints, config);
    combined.resampledPoints.push(...segmentResult.resampledPoints.map((point) => ({ ...point, distanceM: point.distanceM + offsetM, segmentIndex })));
    combined.samples.push(...segmentResult.samples.map((sample) => ({ ...sample, distanceM: sample.distanceM + offsetM, segmentIndex })));
    combined.events.push(...segmentResult.events.map((event) => {
      const startKm = event.startKm + offsetM / 1000;
      const endKm = event.endKm + offsetM / 1000;
      return { ...event, segmentIndex, startKm, endKm, startPosition: { distanceM: startKm * 1000, segmentIndex }, endPosition: { distanceM: endKm * 1000, segmentIndex }, id: `segment-${segmentIndex}-${event.id}` };
    }));
  }
  return combined;
}

function analyzeSingleSegment(
  points: readonly GpxRoutePointData[],
  config: RouteDynamicsConfig,
): RouteDynamicsResult {
  const totalDistanceM = points.at(-1)!.distanceM;
  if (totalDistanceM <= 0) return { totalDistanceKm: 0, resampledPoints: [], samples: [], events: [] };

  const raw = resampleRoute(points, config.resampleIntervalM);
  const median = medianFilter(raw, config.medianFilterRadiusM, config.resampleIntervalM);
  const smoothed = movingAverage(median, config.movingAverageRadiusM, config.resampleIntervalM);
  const resampledPoints = raw.map((point, index) => ({
    distanceM: point.distanceM,
    segmentIndex: points[0].segmentIndex ?? 0,
    elevationM: point.elevationM,
    smoothedElevationM: smoothed[index],
  }));
  const samples = resampledPoints.map((point, index): RouteDynamicSample => {
    const [shortScale, mediumScale, longScale] = config.trendScalesM;
    const short = summarizeWindow(resampledPoints, index, shortScale, config);
    const medium = summarizeWindow(resampledPoints, index, mediumScale, config);
    const long = summarizeWindow(resampledPoints, index, longScale, config);
    const rhythm = agreeAcrossScales(short.rhythm, medium.rhythm, long.rhythm);
    const agreement = [short.rhythm, medium.rhythm, long.rhythm].filter((value) => value === rhythm).length / 3;
    const dominantMetrics = rhythm === "transition"
      ? medium
      : short.rhythm === rhythm ? short : medium.rhythm === rhythm ? medium : long;
    const stability = Math.min(1, agreement * 0.65 + dominantStrength(dominantMetrics) * 0.35);
    return { ...point, segmentIndex: points[0].segmentIndex ?? 0, short, medium, long, rhythm, stability };
  });
  const events = createMicroEvents(samples, resampledPoints, config);
  return { totalDistanceKm: totalDistanceM / 1000, resampledPoints, samples, events };
}

function resampleRoute(points: readonly GpxRoutePointData[], intervalM: number) {
  const total = points.at(-1)!.distanceM;
  const distances: number[] = [];
  for (let distance = 0; distance < total; distance += intervalM) distances.push(distance);
  if (distances.at(-1) !== total) distances.push(total);
  let cursor = 0;
  return distances.map((distanceM) => {
    while (cursor < points.length - 2 && points[cursor + 1].distanceM < distanceM) cursor += 1;
    const start = points[cursor];
    const end = points[Math.min(cursor + 1, points.length - 1)];
    const span = end.distanceM - start.distanceM;
    const ratio = span > 0 ? (distanceM - start.distanceM) / span : 0;
    return { distanceM, elevationM: start.elevationM + (end.elevationM - start.elevationM) * ratio };
  });
}

function medianFilter(points: ReturnType<typeof resampleRoute>, radiusM: number, intervalM: number) {
  const radius = Math.max(0, Math.round(radiusM / intervalM));
  return points.map((_, index) => {
    const values = points.slice(Math.max(0, index - radius), Math.min(points.length, index + radius + 1))
      .map(({ elevationM }) => elevationM).sort((a, b) => a - b);
    const middle = Math.floor(values.length / 2);
    return values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
  });
}

function movingAverage(elevations: number[], radiusM: number, intervalM: number) {
  const radius = Math.max(0, Math.round(radiusM / intervalM));
  return elevations.map((_, index) => {
    const range = elevations.slice(Math.max(0, index - radius), Math.min(elevations.length, index + radius + 1));
    return range.reduce((sum, elevation) => sum + elevation, 0) / range.length;
  });
}

function summarizeWindow(
  points: ResampledRoutePoint[],
  centerIndex: number,
  scaleM: number,
  config: RouteDynamicsConfig,
): RouteTrendMetrics {
  const center = points[centerIndex];
  const startM = Math.max(0, center.distanceM - scaleM / 2);
  const endM = Math.min(points.at(-1)!.distanceM, center.distanceM + scaleM / 2);
  let startIndex = centerIndex;
  while (startIndex > 0 && points[startIndex - 1].distanceM >= startM) startIndex -= 1;
  let endIndex = centerIndex;
  while (endIndex < points.length - 1 && points[endIndex + 1].distanceM <= endM) endIndex += 1;
  let ascentM = 0;
  let descentM = 0;
  let directionChanges = 0;
  let previousDirection = 0;
  for (let index = startIndex + 1; index <= endIndex; index += 1) {
    const change = points[index].smoothedElevationM - points[index - 1].smoothedElevationM;
    if (change > 0) ascentM += change;
    else descentM += Math.abs(change);
    const direction = change >= config.meaningfulElevationStepM ? 1 : change <= -config.meaningfulElevationStepM ? -1 : 0;
    if (direction !== 0 && previousDirection !== 0 && direction !== previousDirection) directionChanges += 1;
    if (direction !== 0) previousDirection = direction;
  }
  const start = points[startIndex];
  const end = points[endIndex];
  const distanceKm = Math.max((end.distanceM - start.distanceM) / 1000, config.resampleIntervalM / 1000);
  const verticalIntensityMPerKm = (ascentM + descentM) / distanceKm;
  const directionBalance = ascentM + descentM === 0 ? 0 : (ascentM - descentM) / (ascentM + descentM);
  const directionStrength = Math.abs(directionBalance);
  const gradientPct = ((end.smoothedElevationM - start.smoothedElevationM) / (distanceKm * 1000)) * 100;
  const ascentShare = (ascentM + descentM) === 0 ? 0 : ascentM / (ascentM + descentM);
  const descentShare = 1 - ascentShare;
  let rhythm: RouteRhythm = "transition";
  if (
    verticalIntensityMPerKm >= config.rollingMinimumIntensityMPerKm &&
    directionStrength <= config.rollingMaximumDirectionStrength &&
    directionChanges >= config.rollingMinimumDirectionChanges &&
    ascentShare >= config.rollingMinimumContributionShare &&
    descentShare >= config.rollingMinimumContributionShare
  ) rhythm = "rolling";
  else if (verticalIntensityMPerKm <= config.flatMaximumIntensityMPerKm) rhythm = "flat";
  else if (verticalIntensityMPerKm >= config.minimumDirectionalIntensityMPerKm && directionStrength >= config.minimumDirectionStrength) {
    rhythm = directionBalance > 0 ? "climb" : "descent";
  }
  return {
    scaleM,
    startDistanceM: start.distanceM,
    endDistanceM: end.distanceM,
    startElevationM: start.smoothedElevationM,
    endElevationM: end.smoothedElevationM,
    ascentM,
    descentM,
    netElevationM: end.smoothedElevationM - start.smoothedElevationM,
    gradientPct,
    verticalIntensityMPerKm,
    directionBalance,
    directionStrength,
    directionChanges,
    rhythm,
  };
}

function agreeAcrossScales(short: RouteRhythm, medium: RouteRhythm, long: RouteRhythm): RouteRhythm {
  const directional = (rhythm: RouteRhythm) => rhythm === "climb" || rhythm === "descent";
  if (long === "rolling") return "rolling";
  if (directional(medium) && medium === long) return medium;
  if (medium === "rolling" && (long === "transition" || directional(long))) return "rolling";
  if (directional(long) && (medium === "transition" || medium === "flat") && short === long) return long;
  if (short === medium && medium === long) return medium;
  if (medium === "flat" && (short === "flat" || short === "transition") && (long === "flat" || long === "transition")) return "flat";
  if (medium === "rolling" && short === "rolling") return "rolling";
  return "transition";
}

function createMicroEvents(
  samples: RouteDynamicSample[],
  points: ResampledRoutePoint[],
  config: RouteDynamicsConfig,
): RouteDynamicEvent[] {
  const directions = points.map((point, index) => {
    if (index === 0) return 0;
    const change = point.smoothedElevationM - points[index - 1].smoothedElevationM;
    return change >= config.meaningfulElevationStepM ? 1 : change <= -config.meaningfulElevationStepM ? -1 : 0;
  });
  const runs: Array<{ direction: number; start: number; end: number }> = [];
  directions.forEach((direction, index) => {
    const previous = runs.at(-1);
    if (previous?.direction === direction) previous.end = index;
    else runs.push({ direction, start: index, end: index });
  });
  for (let index = 1; index < runs.length - 1; index += 1) {
    const run = runs[index];
    const distanceKm = (points[run.end].distanceM - points[run.start].distanceM) / 1000;
    if (run.direction === 0 && distanceKm < config.minimumMicroEventDistanceKm && runs[index - 1].direction === runs[index + 1].direction) {
      runs[index - 1].end = runs[index + 1].end;
      runs.splice(index, 2);
      index -= 1;
    }
  }
  return runs.flatMap((run, index) => {
    const start = points[run.start];
    const end = points[run.end];
    const distanceKm = (end.distanceM - start.distanceM) / 1000;
    if (distanceKm < config.minimumMicroEventDistanceKm) return [];
    let ascentM = 0;
    let descentM = 0;
    for (let pointIndex = run.start + 1; pointIndex <= run.end; pointIndex += 1) {
      const change = points[pointIndex].smoothedElevationM - points[pointIndex - 1].smoothedElevationM;
      if (change > 0) ascentM += change;
      else descentM += Math.abs(change);
    }
    const vertical = ascentM + descentM;
    const directionBalance = vertical === 0 ? 0 : (ascentM - descentM) / vertical;
    const localSamples = samples.slice(run.start, run.end + 1);
    const neutralRhythm = (name: "rolling" | "flat") => localSamples.filter((sample) => sample.short.rhythm === name).length / Math.max(1, localSamples.length);
    const rhythm: RouteRhythm = run.direction > 0
      ? "climb"
      : run.direction < 0
        ? "descent"
        : neutralRhythm("rolling") >= 0.5 ? "rolling" : neutralRhythm("flat") >= 0.5 ? "flat" : "transition";
    if (rhythm === "transition") return [];
    const prior = runs[index - 1];
    const next = runs[index + 1];
    const contextDistanceKm = ((prior ? points[prior.end].distanceM - points[prior.start].distanceM : 0) +
      (next ? points[next.end].distanceM - points[next.start].distanceM : 0)) / 1000;
    const contextVertical = (prior ? Math.abs(points[prior.end].smoothedElevationM - points[prior.start].smoothedElevationM) : 0) +
      (next ? Math.abs(points[next.end].smoothedElevationM - points[next.start].smoothedElevationM) : 0);
    const persistence = Math.min(1, distanceKm / config.minimumConfirmedPhaseKm);
    const significance = relativeSignificance(distanceKm, contextDistanceKm, vertical, contextVertical);
    const confidence = samples.slice(run.start, run.end + 1).reduce((sum, sample) => sum + sample.stability, 0) / (run.end - run.start + 1);
    return [{
      id: `dynamic-event-${run.start + 1}`,
      segmentIndex: points[0].segmentIndex ?? 0,
      startKm: Number((start.distanceM / 1000).toFixed(2)),
      endKm: Number((end.distanceM / 1000).toFixed(2)),
      startPosition: { distanceM: start.distanceM, segmentIndex: points[0].segmentIndex ?? 0 },
      endPosition: { distanceM: end.distanceM, segmentIndex: points[0].segmentIndex ?? 0 },
      rhythm,
      ascentM: Math.round(ascentM),
      descentM: Math.round(descentM),
      netElevationM: Math.round(end.smoothedElevationM - start.smoothedElevationM),
      gradientPct: distanceKm > 0 ? Number(((end.smoothedElevationM - start.smoothedElevationM) / (distanceKm * 10)).toFixed(2)) : 0,
      verticalIntensity: distanceKm > 0 ? Number((vertical / distanceKm).toFixed(1)) : 0,
      directionBalance: Number(directionBalance.toFixed(2)),
      directionStrength: Number(Math.abs(directionBalance).toFixed(2)),
      persistence: Number(persistence.toFixed(2)),
      significance: Number(significance.toFixed(2)),
      confidence: Number(confidence.toFixed(2)),
    }];
  });
}

export function relativeSignificance(eventDistanceKm: number, contextDistanceKm: number, eventVerticalM: number, contextVerticalM: number) {
  const distanceShare = eventDistanceKm + contextDistanceKm > 0 ? eventDistanceKm / (eventDistanceKm + contextDistanceKm) : 0;
  const verticalShare = eventVerticalM + contextVerticalM > 0 ? eventVerticalM / (eventVerticalM + contextVerticalM) : 0;
  return Math.min(1, Math.max(0, distanceShare * 0.35 + verticalShare * 0.65));
}

function dominantStrength(metrics: RouteTrendMetrics) {
  return metrics.rhythm === "transition" ? 0 : metrics.directionStrength;
}
