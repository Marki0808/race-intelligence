import { parseGpxText } from "./gpxAnalysis.ts";
import { inspectGpxArchive, OFFICIAL_GPX_ARCHIVE_LIMITS, type ExtractedGpxFile } from "./officialGpxArchive.ts";
import {
  createOfficialGpxDiscovery,
  fetchPublicHttps,
  validateOfficialPageUrl,
  type OfficialGpxDiscoveryResult,
  type SafeHttpsDependencies,
  type SafeHttpsResponse,
} from "./officialGpxDiscovery.ts";

export const OFFICIAL_GPX_DOWNLOAD_LIMITS = {
  timeoutMs: 12_000,
  maxRedirects: 2,
  maxBytes: 4 * 1024 * 1024,
  maxConcurrentPerProcess: 1,
} as const;

export type OfficialGpxDownloadResult =
  | { status: "success"; text: string }
  | { status: "archive-choices"; archiveDigest: string; files: Array<Pick<ExtractedGpxFile, "id" | "displayLabel">> }
  | { status: "archive-inspection-success"; archiveDigest: string; files: ExtractedGpxFile[] }
  | { status: "unsafe-destination" | "invalid-url" | "candidate-not-found" | "archive-changed" | "invalid-gpx" | "invalid-archive" | "unsafe-archive" | "archive-too-large" | "no-gpx-in-archive" }
  | { status: "provider-failure"; category: "timeout" | "unavailable" | "invalid-response" | "busy" };

type SafeFetcher = (
  input: string,
  options: { maxBytes: number; timeoutMs: number; maxRedirects: number; accept: string; sameOriginRedirects: boolean },
  dependencies?: SafeHttpsDependencies,
) => Promise<SafeHttpsResponse & { finalUrl: URL; bytesRead: number }>;

const ACCEPTED_GPX_TYPES = new Set([
  "application/gpx+xml",
  "application/xml",
  "text/xml",
  "application/octet-stream",
]);
const ACCEPTED_ZIP_TYPES = new Set(["application/zip", "application/x-zip-compressed", "application/octet-stream"]);

let activeGpxDownloads = 0;

export function createOfficialGpxDownloader(
  fetcher: SafeFetcher = fetchPublicHttps,
  dependencies?: SafeHttpsDependencies,
  limits: typeof OFFICIAL_GPX_DOWNLOAD_LIMITS = OFFICIAL_GPX_DOWNLOAD_LIMITS,
) {
  return async function downloadOfficialGpx(input: string): Promise<OfficialGpxDownloadResult> {
    if (!validateOfficialPageUrl(input)) return { status: "invalid-url" };
    if (activeGpxDownloads >= limits.maxConcurrentPerProcess) {
      return { status: "provider-failure", category: "busy" };
    }
    activeGpxDownloads++;
    try {
      const response = await fetcher(input, {
        maxBytes: limits.maxBytes,
        timeoutMs: limits.timeoutMs,
        maxRedirects: limits.maxRedirects,
        accept: "application/gpx+xml, application/xml, text/xml, application/octet-stream;q=0.8",
        sameOriginRedirects: false,
      }, dependencies);
      const contentType = response.headers["content-type"]?.split(";")[0].trim().toLowerCase();
      const contentEncoding = response.headers["content-encoding"]?.toLowerCase();
      if (response.bytesRead > limits.maxBytes || response.body.byteLength > limits.maxBytes || response.statusCode < 200 || response.statusCode >= 300 || !ACCEPTED_GPX_TYPES.has(contentType ?? "") || (contentEncoding && contentEncoding !== "identity")) {
        return { status: "provider-failure", category: "invalid-response" };
      }

      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(response.body);
        parseGpxText(text);
      } catch {
        return { status: "invalid-gpx" };
      }
      return { status: "success", text };
    } catch (error) {
      const message = error instanceof Error ? error.name : "";
      if (message === "UnsafeDestinationError") return { status: "unsafe-destination" };
      if (message === "OfficialGpxDiscoveryTimeoutError") return { status: "provider-failure", category: "timeout" };
      if (message === "InvalidResponseError") return { status: "provider-failure", category: "invalid-response" };
      return { status: "provider-failure", category: "unavailable" };
    } finally {
      activeGpxDownloads--;
    }
  };
}

