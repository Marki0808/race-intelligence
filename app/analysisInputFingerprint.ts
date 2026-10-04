import type { GpxTrackPointInput } from "./gpxAnalysis.ts";

export const ANALYSIS_INPUT_FINGERPRINT_VERSION = 1;

/** Identifies the exact ordered point data used by Route Analysis, independently of route identity and GPX metadata. */
export async function createAnalysisInputFingerprint(
  points: readonly GpxTrackPointInput[],
): Promise<string> {
  const canonicalPoints = points.map(({ latitude, longitude, elevationM }) => {
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || !Number.isFinite(elevationM)) {
      throw new RangeError("Analysis input points must contain finite coordinates and elevation.");
    }
    return [normalizeZero(latitude), normalizeZero(longitude), normalizeZero(elevationM)];
  });
  const canonical = [
    `route-analysis-input-v${ANALYSIS_INPUT_FINGERPRINT_VERSION}`,
    JSON.stringify(canonicalPoints),
  ].join("\n");
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `analysis-input-v${ANALYSIS_INPUT_FINGERPRINT_VERSION}-sha256-${hex}`;
}

function normalizeZero(value: number) {
  return value === 0 ? 0 : value;
}
