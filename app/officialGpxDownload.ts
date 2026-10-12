import { parseGpxText } from "./gpxAnalysis.ts";
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
  | { status: "unsafe-destination" | "invalid-url" | "candidate-not-found" | "invalid-gpx" }
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

export function createOfficialGpxDownloadFlow(
  discover: (sourceUrl: string) => Promise<OfficialGpxDiscoveryResult> = createOfficialGpxDiscovery(),
  download: (gpxUrl: string) => Promise<OfficialGpxDownloadResult> = createOfficialGpxDownloader(),
) {
  return async function downloadDiscoveredGpx(sourcePageUrl: string, candidateUrl: string): Promise<OfficialGpxDownloadResult> {
    if (sourcePageUrl.length > 2_048 || candidateUrl.length > 2_048 || !validateOfficialPageUrl(sourcePageUrl) || !validateOfficialPageUrl(candidateUrl)) {
      return { status: "invalid-url" };
    }
    const result = await discover(sourcePageUrl);
    if (result.status === "provider-failure") return result;
    if (result.status === "unsafe-destination") return result;
    if (result.status !== "success" || !result.candidates.some((candidate) => candidate.gpxUrl === candidateUrl)) {
      return { status: "candidate-not-found" };
    }
    return download(candidateUrl);
  };
}

export const downloadDiscoveredGpx = createOfficialGpxDownloadFlow();
