import type { GpxRoutePointData } from "./gpxAnalysis";
import { formatDistanceMeters, formatElevationMeters } from "./routeUnits.ts";

export type FlyoverSample = {
  latitude: number;
  longitude: number;
  elevationM: number | null;
  distanceM: number;
  segmentIndex: number;
};

export type FlyoverPath = {
  samples: readonly FlyoverSample[];
  startDistanceM: number;
  endDistanceM: number;
  segmentIndex: number;
};

export type FlyoverMarkerFeatureCollection = {
  type: "FeatureCollection";
  features: Array<{
    type: "Feature";
    id: number;
    properties: { segmentIndex: number };
    geometry: { type: "Point"; coordinates: [number, number] };
  }>;
};

export const FLYOVER_MARKER_FEATURE_ID = 1;

export type FlyoverPathResult =
  | { available: true; path: FlyoverPath }
  | { available: false; reason: "disconnected-components" | "invalid-geometry" | "insufficient-distance" };

export type FlyoverPlaybackPhase = "idle" | "playing" | "paused" | "complete";
export type FlyoverSpeedMultiplier = 1 | 2 | 4 | 8 | 16 | 32;
export type FlyoverPlaybackState = {
  phase: FlyoverPlaybackPhase;
  distanceM: number;
  speedMultiplier: FlyoverSpeedMultiplier;
};

export type FlyoverPlaybackAction =
  | { type: "start" }
  | { type: "pause" }
  | { type: "resume" }
  | { type: "restart" }
  | { type: "exit" }
  | { type: "seek"; distanceM: number }
  | { type: "set-speed"; speedMultiplier: FlyoverSpeedMultiplier }
  | { type: "advance"; distanceM: number };

export const FLYOVER_BASELINE_METERS_PER_SECOND = 25;

/** Prepare one component-aware, distance-indexed path from the canonical analyzed GPX points. */
export function buildFlyoverPath(points: readonly GpxRoutePointData[]): FlyoverPathResult {
  if (points.length < 2) return { available: false, reason: "insufficient-distance" };
  const segmentIds = new Set<number>();
  const samples: FlyoverSample[] = [];
  for (const point of points) {
    if (
      !Number.isFinite(point.latitude) || point.latitude < -90 || point.latitude > 90 ||
      !Number.isFinite(point.longitude) || point.longitude < -180 || point.longitude > 180 ||
      !Number.isFinite(point.distanceM) || !Number.isInteger(point.segmentIndex)
    ) return { available: false, reason: "invalid-geometry" };
    segmentIds.add(point.segmentIndex);
    const sample: FlyoverSample = {
      latitude: point.latitude,
      longitude: point.longitude,
      elevationM: Number.isFinite(point.elevationM) ? point.elevationM : null,
      distanceM: point.distanceM,
      segmentIndex: point.segmentIndex,
    };
    const previous = samples.at(-1);
    if (previous && sample.distanceM < previous.distanceM) return { available: false, reason: "invalid-geometry" };
    if (previous && sample.distanceM === previous.distanceM) {
      // A zero-distance edge cannot describe travel. Collapse exact duplicate positions only.
      if (sample.segmentIndex !== previous.segmentIndex ||
        Math.abs(sample.latitude - previous.latitude) > 1e-9 || Math.abs(sample.longitude - previous.longitude) > 1e-9) {
        return { available: false, reason: "invalid-geometry" };
      }
      samples[samples.length - 1] = sample;
      continue;
    }
    samples.push(sample);
  }
  if (segmentIds.size !== 1) return { available: false, reason: "disconnected-components" };
  const first = samples[0];
  const last = samples.at(-1);
  if (!first || !last || last.distanceM <= first.distanceM) return { available: false, reason: "insufficient-distance" };
  return {
    available: true,
    path: { samples, startDistanceM: first.distanceM, endDistanceM: last.distanceM, segmentIndex: first.segmentIndex },
  };
}

/** Interpolate only within a path edge. Missing elevation on either edge endpoint stays unknown. */
export function sampleFlyoverPath(path: FlyoverPath, requestedDistanceM: number): FlyoverSample {
  const distanceM = clamp(requestedDistanceM, path.startDistanceM, path.endDistanceM);
  const samples = path.samples;
  const lastSample = samples.at(-1)!;
  if (distanceM === lastSample.distanceM) return { ...lastSample };
  let low = 0;
  let high = samples.length - 1;
  while (low + 1 < high) {
    const middle = (low + high) >>> 1;
    if (samples[middle].distanceM <= distanceM) low = middle;
    else high = middle;
  }
  const left = samples[low];
  const right = samples[Math.min(low + 1, samples.length - 1)];
  if (left.distanceM === distanceM || left === right) return { ...left, distanceM };
  const fraction = (distanceM - left.distanceM) / (right.distanceM - left.distanceM);
  return {
    latitude: left.latitude + (right.latitude - left.latitude) * fraction,
    longitude: left.longitude + (right.longitude - left.longitude) * fraction,
    elevationM: left.elevationM === null || right.elevationM === null ? null : left.elevationM + (right.elevationM - left.elevationM) * fraction,
    distanceM,
    segmentIndex: path.segmentIndex,
  };
}

