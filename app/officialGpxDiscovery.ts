import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { request as httpsRequest, type RequestOptions } from "node:https";

export const OFFICIAL_GPX_DISCOVERY_LIMITS = {
  timeoutMs: 8_000,
  maxPages: 3,
  maxRedirects: 2,
  maxResponseBytes: 1_000_000,
  maxCandidates: 20,
  maxConcurrentPerProcess: 2,
} as const;

export type GpxDiscoveryCandidate = {
  gpxUrl: string;
  sourcePageUrl: string;
  linkText: string;
  supportingEvidence: string[];
  distanceLabel: string | null;
  discoveryStatus: "link-evidence-only";
  ambiguity: "multiple-candidates" | null;
};

export type OfficialGpxDiscoveryResult =
  | { status: "success"; candidates: GpxDiscoveryCandidate[] }
  | { status: "no-results"; candidates: [] }
  | { status: "invalid-url"; candidates: [] }
  | { status: "unsafe-destination"; candidates: [] }
  | { status: "provider-failure"; candidates: []; category: "timeout" | "unavailable" | "invalid-response" | "busy" };

export type SafeHttpsAddress = { address: string; family: 4 | 6 };
export type SafeHttpsResponse = { statusCode: number; headers: Record<string, string | undefined>; body: Uint8Array };
export type SafeHttpsDependencies = {
  resolve: (hostname: string) => Promise<SafeHttpsAddress[]>;
  request: (url: URL, address: SafeHttpsAddress, maxBytes: number, timeoutMs: number, accept?: string) => Promise<SafeHttpsResponse>;
};

const IPV4_BLOCKED: Array<[string, number]> = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["203.0.113.0", 24], ["192.88.99.0", 24],
  ["224.0.0.0", 4], ["240.0.0.0", 4],
];

function ipv4Number(address: string): number | null {
  const pieces = address.split(".").map(Number);
  if (pieces.length !== 4 || pieces.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return (((pieces[0] * 256 + pieces[1]) * 256 + pieces[2]) * 256 + pieces[3]) >>> 0;
}

function prefixMatches(address: number, base: number, bits: number): boolean {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (address & mask) === (base & mask);
}

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const numeric = ipv4Number(address);
    if (numeric === null) return false;
    return !IPV4_BLOCKED.some(([baseText, bits]) => {
      const base = ipv4Number(baseText);
      if (base === null) return false;
      return prefixMatches(numeric, base, bits);
    }) && !prefixMatches(numeric, ipv4Number("192.0.2.0")!, 24)
      && !prefixMatches(numeric, ipv4Number("198.51.100.0")!, 24)
      && !prefixMatches(numeric, ipv4Number("203.0.113.0")!, 24)
      && !prefixMatches(numeric, ipv4Number("192.88.99.0")!, 24);
  }
  if (family !== 6) return false;
  const groups = expandIpv6(address);
  if (!groups) return false;
  // Only global-unicast 2000::/3 is eligible. This also rejects special-use
  // prefixes outside that block, including the non-globally-reachable
  // 5f00::/16 Segment Routing SID range; reject additional special-use,
  // documentation, transition, and benchmarking allocations within 2000::/3.
  if ((groups[0] & 0xe000) !== 0x2000) return false;
  if (groups[0] === 0x2001 && (groups[1] <= 0x01ff || (groups[1] & 0xfff0) === 0x0010 || (groups[1] & 0xfff0) === 0x0020 || groups[1] === 0x0db8)) return false;
  if (groups[0] === 0x2002 || (groups[0] === 0x3fff && (groups[1] & 0xfff0) === 0x0000)) return false;
  return true;
}

