import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { request as httpsRequest, type RequestOptions } from "node:https";

export const OFFICIAL_GPX_DISCOVERY_LIMITS = {
  timeoutMs: 8_000,
  maxPages: 3,
  maxSubpageDepth: 2,
  maxRedirects: 2,
  // Keep each page bounded while allowing a realistic multi-page discovery.
  maxResponseBytes: 1_000_000,
  maxTotalResponseBytes: 2_000_000,
  maxCandidates: 20,
  maxConcurrentPerProcess: 2,
} as const;

export type GpxDiscoveryCandidate = {
  gpxUrl: string;
  sourcePageUrl: string;
  linkText: string;
  displayLabel: string;
  supportingEvidence: string[];
  distanceLabel: string | null;
  discoveryStatus: "link-evidence-only";
  ambiguity: "multiple-candidates" | null;
};

export type OfficialGpxEventChoice = {
  url: string;
  sourcePageUrl: string;
  linkText: string;
  displayName: string;
  supportingEvidence: string[];
};

export type UnsupportedGpxResource = {
  sourcePageUrl: string;
  displayLabel: string;
  linkText: string;
  supportingEvidence: string[];
  format: "zip";
};

export type OfficialGpxDiscoveryResult =
  | { status: "success"; candidates: GpxDiscoveryCandidate[] }
  | { status: "event-selection-required"; events: OfficialGpxEventChoice[] }
  | { status: "unsupported-resources"; resources: UnsupportedGpxResource[] }
  | { status: "no-results"; candidates: [] }
  | { status: "invalid-url"; candidates: [] }
  | { status: "unsafe-destination"; candidates: [] }
  | { status: "provider-failure"; candidates: []; category: "timeout" | "unavailable" | "invalid-response" | "busy" };

export type OfficialGpxDiscoveryDiagnostic = {
  stage: "dns-resolution" | "https-request" | "http-response" | "response-read" | "redirect-validation" | "html-validation" | "page-processing" | "concurrency-guard";
  reason: "timeout" | "unavailable" | "invalid-response" | "response-size-limit" | "busy" | "no-results" | "unsupported-resources";
  pagesAttempted: number;
  subpageDepth: number;
  candidatesFound: number;
  aggregateBytesAccepted: number;
  eventDetection?: OfficialGpxEventDetectionDiagnostic;
};

export type OfficialGpxEventDetectionDiagnostic = {
  rootResponseStatus: number | null;
  rootContentType: "text/html" | "application/xhtml+xml" | "other" | "missing" | null;
  rootHtmlBytesAccepted: number;
  parsedAnchors: number;
  sameOriginAnchors: number;
  eventLinkProspects: number;
  meaningfulHeadingCount: number;
  finalDeduplicatedEventChoices: number;
  gpxCandidatePrecedenceSuppressed: boolean;
  explicitGpxIndexPrecedenceSuppressed: boolean;
  structure: OrganizerEventStructureDiagnostic;
  decisionReason:
    | "root-fetch-failure"
    | "root-http-status"
    | "root-non-html-content-type"
    | "root-unsupported-content-encoding"
    | "root-empty-body"
    | "root-invalid-utf8"
    | "root-invalid-html-document"
    | "root-response-size-limit"
    | "gpx-candidate-precedence"
    | "explicit-gpx-index-precedence"
    | "no-event-link-prospects"
    | "no-meaningful-headings"
    | "fewer-than-two-distinct-event-choices"
    | "provider-failure-during-crawl"
    | "unsupported-resources-found"
    | "no-supported-gpx-after-crawl";
};

export type OrganizerEventStructureDiagnostic = {
  headingElements: number;
  meaningfulHeadingElements: number;
  prospectsWithMeaningfulAnchorText: number;
  prospectsWithMeaningfulAriaOrTitle: number;
  prospectsWithMeaningfulImageAlt: number;
  prospectsInsideSemanticCards: number;
  prospectsWithHeadingInSharedContainer: number;
  prospectsRejectedWithoutSharedHeading: number;
  prospectsRejectedWithNonMeaningfulHeading: number;
  prospectsExcludedByNavigation: number;
  prospectsByAncestorCategory: {
    semanticCard: number;
    section: number;
    listOrTable: number;
    divContainer: number;
    other: number;
  };
  maxProspectNestingDepth: number;
};

const DIAGNOSTIC_COUNT_CAP = 1000;
function boundedDiagnosticCount(value: number): number {
  return Math.min(DIAGNOSTIC_COUNT_CAP, Math.max(0, Math.trunc(value)));
}
function incrementDiagnosticCount(value: number): number {
  return boundedDiagnosticCount(value + 1);
}

