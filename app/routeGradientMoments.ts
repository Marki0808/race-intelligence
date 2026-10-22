import type { GradientIntelligenceV1, GradientIntervalV1 } from "./gradientIntelligence.ts";
import type { KeyMomentData } from "./raceTypes.ts";

/** Adds only route-level extrema directly visible in the existing high-confidence gradient intervals. */
export function buildSustainedGradientKeyMoments(
  intelligence: GradientIntelligenceV1 | undefined,
  existing: readonly KeyMomentData[] = [],
): KeyMomentData[] {
  if (!intelligence) return [];
  return (['climb', 'descent'] as const).flatMap((direction) => {
    const candidates = intelligence.sections.flatMap((section) => section.intervals
      .filter((interval) => interval.segmentIndex === section.segmentIndex && isQualifyingSustainedInterval(interval, direction))
      .map((interval) => ({ interval, segmentIndex: section.segmentIndex })));
    const strongest = candidates.reduce<typeof candidates[number] | null>((best, candidate) => {
      if (!best) return candidate;
      const grade = Math.abs(candidate.interval.metrics.netGradientPct);
      const bestGrade = Math.abs(best.interval.metrics.netGradientPct);
      return grade > bestGrade || (grade === bestGrade && candidate.interval.startDistanceM < best.interval.startDistanceM) ? candidate : best;
    }, null);
    if (!strongest || isAlreadyCovered(strongest.interval, strongest.segmentIndex, direction, existing)) return [];
    const interval = strongest.interval;
    const startKm = interval.startDistanceM / 1000;
    const endKm = interval.endDistanceM / 1000;
    const signedGrade = `${interval.metrics.netGradientPct > 0 ? '+' : ''}${interval.metrics.netGradientPct.toFixed(1)}%`;
    const noun = direction === 'climb' ? 'climb' : 'descent';
    const gradePhrase = direction === 'climb' ? 'uphill' : 'downhill';
    return [{
      id: `gradient-sustained-${direction}`,
      number: '',
      title: `Steepest sustained ${noun}`,
      distance: `${startKm.toFixed(1)}–${endKm.toFixed(1)} km`,
      focusStartKm: startKm,
      focusEndKm: endKm,
      segmentIndex: strongest.segmentIndex,
      focusStartPosition: { distanceM: interval.startDistanceM, segmentIndex: strongest.segmentIndex },
      focusEndPosition: { distanceM: interval.endDistanceM, segmentIndex: strongest.segmentIndex },
      measurement: {
        kind: 'gradient',
        direction,
        startDistanceM: interval.startDistanceM,
        endDistanceM: interval.endDistanceM,
        distanceM: interval.distanceM,
        averageNetGradientPct: interval.metrics.netGradientPct,
        segmentIndex: strongest.segmentIndex,
      },
      text: `The GPX-smoothed profile averages ${signedGrade} net grade ${gradePhrase} over ${(interval.distanceM / 1000).toFixed(1)} km.`,
      source: 'GPX-derived smoothed profile',
    }];
  });
}

function isAlreadyCovered(interval: GradientIntervalV1, segmentIndex: number, direction: 'climb' | 'descent', moments: readonly KeyMomentData[]) {
  const startKm = interval.startDistanceM / 1000;
  const endKm = interval.endDistanceM / 1000;
  return moments.some((moment) => {
    const title = moment.title.toLowerCase();
    if (!title.includes(direction)) return false;
    if (moment.segmentIndex !== undefined && moment.segmentIndex !== segmentIndex) return false;
    const start = moment.focusStartPosition?.distanceM != null ? moment.focusStartPosition.distanceM / 1000 : moment.focusStartKm;
    const end = moment.focusEndPosition?.distanceM != null ? moment.focusEndPosition.distanceM / 1000 : moment.focusEndKm;
    const overlap = Math.max(0, Math.min(end, endKm) - Math.max(start, startKm));
    return overlap / (endKm - startKm) >= 0.5;
  });
}

function isQualifyingSustainedInterval(interval: GradientIntervalV1, direction: 'climb' | 'descent'): boolean {
  return interval.direction === direction
    && interval.distanceM >= 1500
    && (interval.intervalLengthClass === undefined || interval.intervalLengthClass === 'sustained')
    && (interval.gradientBand === 'steep' || interval.gradientBand === 'very-steep' || interval.gradientBand === 'extreme-grade')
    && interval.confidence === 'high'
    && (interval.measurementAvailability === undefined || interval.measurementAvailability === 'available')
    && Number.isFinite(interval.startDistanceM)
    && Number.isFinite(interval.endDistanceM)
    && interval.endDistanceM > interval.startDistanceM
    && interval.endDistanceM - interval.startDistanceM >= 1500
    && Math.abs(interval.distanceM - (interval.endDistanceM - interval.startDistanceM)) <= 1
    && Number.isFinite(interval.metrics.netGradientPct)
    && (direction === 'climb' ? interval.metrics.netGradientPct > 0 : interval.metrics.netGradientPct < 0);
}