function expandIpv6(input: string): number[] | null {
  const value = input.toLowerCase().split("%")[0];
  if (value.includes(".")) return null; // Excludes IPv4-mapped and mixed notation.
  const halves = value.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":").map((part) => parseInt(part, 16)) : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":").map((part) => parseInt(part, 16)) : [];
  if ([...left, ...right].some((part) => !Number.isInteger(part) || part < 0 || part > 0xffff)) return null;
  const zeros = halves.length === 2 ? 8 - left.length - right.length : 0;
  if ((halves.length === 1 && left.length !== 8) || zeros < 1) return null;
  return [...left, ...Array(zeros).fill(0), ...right];
}

export function validateOfficialPageUrl(input: string): URL | null {
  try {
    const url = new URL(input);
    if (url.protocol !== "https:" || url.username || url.password || !url.hostname || url.port && url.port !== "443" || isIP(url.hostname.replace(/^\[|\]$/g, ""))) return null;
    url.hash = "";
    return url;
  } catch {
    return null;
  }
}

async function resolvePublic(hostname: string): Promise<SafeHttpsAddress[]> {
  const bareHost = hostname.replace(/^\[|\]$/g, "");
  const family = isIP(bareHost);
  const records = family
    ? [{ address: bareHost, family }]
    : await lookup(bareHost, { all: true, verbatim: true });
  if (!records.length || records.some((record) => !isPublicAddress(record.address))) throw new UnsafeDestinationError();
  return records.map((record) => ({ address: record.address, family: record.family as 4 | 6 }));
}

class UnsafeDestinationError extends Error {
  constructor() { super(); this.name = "UnsafeDestinationError"; }
}
class OfficialGpxDiscoveryTimeoutError extends Error {
  constructor() { super(); this.name = "OfficialGpxDiscoveryTimeoutError"; }
}
class InvalidResponseError extends Error {
  constructor() { super(); this.name = "InvalidResponseError"; }
}

function withinTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new OfficialGpxDiscoveryTimeoutError()), timeoutMs);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

function requestPinnedHttps(url: URL, address: SafeHttpsAddress, maxBytes: number, timeoutMs: number, accept = "text/html"): Promise<SafeHttpsResponse> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, value?: SafeHttpsResponse) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(value!);
    };
    const lookupPinned = createPinnedDnsLookup(address);
    const req = httpsRequest({
      protocol: "https:", hostname: url.hostname, port: 443, method: "GET",
      path: `${url.pathname}${url.search}`, servername: url.hostname.replace(/^\[|\]$/g, ""),
      rejectUnauthorized: true, lookup: lookupPinned,
      headers: { accept, "user-agent": "RaceIntelligence-GpxDiscovery/1.0", "accept-encoding": "identity" },
    }, (res) => {
      const chunks: Uint8Array[] = [];
      let length = 0;
      res.on("aborted", () => finish(new Error("response-aborted")));
      res.on("error", (error) => finish(error));
      res.on("data", (chunk: Buffer) => {
        length += chunk.byteLength;
        if (length > maxBytes) {
          req.destroy(new InvalidResponseError());
          return;
        }
        chunks.push(chunk);
      });
      res.on("end", () => {
        const body = new Uint8Array(length);
        let offset = 0;
        for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
        const headers: Record<string, string | undefined> = {};
        for (const [key, value] of Object.entries(res.headers)) headers[key.toLowerCase()] = Array.isArray(value) ? value.join(",") : value;
        finish(undefined, { statusCode: res.statusCode ?? 0, headers, body });
      });
    });
    const timer = setTimeout(() => req.destroy(new OfficialGpxDiscoveryTimeoutError()), timeoutMs);
    req.on("close", () => clearTimeout(timer));
    req.on("error", (error) => finish(error));
    req.end();
  });
}

export function createPinnedDnsLookup(address: SafeHttpsAddress): NonNullable<RequestOptions["lookup"]> {
  return ((_: string, optionsOrCallback: unknown, maybeCallback?: (...args: unknown[]) => void) => {
    const callback = typeof optionsOrCallback === "function" ? optionsOrCallback as (...args: unknown[]) => void : maybeCallback;
    if (!callback) throw new Error("Pinned DNS lookup callback missing");
    const options = typeof optionsOrCallback === "object" && optionsOrCallback !== null
      ? optionsOrCallback as { all?: boolean }
      : undefined;
    if (options?.all) callback(null, [{ address: address.address, family: address.family }]);
    else callback(null, address.address, address.family);
  }) as NonNullable<RequestOptions["lookup"]>;
}