function emptyOrganizerEventStructureDiagnostic(): OrganizerEventStructureDiagnostic {
  return {
    headingElements: 0,
    meaningfulHeadingElements: 0,
    prospectsWithMeaningfulAnchorText: 0,
    prospectsWithMeaningfulAriaOrTitle: 0,
    prospectsWithMeaningfulImageAlt: 0,
    prospectsInsideSemanticCards: 0,
    prospectsWithHeadingInSharedContainer: 0,
    prospectsRejectedWithoutSharedHeading: 0,
    prospectsRejectedWithNonMeaningfulHeading: 0,
    prospectsExcludedByNavigation: 0,
    prospectsByAncestorCategory: { semanticCard: 0, section: 0, listOrTable: 0, divContainer: 0, other: 0 },
    maxProspectNestingDepth: 0,
  };
}

export type SafeHttpsAddress = { address: string; family: 4 | 6 };
export type SafeHttpsResponse = { statusCode: number; headers: Record<string, string | undefined>; body: Uint8Array };
export type SafeHttpsDependencies = {
  resolve: (hostname: string) => Promise<SafeHttpsAddress[]>;
  request: (url: URL, address: SafeHttpsAddress, maxBytes: number, timeoutMs: number, accept?: string, onStage?: (stage: OfficialGpxDiscoveryDiagnostic["stage"]) => void) => Promise<SafeHttpsResponse>;
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
class ResponseSizeLimitError extends InvalidResponseError {
  constructor() { super(); this.name = "ResponseSizeLimitError"; }
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

function requestPinnedHttps(url: URL, address: SafeHttpsAddress, maxBytes: number, timeoutMs: number, accept = "text/html", onStage?: (stage: OfficialGpxDiscoveryDiagnostic["stage"]) => void): Promise<SafeHttpsResponse> {
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
      onStage?.("http-response");
      const chunks: Uint8Array[] = [];
      let length = 0;
      res.on("aborted", () => { onStage?.("response-read"); finish(new Error("response-aborted")); });
      res.on("error", (error) => { onStage?.("response-read"); finish(error); });
      res.on("data", (chunk: Buffer) => {
        length += chunk.byteLength;
        if (length > maxBytes) {
          onStage?.("response-read");
          req.destroy(new ResponseSizeLimitError());
          return;
        }
        chunks.push(chunk);
      });
      res.on("end", () => {
        onStage?.("http-response");
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

type HtmlLink = {
  href: string;
  text: string;
  title: string;
  contextHeading: string | null;
  isNavigation: boolean;
  meaningfulAnchorText: boolean;
  meaningfulAriaOrTitle: boolean;
  meaningfulImageAlt: boolean;
  insideSemanticCard: boolean;
  headingInSharedContainer: boolean;
  ancestorCategory: "semanticCard" | "section" | "listOrTable" | "divContainer" | "other";
  nestingDepth: number;
};
type ParsedHtmlAnchors = {
  links: HtmlLink[];
  headingElements: number;
  meaningfulHeadingElements: number;
};
function parseAnchorLinks(html: string): ParsedHtmlAnchors {
  const links: HtmlLink[] = [];
  const scopes: Array<{ tag: string; heading: string | null; isCard: boolean; isNavigation: boolean }> = [];
  let active: {
    href: string; title: string; pieces: string[]; contextHeading: string | null; isNavigation: boolean;
    meaningfulAriaOrTitle: boolean; meaningfulImageAlt: boolean; insideSemanticCard: boolean;
    headingInSharedContainer: boolean; ancestorCategory: HtmlLink["ancestorCategory"]; nestingDepth: number;
  } | null = null;
  let activeHeading: { tag: string; pieces: string[] } | null = null;
  let headingElements = 0;
  let meaningfulHeadingElements = 0;
  let cursor = 0;
  const finishAnchor = () => {
    if (active) links.push({
      href: decodeEntities(active.href).trim(),
      title: active.title,
      text: decodeEntities(active.pieces.join(" ").replace(/\s+/g, " ").trim()).slice(0, 300),
      contextHeading: active.contextHeading,
      isNavigation: active.isNavigation,
      meaningfulAnchorText: hasMeaningfulEventHeading(decodeEntities(active.pieces.join(" ").replace(/\s+/g, " ").trim()).slice(0, 160)),
      meaningfulAriaOrTitle: active.meaningfulAriaOrTitle,
      meaningfulImageAlt: active.meaningfulImageAlt,
      insideSemanticCard: active.insideSemanticCard,
      headingInSharedContainer: active.headingInSharedContainer,
      ancestorCategory: active.ancestorCategory,
      nestingDepth: active.nestingDepth,
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
      if (activeHeading) activeHeading.pieces.push("<");
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
    const textBetweenTags = html.slice(cursor, start);
    if (activeHeading) activeHeading.pieces.push(textBetweenTags);
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
    const closingTag = /^<\s*\/\s*([a-z][\w:-]*)/i.exec(tag)?.[1]?.toLowerCase();
    if (closingTag && activeHeading?.tag === closingTag) {
      const heading = decodeEntities(activeHeading.pieces.join(" ").replace(/\s+/g, " ").trim()).slice(0, 200);
      if (heading) {
        if (hasMeaningfulEventHeading(heading)) meaningfulHeadingElements++;
        const cardScope = [...scopes].reverse().find((item) => item.isCard);
        const localScope = [...scopes].reverse().find((item) => item.tag !== "html" && item.tag !== "body" && item.tag !== "main");
        if (cardScope) cardScope.heading = heading;
        else if (localScope) localScope.heading = heading;
      }
      activeHeading = null;
    }
    if (closingTag && ["div", "section", "article", "li", "tr", "td", "nav", "header", "footer", "main", "body", "html"].includes(closingTag)) {
      for (let index = scopes.length - 1; index >= 0; index--) {
        if (scopes[index].tag === closingTag) {
          scopes.length = index;
          break;
        }
      }
      continue;
    }
    if (/^<\s*a\b/i.test(tag)) {
      finishAnchor();
      const attrs: Record<string, string> = {};
      const remainder = tag.replace(/^<\s*a\b/i, "").replace(/>\s*$/, "");
      const attrPattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
      for (const attr of remainder.matchAll(attrPattern)) attrs[attr[1].toLowerCase()] = attr[2] ?? attr[3] ?? attr[4] ?? "";
      const card = scopes.some((item) => item.isCard);
      const ancestorCategory: HtmlLink["ancestorCategory"] = card ? "semanticCard"
        : scopes.some((item) => item.tag === "section") ? "section"
          : scopes.some((item) => ["li", "tr", "td"].includes(item.tag)) ? "listOrTable"
            : scopes.some((item) => item.tag === "div") ? "divContainer" : "other";
      active = attrs.href ? {
        href: attrs.href,
        title: decodeEntities(attrs.title ?? ""),
        pieces: [],
        contextHeading: [...scopes].reverse().find((item) => item.heading)?.heading ?? null,
        isNavigation: scopes.some((item) => item.isNavigation),
        meaningfulAriaOrTitle: [attrs["aria-label"], attrs.title]
          .some((label) => hasMeaningfulEventHeading(decodeEntities(label ?? "").trim().slice(0, 160))),
        meaningfulImageAlt: false,
        insideSemanticCard: card,
        headingInSharedContainer: scopes.some((item) => item.heading !== null),
        ancestorCategory,
        nestingDepth: Math.min(32, scopes.length),
      } : null;
      if (/\/\s*>$/.test(tag)) finishAnchor();
      continue;
    }
    if (active && /^<\s*img\b/i.test(tag)) {
      const alt = /\balt\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
      const altText = decodeEntities(alt?.[1] ?? alt?.[2] ?? alt?.[3] ?? "").trim().slice(0, 160);
      if (hasMeaningfulEventHeading(altText)) active.meaningfulImageAlt = true;
    }
    const openingTag = /^<\s*([a-z][\w:-]*)/i.exec(tag)?.[1]?.toLowerCase();
    if (!openingTag || /^<\s*!|^<\s*\?/i.test(tag)) continue;
    if (["div", "section", "article", "li", "tr", "td", "nav", "header", "footer", "main", "body", "html"].includes(openingTag) && !/\/\s*>$/.test(tag)) {
      const attributes = tag.replace(/^<\s*[a-z][\w:-]*/i, "").replace(/>\s*$/, "");
      const role = /\brole\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attributes);
      const className = /\b(?:class|id)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attributes);
      const structuralCard = ["article", "li", "tr"].includes(openingTag) || /^(?:article|listitem)$/i.test(role?.[1] ?? role?.[2] ?? role?.[3] ?? "");
      const labeledCard = /(?:^|\s)(?:card|tile)(?:$|\s)|(?:^|[\s_-])(?:event|race|course)[_-](?:card|tile|item)(?:$|[\s_-])/i
        .test(className?.[1] ?? className?.[2] ?? className?.[3] ?? "");
      scopes.push({
        tag: openingTag,
        heading: null,
        isCard: structuralCard || labeledCard,
        isNavigation: ["nav", "header", "footer"].includes(openingTag) || /^(?:navigation|contentinfo)$/i.test(role?.[1] ?? role?.[2] ?? role?.[3] ?? ""),
      });
    }
    if (/^h[1-6]$/.test(openingTag)) {
      headingElements++;
      activeHeading = { tag: openingTag, pieces: [] };
    }
  }
  finishAnchor();
  return { links, headingElements: boundedDiagnosticCount(headingElements), meaningfulHeadingElements: boundedDiagnosticCount(meaningfulHeadingElements) };
}

const DISTANCE = /(?:^|[^a-z0-9])(\d{1,3}(?:[.,]\d{1,2})?\s*(?:km|k|mi|mile|miles))(?![a-z])/i;
const ROUTE_NAV = /\b(gpx|tracks?|stazes?|stazama|trases?|trasama|routes?|courses?|parcours|recorridos|downloads?)\b/i;
const RACE_NAV = /\b(utrke|races?|events?)\b/i;
const IRRELEVANT_NAV = /\b(account|login|sign[\s_-]?in|register|registration|prijava|partners?|sponsors?|advert|shop|store|news|media|faq|privacy|terms|contact|volunteers?|accommodation|hotel|travel|transport|destination|climate|weather|results?|schedule|program|photos|newsletter|cookies)\b/i;
const DOWNLOAD = /\bdownload\b.{0,40}\b(?:gpx|track|route)\b|\b(?:gpx|track|route)\b.{0,40}\bdownload\b/i;
const GPX_PATH = /\.gpx$/i;

type QueuedPage = { url: URL; depth: number; priority: number; order: number };

function distanceIn(value: string): string | null {
  const matches = [...value.matchAll(new RegExp(DISTANCE.source, "gi"))]
    .map((match) => match[1].replace(/\s+/g, " ").trim().replace(/(\d)\s*(km|mi)$/i, "$1 $2").replace(/k$/i, "K"));
  const unique = [...new Set(matches)];
  return unique.length === 1 ? unique[0] : null;
}

function fileNameFromUrl(url: URL): string | null {
  const segment = url.pathname.split("/").filter(Boolean).at(-1);
  if (!segment) return null;
  try {
    const decoded = decodeURIComponent(segment).replace(/\.gpx$/i, "").replace(/[._-]+/g, " ").replace(/\s+/g, " ").trim();
    return decoded.slice(0, 120) || null;
  } catch {
    return segment.replace(/\.gpx$/i, "").replace(/[._-]+/g, " ").slice(0, 120) || null;
  }
}

function isGpxEvidence(url: URL, link: HtmlLink): boolean {
  const labels = `${link.text} ${link.title}`;
  // A generic “GPX tracks” navigation label is not a file candidate. It can
  // still be followed below as a same-origin course index page.
  return GPX_PATH.test(url.pathname) || DOWNLOAD.test(labels);
}

const GENERIC_EVENT_LABEL = /^(?:learn more|find out more|more|details|saznaj više|saznaj vise|više|vise|event|events|race|races|utrka|utrke|homepage|home)$/i;

function isDistanceRoutePath(pathname: string): boolean {
  const segments = pathname.split("/").filter(Boolean);
  const leaf = segments.at(-1) ?? "";
  return /^(?:\d{1,3}(?:[.,]\d{1,2})?\s*(?:km|k|m|mi|mile|miles))$/i.test(leaf)
    || (/^(?:races?|events?|courses?)$/i.test(segments.at(-2) ?? "") && /^\d{1,3}(?:km|k|m|mi)$/i.test(leaf));
}

function hasMeaningfulEventHeading(name: string): boolean {
  return Boolean(name && name.length <= 160 && !GENERIC_EVENT_LABEL.test(name) && !IRRELEVANT_NAV.test(name)
    && name.split(/\s+/).filter(Boolean).length >= 2);
}

function organizerEventChoices(
  links: HtmlLink[],
  sourceUrl: URL,
  headingElements: number,
  meaningfulHeadingElements: number,
  maxChoices = 8,
): { choices: OfficialGpxEventChoice[]; eventLinkProspects: number; meaningfulHeadingCount: number; structure: OrganizerEventStructureDiagnostic } {
  const choices = new Map<string, OfficialGpxEventChoice>();
  let eventLinkProspects = 0;
  let meaningfulHeadingCount = 0;
  const structure = emptyOrganizerEventStructureDiagnostic();
  structure.headingElements = boundedDiagnosticCount(headingElements);
  structure.meaningfulHeadingElements = boundedDiagnosticCount(meaningfulHeadingElements);
  for (const link of links) {
    const target = sanitizeWebUrl(link.href, sourceUrl, true);
    if (!target || hasSensitiveQuery(target) || target.href === sourceUrl.href || isDistanceRoutePath(target.pathname)
      || isGpxEvidence(target, link) || unsupportedArchiveEvidence(target, link)) continue;
    const priority = subpagePriority(link, target);
    if (priority >= 80 || IRRELEVANT_NAV.test(`${link.text} ${link.title}`)) continue;
    if (link.isNavigation) {
      structure.prospectsExcludedByNavigation = incrementDiagnosticCount(structure.prospectsExcludedByNavigation);
      continue;
    }
    eventLinkProspects = incrementDiagnosticCount(eventLinkProspects);
    if (link.meaningfulAnchorText) structure.prospectsWithMeaningfulAnchorText = incrementDiagnosticCount(structure.prospectsWithMeaningfulAnchorText);
    if (link.meaningfulAriaOrTitle) structure.prospectsWithMeaningfulAriaOrTitle = incrementDiagnosticCount(structure.prospectsWithMeaningfulAriaOrTitle);
    if (link.meaningfulImageAlt) structure.prospectsWithMeaningfulImageAlt = incrementDiagnosticCount(structure.prospectsWithMeaningfulImageAlt);
    if (link.insideSemanticCard) structure.prospectsInsideSemanticCards = incrementDiagnosticCount(structure.prospectsInsideSemanticCards);
    if (link.headingInSharedContainer) structure.prospectsWithHeadingInSharedContainer = incrementDiagnosticCount(structure.prospectsWithHeadingInSharedContainer);
    structure.prospectsByAncestorCategory[link.ancestorCategory] = incrementDiagnosticCount(structure.prospectsByAncestorCategory[link.ancestorCategory]);
    structure.maxProspectNestingDepth = Math.max(structure.maxProspectNestingDepth, Math.min(32, link.nestingDepth));
    const name = link.contextHeading?.trim() ?? "";
    // An enclosing card/section heading is required. Bare navigation labels
    // are too weak to distinguish organizer events from ordinary site menus.
    if (!link.headingInSharedContainer) {
      structure.prospectsRejectedWithoutSharedHeading = incrementDiagnosticCount(structure.prospectsRejectedWithoutSharedHeading);
      continue;
    }
    if (!hasMeaningfulEventHeading(name)) {
      structure.prospectsRejectedWithNonMeaningfulHeading = incrementDiagnosticCount(structure.prospectsRejectedWithNonMeaningfulHeading);
      continue;
    }
    meaningfulHeadingCount = incrementDiagnosticCount(meaningfulHeadingCount);
    const evidence = [
      link.text && `link text: ${link.text}`,
      link.title && `title: ${link.title}`,
      `associated heading: ${name}`,
    ].filter(Boolean) as string[];
    const existing = choices.get(target.href);
    if (existing) {
      existing.supportingEvidence = [...new Set([...existing.supportingEvidence, ...evidence])];
      if (existing.displayName.length < name.length) existing.displayName = name;
      if (!existing.linkText && link.text) existing.linkText = link.text;
    } else if (choices.size < maxChoices) {
      choices.set(target.href, {
        url: target.href,
        sourcePageUrl: publicSourceUrl(sourceUrl),
        linkText: link.text,
        displayName: name,
        supportingEvidence: evidence,
      });
    }
  }
  return { choices: [...choices.values()], eventLinkProspects, meaningfulHeadingCount, structure };
}

function unsupportedArchiveEvidence(url: URL, link: HtmlLink): boolean {
  return /\.zip$/i.test(url.pathname) && /\bgpx\b/i.test(`${link.text} ${link.title}`);
}

function safeContentType(value: string | undefined): OfficialGpxEventDetectionDiagnostic["rootContentType"] {
  if (!value) return "missing";
  const type = value.split(";")[0].trim().toLowerCase();
  return type === "text/html" || type === "application/xhtml+xml" ? type : "other";
}

function rootHtmlProblem(response: SafeHttpsResponse): OfficialGpxEventDetectionDiagnostic["decisionReason"] | null {
  if (response.statusCode < 200 || response.statusCode >= 300) return "root-http-status";
  const contentType = safeContentType(response.headers["content-type"]);
  if (contentType !== "text/html" && contentType !== "application/xhtml+xml") return "root-non-html-content-type";
  const encoding = response.headers["content-encoding"]?.toLowerCase();
  if (encoding && encoding !== "identity") return "root-unsupported-content-encoding";
  if (response.body.byteLength === 0) return "root-empty-body";
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(response.body); } catch { return "root-invalid-utf8"; }
  if (!/<(?:!doctype\s+html|html)\b/i.test(text)) return "root-invalid-html-document";
  return null;
}

function subpagePriority(link: HtmlLink, target: URL): number {
  const label = `${link.text} ${link.title}`.trim();
  let decodedPath = target.pathname;
  try { decodedPath = decodeURIComponent(target.pathname); } catch { /* retain the safely parsed encoded path */ }
  const path = decodedPath.replace(/[-_]+/g, " ");
  const evidence = `${label} ${path}`;
  if (IRRELEVANT_NAV.test(evidence) || DOWNLOAD.test(label)) return 0;

  const routeLabel = ROUTE_NAV.test(label);
  const routePath = ROUTE_NAV.test(path);
  const gpxContext = /\bgpx\b/i.test(evidence);
  if (gpxContext) return 120;
  if (routeLabel) return 100;
  if (routePath) return 80;

  // Individual race pages can expose route pages one level deeper, but generic
  // global race/event indexes are deliberately excluded.
  if (RACE_NAV.test(evidence) && !/\/(?:races?|utrke|events?)(?:\/)?$/i.test(target.pathname)) return 35;
  return 0;
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
  onStage?: (stage: OfficialGpxDiscoveryDiagnostic["stage"]) => void,
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
    onStage?.("dns-resolution");
    const addresses = await withinTimeout(dependencies.resolve(hostname), remaining);
    if (!addresses.length || addresses.some((item) => !isPublicAddress(item.address))) throw new UnsafeDestinationError();

    const requestRemaining = options.timeoutMs - (Date.now() - started);
    if (requestRemaining <= 0) throw new OfficialGpxDiscoveryTimeoutError();
    onStage?.("https-request");
    const response = await withinTimeout(
      dependencies.request(current, addresses[0], options.maxBytes - bytesRead, requestRemaining, options.accept, onStage),
      requestRemaining,
    );
    onStage?.("http-response");
    bytesRead += response.body.byteLength;
    if (bytesRead > options.maxBytes) throw new ResponseSizeLimitError();

    if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
      onStage?.("redirect-validation");
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
  onDiagnostic?: (diagnostic: OfficialGpxDiscoveryDiagnostic) => void,
) {
  return async function discoverOfficialGpx(input: string): Promise<OfficialGpxDiscoveryResult> {
    const firstUrl = validateOfficialPageUrl(input);
    if (!firstUrl) return { status: "invalid-url", candidates: [] };
    if (activeDiscoveries >= limits.maxConcurrentPerProcess) {
      onDiagnostic?.({ stage: "concurrency-guard", reason: "busy", pagesAttempted: 0, subpageDepth: 0, candidatesFound: 0, aggregateBytesAccepted: 0 });
      return { status: "provider-failure", candidates: [], category: "busy" };
    }
    activeDiscoveries++;
    const started = Date.now();
    const candidates = new Map<string, GpxDiscoveryCandidate>();
    const unsupportedResources = new Map<string, UnsupportedGpxResource>();
    const visited = new Set<string>();
    const queue: QueuedPage[] = [{ url: firstUrl, depth: 0, priority: Number.POSITIVE_INFINITY, order: 0 }];
    let nextQueueOrder = 1;
    let responseBytes = 0;
    let failureStage: OfficialGpxDiscoveryDiagnostic["stage"] = "page-processing";
    let failureDepth = 0;
    const eventDetection: OfficialGpxEventDetectionDiagnostic = {
      rootResponseStatus: null,
      rootContentType: null,
      rootHtmlBytesAccepted: 0,
      parsedAnchors: 0,
      sameOriginAnchors: 0,
      eventLinkProspects: 0,
      meaningfulHeadingCount: 0,
      finalDeduplicatedEventChoices: 0,
      gpxCandidatePrecedenceSuppressed: false,
      explicitGpxIndexPrecedenceSuppressed: false,
      structure: emptyOrganizerEventStructureDiagnostic(),
      decisionReason: "root-fetch-failure",
    };
    let rootResponseReceived = false;
    const enqueuePage = (url: URL, depth: number, priority: number) => {
      if (depth > limits.maxSubpageDepth || visited.has(url.href)) return;
      const existingIndex = queue.findIndex((item) => item.url.href === url.href);
      if (existingIndex >= 0) {
        if (queue[existingIndex].priority < priority) queue[existingIndex] = { ...queue[existingIndex], priority };
      } else {
        queue.push({ url, depth, priority, order: nextQueueOrder++ });
      }
      queue.sort((left, right) => right.priority - left.priority || left.order - right.order);
      const available = Math.max(0, limits.maxPages - visited.size);
      if (queue.length > available) queue.length = available;
    };
    try {
      while (queue.length && visited.size < limits.maxPages && candidates.size < limits.maxCandidates && responseBytes < limits.maxTotalResponseBytes) {
        const currentPage = queue.shift()!;
        const pageUrl = currentPage.url;
        if (visited.has(pageUrl.href)) continue;
        visited.add(pageUrl.href);
        failureDepth = currentPage.depth;
        if (queue.length > limits.maxPages - visited.size) queue.length = limits.maxPages - visited.size;
        const fetched = await fetchPublicHttps(pageUrl.href, {
          maxBytes: Math.min(limits.maxResponseBytes, limits.maxTotalResponseBytes - responseBytes),
          timeoutMs: limits.timeoutMs - (Date.now() - started),
          maxRedirects: limits.maxRedirects,
          accept: "text/html",
          sameOriginRedirects: true,
        }, dependencies, (stage) => { failureStage = stage; });
        failureStage = "html-validation";
        if (currentPage.depth === 0) {
          rootResponseReceived = true;
          eventDetection.rootResponseStatus = Number.isInteger(fetched.statusCode) && fetched.statusCode >= 100 && fetched.statusCode <= 599
            ? fetched.statusCode : null;
          eventDetection.rootContentType = safeContentType(fetched.headers["content-type"]);
          const rootIssue = rootHtmlProblem(fetched);
          if (rootIssue) {
            eventDetection.decisionReason = rootIssue;
            throw new InvalidResponseError();
          }
        }
        const { html, sourceUrl } = validateHtmlResponse(fetched);
        failureStage = "page-processing";
        responseBytes += fetched.bytesRead;
        const parsedAnchors = parseAnchorLinks(html);
        const links = parsedAnchors.links;
        if (currentPage.depth === 0) {
          eventDetection.rootHtmlBytesAccepted = Math.max(0, Math.min(limits.maxResponseBytes, fetched.bytesRead));
          eventDetection.parsedAnchors = boundedDiagnosticCount(links.length);
          eventDetection.sameOriginAnchors = boundedDiagnosticCount(links.reduce((count, link) =>
            count + (sanitizeWebUrl(link.href, sourceUrl, true) ? 1 : 0), 0));
        }
        const candidatesBeforePage = candidates.size;
        const routeIndexEvidence = links.some((link) => {
          const target = sanitizeWebUrl(link.href, pageUrl, true);
          return target !== null && !isGpxEvidence(target, link) && subpagePriority(link, target) >= 80;
        });
        for (const link of links) {
          const target = sanitizeWebUrl(link.href, pageUrl, false);
          if (!target) continue;
          const evidence = [
            link.text && `link text: ${link.text}`,
            link.title && `title: ${link.title}`,
            link.contextHeading && `associated heading: ${link.contextHeading}`,
          ].filter(Boolean) as string[];
          const gpxLink = isGpxEvidence(target, link);
          if (gpxLink && !hasSensitiveQuery(target)) {
            const headingDistance = link.contextHeading ? distanceIn(link.contextHeading) : null;
            const linkDistance = distanceIn(`${link.text} ${link.title}`);
            const fileName = fileNameFromUrl(target);
            const distanceLabel = headingDistance ?? linkDistance ?? (fileName ? distanceIn(fileName) : null);
            const visibleText = [link.text, link.title].map((item) => item.trim()).find((item) =>
              item && !/^(?:gpx|track|route|download)(?:\s+(?:track|route|file|download|gpx|tracks|routes))*$/i.test(item),
            ) ?? "";
            const displayLabel = distanceLabel
              ? (headingDistance ? link.contextHeading!.slice(0, 200) : distanceLabel)
              : visibleText
                ? visibleText.slice(0, 200)
                : fileName ?? `${target.hostname}${target.pathname}`.slice(0, 200);
            if (fileName) evidence.push(`filename: ${fileName}`);
            const existing = candidates.get(target.href);
            if (existing) {
              const labelsConflict = existing.distanceLabel && distanceLabel && existing.distanceLabel !== distanceLabel;
              candidates.set(target.href, {
                ...existing,
                distanceLabel: labelsConflict ? null : existing.distanceLabel ?? distanceLabel,
                displayLabel: labelsConflict ? fileName ?? existing.displayLabel : existing.displayLabel || displayLabel,
                linkText: existing.linkText || link.text,
                supportingEvidence: [...new Set([...existing.supportingEvidence, ...evidence])],
              });
            } else {
              candidates.set(target.href, {
                gpxUrl: target.href, sourcePageUrl: publicSourceUrl(sourceUrl), linkText: link.text,
                displayLabel,
                supportingEvidence: evidence.length ? evidence : ["URL path ends in .gpx"],
                distanceLabel,
                discoveryStatus: "link-evidence-only", ambiguity: null,
              });
            }
          } else if (unsupportedArchiveEvidence(target, link) && !hasSensitiveQuery(target)) {
            const heading = link.contextHeading?.trim();
            const fileName = fileNameFromUrl(target);
            const distance = distanceIn(`${heading ?? ""} ${link.text} ${link.title} ${fileName ?? ""}`);
            const displayLabel = heading && !GENERIC_EVENT_LABEL.test(heading)
              ? heading.slice(0, 200)
              : distance ?? fileName ?? "GPX archive";
            const resource: UnsupportedGpxResource = {
              sourcePageUrl: publicSourceUrl(sourceUrl),
              displayLabel,
              linkText: link.text,
              supportingEvidence: [
                link.text && `link text: ${link.text}`,
                heading && `associated heading: ${heading}`,
                `resource format: ZIP archive`,
              ].filter(Boolean) as string[],
              format: "zip",
            };
            unsupportedResources.set(target.href, resource);
          } else if (!gpxLink && target.origin === firstUrl.origin && currentPage.depth < limits.maxSubpageDepth) {
            const priority = subpagePriority(link, target);
            if (priority > 0) enqueuePage(target, currentPage.depth + 1, priority);
          }
          if (candidates.size >= limits.maxCandidates) break;
        }
        if (currentPage.depth === 0) {
          const eventScan = organizerEventChoices(links, sourceUrl, parsedAnchors.headingElements, parsedAnchors.meaningfulHeadingElements);
          eventDetection.eventLinkProspects = eventScan.eventLinkProspects;
          eventDetection.meaningfulHeadingCount = eventScan.meaningfulHeadingCount;
          eventDetection.finalDeduplicatedEventChoices = eventScan.choices.length;
          eventDetection.structure = eventScan.structure;
          eventDetection.gpxCandidatePrecedenceSuppressed = candidates.size > 0;
          eventDetection.explicitGpxIndexPrecedenceSuppressed = candidates.size === 0 && routeIndexEvidence;
          if (candidates.size > 0) {
            eventDetection.decisionReason = "gpx-candidate-precedence";
          } else if (routeIndexEvidence) {
            eventDetection.decisionReason = "explicit-gpx-index-precedence";
          } else if (eventScan.choices.length >= 2) {
            return { status: "event-selection-required", events: eventScan.choices };
          } else if (eventScan.eventLinkProspects === 0) {
            eventDetection.decisionReason = "no-event-link-prospects";
          } else if (eventScan.meaningfulHeadingCount === 0) {
            eventDetection.decisionReason = "no-meaningful-headings";
          } else {
            eventDetection.decisionReason = "fewer-than-two-distinct-event-choices";
          }
        }
        if (candidates.size > candidatesBeforePage) {
          // Once an explicit route page has produced selectable GPX links,
          // do not spend the remaining page budget on lower-confidence race
          // listings or unrelated site navigation.
          for (let index = queue.length - 1; index >= 0; index--) {
            if (queue[index].priority < 80) queue.splice(index, 1);
          }
        }
      }
      const results = [...candidates.values()].map((candidate) => ({ ...candidate, ambiguity: candidates.size > 1 ? "multiple-candidates" as const : null }));
      if (results.length) return { status: "success", candidates: results };
      if (unsupportedResources.size) {
        eventDetection.decisionReason = "unsupported-resources-found";
        onDiagnostic?.({ stage: "page-processing", reason: "unsupported-resources", pagesAttempted: visited.size, subpageDepth: failureDepth, candidatesFound: 0, aggregateBytesAccepted: responseBytes, eventDetection });
        return { status: "unsupported-resources", resources: [...unsupportedResources.values()] };
      }
      if (eventDetection.decisionReason === "root-fetch-failure") eventDetection.decisionReason = "no-supported-gpx-after-crawl";
      onDiagnostic?.({ stage: "page-processing", reason: "no-results", pagesAttempted: visited.size, subpageDepth: failureDepth, candidatesFound: 0, aggregateBytesAccepted: responseBytes, eventDetection });
      return { status: "no-results", candidates: [] };
    } catch (error) {
      const result = safeError(error);
      if (result.status === "provider-failure") {
        if (rootResponseReceived && failureDepth > 0) {
          eventDetection.decisionReason = "provider-failure-during-crawl";
        } else if (eventDetection.decisionReason === "root-fetch-failure") {
          eventDetection.decisionReason = !rootResponseReceived && error instanceof ResponseSizeLimitError
            ? "root-response-size-limit"
            : rootResponseReceived ? "provider-failure-during-crawl" : "root-fetch-failure";
        }
        onDiagnostic?.({
          stage: failureStage,
          reason: error instanceof ResponseSizeLimitError ? "response-size-limit" : result.category,
          pagesAttempted: visited.size,
          subpageDepth: failureDepth,
          candidatesFound: candidates.size,
          aggregateBytesAccepted: responseBytes,
          eventDetection,
        });
      }
      return result;
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

export const discoverOfficialGpx = createOfficialGpxDiscovery(undefined, undefined, (diagnostic) => {
  if (diagnostic.reason === "no-results" || diagnostic.reason === "unsupported-resources") console.info("[race-gpx-discovery] unsuccessful discovery", diagnostic);
  else console.warn("[race-gpx-discovery] provider failure", diagnostic);
});