export function createOfficialGpxArchiveDownloader(
  fetcher: SafeFetcher = fetchPublicHttps,
  dependencies?: SafeHttpsDependencies,
  limits: typeof OFFICIAL_GPX_DOWNLOAD_LIMITS = OFFICIAL_GPX_DOWNLOAD_LIMITS,
) {
  return async function downloadOfficialGpxArchive(input: string): Promise<OfficialGpxDownloadResult> {
    if (!validateOfficialPageUrl(input)) return { status: "invalid-url" };
    if (activeGpxDownloads >= limits.maxConcurrentPerProcess) return { status: "provider-failure", category: "busy" };
    activeGpxDownloads++;
    try {
      const response = await fetcher(input, {
        maxBytes: OFFICIAL_GPX_ARCHIVE_LIMITS.maxCompressedBytes,
        timeoutMs: limits.timeoutMs,
        maxRedirects: limits.maxRedirects,
        accept: "application/zip, application/x-zip-compressed, application/octet-stream;q=0.8",
        sameOriginRedirects: false,
      }, dependencies);
      const contentType = response.headers["content-type"]?.split(";")[0].trim().toLowerCase();
      const contentEncoding = response.headers["content-encoding"]?.toLowerCase();
      if (response.bytesRead > OFFICIAL_GPX_ARCHIVE_LIMITS.maxCompressedBytes ||
        response.body.byteLength > OFFICIAL_GPX_ARCHIVE_LIMITS.maxCompressedBytes ||
        response.statusCode < 200 || response.statusCode >= 300 ||
        !ACCEPTED_ZIP_TYPES.has(contentType ?? "") || (contentEncoding && contentEncoding !== "identity")) {
        return { status: "provider-failure", category: "invalid-response" };
      }
      const inspected = await inspectGpxArchive(response.body);
      return inspected.status === "success"
        ? { status: "archive-inspection-success", archiveDigest: inspected.archiveDigest, files: inspected.files }
        : inspected;
    } catch (error) {
      const message = error instanceof Error ? error.name : "";
      if (message === "UnsafeDestinationError") return { status: "unsafe-destination" };
      if (message === "OfficialGpxDiscoveryTimeoutError") return { status: "provider-failure", category: "timeout" };
      if (message === "InvalidResponseError") return { status: "provider-failure", category: "invalid-response" };
      return { status: "provider-failure", category: "unavailable" };
    } finally {
      activeGpxDownloads--;
    }
  };
}

export function createOfficialGpxDownloadFlow(
  discover: (sourceUrl: string) => Promise<OfficialGpxDiscoveryResult> = createOfficialGpxDiscovery(),
  download: (gpxUrl: string) => Promise<OfficialGpxDownloadResult> = createOfficialGpxDownloader(),
  downloadArchive: (archiveUrl: string) => Promise<OfficialGpxDownloadResult> = createOfficialGpxArchiveDownloader(),
) {
  return async function downloadDiscoveredGpx(sourcePageUrl: string, candidateUrl: string, resourceType: "gpx" | "zip" | "zip-entry" = "gpx", archiveDigest?: string, entryId?: string): Promise<OfficialGpxDownloadResult> {
    if (sourcePageUrl.length > 2_048 || candidateUrl.length > 2_048 || !validateOfficialPageUrl(sourcePageUrl) || !validateOfficialPageUrl(candidateUrl)) {
      return { status: "invalid-url" };
    }
    const result = await discover(sourcePageUrl);
    if (result.status === "provider-failure") return result;
    if (result.status === "unsafe-destination") return result;
    if (result.status !== "success") return { status: "candidate-not-found" };
    if (resourceType === "zip") {
      if (!result.archives?.some((resource) => resource.archiveUrl === candidateUrl)) return { status: "candidate-not-found" };
      const inspected = await downloadArchive(candidateUrl);
      if (inspected.status !== "archive-inspection-success") return inspected;
      return { status: "archive-choices", archiveDigest: inspected.archiveDigest, files: inspected.files.map(({ id, displayLabel }) => ({ id, displayLabel })) };
    }
    if (resourceType === "zip-entry") {
      if (!/^[a-f0-9]{64}$/.test(archiveDigest ?? "") || !/^gpx-\d+$/.test(entryId ?? "")) return { status: "candidate-not-found" };
      if (!result.archives?.some((resource) => resource.archiveUrl === candidateUrl)) return { status: "candidate-not-found" };
      const inspected = await downloadArchive(candidateUrl);
      if (inspected.status !== "archive-inspection-success") return inspected;
      if (inspected.archiveDigest !== archiveDigest) return { status: "archive-changed" };
      const selectedFile = inspected.files.find((file) => file.id === entryId);
      return selectedFile ? { status: "success", text: selectedFile.text } : { status: "candidate-not-found" };
    }
    if (!result.candidates.some((candidate) => candidate.gpxUrl === candidateUrl)) {
      return { status: "candidate-not-found" };
    }
    return download(candidateUrl);
  };
}

export const downloadDiscoveredGpx = createOfficialGpxDownloadFlow();