function decodeEntities(value: string): string {
  return value.replace(/&(#x[\da-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/gi, (entity, name: string) => {
    const lower = name.toLowerCase();
    if (lower === "amp") return "&";
    if (lower === "quot") return '"';
    if (lower === "apos") return "'";
    if (lower === "lt") return "<";
    if (lower === "gt") return ">";
    if (lower === "nbsp") return " ";
    const code = lower.startsWith("#x") ? parseInt(lower.slice(2), 16) : parseInt(lower.slice(1), 10);
    return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
  });
}

type HtmlLink = { href: string; text: string; title: string };
function parseAnchorLinks(html: string): HtmlLink[] {
  const links: HtmlLink[] = [];
  let active: { href: string; title: string; pieces: string[] } | null = null;
  let cursor = 0;
  const finishAnchor = () => {
    if (active) links.push({
      href: decodeEntities(active.href).trim(),
      title: active.title,
      text: decodeEntities(active.pieces.join(" ").replace(/\s+/g, " ").trim()).slice(0, 300),
    });
    active = null;
  };
  while (cursor < html.length) {
    const start = html.indexOf("<", cursor);
    if (start < 0) {
      if (active) active.pieces.push(html.slice(cursor));
      break;
    }
    if (active) active.pieces.push(html.slice(cursor, start));
    if (html.startsWith("<!--", start)) {
      const close = html.indexOf("-->", start + 4);
      if (close < 0) break;
      cursor = close + 3;
      continue;
    }
    if (!/[a-zA-Z/!?]/.test(html[start + 1] ?? "")) {
      if (active) active.pieces.push("<");
      cursor = start + 1;
      continue;
    }
    let quote = "";
    let end = start + 1;
    for (; end < html.length; end++) {
      const char = html[end];
      if (quote) {
        if (char === quote) quote = "";
      } else if (char === "\"" || char === "'") quote = char;
      else if (char === ">") break;
    }
    if (end >= html.length) break;
    const tag = html.slice(start, end + 1);
    cursor = end + 1;
    if (/^<\s*(script|style)\b/i.test(tag) && !/\/\s*>$/.test(tag)) {
      const name = /^<\s*(script|style)\b/i.exec(tag)?.[1] ?? "script";
      const closePattern = new RegExp(`<\\/\\s*${name}\\s*>`, "ig");
      closePattern.lastIndex = cursor;
      const close = closePattern.exec(html);
      if (!close) break;
      cursor = closePattern.lastIndex;
      continue;
    }
    if (/^<\s*\/\s*a\s*>/i.test(tag)) {
      finishAnchor();
      continue;
    }
    if (/^<\s*a\b/i.test(tag)) {
      finishAnchor();
      const attrs: Record<string, string> = {};
      const remainder = tag.replace(/^<\s*a\b/i, "").replace(/>\s*$/, "");
      const attrPattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
      for (const attr of remainder.matchAll(attrPattern)) attrs[attr[1].toLowerCase()] = attr[2] ?? attr[3] ?? attr[4] ?? "";
      active = attrs.href ? { href: attrs.href, title: decodeEntities(attrs.title ?? ""), pieces: [] } : null;
      if (/\/\s*>$/.test(tag)) finishAnchor();
    }
  }
  finishAnchor();
  return links;
}

const DISTANCE = /\b(\d{1,3}(?:[.,]\d{1,2})?\s*(?:km|k|mi|mile|miles))\b/i;
const RELEVANT = /\b(course|route|distance|track|gpx|download|map|ultra|race)\b/i;
const DOWNLOAD = /\b(gpx|download.{0,30}(?:track|route)|(?:track|route).{0,30}download)\b/i;
const GPX_PATH = /\.gpx$/i;