export function createFlyoverMarkerFeature(sample: FlyoverSample): FlyoverMarkerFeatureCollection {
  return {
    type: "FeatureCollection",
    features: [{
      type: "Feature",
      id: FLYOVER_MARKER_FEATURE_ID,
      properties: { segmentIndex: sample.segmentIndex },
      geometry: { type: "Point", coordinates: [sample.longitude, sample.latitude] },
    }],
  };
}

export function advanceFlyoverDistance(path: FlyoverPath, currentDistanceM: number, elapsedMs: number, speedMultiplier: number): number {
  const safeElapsedMs = Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : 0;
  return Math.min(path.endDistanceM, currentDistanceM + FLYOVER_BASELINE_METERS_PER_SECOND * (safeElapsedMs / 1000) * speedMultiplier);
}

export function createFlyoverPlaybackState(path: FlyoverPath): FlyoverPlaybackState {
  return { phase: "idle", distanceM: path.startDistanceM, speedMultiplier: 1 };
}

export function reduceFlyoverPlayback(
  path: FlyoverPath,
  state: FlyoverPlaybackState,
  action: FlyoverPlaybackAction,
): FlyoverPlaybackState {
  switch (action.type) {
    case "start":
      return { ...state, phase: "playing", distanceM: path.startDistanceM };
    case "pause":
      return state.phase === "playing" ? { ...state, phase: "paused" } : state;
    case "resume":
      return state.phase === "paused" && state.distanceM < path.endDistanceM ? { ...state, phase: "playing" } : state;
    case "restart":
      return { ...state, phase: "playing", distanceM: path.startDistanceM };
    case "exit":
      return { ...state, phase: "idle", distanceM: path.startDistanceM };
    case "seek": {
      const distanceM = clamp(action.distanceM, path.startDistanceM, path.endDistanceM);
      return { ...state, distanceM, phase: state.phase === "playing" ? "playing" : distanceM === path.endDistanceM ? "complete" : "paused" };
    }
    case "set-speed":
      return { ...state, speedMultiplier: action.speedMultiplier };
    case "advance": {
      if (state.phase !== "playing") return state;
      const distanceM = clamp(action.distanceM, path.startDistanceM, path.endDistanceM);
      return { ...state, distanceM, phase: distanceM >= path.endDistanceM ? "complete" : "playing" };
    }
  }
}

export function getFlyoverBearing(from: Pick<FlyoverSample, "latitude" | "longitude">, to: Pick<FlyoverSample, "latitude" | "longitude">): number {
  const radians = Math.PI / 180;
  const latitude1 = from.latitude * radians;
  const latitude2 = to.latitude * radians;
  const deltaLongitude = (to.longitude - from.longitude) * radians;
  const y = Math.sin(deltaLongitude) * Math.cos(latitude2);
  const x = Math.cos(latitude1) * Math.sin(latitude2) - Math.sin(latitude1) * Math.cos(latitude2) * Math.cos(deltaLongitude);
  return ((Math.atan2(y, x) / radians) + 360) % 360;
}

export function smoothFlyoverBearing(current: number, target: number, fraction: number): number {
  const delta = ((target - current + 540) % 360) - 180;
  return (current + delta * clamp(fraction, 0, 1) + 360) % 360;
}

export function formatFlyoverReadout(sample: FlyoverSample, units: "metric" | "us-customary") {
  return {
    distance: formatDistanceMeters(sample.distanceM, units, 2),
    elevation: sample.elevationM === null ? "Unavailable" : formatElevationMeters(sample.elevationM, units, 0),
  };
}

export const FLYOVER_CAMERA_PARAMETERS = Object.freeze({
  pitch: 52,
  minimumZoom: 14.2,
  maximumZoom: 16.2,
  highSpeedMinimumZoom: 12.8,
  zoomReferenceMeters: 10_000,
  desiredRunnerScreenOffset: 0.16,
  headingLookAheadMinimumMeters: 300,
  baseHeadingLookAheadSeconds: 2.5,
  headingSmoothingTimeMs: 380,
  zoomSmoothingTimeMs: 520,
});

export type FlyoverCameraSpeedProfile = {
  zoomOffset: number;
  lookAheadSeconds: number;
  headingSmoothingTimeMs: number;
};

