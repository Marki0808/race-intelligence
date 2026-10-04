import type { GpxTrackPointInput } from "./gpxAnalysis.ts";

export const ANALYSIS_INPUT_FINGERPRINT_VERSION = 2;

/** Identifies the exact ordered point data used by Route Analysis, independently of route identity and GPX metadata. */
export async function createAnalysisInputFingerprint(
  input: readonly GpxTrackPointInput[] | readonly (readonly GpxTrackPointInput[])[],
): Promise<string> {
  const first = input[0];
  const segments = Array.isArray(first)
    ? input as readonly (readonly GpxTrackPointInput[])[]
    : groupBySegment(input as readonly (GpxTrackPointInput & { segmentIndex?: number })[]);
  const canonicalSegments = segments.map((segment) => segment.map(({ latitude, longitude, elevationM }) => {
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || !Number.isFinite(elevationM)) {
      throw new RangeError("Analysis input points must contain finite coordinates and elevation.");
    }
    return [normalizeZero(latitude), normalizeZero(longitude), normalizeZero(elevationM)];
  }));
  const canonical = [
    `route-analysis-input-v${ANALYSIS_INPUT_FINGERPRINT_VERSION}`,
    JSON.stringify(canonicalSegments),
  ].join("\n");
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `analysis-input-v${ANALYSIS_INPUT_FINGERPRINT_VERSION}-sha256-${hex}`;
}

function groupBySegment(points: readonly (GpxTrackPointInput & { segmentIndex?: number })[]) {
  const segments: GpxTrackPointInput[][] = [];
  for (const point of points) {
    const index = point.segmentIndex ?? 0;
    while (segments.length <= index) segments.push([]);
    segments[index].push(point);
  }
  return segments;
}

function normalizeZero(value: number) {
  return value === 0 ? 0 : value;
}