function isGpxEvidence(url: URL, label: string): boolean {
  return GPX_PATH.test(url.pathname) || DOWNLOAD.test(label);
}

function isRelevantSubpage(link: HtmlLink): boolean {
  return RELEVANT.test(`${link.text} ${link.title} ${link.href}`) && !DOWNLOAD.test(`${link.text} ${link.title}`);
}

function sanitizeWebUrl(raw: string, base: URL, sameOriginOnly: boolean): URL | null {
  try {
    const url = new URL(raw, base);
    if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) return null;
    url.hash = "";
    if (sameOriginOnly && url.origin !== base.origin) return null;
    return url;
  } catch { return null; }
}

export async function fetchPublicHttps(
  input: string,
  options: { maxBytes: number; timeoutMs: number; maxRedirects: number; accept: string; sameOriginRedirects: boolean },
  dependencies: SafeHttpsDependencies = { resolve: resolvePublic, request: requestPinnedHttps },
): Promise<SafeHttpsResponse & { finalUrl: URL; bytesRead: number }> {
  const initialUrl = validateOfficialPageUrl(input);
  if (!initialUrl) throw new UnsafeDestinationError();
  const initialOrigin = initialUrl.origin;
  let current = initialUrl;
  let bytesRead = 0;
  const started = Date.now();

  for (let redirects = 0; ; redirects++) {
    const remaining = options.timeoutMs - (Date.now() - started);
    if (remaining <= 0) throw new OfficialGpxDiscoveryTimeoutError();
    if (options.sameOriginRedirects && current.origin !== initialOrigin) throw new UnsafeDestinationError();
    const hostname = current.hostname.replace(/^\[|\]$/g, "");
    const addresses = await withinTimeout(dependencies.resolve(hostname), remaining);
    if (!addresses.length || addresses.some((item) => !isPublicAddress(item.address))) throw new UnsafeDestinationError();

    const requestRemaining = options.timeoutMs - (Date.now() - started);
    if (requestRemaining <= 0) throw new OfficialGpxDiscoveryTimeoutError();
    const response = await withinTimeout(
      dependencies.request(current, addresses[0], options.maxBytes - bytesRead, requestRemaining, options.accept),
      requestRemaining,
    );
    bytesRead += response.body.byteLength;
    if (bytesRead > options.maxBytes) throw new InvalidResponseError();

    if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
      if (redirects >= options.maxRedirects) throw new Error("redirect-limit");
      const target = response.headers.location
        ? sanitizeWebUrl(response.headers.location, current, options.sameOriginRedirects)
        : null;
      if (!target) throw new UnsafeDestinationError();
      current = target;
      continue;
    }
    return { ...response, finalUrl: current, bytesRead };
  }
}

const SENSITIVE_QUERY_KEY = /(?:^|[_-])(?:key|token|secret|password|credential|signature|sig|auth|jwt|session|code)(?:[_-]|$)/i;
function hasSensitiveQuery(url: URL): boolean {
  return [...url.searchParams.keys()].some((key) => SENSITIVE_QUERY_KEY.test(key));
}
function publicSourceUrl(url: URL): string {
  const safe = new URL(url);
  for (const key of [...safe.searchParams.keys()]) if (SENSITIVE_QUERY_KEY.test(key)) safe.searchParams.delete(key);
  return safe.href;
}

function safeError(error: unknown): OfficialGpxDiscoveryResult {
  if (error instanceof UnsafeDestinationError) return { status: "unsafe-destination", candidates: [] };
  return { status: "provider-failure", candidates: [], category: error instanceof OfficialGpxDiscoveryTimeoutError ? "timeout" : error instanceof InvalidResponseError ? "invalid-response" : "unavailable" };
}

let activeDiscoveries = 0;

