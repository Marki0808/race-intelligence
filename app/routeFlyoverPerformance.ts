export const FLYOVER_READOUT_MARKER_SIZE_CSS = 56;
export const FLYOVER_PERFORMANCE_SAMPLE_CAPACITY = 360;
export const FLYOVER_PERFORMANCE_WINDOW_MS = 5_000;

type TimedValues = {
  timestamps: Float64Array;
  values: Float64Array;
  next: number;
  length: number;
};

function createTimedValues(): TimedValues {
  return {
    timestamps: new Float64Array(FLYOVER_PERFORMANCE_SAMPLE_CAPACITY),
    values: new Float64Array(FLYOVER_PERFORMANCE_SAMPLE_CAPACITY),
    next: 0,
    length: 0,
  };
}

function addValue(buffer: TimedValues, timestamp: number, value: number) {
  buffer.timestamps[buffer.next] = timestamp;
  buffer.values[buffer.next] = value;
  buffer.next = (buffer.next + 1) % FLYOVER_PERFORMANCE_SAMPLE_CAPACITY;
  buffer.length = Math.min(FLYOVER_PERFORMANCE_SAMPLE_CAPACITY, buffer.length + 1);
}

function statsSince(buffer: TimedValues, threshold: number) {
  let count = 0;
  let total = 0;
  let maximum = 0;
  for (let offset = 0; offset < buffer.length; offset += 1) {
    const index = (buffer.next - 1 - offset + FLYOVER_PERFORMANCE_SAMPLE_CAPACITY) % FLYOVER_PERFORMANCE_SAMPLE_CAPACITY;
    const timestamp = buffer.timestamps[index];
    if (timestamp < threshold) break;
    const value = buffer.values[index];
    count += 1;
    total += value;
    maximum = Math.max(maximum, value);
  }
  return { count, average: count ? total / count : 0, maximum };
}

export type FlyoverPerformanceSnapshot = {
  fps: number;
  frameAverageMs: number;
  frameMaximumMs: number;
  framesOver33Ms: number;
  framesOver50Ms: number;
  cameraUpdatesPerSecond: number;
  markerUpdatesPerSecond: number;
  readoutUpdatesPerSecond: number;
  mainThreadLongTasksInWindow: number;
  mainThreadLongTaskMaximumMs: number;
  mapRendersPerSecond: number;
  mapRenderMaximumGapMs: number;
  mapRenderGapsOver33Ms: number;
  mapRenderGapsOver50Ms: number;
  significantMapRenderDelay: boolean;
  bufferedFrameSamples: number;
};

/** Fixed-capacity rolling measurements; it never retains a per-frame history beyond the ring buffers. */
export class FlyoverPerformanceSampler {
  private readonly frameTimes = createTimedValues();
  private readonly renderGaps = createTimedValues();
  private readonly cameraUpdates = createTimedValues();
  private readonly markerUpdates = createTimedValues();
  private readonly readoutUpdates = createTimedValues();
  private readonly mainThreadLongTasks = createTimedValues();
  private lastFrameTimestamp: number | null = null;
  private lastRenderTimestamp: number | null = null;

  recordFrame(timestamp: number) {
    if (this.lastFrameTimestamp !== null) addValue(this.frameTimes, timestamp, Math.max(0, timestamp - this.lastFrameTimestamp));
    this.lastFrameTimestamp = timestamp;
  }

  recordMapRender(timestamp: number) {
    if (this.lastRenderTimestamp !== null) addValue(this.renderGaps, timestamp, Math.max(0, timestamp - this.lastRenderTimestamp));
    this.lastRenderTimestamp = timestamp;
  }

  recordCameraUpdate(timestamp: number) { addValue(this.cameraUpdates, timestamp, 1); }
  recordMarkerUpdate(timestamp: number) { addValue(this.markerUpdates, timestamp, 1); }
  recordReadoutUpdate(timestamp: number) { addValue(this.readoutUpdates, timestamp, 1); }
  recordMainThreadLongTask(timestamp: number, durationMs: number) { addValue(this.mainThreadLongTasks, timestamp, Math.max(0, durationMs)); }

  snapshot(now: number): FlyoverPerformanceSnapshot {
    const oneSecondAgo = now - 1_000;
    const windowStart = now - FLYOVER_PERFORMANCE_WINDOW_MS;
    const frames = statsSince(this.frameTimes, windowStart);
    const frameRecent = statsSince(this.frameTimes, oneSecondAgo);
    const renders = statsSince(this.renderGaps, windowStart);
    const renderRecent = statsSince(this.renderGaps, oneSecondAgo);
    const longTasks = statsSince(this.mainThreadLongTasks, windowStart);
    let framesOver33Ms = 0;
    let framesOver50Ms = 0;
    let mapRenderGapsOver33Ms = 0;
    let mapRenderGapsOver50Ms = 0;
    // Ring buffers are ordered newest-first; only inspect entries in the bounded reporting window.
    for (let offset = 0; offset < this.frameTimes.length; offset += 1) {
      const index = (this.frameTimes.next - 1 - offset + FLYOVER_PERFORMANCE_SAMPLE_CAPACITY) % FLYOVER_PERFORMANCE_SAMPLE_CAPACITY;
      if (this.frameTimes.timestamps[index] < windowStart) break;
      const gap = this.frameTimes.values[index];
      if (gap > 33) framesOver33Ms += 1;
      if (gap > 50) framesOver50Ms += 1;
    }
    for (let offset = 0; offset < this.renderGaps.length; offset += 1) {
      const index = (this.renderGaps.next - 1 - offset + FLYOVER_PERFORMANCE_SAMPLE_CAPACITY) % FLYOVER_PERFORMANCE_SAMPLE_CAPACITY;
      if (this.renderGaps.timestamps[index] < windowStart) break;
      const gap = this.renderGaps.values[index];
      if (gap > 33) mapRenderGapsOver33Ms += 1;
      if (gap > 50) mapRenderGapsOver50Ms += 1;
    }
    return {
      fps: frameRecent.count,
      frameAverageMs: frames.average,
      frameMaximumMs: frames.maximum,
      framesOver33Ms,
      framesOver50Ms,
      cameraUpdatesPerSecond: statsSince(this.cameraUpdates, oneSecondAgo).count,
      markerUpdatesPerSecond: statsSince(this.markerUpdates, oneSecondAgo).count,
      readoutUpdatesPerSecond: statsSince(this.readoutUpdates, oneSecondAgo).count,
      mainThreadLongTasksInWindow: longTasks.count,
      mainThreadLongTaskMaximumMs: longTasks.maximum,
      mapRendersPerSecond: renderRecent.count,
      mapRenderMaximumGapMs: renders.maximum,
      mapRenderGapsOver33Ms,
      mapRenderGapsOver50Ms,
      significantMapRenderDelay: mapRenderGapsOver50Ms > 0,
      bufferedFrameSamples: this.frameTimes.length,
    };
  }
}

export function shouldCollectFlyoverDiagnostics(environment: string | undefined, enabledFlag: string | undefined) {
  return environment === "development" && enabledFlag === "true";
}
