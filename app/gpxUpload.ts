import { GpxAnalysisError, parseGpxText, type ParsedGpx } from "./gpxAnalysis.ts";

/** Browser upload limits: 20 MiB and 100,000 route points. */
export const MAX_GPX_UPLOAD_BYTES = 20 * 1024 * 1024;
export const MAX_GPX_UPLOAD_TRACK_POINTS = 100_000;

export type GpxUploadFile = Pick<File, "name" | "size" | "text">;
export type GpxUploadErrorCode = "unsupported-file-name" | "file-too-large";

export class GpxUploadError extends Error {
  readonly code: GpxUploadErrorCode;

  constructor(code: GpxUploadErrorCode) {
    super(getGpxUploadErrorMessage(code));
    this.name = "GpxUploadError";
    this.code = code;
  }
}

export function getGpxUploadErrorMessage(code: GpxUploadErrorCode) {
  return code === "file-too-large"
    ? "This file is larger than the 20 MiB upload limit. Export a smaller or simplified GPX file and try again."
    : "Choose a .gpx or .xml file containing a valid GPX route.";
}

/** Accepts GPX XML by its .gpx/.xml filename, then validates its actual GPX structure and content. */
export async function readGpxUpload(file: GpxUploadFile): Promise<{ parsed: ParsedGpx; fallbackName: string }> {
  if (!/\.(?:gpx|xml)$/i.test(file.name)) throw new GpxUploadError("unsupported-file-name");
  if (!Number.isFinite(file.size) || file.size < 0 || file.size > MAX_GPX_UPLOAD_BYTES) {
    throw new GpxUploadError("file-too-large");
  }
  const text = await file.text();
  if (new Blob([text]).size > MAX_GPX_UPLOAD_BYTES) throw new GpxUploadError("file-too-large");
  const parsed = parseGpxText(text, { maxTrackPoints: MAX_GPX_UPLOAD_TRACK_POINTS });
  return { parsed, fallbackName: file.name.replace(/\.(?:gpx|xml)$/i, "") };
}

/** Applies the same byte and point bounds to text transferred into Route Mode. */
export function parseRouteModeGpxText(text: string): ParsedGpx {
  if (new Blob([text]).size > MAX_GPX_UPLOAD_BYTES) throw new GpxUploadError("file-too-large");
  try {
    return parseGpxText(text, { maxTrackPoints: MAX_GPX_UPLOAD_TRACK_POINTS });
  } catch (error) {
    if (error instanceof GpxAnalysisError || error instanceof GpxUploadError) throw error;
    throw new GpxAnalysisError("invalid-gpx");
  }
}