export function createOfficialGpxDiscovery(
  dependencies: SafeHttpsDependencies = { resolve: resolvePublic, request: requestPinnedHttps },
  limits: typeof OFFICIAL_GPX_DISCOVERY_LIMITS = OFFICIAL_GPX_DISCOVERY_LIMITS,
) {
  return async function discoverOfficialGpx(input: string): Promise<OfficialGpxDiscoveryResult> {
    const firstUrl = validateOfficialPageUrl(input);
    if (!firstUrl) return { status: "invalid-url", candidates: [] };
    if (activeDiscoveries >= limits.maxConcurrentPerProcess) return { status: "provider-failure", candidates: [], category: "busy" };
    activeDiscoveries++;
    const started = Date.now();
    const candidates = new Map<string, GpxDiscoveryCandidate>();
    const visited = new Set<string>();
    const queue: URL[] = [firstUrl];
    let responseBytes = 0;
    try {
      while (queue.length && visited.size < limits.maxPages && candidates.size < limits.maxCandidates && responseBytes < limits.maxResponseBytes) {
        const pageUrl = queue.shift()!;
        if (visited.has(pageUrl.href)) continue;
        visited.add(pageUrl.href);
        const fetched = await fetchPublicHttps(pageUrl.href, {
          maxBytes: limits.maxResponseBytes - responseBytes,
          timeoutMs: limits.timeoutMs - (Date.now() - started),
          maxRedirects: limits.maxRedirects,
          accept: "text/html",
          sameOriginRedirects: true,
        }, dependencies);
        const { html, sourceUrl } = validateHtmlResponse(fetched);
        responseBytes += fetched.bytesRead;
        const links = parseAnchorLinks(html);
        for (const link of links) {
          const target = sanitizeWebUrl(link.href, pageUrl, false);
          if (!target) continue;
          const evidence = [link.text && `link text: ${link.text}`, link.title && `title: ${link.title}`].filter(Boolean) as string[];
          if (isGpxEvidence(target, `${link.text} ${link.title}`) && !hasSensitiveQuery(target)) {
            candidates.set(target.href, {
              gpxUrl: target.href, sourcePageUrl: publicSourceUrl(sourceUrl), linkText: link.text,
              supportingEvidence: evidence.length ? evidence : ["URL path ends in .gpx"],
              distanceLabel: `${link.text} ${link.title}`.match(DISTANCE)?.[0] ?? null,
              discoveryStatus: "link-evidence-only", ambiguity: null,
            });
          } else if (queue.length + visited.size < OFFICIAL_GPX_DISCOVERY_LIMITS.maxPages &&
            target.origin === firstUrl.origin && isRelevantSubpage(link) && !visited.has(target.href) && !queue.some((item) => item.href === target.href)) {
            queue.push(target);
          }
          if (candidates.size >= limits.maxCandidates) break;
        }
      }
      const results = [...candidates.values()].map((candidate) => ({ ...candidate, ambiguity: candidates.size > 1 ? "multiple-candidates" as const : null }));
      return results.length ? { status: "success", candidates: results } : { status: "no-results", candidates: [] };
    } catch (error) {
      return safeError(error);
    } finally {
      activeDiscoveries--;
    }
  };
}

function validateHtmlResponse(response: SafeHttpsResponse & { finalUrl: URL }): { html: string; sourceUrl: URL } {
  if (response.statusCode < 200 || response.statusCode >= 300) throw new InvalidResponseError();
  const contentType = response.headers["content-type"]?.split(";")[0].trim().toLowerCase();
  const encoding = response.headers["content-encoding"]?.toLowerCase();
  if (contentType !== "text/html" && contentType !== "application/xhtml+xml") throw new InvalidResponseError();
  if (encoding && encoding !== "identity") throw new InvalidResponseError();
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(response.body); } catch { throw new InvalidResponseError(); }
  if (!/<(?:!doctype\s+html|html)\b/i.test(text)) throw new InvalidResponseError();
  return { html: text, sourceUrl: response.finalUrl };
}

export const discoverOfficialGpx = createOfficialGpxDiscovery();