/** Wider framing and longer heading windows reduce apparent camera jerk at high visualization speeds. */
export function getFlyoverCameraSpeedProfile(speedMultiplier: number): FlyoverCameraSpeedProfile {
  if (speedMultiplier >= 32) return { zoomOffset: -1.5, lookAheadSeconds: 4.5, headingSmoothingTimeMs: 760 };
  if (speedMultiplier >= 16) return { zoomOffset: -1.1, lookAheadSeconds: 4, headingSmoothingTimeMs: 640 };
  if (speedMultiplier >= 8) return { zoomOffset: -0.7, lookAheadSeconds: 3.5, headingSmoothingTimeMs: 500 };
  if (speedMultiplier >= 4) return { zoomOffset: -0.35, lookAheadSeconds: 3, headingSmoothingTimeMs: 430 };
  return { zoomOffset: 0, lookAheadSeconds: FLYOVER_CAMERA_PARAMETERS.baseHeadingLookAheadSeconds, headingSmoothingTimeMs: FLYOVER_CAMERA_PARAMETERS.headingSmoothingTimeMs };
}

export function smoothFlyoverCameraZoom(current: number, target: number, elapsedMs: number, smoothingTimeMs: number): number {
  const fraction = 1 - Math.exp(-Math.max(0, elapsedMs) / Math.max(1, smoothingTimeMs));
  return current + (target - current) * fraction;
}

export type FlyoverCameraPlan = {
  center: [number, number];
  zoom: number;
  bearing: number;
  pitch: number;
  centerDistanceM: number;
  lookAheadDistanceM: number;
  leadMeters: number;
};

/**
 * Camera follow is time-based and route-aware. The camera looks ahead so the runner sits
 * about 16% of the viewport height below center; pitch 52° keeps the forward terrain visible.
 */
export function getFlyoverCameraPlan(
  path: FlyoverPath,
  sample: FlyoverSample,
  speedMultiplier: number,
  currentBearing: number | null,
  elapsedMs: number,
  viewportHeight: number,
  currentZoom: number | null = null,
): FlyoverCameraPlan {
  const parameters = FLYOVER_CAMERA_PARAMETERS;
  const speedProfile = getFlyoverCameraSpeedProfile(speedMultiplier);
  const routeLength = path.endDistanceM - path.startDistanceM;
  const baseZoom = clamp(
    parameters.maximumZoom - Math.log2(Math.max(1, routeLength) / parameters.zoomReferenceMeters),
    parameters.minimumZoom,
    parameters.maximumZoom,
  );
  const targetZoom = clamp(baseZoom + speedProfile.zoomOffset, parameters.highSpeedMinimumZoom, parameters.maximumZoom);
  const zoom = currentZoom === null
    ? targetZoom
    : smoothFlyoverCameraZoom(currentZoom, targetZoom, elapsedMs, parameters.zoomSmoothingTimeMs);
  const metersPerPixel = 156543.03392804097 * Math.cos(sample.latitude * Math.PI / 180) / (2 ** zoom);
  const leadMeters = clamp(
    Math.max(1, viewportHeight) * parameters.desiredRunnerScreenOffset * metersPerPixel / Math.sin(parameters.pitch * Math.PI / 180),
    0,
    Math.min(650, routeLength * 0.25),
  );
  const centerDistanceM = Math.min(path.endDistanceM, sample.distanceM + leadMeters);
  const lookAheadMeters = Math.max(
    parameters.headingLookAheadMinimumMeters,
    speedMultiplier * FLYOVER_BASELINE_METERS_PER_SECOND * speedProfile.lookAheadSeconds,
  );
  const lookAheadDistanceM = Math.min(path.endDistanceM, sample.distanceM + lookAheadMeters);
  const ahead = sampleFlyoverPath(path, lookAheadDistanceM);
  let targetBearing = getFlyoverBearing(sample, ahead);
  if (Math.abs(ahead.longitude - sample.longitude) + Math.abs(ahead.latitude - sample.latitude) < 1e-10 && sample.distanceM > path.startDistanceM) {
    const before = sampleFlyoverPath(path, Math.max(path.startDistanceM, sample.distanceM - lookAheadMeters));
    targetBearing = getFlyoverBearing(before, sample);
  }
  const bearing = currentBearing === null
    ? targetBearing
    : smoothFlyoverBearing(currentBearing, targetBearing, 1 - Math.exp(-Math.max(0, elapsedMs) / speedProfile.headingSmoothingTimeMs));
  const cameraCenter = sampleFlyoverPath(path, centerDistanceM);
  return {
    center: [cameraCenter.longitude, cameraCenter.latitude],
    zoom,
    bearing,
    pitch: parameters.pitch,
    centerDistanceM,
    lookAheadDistanceM,
    leadMeters,
  };
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}
