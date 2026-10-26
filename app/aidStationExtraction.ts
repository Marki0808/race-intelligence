import { z } from "zod";
import { parseGpxText } from "./gpxAnalysis.ts";

/** Offline, source-preserving aid-station extraction. This module is not wired to Race Mode. */
export const STATION_EVIDENCE_SCHEMA_VERSION = 1 as const;
/** Retained as diagnostic thresholds for source-vs-coordinate discrepancy; never a rejection or scaling rule. */
export const SOURCE_KM_ALIGNMENT_TOLERANCE_KM = 0.5;
export const SOURCE_KM_ALIGNMENT_TOLERANCE_RATIO = 0.005;
/** A route-total sanity guard only; station kilometers are never scaled to compensate. */
export const MATERIAL_COURSE_DISTANCE_DISCREPANCY_KM = 2;
export const MATERIAL_COURSE_DISTANCE_DISCREPANCY_RATIO = 0.05;
export const COORDINATE_MATCH_TOLERANCE_M = 100;

export const stationRoleSchema = z.enum(["aid-station", "water-only", "checkpoint", "start", "finish"]);
export const stationPositionConfidenceSchema = z.enum(["verified", "approximate", "unresolved"]);
const sourceLocatorSchema = z.object({
  kind: z.enum(["next-data-json-path", "html-table-row", "html-table-column", "html-list-item", "html-prose"]),
  path: z.string().min(1).max(300),
  row: z.number().int().nonnegative().optional(),
  column: z.number().int().nonnegative().optional(),
}).strict();
const coordinateSchema = z.object({ latitude: z.number().finite().min(-90).max(90), longitude: z.number().finite().min(-180).max(180) }).strict();
const sourceDistanceSchema = z.object({
  value: z.number().finite().nonnegative(),
  endValue: z.number().finite().nonnegative().optional(),
  unit: z.enum(["km", "mi", "m"]),
  normalizedKm: z.number().finite().nonnegative(),
  endKm: z.number().finite().nonnegative().optional(),
  qualifier: z.enum(["exact", "approximate", "at-least", "range"]),
  semantics: z.enum(["cumulative", "interval", "unknown"]),
}).strict();
export const stationVisitEvidenceV1Schema = z.object({
  schemaVersion: z.literal(STATION_EVIDENCE_SCHEMA_VERSION),
  visitId: z.string().min(1).max(200),
  source: z.object({
    url: z.string().url().max(2_000),
    format: z.enum(["next-data", "html-table", "html-list", "html-prose"]),
    locator: sourceLocatorSchema,
    excerpt: z.string().max(400),
  }).strict(),
  context: z.object({
    eventName: z.string().max(200).nullable(),
    eventId: z.string().max(160).nullable(),
    editionYear: z.number().int().min(1900).max(3000).nullable(),
    courseLabel: z.string().max(160).nullable(),
    courseId: z.string().max(160).nullable(),
    courseDistanceKm: z.number().finite().nonnegative().nullable(),
    selectedGpxUrl: z.string().url().max(2_000).nullable(),
  }).strict(),
  sourceOrder: z.number().int().nonnegative(),
  uid: z.string().max(160).nullable(),
  name: z.string().max(200).nullable(),
  roles: z.array(stationRoleSchema).max(5),
  sequenceRole: z.enum(["start", "intermediate-candidate", "finish", "unclassified"]),
  classification: z.enum(["explicit-role", "inferred-role", "course-point", "station-candidate", "unclassified"]),
  sourcePosition: sourceDistanceSchema.nullable(),
  sourceIntervalToNext: sourceDistanceSchema.nullable(),
  coordinates: coordinateSchema.nullable(),
  sourceAttributes: z.record(z.string(), z.union([z.string().max(200), z.number().finite(), z.boolean(), z.null()])).refine((v) => Object.keys(v).length <= 24),
  position: z.object({
    confidence: stationPositionConfidenceSchema,
    componentIndex: z.number().int().nonnegative().optional(),
    distanceKm: z.number().finite().nonnegative().optional(),
    offsetM: z.number().finite().nonnegative().optional(),
    method: z.enum(["coordinate-projection", "source-distance"]).optional(),
    reason: z.enum(["not-aligned", "course-binding-unverified", "course-identity-mismatch", "source-distance-not-cumulative", "route-distance-mismatch", "coordinate-off-route", "coordinate-match-ambiguous", "source-position-out-of-range"]).optional(),
  }).strict(),
  ambiguities: z.array(z.string().max(120)).max(12),
  supportingEvidence: z.array(z.object({
    url: z.string().url().max(2_000), format: z.enum(["next-data", "html-table", "html-list", "html-prose"]),
    locator: sourceLocatorSchema, excerpt: z.string().max(400),
  }).strict()).max(4).optional(),
}).strict();
export type StationVisitEvidenceV1 = z.infer<typeof stationVisitEvidenceV1Schema>;
export type StationRole = z.infer<typeof stationRoleSchema>;
export type StationExtractionIssue = "malformed-source" | "course-selection-required" | "course-identity-conflict" | "selected-gpx-mismatch" | "no-station-evidence" | "incomplete-source" | "out-of-order-visits" | "duplicate-source-position" | "source-distance-discrepancy" | "conflicting-counts";
export type StationExtractionResult = {
  status: "success" | "course-selection-required" | "rejected" | "no-evidence";
  format: "next-data" | "html";
  visits: StationVisitEvidenceV1[];
  courseChoices: Array<{ label: string; distanceKm: number | null }>;
  completeness: { status: "unknown" | "complete" | "partial" | "conflicting"; declaredCount: number | null; extractedCount: number; basis?: "explicit-count" | "dedicated-course-list" | "course-points-corroborated" };
  countEvidence?: StationCountEvidence;
  issues: StationExtractionIssue[];
};
export type StationCountEvidence = {
  declaredCount: number;
  context: { eventName: string | null; editionYear: number | null; courseLabel: string | null; courseDistanceKm: number | null };
  source: { url: string; format: "html-list" | "html-prose"; locator: { kind: "html-list-item" | "html-prose"; path: string }; excerpt: string };
};
export type StationExtractionOptions = {
  eventName?: string | null;
  expectedEventName?: string | null;
  editionYear?: number | null;
  selectedCourseLabel?: string | null;
  selectedCourseDistanceKm?: number | null;
  selectedGpxUrl?: string | null;
  expectedCourseLabel?: string | null;
  expectedEditionYear?: number | null;
};

const MAX_HTML_BYTES = 2_000_000;
const MAX_VISITS = 500;
const MAX_TREE_NODES = 50_000;
const VALID_URL = /^https:\/\//i;
const emptyResult = (format: StationExtractionResult["format"], status: StationExtractionResult["status"], issues: StationExtractionIssue[] = []): StationExtractionResult => ({
  status, format, visits: [], courseChoices: [], completeness: { status: issues.includes("course-identity-conflict") || issues.includes("selected-gpx-mismatch") ? "conflicting" : issues.includes("incomplete-source") ? "partial" : "unknown", declaredCount: null, extractedCount: 0 }, issues,
});

function validSourceUrl(url: string): boolean { return url.length <= 2_000 && VALID_URL.test(url) && (() => { try { return new URL(url).username === "" && new URL(url).password === ""; } catch { return false; } })(); }
function normalizedOptionalHttpsUrl(value: string | null | undefined, base: string): string | null {
  if (!value) return null;
  try { const url = new URL(value, base); return url.protocol === "https:" && !url.username && !url.password ? url.href : null; } catch { return null; }
}
function cleanText(value: unknown, max = 200): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value).replace(/\s+/g, " ").trim();
  return text ? text.slice(0, max) : null;
}
function finite(value: unknown): number | null { return typeof value === "number" && Number.isFinite(value) ? value : null; }
function sourcePosition(value: number, unit: "km" | "mi" | "m", qualifier: "exact" | "approximate" | "at-least" | "range" = "exact", semantics: "cumulative" | "interval" | "unknown" = "unknown", endValue?: number): z.infer<typeof sourceDistanceSchema> {
  const factor = unit === "mi" ? 1.609344 : unit === "m" ? 0.001 : 1;
  return { value, ...(endValue === undefined ? {} : { endValue }), unit, normalizedKm: value * factor, ...(endValue === undefined ? {} : { endKm: endValue * factor }), qualifier: endValue === undefined ? qualifier : "range", semantics };
}
function initialPosition(): StationVisitEvidenceV1["position"] { return { confidence: "unresolved", reason: "not-aligned" }; }
function buildVisit(input: Omit<StationVisitEvidenceV1, "schemaVersion" | "position">): StationVisitEvidenceV1 {
  return stationVisitEvidenceV1Schema.parse({ ...input, schemaVersion: STATION_EVIDENCE_SCHEMA_VERSION, position: initialPosition() });
}
function result(format: StationExtractionResult["format"], visits: StationVisitEvidenceV1[], choices: StationExtractionResult["courseChoices"] = [], issues: StationExtractionIssue[] = [], completeness?: StationExtractionResult["completeness"]): StationExtractionResult {
  const ordered = visits.slice(0, MAX_VISITS).map((visit) => ({ ...visit, ambiguities: [...visit.ambiguities] }));
  let previous: { index: number; km: number } | null = null;
  for (let i = 0; i < ordered.length; i++) {
    const pos = ordered[i].sourcePosition;
    if (!pos || pos.semantics !== "cumulative") continue;
    if (previous && pos.normalizedKm < previous.km - 0.01) {
      ordered[previous.index].ambiguities.push("source-distance-out-of-order"); ordered[i].ambiguities.push("source-distance-out-of-order");
      if (!issues.includes("out-of-order-visits")) issues.push("out-of-order-visits");
    }
    if (previous && Math.abs(pos.normalizedKm - previous.km) <= 0.001) {
      ordered[previous.index].ambiguities.push("duplicate-source-position"); ordered[i].ambiguities.push("duplicate-source-position");
      if (!issues.includes("duplicate-source-position")) issues.push("duplicate-source-position");
    }
    previous = { index: i, km: pos.normalizedKm };
  }
  return { status: ordered.length ? "success" : issues.includes("course-selection-required") ? "course-selection-required" : issues.includes("course-identity-conflict") || issues.includes("selected-gpx-mismatch") ? "rejected" : "no-evidence", format, visits: ordered, courseChoices: choices, completeness: completeness ?? { status: issues.includes("course-identity-conflict") || issues.includes("selected-gpx-mismatch") ? "conflicting" : issues.includes("incomplete-source") || issues.includes("out-of-order-visits") ? "partial" : "unknown", declaredCount: null, extractedCount: ordered.length }, issues };
}

function rolesFromExplicitText(text: string): StationRole[] {
  const t = text.toLocaleLowerCase();
  const roles: StationRole[] = [];
  if (/\b(water[- ]only|water station|water point|drink station|drinks point|water checkpoint)\b/.test(t)) roles.push("water-only");
  if (/\b(aid station|aid point|feed station|feeding station|refreshment station|checkpoint with aid)\b/.test(t)) roles.push("aid-station");
  if (/\b(checkpoint|control point|timing point)\b/.test(t)) roles.push("checkpoint");
  if (/\b(start|starting line)\b/.test(t)) roles.push("start");
  if (/\b(finish|finish line)\b/.test(t)) roles.push("finish");
  return [...new Set(roles)];
}
function extractDistance(text: string, semantics: "cumulative" | "interval" | "unknown" = "unknown"): z.infer<typeof sourceDistanceSchema> | null {
  const unitPattern = "(?:km|kilomet(?:er|re)s?|mi|miles?|m)\\b";
  const range = new RegExp(`(\\d+(?:[.,]\\d+)?)\\s*(?:${unitPattern})?\\s*(?:-|–|—|\\bto\\b)\\s*(\\d+(?:[.,]\\d+)?)\\s*(${unitPattern})`, "i").exec(text);
  if (range) {
    const start = Number(range[1].replace(",", ".")); const end = Number(range[2].replace(",", ".")); const unitText = range[3].toLowerCase();
    if (Number.isFinite(start) && Number.isFinite(end) && end >= start) return sourcePosition(start, unitText.startsWith("mi") ? "mi" : unitText === "m" ? "m" : "km", "range", semantics, end);
  }
  const re = new RegExp(`(\\bapprox(?:imately)?\\.?|\\babout\\b|\\bca\\.?|~)?\\s*(\\d+(?:[.,]\\d+)?)(\\+)?\\s*(${unitPattern})\\s*(?:\\bto\\s*(\\d+(?:[.,]\\d+)?)\\s*(?:${unitPattern})?)?`, "i");
  const match = re.exec(text);
  if (!match) {
    const prefix = new RegExp(`\\b(${unitPattern})\\s*(\\d+(?:[.,]\\d+)?)(\\+)?`, "i").exec(text);
    if (prefix) {
      const unit = prefix[1].toLowerCase().startsWith("mi") ? "mi" : "km";
      const value = Number(prefix[2].replace(",", "."));
      return Number.isFinite(value) ? sourcePosition(value, unit, prefix[3] ? "at-least" : "exact", semantics) : null;
    }
  }
  if (!match) return null;
  const value = Number(match[2].replace(",", "."));
  const end = match[5] ? Number(match[5].replace(",", ".")) : undefined;
  if (!Number.isFinite(value) || (end !== undefined && (!Number.isFinite(end) || end < value))) return null;
  const u = match[4].toLowerCase();
  const unit = u.startsWith("mi") ? "mi" : u === "m" ? "m" : "km";
  const qualifier = end !== undefined ? "range" : match[3] === "+" ? "at-least" : match[1] ? "approximate" : "exact";
  return sourcePosition(value, unit, qualifier, semantics, end);
}
function extractName(raw: string): string | null {
  let value = raw.replace(/\([^)]*\)/g, " ").replace(/\b(?:aid station|water[- ]only point|water station|checkpoint|control point|timing point|feed station|refreshment station)\b/gi, " ");
  value = value.replace(/\b(?:at|km|mile|mi|miles?)\s*\d+(?:[.,]\d+)?\s*(?:km|mi|miles?)?/gi, " ");
  value = value.replace(/\b\d+(?:[.,]\d+)?\s*(?:km|kilomet(?:er|re)s?|mi|miles?)\b/gi, " ");
  value = value.replace(/^\s*(?:station|aid|water|checkpoint|cp|as)?\s*#?\s*\d{1,3}\s*[:.)\-–—|]*\s*/i, "");
  value = value.replace(/\b(?:approximately|approx\.?|about|ca\.?)\b/gi, " ");
  value = value.replace(/[|;,.:\-–—]+$/g, "").replace(/^['“”" ]+|['“”" ]+$/g, "").replace(/[\s,.;:|]+$/g, "").replace(/\s+/g, " ").trim();
  if (!value || value.length > 120 || /^(?:aid station|water station|checkpoint|station|start|finish)$/i.test(value)) return null;
  return value.slice(0, 120);
}
function parseRolesAndName(text: string, contextRoles: readonly StationRole[] = []): { roles: StationRole[]; name: string | null } {
  const roles = rolesFromExplicitText(text);
  for (const role of contextRoles) if (!roles.includes(role)) roles.push(role);
  let name: string | null = null;
  const patterns = [
    /\b(?:km|mile|mi)\s*\d+(?:[.,]\d+)?\s*[:–—-]\s*(.+)$/i,
    /\b(?:aid station|water station|water[- ]only point|checkpoint|feed station)\s*(?:#?\d+\s*)?(?:at\s*)?(?:km\s*)?\d+(?:[.,]\d+)?\s*(?:km|mi|miles?)?\s*[:–—-]\s*(.+)$/i,
    /\b(?:at\s*)?(?:km\s*)?\d+(?:[.,]\d+)?\s*(km|mi|miles?)\s*[,;:]?\s*(?:the\s+)?(.+?)\s+(?:is\s+)?(?:an?\s+)?(?:aid station|water station|checkpoint)\b/i,
    /\b(?:aid station|water station|checkpoint)\s+(?:called|named)\s+(.+?)(?:\s+at\s+|\s*,?\s*(?:km|mile)\s*\d|$)/i,
  ];
  for (let i = 0; i < patterns.length; i++) {
    const m = patterns[i].exec(text);
    if (m) { name = extractName(m[i === 2 ? 2 : 1]); if (name) break; }
  }
  if (!name) {
    // Only accept the explicitly delimited name portion of compact list/table-like text.
    const parts = text.split(/[:|–—]/).map((p) => p.trim());
    if (parts.length > 1) name = extractName(parts.slice(1).join(" "));
  }
  return { roles, name };
}

type JsonRecord = Record<string, unknown>;
function asRecord(value: unknown): JsonRecord | null { return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null; }
function getPath(value: unknown, path: string[]): unknown { let cursor = value; for (const key of path) { const record = asRecord(cursor); if (!record) return undefined; cursor = record[key]; } return cursor; }
function htmlDecode(text: string): string {
  return text.replace(/&(#x[\da-f]+|#\d+|nbsp|amp|lt|gt|quot|apos);/gi, (_all, entity: string) => {
    const lower = entity.toLowerCase();
    if (lower === "nbsp") return " "; if (lower === "amp") return "&"; if (lower === "lt") return "<"; if (lower === "gt") return ">"; if (lower === "quot") return '"'; if (lower === "apos") return "'";
    const code = lower.startsWith("#x") ? Number.parseInt(lower.slice(2), 16) : Number.parseInt(lower.slice(1), 10);
    return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
  });
}
type HtmlNode = { tag: string; attrs: Record<string, string>; parent: HtmlNode | null; children: Array<HtmlNode | string> };
function parseHtmlTree(html: string): HtmlNode | null {
  if (new TextEncoder().encode(html).length > MAX_HTML_BYTES) return null;
  const root: HtmlNode = { tag: "#root", attrs: {}, parent: null, children: [] };
  const stack: HtmlNode[] = [root];
  const voidTags = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
  const token = /<!--[\s\S]*?-->|<![^>]*>|<\/?[a-zA-Z][^>]*>|[^<]+/g;
  let match: RegExpExecArray | null; let nodes = 0; let skipRaw: string | null = null;
  while ((match = token.exec(html)) && nodes < MAX_TREE_NODES) {
    const t = match[0];
    if (skipRaw) { if (new RegExp(`<\\/${skipRaw}\\s*>`, "i").test(t)) skipRaw = null; continue; }
    if (t.startsWith("<!--") || /^<!/i.test(t)) continue;
    const close = /^<\//.test(t); const tagMatch = /^<\/?\s*([\w:-]+)/.exec(t); if (!tagMatch) { if (t[0] !== "<") stack[stack.length - 1].children.push(htmlDecode(t)); continue; }
    const tag = tagMatch[1].toLowerCase();
    if (close) { for (let i = stack.length - 1; i > 0; i--) { if (stack[i].tag === tag) { stack.length = i; break; } } continue; }
    const attrs: Record<string, string> = {};
    const rest = t.slice(tagMatch[0].length, t.length - 1);
    const attrRe = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g; let a: RegExpExecArray | null;
    while ((a = attrRe.exec(rest))) attrs[a[1].toLowerCase()] = htmlDecode(a[2] ?? a[3] ?? a[4] ?? "").slice(0, 500);
    const node: HtmlNode = { tag, attrs, parent: stack[stack.length - 1], children: [] }; node.parent!.children.push(node); nodes++;
    if (tag === "script" || tag === "style") { skipRaw = tag; continue; }
    if (!voidTags.has(tag) && !/\/\s*>$/.test(t)) stack.push(node);
  }
  if (nodes >= MAX_TREE_NODES) return null;
  // Truncated table markup is not reliable evidence. Ordinary optional end tags remain tolerated elsewhere.
  if (stack.some((node) => ["table", "tr", "td", "th"].includes(node.tag))) return null;
  return root;
}
function nodeText(node: HtmlNode): string {
  const all: string[] = []; const visit = (n: HtmlNode): void => { if (["script", "style", "noscript"].includes(n.tag)) return; for (const child of n.children) { if (typeof child === "string") all.push(child); else visit(child); } };
  visit(node); return all.join(" ").replace(/\s+/g, " ").trim().slice(0, 2_000);
}
function descendants(node: HtmlNode, tag: string): HtmlNode[] {
  const found: HtmlNode[] = []; const visit = (n: HtmlNode): void => { for (const child of n.children) if (typeof child !== "string") { if (child.tag === tag) found.push(child); visit(child); } }; visit(node); return found;
}
function attrsForDistance(text: string): { label: string; km: number | null } | null {
  let d = extractDistance(text, "unknown");
  if (!d) {
    const compactKm = /(\d+(?:[.,]\d+)?)\s*k\b/i.exec(text);
    if (compactKm) { const value = Number(compactKm[1].replace(",", ".")); if (Number.isFinite(value)) d = sourcePosition(value, "km", "exact", "unknown"); }
  }
  if (!d) return null;
  const label = text.replace(/\s+/g, " ").trim();
  return { label: label.slice(0, 160), km: d.normalizedKm };
}
function sameSelectedCourse(course: { label: string; km: number | null }, options: StationExtractionOptions): boolean {
  if (options.selectedCourseDistanceKm != null && course.km != null) return Math.abs(course.km - options.selectedCourseDistanceKm) <= Math.max(0.05, options.selectedCourseDistanceKm * 0.001);
  if (options.selectedCourseLabel) return course.label.toLocaleLowerCase().includes(options.selectedCourseLabel.toLocaleLowerCase());
  return false;
}
function effectiveEdition(options: StationExtractionOptions, sourceYear: number | null): number | null {
  if (options.expectedEditionYear != null && sourceYear != null && options.expectedEditionYear !== sourceYear) return -1;
  return sourceYear ?? options.editionYear ?? null;
}
function toContext(options: StationExtractionOptions, courseLabel: string | null, courseKm: number | null, year: number | null, eventName: string | null, selectedGpxUrl: string | null = null, eventId: string | null = null, courseId: string | null = null) {
  return { eventName: options.eventName ?? eventName, eventId, editionYear: year, courseLabel: courseLabel ?? options.selectedCourseLabel ?? options.expectedCourseLabel ?? null, courseId, courseDistanceKm: courseKm ?? options.selectedCourseDistanceKm ?? null, selectedGpxUrl: selectedGpxUrl ?? options.selectedGpxUrl ?? null };
}

/** Extract course points from a Next.js __NEXT_DATA__ payload without interpreting service booleans as roles. */
function extractNextDataStationEvidenceInternal(html: string, sourceUrl: string, options: StationExtractionOptions = {}): StationExtractionResult {
  if (!validSourceUrl(sourceUrl) || html.length > MAX_HTML_BYTES) return emptyResult("next-data", "rejected", ["malformed-source"]);
  const script = /<script\b(?=[^>]*\bid\s*=\s*(["'])__NEXT_DATA__\1)[^>]*>([\s\S]*?)<\/script\s*>/i.exec(html);
  if (!script) return emptyResult("next-data", "no-evidence", ["malformed-source"]);
  let payload: unknown; try { payload = JSON.parse(script[2]); } catch { return emptyResult("next-data", "rejected", ["malformed-source"]); }
  const pageProps = getPath(payload, ["props", "pageProps"]); const pagePropsRecord = asRecord(pageProps); const track = asRecord(pagePropsRecord?.track); const points = track?.points;
  if (!Array.isArray(points) || points.length === 0) return emptyResult("next-data", "no-evidence", ["no-station-evidence"]);
  if (points.length < 2) return emptyResult("next-data", "rejected", ["incomplete-source"]);
  if (points.length > MAX_VISITS) return emptyResult("next-data", "rejected", ["incomplete-source"]);
  const event = asRecord(asRecord(pageProps)?.event); const raceQuery = asRecord(getPath(payload, ["query"]));
  const eventName = cleanText(event?.name ?? event?.title); const editionDate = cleanText(event?.begin ?? event?.startDate, 40); const yearMatch = editionDate?.match(/(?:^|\D)(20\d{2})(?:\D|$)/); const sourceYear = yearMatch ? Number(yearMatch[1]) : null;
  const year = effectiveEdition(options, sourceYear); if (year === -1) return emptyResult("next-data", "rejected", ["course-identity-conflict"]);
  const courseLabel = cleanText(raceQuery?.race ?? raceQuery?.course ?? track?.name, 160);
  const trackDistanceKm = finite(track?.distanceKm); const trackDistanceM = finite(track?.distanceM ?? track?.distance);
  const courseKm = trackDistanceKm ?? (trackDistanceM == null ? null : trackDistanceM / 1000);
  const gpxUrl = cleanText(pagePropsRecord?.gpxUrl ?? track?.gpxUrl ?? track?.gpx, 2_000);
  const normalizedGpxUrl = normalizedOptionalHttpsUrl(gpxUrl, sourceUrl);
  if (!normalizedGpxUrl) return emptyResult("next-data", "rejected", ["incomplete-source"]);
  const selectedGpxUrl = normalizedOptionalHttpsUrl(options.selectedGpxUrl, sourceUrl);
  if (options.selectedGpxUrl && selectedGpxUrl !== normalizedGpxUrl) return emptyResult("next-data", "rejected", ["selected-gpx-mismatch"]);
  if (options.expectedEventName && eventName && eventName.toLocaleLowerCase() !== options.expectedEventName.toLocaleLowerCase()) return emptyResult("next-data", "rejected", ["course-identity-conflict"]);
  if (options.expectedCourseLabel && courseLabel && !courseLabel.toLocaleLowerCase().includes(options.expectedCourseLabel.toLocaleLowerCase())) return emptyResult("next-data", "rejected", ["course-identity-conflict"]);
  if (options.selectedCourseLabel && courseLabel && !courseLabel.toLocaleLowerCase().includes(options.selectedCourseLabel.toLocaleLowerCase())) return emptyResult("next-data", "rejected", ["course-identity-conflict"]);
  if (gpxUrl) { try { const u = new URL(gpxUrl, sourceUrl); if (u.protocol !== "https:" || !/\.gpx(?:$|[?#])/i.test(u.href)) return emptyResult("next-data", "rejected", ["course-identity-conflict"]); } catch { return emptyResult("next-data", "rejected", ["course-identity-conflict"]); } }
  const records = points.map(asRecord); if (records.some((p) => !p)) return emptyResult("next-data", "rejected", ["malformed-source"]);
  const visits = records.map((point, index) => {
    const p = point!; const name = cleanText(p.name ?? p.shortName); const lat = finite(p.lat ?? p.latitude); const lon = finite(p.lon ?? p.lng ?? p.longitude);
    const coords = lat != null && lon != null && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { latitude: lat, longitude: lon } : null;
    const rawDistance = finite(p.distance ?? p.distanceM ?? p.km); const distanceUnit = p.distanceM !== undefined || (rawDistance != null && rawDistance > 1000) ? "m" : p.km !== undefined ? "km" : "m";
    const sourcePos = rawDistance == null ? null : sourcePosition(distanceUnit === "m" && rawDistance > 1000 ? rawDistance : rawDistance, distanceUnit, "exact", "cumulative");
    const explicitRoleText = [p.type, p.role, p.kind, p.category].map((v) => cleanText(v, 80) ?? "").join(" "); const roles = rolesFromExplicitText(explicitRoleText);
    if (p.isWaterOnly === true && !roles.includes("water-only")) roles.push("water-only");
    if (p.isAidStation === true && !roles.includes("aid-station")) roles.push("aid-station");
    if (p.isCheckpoint === true && !roles.includes("checkpoint")) roles.push("checkpoint");
    if (index === 0 && sourcePos?.normalizedKm === 0 && !roles.includes("start")) roles.push("start");
    if (index === records.length - 1 && courseKm != null && sourcePos && Math.abs(sourcePos.normalizedKm - courseKm) <= Math.max(0.2, courseKm * 0.005) && !roles.includes("finish")) roles.push("finish");
    const attrs: StationVisitEvidenceV1["sourceAttributes"] = {};
    for (const [key, raw] of Object.entries(p)) {
      if (["uid", "name", "shortName", "lat", "lon", "latitude", "longitude", "distance", "distanceM", "km", "cutoffDatetime"].includes(key) || !/^[A-Za-z][\w-]{0,39}$/.test(key)) continue;
      if (typeof raw === "boolean" || (typeof raw === "number" && Number.isFinite(raw))) attrs[key] = raw;
      else if (typeof raw === "string" && raw.length <= 200) attrs[key] = raw;
      else if (key.toLocaleLowerCase() === "supplies" && Array.isArray(raw) && raw.length <= 8 && raw.every((item) => typeof item === "string" && item.length <= 80)) attrs[key] = (raw as string[]).join(", ").slice(0, 200);
      if (Object.keys(attrs).length >= 24) break;
    }
    const sequenceRole = roles.includes("start") ? "start" : roles.includes("finish") ? "finish" : index > 0 && index < records.length - 1 ? "intermediate-candidate" : "unclassified";
    return buildVisit({
      visitId: `${sourceUrl}#track-point-${index}`, source: { url: sourceUrl, format: "next-data", locator: { kind: "next-data-json-path", path: `props.pageProps.track.points[${index}]` }, excerpt: JSON.stringify({ name: p.name, shortName: p.shortName, distance: p.distance, type: p.type, supplies: p.supplies }).slice(0, 400) },
      context: toContext(options, courseLabel, courseKm, year, eventName, normalizedGpxUrl, cleanText(event?.id ?? event?.eventId, 160), cleanText(pagePropsRecord?.raceId ?? raceQuery?.raceId ?? raceQuery?.race, 160)), sourceOrder: index, uid: cleanText(p.uid, 160), name, roles, sequenceRole, classification: roles.length ? "explicit-role" : "course-point", sourcePosition: sourcePos, sourceIntervalToNext: null, coordinates: coords, sourceAttributes: attrs, ambiguities: coords ? [] : ["missing-coordinates"],
    });
  });
  return result("next-data", visits);
}
export function extractNextDataStationEvidence(html: string, sourceUrl: string, options: StationExtractionOptions = {}): StationExtractionResult {
  try { return extractNextDataStationEvidenceInternal(html, sourceUrl, options); } catch { return emptyResult("next-data", "rejected", ["malformed-source"]); }
}

type HtmlBlock = { kind: "table" | "list" | "prose"; node: HtmlNode; text: string; locator: string; headings: string[] };
function collectHtmlBlocks(root: HtmlNode): HtmlBlock[] {
  const blocks: HtmlBlock[] = []; const headingStack: Array<{ level: number; text: string }> = []; let tableNo = 0; let listNo = 0; let paragraphNo = 0;
  const visit = (node: HtmlNode): void => {
    if (/^h[1-6]$/.test(node.tag)) { const level = Number(node.tag[1]); while (headingStack.length && headingStack.at(-1)!.level >= level) headingStack.pop(); const text = nodeText(node); if (text) headingStack.push({ level, text }); return; }
    if (node.tag === "table") { blocks.push({ kind: "table", node, text: nodeText(node), locator: `table[${tableNo++}]`, headings: headingStack.map((h) => h.text) }); return; }
    if (node.tag === "li") { blocks.push({ kind: "list", node, text: nodeText(node), locator: `list-item[${listNo++}]`, headings: headingStack.map((h) => h.text) }); return; }
    if (node.tag === "p") { blocks.push({ kind: "prose", node, text: nodeText(node), locator: `paragraph[${paragraphNo++}]`, headings: headingStack.map((h) => h.text) }); return; }
    for (const child of node.children) if (typeof child !== "string") visit(child);
  };
  visit(root); return blocks;
}
function courseFromHeadings(headings: string[]): { label: string | null; km: number | null } {
  for (let i = headings.length - 1; i >= 0; i--) { const parsed = attrsForDistance(headings[i]); if (parsed && /\b(course|race|run|trail|ultra|\d+\s*(?:k|km|m|mi|mile))/i.test(headings[i])) return parsed; }
  return { label: null, km: null };
}
function declaredStationCount(headings: string[]): number | null {
  const text = headings.join(" | ");
  if (!courseFromHeadings(headings).km || !/\b(aid stations?|water stations?|checkpoints?|refreshment points?)\b/i.test(text)) return null;
  const patterns = [
    /\b(?:total(?: of)?\s+)(\d{1,3})\s+(?:aid stations?|water stations?|checkpoints?|refreshment points?)\b/i,
    /\b(\d{1,3})\s+(?:aid stations?|water stations?|checkpoints?|refreshment points?)\s+(?:in total|overall)\b/i,
    /\b(?:aid stations?|water stations?|checkpoints?|refreshment points?)\s*\(\s*(\d{1,3})\s*\)/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match) return Number(match[1]);
  }
  return null;
}
function tableRows(table: HtmlNode): string[][] {
  return descendants(table, "tr").map((row) => {
    const cells: string[] = [];
    const visit = (node: HtmlNode): void => { for (const child of node.children) if (typeof child !== "string") { if (child.tag === "th" || child.tag === "td") cells.push(nodeText(child)); else visit(child); } };
    visit(row); return cells;
  });
}
function normalizedTableRowLabel(value: string): string {
  return value.toLocaleLowerCase().replace(/[\s:：]+/g, " ").replace(/[()\[\]]/g, "").trim();
}
function extractTransposedHtmlTable(block: HtmlBlock, sourceUrl: string, options: StationExtractionOptions, eventName: string | null, year: number | null, rows: string[][]): StationVisitEvidenceV1[] {
  if (rows.length < 2 || rows.length > 40) return [];
  const width = rows[0]?.length ?? 0;
  // Column alignment is the evidence: a ragged table cannot safely pair names and distances.
  if (width < 2 || width > MAX_VISITS + 1 || rows.some((row) => row.length !== width)) return [];
  const headingText = block.headings.join(" ");
  const stationNameRows = rows.flatMap((row, index) => {
    const label = normalizedTableRowLabel(row[0] ?? "");
    const aidRow = /^(?:aid stations?|aid points?)$/.test(label);
    const waterRow = /^(?:water stations?|water[- ]only points?)$/.test(label);
    const checkpointRow = /^(?:checkpoints?|control points?|timing points?)$/.test(label);
    const genericStationRow = /^(?:stations?|station names?|locations?|places?)$/.test(label) && /\b(?:aid stations?|water stations?|checkpoints?|refreshment points?)\b/i.test(headingText);
    return aidRow || waterRow || checkpointRow || genericStationRow
      ? [{ index, roles: aidRow || genericStationRow ? ["aid-station" as const] : waterRow ? ["water-only" as const] : ["checkpoint" as const] }]
      : [];
  });
  if (stationNameRows.length !== 1) return [];
  const distanceRows = rows.flatMap((row, index) => {
    const label = normalizedTableRowLabel(row[0] ?? "");
    if (/\b(?:to next|next|between|interval|remaining)\b/.test(label)) return [];
    return /^(?:distance|course distance|distance from start|km|kilometers?|kilometres?|mileage)(?:\s+(?:\(?(?:km|mi|m)\)?))?$/.test(label)
      ? [{ index, label }]
      : [];
  });
  if (distanceRows.length !== 1) return [];
  const nameRow = stationNameRows[0];
  const distanceRow = distanceRows[0];
  if (nameRow.index === distanceRow.index) return [];
  const contextCourse = courseFromHeadings(block.headings);
  const courseLabel = contextCourse.label ?? options.selectedCourseLabel ?? options.expectedCourseLabel ?? null;
  const courseKm = contextCourse.km ?? options.selectedCourseDistanceKm ?? null;
  const distanceLabel = rows[distanceRow.index][0] ?? "";
  const inferredUnit: "km" | "mi" | "m" | null = /\bmi(?:le|les)?\b/.test(distanceLabel) ? "mi" : /\bmeters?\b|\(m\)/.test(distanceLabel) ? "m" : /\bkm\b|kilomet/.test(distanceLabel) ? "km" : null;
  const visits: StationVisitEvidenceV1[] = [];
  const seenPositions = new Set<number>();
  for (let column = 1; column < width; column++) {
    const rawName = cleanText(rows[nameRow.index][column], 200);
    const rawDistance = cleanText(rows[distanceRow.index][column], 100);
    if (!rawName || !rawDistance) return [];
    const nameRoles = rolesFromExplicitText(rawName);
    const isStart = nameRoles.includes("start") || /^start(?:ing)?(?:\s|$)/i.test(rawName);
    const isFinish = nameRoles.includes("finish") || /^finish(?:\s|$)/i.test(rawName);
    const postFinish = /\b(?:after|post)[- ]finish\b|\bfinish(?:-line)? refreshments\b/i.test(rawName);
    if (postFinish) return [];
    const distanceText = /\b(?:km|kilomet(?:er|re)s?|mi|miles?|m)\b/i.test(rawDistance)
      ? rawDistance
      : inferredUnit ? `${rawDistance} ${inferredUnit}` : rawDistance;
    const position = extractDistance(distanceText, "cumulative");
    if (!position || position.qualifier === "range" || position.qualifier === "at-least") return [];
    const km = position.normalizedKm;
    if ((!isStart && km <= 0) || (courseKm != null && (km > courseKm + 0.001 || (!isFinish && km >= courseKm - 0.001))) || [...seenPositions].some((prior) => Math.abs(prior - km) <= 0.001)) return [];
    seenPositions.add(km);
    // An aid-station table may include explicit start/finish columns; never label those as aid visits.
    const roles = isStart ? ["start" as const] : isFinish ? ["finish" as const] : [...new Set([...nameRow.roles, ...nameRoles])];
    const excerpt = `${rows[nameRow.index][0]}: ${rawName} | ${distanceLabel}: ${rawDistance}`.slice(0, 400);
    const name = extractName(rawName) ?? (isStart || isFinish ? rawName : null);
    if (!name) return [];
    visits.push(buildVisit({
      visitId: `${sourceUrl}#${block.locator}-column-${column}`,
      source: { url: sourceUrl, format: "html-table", locator: { kind: "html-table-column", path: block.locator, row: nameRow.index, column }, excerpt },
      context: toContext(options, courseLabel, courseKm, year, eventName), sourceOrder: column - 1, uid: null, name, roles,
      sequenceRole: isStart ? "start" : isFinish ? "finish" : "intermediate-candidate",
      classification: roles.length ? "explicit-role" : "station-candidate", sourcePosition: position, sourceIntervalToNext: null, coordinates: null,
      sourceAttributes: { nameRow: rows[nameRow.index][0].slice(0, 200), distanceRow: distanceLabel.slice(0, 200), columnIndex: column },
      ambiguities: [],
    }));
  }
  return visits;
}
function extractHtmlTable(block: HtmlBlock, sourceUrl: string, options: StationExtractionOptions, eventName: string | null, year: number | null): StationVisitEvidenceV1[] {
  const rows = tableRows(block.node); if (rows.length < 2) return [];
  const header = rows[0].map((s) => s.toLocaleLowerCase());
  const nameIdx = header.findIndex((h) => /\b(name|location|station|aid point|place)\b/.test(h));
  const distanceIdx = header.findIndex((h) => /\b(km|kilomet|mile|mileage|distance|marker)\b/.test(h) && !/\b(next|between|interval|remaining|to next)\b/.test(h));
  const nextIdx = header.findIndex((h) => /\b(next|interval|between|to next)\b/.test(h) && /\b(km|mile|distance)?\b/.test(h));
  const contextCourse = courseFromHeadings(block.headings);
  const courseLabel = contextCourse.label ?? options.selectedCourseLabel ?? options.expectedCourseLabel ?? null;
  const courseKm = contextCourse.km ?? options.selectedCourseDistanceKm ?? null;
  if (nameIdx < 0 || distanceIdx < 0 || !/(?:station|aid|checkpoint|water)/i.test(`${block.headings.join(" ")} ${header.join(" ")}`)) {
    return extractTransposedHtmlTable(block, sourceUrl, options, eventName, year, rows);
  }
  const hDistance = header[distanceIdx]; const semantics: "cumulative" | "interval" | "unknown" = /\b(from start|course km|mile marker|cumulative|distance along)\b/.test(hDistance) || /^(?:km|kilomet(?:er|re)s?|mile|miles|mileage)$/i.test(hDistance.trim()) ? "cumulative" : /\b(next|interval|between|to next)\b/.test(hDistance) ? "interval" : "unknown";
  return rows.slice(1).flatMap((row, rowIndex) => {
    const cellText = row.join(" | ");
    const numericCell = (value: string, headerText: string): string => /^\s*\d+(?:[.,]\d+)?\s*(?:\+|to\s*\d+(?:[.,]\d+)?)?\s*$/i.test(value) ? `${value} ${/\bmi(?:les)?\b/.test(headerText) ? "mi" : /\bmeters?\b|\(m\)/.test(headerText) ? "m" : "km"}` : value;
    const position = extractDistance(numericCell(row[distanceIdx] ?? "", hDistance), semantics); if (!position) return [];
    const name = extractName(row[nameIdx] ?? ""); if (!name) return [];
    const roleText = [name, cellText, block.headings.join(" ")].join(" "); const contextRoles = [...stationContextRoles(block.headings), ...stationContextRoles([header.join(" ")])];
    const parsed = parseRolesAndName(roleText, contextRoles); const roles = parsed.roles;
    const intervalHeader = nextIdx >= 0 ? header[nextIdx] : "";
    const interval = nextIdx >= 0 ? extractDistance(numericCell(row[nextIdx] ?? "", intervalHeader), "interval") : null;
    return [buildVisit({
      visitId: `${sourceUrl}#${block.locator}-row-${rowIndex + 1}`, source: { url: sourceUrl, format: "html-table", locator: { kind: "html-table-row", path: block.locator, row: rowIndex + 1 }, excerpt: cellText.slice(0, 400) },
      context: toContext(options, courseLabel, courseKm, year, eventName), sourceOrder: rowIndex, uid: cleanText(row[0], 160), name, roles, sequenceRole: roles.includes("start") ? "start" : roles.includes("finish") ? "finish" : "intermediate-candidate", classification: roles.length ? "explicit-role" : "station-candidate", sourcePosition: position, sourceIntervalToNext: interval, coordinates: null, sourceAttributes: { header: header.join(" | ").slice(0, 200) }, ambiguities: semantics === "unknown" ? ["distance-semantics-unclear"] : [],
    })];
  });
}
function stationContextRoles(headings: string[]): StationRole[] {
  const text = headings.join(" ").toLocaleLowerCase();
  const roles: StationRole[] = [];
  if (/\bwater[- ]only|water stations?|water points?\b/.test(text)) roles.push("water-only");
  if (/\bcheckpoint|check points?\b/.test(text)) roles.push("checkpoint");
  if (/\b(aid stations?|feeding stations?|refreshment points?)\b/.test(text)) roles.push("aid-station");
  return roles;
}
function extractHtmlListOrProse(block: HtmlBlock, sourceUrl: string, options: StationExtractionOptions, eventName: string | null, year: number | null, order: number, selectedGpxUrl: string | null): StationVisitEvidenceV1[] {
  const text = block.text; const contextRoles = stationContextRoles(block.headings);
  const localHeading = block.headings.at(-1) ?? "";
  const headingRoles = rolesFromExplicitText(localHeading);
  const hasExplicitRole = rolesFromExplicitText(text).length > 0 || contextRoles.length > 0 || headingRoles.length > 0;
  if (!hasExplicitRole) return [];
  if ([...text.matchAll(/\b\d{1,3}(?:[.,]\s*\d{1,2})?\s*(?:km|kilomet(?:er|re)s?|mi|miles?)\b/gi)].length > 1) return [];
  let distance = extractDistance(text, /\b(next|interval|between stations)\b/i.test(text) ? "interval" : "unknown");
  let parsed = parseRolesAndName(text, contextRoles);
  let excerpt = text;
  if (!distance || !parsed.name) {
    const roles = [...new Set([...contextRoles, ...headingRoles])];
    const headingName = extractName(localHeading) ?? (headingRoles.includes("start") ? "Start" : headingRoles.includes("finish") ? "Finish" : null);
    const headingDistance = parseHeadingDistance(text);
    if (!headingDistance || !headingName || !roles.length || isGenericSectionHeading(localHeading)
      || /\b(?:after|post)[- ]finish\b/i.test(`${localHeading} ${text}`)) return [];
    distance = headingDistance;
    parsed = { roles, name: headingName };
    excerpt = `${localHeading} | ${text}`;
  }
  const course = courseFromHeadings(block.headings); const format = block.kind === "list" ? "html-list" : "html-prose";
  return [buildVisit({
    visitId: `${sourceUrl}#${block.locator}`, source: { url: sourceUrl, format, locator: { kind: format === "html-list" ? "html-list-item" : "html-prose", path: block.locator }, excerpt: excerpt.slice(0, 400) },
    context: toContext(options, course.label, course.km, year, eventName, selectedGpxUrl), sourceOrder: order, uid: null, name: parsed.name, roles: parsed.roles, sequenceRole: parsed.roles.includes("start") ? "start" : parsed.roles.includes("finish") ? "finish" : "intermediate-candidate", classification: parsed.roles.length ? "explicit-role" : "station-candidate", sourcePosition: distance, sourceIntervalToNext: null, coordinates: null, sourceAttributes: {}, ambiguities: distance.semantics === "unknown" ? ["distance-semantics-unclear"] : [],
  })];
}

function isGenericSectionHeading(text: string): boolean {
  return /^(?:general|course|race|event|route|station|stations|aid station|aid stations|water(?:[- ]only)? (?:point|points|station|stations)|checkpoint|checkpoints|refreshments?|information|details|schedule|results|registration)(?:\s+(?:information|details|points|stations|list|for runners))?$/i.test(text.trim());
}

/** Accepts only a single, standalone course-distance marker immediately under a heading. */
function parseHeadingDistance(text: string): z.infer<typeof sourceDistanceSchema> | null {
  if (/\b(?:cut[- ]?off|time\s*limit|hours?|minutes?|time|opens?|closes?|at\s+\d{1,2}:\d{2})\b/i.test(text)) return null;
  const normalized = text
    .replace(/(\d{1,3})[.,]\s+(\d{1,2})(?=\s*(?:km|kilomet(?:er|re)s?|mi|miles?)\b)/gi, "$1.$2")
    .replace(/(\d{1,3})\.\s*(?=(?:km|kilomet(?:er|re)s?|mi|miles?)\b)/gi, "$1");
  const matches = [...normalized.matchAll(/\b\d{1,3}(?:[.,]\d{1,2})?\s*(?:km|kilomet(?:er|re)s?|mi|miles?)\b/gi)];
  if (matches.length !== 1) return null;
  const match = matches[0];
  const residue = `${normalized.slice(0, match.index)} ${normalized.slice((match.index ?? 0) + match[0].length)}`
    .replace(/\b(?:distance|course|route|at|km|marker|the)\b/gi, " ")
    .replace(/[\s:：,.;()\-–—]+/g, "").trim();
  if (residue) return null;
  return extractDistance(match[0], "cumulative");
}

function selectedCourseMention(text: string, options: StationExtractionOptions): { label: string; km: number | null } | null {
  const selected = options.selectedCourseLabel ?? options.expectedCourseLabel;
  const distance = options.selectedCourseDistanceKm;
  const matches = [...text.matchAll(/\b(\d{1,3}(?:[.,]\d{1,2})?)\s*(km|k)\b/gi)];
  for (const match of matches) {
    const km = Number(match[1].replace(",", "."));
    if (!Number.isFinite(km)) continue;
    if (distance != null && Math.abs(km - distance) <= Math.max(0.05, distance * 0.001)) return { label: `${match[1]}K`, km };
    if (selected && `${match[1]}${match[2]}`.toLocaleLowerCase() === selected.replace(/\s+/g, "").toLocaleLowerCase()) return { label: selected, km };
  }
  return null;
}

function wordOrNumericCount(value: string): number | null {
  const words: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
  return /^\d{1,3}$/.test(value) ? Number(value) : words[value.toLocaleLowerCase()] ?? null;
}

function stationCountFromBlock(block: HtmlBlock, sourceUrl: string, options: StationExtractionOptions, eventName: string | null, year: number | null): StationCountEvidence | null {
  const scopedCourse = selectedCourseMention(`${block.text} ${block.headings.join(" ")}`, options);
  if (!scopedCourse || !/\b(?:aid stations?|on-course aid stations?|water stations?|refreshment points?)\b/i.test(`${block.text} ${block.headings.join(" ")}`)) return null;
  const match = /\b(?:has|have|includes?|are|is|:)?\s*(\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:on[- ]course\s+)?(?:aid stations?|water stations?|refreshment points?)\b/i.exec(block.text);
  const count = match ? wordOrNumericCount(match[1]) : null;
  if (count == null || count < 1 || count > 100) return null;
  const format = block.kind === "list" ? "html-list" as const : "html-prose" as const;
  return {
    declaredCount: count,
    context: { eventName: options.eventName ?? eventName, editionYear: year, courseLabel: scopedCourse.label, courseDistanceKm: scopedCourse.km },
    source: { url: sourceUrl, format, locator: { kind: format === "html-list" ? "html-list-item" : "html-prose", path: block.locator }, excerpt: block.text.slice(0, 400) },
  };
}

function namedRoleEvidenceFromBlock(block: HtmlBlock, sourceUrl: string, options: StationExtractionOptions, eventName: string | null, year: number | null, order: number, selectedGpxUrl: string | null): StationVisitEvidenceV1[] {
  if (block.kind !== "list" || !stationContextRoles(block.headings).includes("aid-station")) return [];
  const colon = block.text.indexOf(":");
  if (colon < 0) return [];
  const course = selectedCourseMention(block.text.slice(0, colon), options);
  if (!course) return [];
  const names = block.text.slice(colon + 1).split(/\s*,\s*|\s+and\s+/i).map((value) => extractName(value)).filter((value): value is string => Boolean(value));
  if (!names.length || names.length > 20) return [];
  return names.map((name, index) => buildVisit({
    visitId: `${sourceUrl}#${block.locator}-named-station-${index}`,
    source: { url: sourceUrl, format: "html-list", locator: { kind: "html-list-item", path: block.locator }, excerpt: `${block.headings.join(" > ")} | ${block.text}`.slice(0, 400) },
    context: toContext(options, course.label, course.km, year, eventName, selectedGpxUrl),
    sourceOrder: order + index, uid: null, name, roles: ["aid-station"], sequenceRole: "intermediate-candidate", classification: "explicit-role",
    sourcePosition: null, sourceIntervalToNext: null, coordinates: null, sourceAttributes: {}, ambiguities: ["position-not-specified"],
  }));
}
function inferredHtmlMetadata(root: HtmlNode): { eventName: string | null; year: number | null } {
  const title = descendants(root, "title")[0]; const h1 = descendants(root, "h1")[0];
  const eventName = (title ? nodeText(title) : null) ?? (h1 ? nodeText(h1) : null);
  const explicit = eventName?.match(/\b(?:edition|event)\s+(20\d{2})\b/i)?.[1] ?? null;
  return { eventName: eventName?.slice(0, 200) ?? null, year: explicit ? Number(explicit) : null };
}

export type StationDocumentIdentity = {
  eventName: string | null;
  eventId: string | null;
  editionYear: number | null;
  courseLabel: string | null;
  courseDistanceKm: number | null;
  gpxUrl: string | null;
};

/** Reads only explicit page-level event/course identity for cross-page binding checks. */
export function inspectStationDocumentIdentity(html: string, sourceUrl: string): StationDocumentIdentity {
  const empty: StationDocumentIdentity = { eventName: null, eventId: null, editionYear: null, courseLabel: null, courseDistanceKm: null, gpxUrl: null };
  if (!validSourceUrl(sourceUrl) || html.length > MAX_HTML_BYTES) return empty;
  const script = /<script\b(?=[^>]*\bid\s*=\s*(["'])__NEXT_DATA__\1)[^>]*>([\s\S]*?)<\/script\s*>/i.exec(html);
  if (script) {
    try {
      const payload: unknown = JSON.parse(script[2]);
      const pageProps = asRecord(getPath(payload, ["props", "pageProps"]));
      const event = asRecord(pageProps?.event);
      const track = asRecord(pageProps?.track);
      const query = asRecord(getPath(payload, ["query"]));
      const date = cleanText(event?.begin ?? event?.startDate, 40);
      const yearMatch = date?.match(/(?:^|\D)(20\d{2})(?:\D|$)/);
      const rawDistance = finite(track?.distanceKm) ?? ((finite(track?.distanceM ?? track?.distance) ?? 0) / 1000);
      const gpx = cleanText(pageProps?.gpxUrl ?? track?.gpxUrl ?? track?.gpx, 2_000);
      return {
        eventName: cleanText(event?.name ?? event?.title),
        eventId: cleanText(event?.id ?? event?.eventId, 160),
        editionYear: yearMatch ? Number(yearMatch[1]) : null,
        courseLabel: cleanText(query?.race ?? query?.course ?? track?.name, 160),
        courseDistanceKm: rawDistance > 0 ? rawDistance : null,
        gpxUrl: gpx ? normalizedOptionalHttpsUrl(gpx, sourceUrl) : null,
      };
    } catch { return empty; }
  }
  const root = parseHtmlTree(html);
  if (!root) return empty;
  const metadata = inferredHtmlMetadata(root);
  const headings = descendants(root, "h1").concat(descendants(root, "h2"), descendants(root, "h3"), descendants(root, "h4"), descendants(root, "h5"), descendants(root, "h6"));
  let courseLabel: string | null = null;
  let courseDistanceKm: number | null = null;
  for (const heading of headings) {
    const parsed = attrsForDistance(nodeText(heading));
    if (parsed) { courseLabel = parsed.label; courseDistanceKm = parsed.km; }
  }
  return { eventName: metadata.eventName, eventId: null, editionYear: metadata.year, courseLabel, courseDistanceKm, gpxUrl: null };
}

/** Extract only explicitly positioned station records from ordinary HTML. Multiple course scopes require explicit selection. */
function extractHtmlStationEvidenceInternal(html: string, sourceUrl: string, options: StationExtractionOptions = {}): StationExtractionResult {
  if (!validSourceUrl(sourceUrl) || html.length > MAX_HTML_BYTES) return emptyResult("html", "rejected", ["malformed-source"]);
  const selectedGpxUrl = normalizedOptionalHttpsUrl(options.selectedGpxUrl, sourceUrl);
  if (options.selectedGpxUrl && !selectedGpxUrl) return emptyResult("html", "rejected", ["course-identity-conflict"]);
  const root = parseHtmlTree(html); if (!root) return emptyResult("html", "rejected", ["malformed-source"]);
  const meta = inferredHtmlMetadata(root);
  const pageIdentity = inspectStationDocumentIdentity(html, sourceUrl);
  const eventName = meta.eventName ?? pageIdentity.eventName;
  const year = effectiveEdition(options, meta.year ?? pageIdentity.editionYear); if (year === -1) return emptyResult("html", "rejected", ["course-identity-conflict"]);
  if (options.expectedEventName && eventName && options.expectedEventName.toLocaleLowerCase() !== eventName.toLocaleLowerCase()) return emptyResult("html", "rejected", ["course-identity-conflict"]);
  const blocks = collectHtmlBlocks(root); const visits: StationVisitEvidenceV1[] = [];
  const countEvidenceByBlock = blocks.map((block) => stationCountFromBlock(block, sourceUrl, options, eventName, year)).filter((item): item is StationCountEvidence => item !== null);
  blocks.forEach((block, i) => {
    if (block.kind === "table") visits.push(...extractHtmlTable(block, sourceUrl, options, eventName, year));
    else {
      visits.push(...extractHtmlListOrProse(block, sourceUrl, options, eventName, year, i, selectedGpxUrl));
      visits.push(...namedRoleEvidenceFromBlock(block, sourceUrl, options, eventName, year, i, selectedGpxUrl));
    }
  });
  const courseMap = new Map<string, { label: string; distanceKm: number | null }>();
  for (const visit of visits) if (visit.context.courseLabel) {
    const key = visit.context.courseLabel.toLocaleLowerCase(); const prior = courseMap.get(key);
    if (prior && prior.distanceKm != null && visit.context.courseDistanceKm != null && Math.abs(prior.distanceKm - visit.context.courseDistanceKm) > 0.05) return emptyResult("html", "rejected", ["course-identity-conflict"]);
    courseMap.set(key, { label: visit.context.courseLabel, distanceKm: visit.context.courseDistanceKm ?? prior?.distanceKm ?? null });
  }
  const choices = [...courseMap.values()];
  if (options.expectedCourseLabel && visits.some((v) => v.context.courseLabel && !v.context.courseLabel.toLocaleLowerCase().includes(options.expectedCourseLabel!.toLocaleLowerCase()))) return emptyResult("html", "rejected", ["course-identity-conflict"]);
  if (choices.length > 1 && !options.selectedCourseLabel && options.selectedCourseDistanceKm == null) return { ...result("html", [], choices, ["course-selection-required"]), status: "course-selection-required" };
  let selected = visits;
  if (options.selectedCourseLabel || options.selectedCourseDistanceKm != null) {
    selected = visits.filter((v) => {
      const course = { label: v.context.courseLabel ?? "", km: v.context.courseDistanceKm };
      if (course.label || course.km != null) return sameSelectedCourse(course, options);
      return choices.length <= 1;
    });
    if (!selected.length && choices.length) return emptyResult("html", "rejected", ["course-identity-conflict"]);
  }
  if (selected.length > MAX_VISITS) return result("html", selected.slice(0, MAX_VISITS), choices, ["incomplete-source"]);
  let priorKm: number | null = null;
  const hasOrderingConflict = selected.some((visit) => {
    const km = visit.sourcePosition?.semantics === "cumulative" ? visit.sourcePosition.normalizedKm : null;
    if (km == null) return false;
    const conflict = priorKm != null && km <= priorKm + 0.001;
    priorKm = km;
    return conflict;
  });
  const scopedDeclaredCounts = [...new Set(blocks.flatMap((block) => {
    const count = declaredStationCount(block.headings);
    return count == null ? [] : [count];
  }))];
  const declaredCount = scopedDeclaredCounts.length === 1 ? scopedDeclaredCounts[0] : null;
  const countConflict = scopedDeclaredCounts.length > 1;
  const dedicatedList = !hasOrderingConflict && selected.length > 0 && selected.every((visit) =>
    visit.context.courseLabel != null && visit.context.courseDistanceKm != null &&
    visit.sourcePosition?.semantics === "cumulative" && visit.roles.some((role) => ["aid-station", "water-only", "checkpoint"].includes(role)),
  ) && selected.every((visit) => visit.source.format === "html-table" || visit.source.format === "html-list") &&
    !/\b(?:some|selected|sample|partial|incomplete|provisional)\b/i.test(blocks.map((block) => block.headings.join(" ")).join(" "));
  const declaredMatches = declaredCount != null && declaredCount === selected.length && !hasOrderingConflict && !countConflict;
  const complete = declaredMatches || (declaredCount == null && !countConflict && dedicatedList);
  const blockCounts = [...new Set(countEvidenceByBlock.map((evidence) => evidence.declaredCount))];
  const countEvidence = blockCounts.length === 1 ? countEvidenceByBlock[0] : undefined;
  const effectiveDeclaredCount = declaredCount ?? countEvidence?.declaredCount ?? null;
  const countsConflict = countConflict || blockCounts.length > 1 || (declaredCount != null && countEvidence != null && declaredCount !== countEvidence.declaredCount);
  const countMatches = effectiveDeclaredCount != null && effectiveDeclaredCount === selected.length && !hasOrderingConflict && !countsConflict;
  const finalComplete = complete || countMatches;
  const completeness: StationExtractionResult["completeness"] = {
    status: countsConflict || (effectiveDeclaredCount != null && effectiveDeclaredCount < selected.length) ? "conflicting" : finalComplete ? "complete" : hasOrderingConflict || effectiveDeclaredCount != null ? "partial" : "unknown",
    declaredCount: effectiveDeclaredCount, extractedCount: selected.length,
    ...(countMatches ? { basis: "explicit-count" as const } : declaredMatches ? { basis: "explicit-count" as const } : complete ? { basis: "dedicated-course-list" as const } : {}),
  };
  const extraction = result("html", selected, choices, [
    ...(hasOrderingConflict ? ["out-of-order-visits" as const] : []),
    ...(countsConflict ? ["conflicting-counts" as const] : []),
  ], completeness);
  return { ...extraction, ...(countEvidence && !countsConflict ? { countEvidence } : {}) };
}
export function extractHtmlStationEvidence(html: string, sourceUrl: string, options: StationExtractionOptions = {}): StationExtractionResult {
  try { return extractHtmlStationEvidenceInternal(html, sourceUrl, options); } catch { return emptyResult("html", "rejected", ["malformed-source"]); }
}

type GpxEdge = { a: { latitude: number; longitude: number }; b: { latitude: number; longitude: number }; componentIndex: number; startKm: number; lengthKm: number };
function haversineKm(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }): number {
  const rad = Math.PI / 180; const dLat = (b.latitude - a.latitude) * rad; const dLon = (b.longitude - a.longitude) * rad;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.latitude * rad) * Math.cos(b.latitude * rad) * Math.sin(dLon / 2) ** 2;
  return 6371.0088 * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}
function projectToEdges(point: { latitude: number; longitude: number }, edges: GpxEdge[]): Array<{ componentIndex: number; distanceKm: number; offsetM: number }> {
  const candidates: Array<{ componentIndex: number; distanceKm: number; offsetM: number }> = [];
  const rad = Math.PI / 180;
  for (const edge of edges) {
    const cos = Math.cos(point.latitude * rad); const ax = (edge.a.longitude - point.longitude) * rad * 6371.0088 * cos; const ay = (edge.a.latitude - point.latitude) * rad * 6371.0088;
    const bx = (edge.b.longitude - point.longitude) * rad * 6371.0088 * cos; const by = (edge.b.latitude - point.latitude) * rad * 6371.0088;
    const dx = bx - ax; const dy = by - ay; const denom = dx * dx + dy * dy; const t = denom === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / denom));
    const x = ax + t * dx; const y = ay + t * dy; const offsetKm = Math.hypot(x, y);
    candidates.push({ componentIndex: edge.componentIndex, distanceKm: edge.startKm + edge.lengthKm * t, offsetM: offsetKm * 1000 });
  }
  candidates.sort((a, b) => a.offsetM - b.offsetM);
  // Adjacent edges representing the same local route visit are one match; distinct chainages remain ambiguous.
  const unique: typeof candidates = [];
  for (const candidate of candidates) if (!unique.some((seen) => seen.componentIndex === candidate.componentIndex && Math.abs(seen.distanceKm - candidate.distanceKm) < 0.04)) unique.push(candidate);
  return unique;
}
export type StationGpxBinding = {
  validatedCourse: boolean;
  editionValidated: boolean;
  bindingEvidenceIds: string[];
  eventName: string | null;
  editionYear: number | null;
  courseLabel: string | null;
  courseId: string | null;
  selectedGpxUrl: string;
  selectedCourseDistanceKm: number | null;
};
export type StationAlignmentResult = { visits: StationVisitEvidenceV1[]; routeDistanceKm: number; issues: string[] };

/** Align source facts only after a caller has independently validated course/edition correspondence. Source km is never rescaled. */
export function alignStationEvidenceToGpx(visits: readonly StationVisitEvidenceV1[], gpxText: string, binding: StationGpxBinding): StationAlignmentResult {
  const parsed = parseGpxText(gpxText); const edges: GpxEdge[] = []; let totalKm = 0;
  parsed.segments.forEach((segment, componentIndex) => {
    let localKm = 0;
    for (let i = 1; i < segment.length; i++) {
      const a = segment[i - 1]; const b = segment[i]; const lengthKm = haversineKm(a, b);
      edges.push({ a: { latitude: a.latitude, longitude: a.longitude }, b: { latitude: b.latitude, longitude: b.longitude }, componentIndex, startKm: totalKm + localKm, lengthKm }); localKm += lengthKm;
    }
    totalKm += localKm;
  });
  const officialKm = binding.selectedCourseDistanceKm;
  const routeDistanceMateriallyMismatched = officialKm != null &&
    Math.abs(totalKm - officialKm) > Math.max(MATERIAL_COURSE_DISTANCE_DISCREPANCY_KM, Math.max(totalKm, officialKm) * MATERIAL_COURSE_DISTANCE_DISCREPANCY_RATIO);
  const validBindingUrl = normalizedOptionalHttpsUrl(binding.selectedGpxUrl, binding.selectedGpxUrl) === binding.selectedGpxUrl;
  const globallyBound = binding.validatedCourse && binding.editionValidated && validBindingUrl && binding.bindingEvidenceIds.length > 0 && binding.bindingEvidenceIds.length <= 32 && binding.bindingEvidenceIds.every((id) => typeof id === "string" && id.length > 0 && id.length <= 160);
  const issues: string[] = [];
  const aligned = visits.map((visit) => {
    if (!globallyBound) { issues.push("course-binding-unverified"); return { ...visit, position: { confidence: "unresolved" as const, reason: "course-binding-unverified" as const } }; }
    const identityConflict = (visit.context.eventName && binding.eventName && visit.context.eventName.toLocaleLowerCase() !== binding.eventName.toLocaleLowerCase())
      || (visit.context.editionYear != null && binding.editionYear != null && visit.context.editionYear !== binding.editionYear)
      || (visit.context.courseLabel && binding.courseLabel && visit.context.courseLabel.toLocaleLowerCase() !== binding.courseLabel.toLocaleLowerCase())
      || (visit.context.courseId && binding.courseId && visit.context.courseId.toLocaleLowerCase() !== binding.courseId.toLocaleLowerCase())
      || (visit.context.selectedGpxUrl && visit.context.selectedGpxUrl !== binding.selectedGpxUrl);
    if (identityConflict) { issues.push("course-identity-conflict"); return { ...visit, position: { confidence: "unresolved" as const, reason: "course-identity-mismatch" as const } }; }
    if (visit.coordinates) {
      const matches = projectToEdges(visit.coordinates, edges); const best = matches[0]; const second = matches.find((m) => m.componentIndex !== best?.componentIndex || Math.abs(m.distanceKm - (best?.distanceKm ?? 0)) > 0.2);
      if (!best || best.offsetM > COORDINATE_MATCH_TOLERANCE_M) { issues.push("coordinate-off-route"); return { ...visit, position: { confidence: "unresolved" as const, reason: "coordinate-off-route" as const } }; }
      if (second && second.offsetM <= COORDINATE_MATCH_TOLERANCE_M && second.offsetM - best.offsetM < 20) { issues.push("coordinate-match-ambiguous"); return { ...visit, position: { confidence: "unresolved" as const, reason: "coordinate-match-ambiguous" as const } }; }
      const sourcePositionDiscrepancy = visit.sourcePosition?.semantics === "cumulative" && (Math.abs(visit.sourcePosition.normalizedKm - best.distanceKm) > SOURCE_KM_ALIGNMENT_TOLERANCE_KM || Math.abs(visit.sourcePosition.normalizedKm - best.distanceKm) / Math.max(totalKm, 0.001) > SOURCE_KM_ALIGNMENT_TOLERANCE_RATIO);
      if (sourcePositionDiscrepancy) { issues.push("source-distance-discrepancy"); }
      return { ...visit, ...(sourcePositionDiscrepancy ? { ambiguities: [...visit.ambiguities, "source-vs-gpx-distance-discrepancy"] } : {}), position: { confidence: "verified" as const, componentIndex: best.componentIndex, distanceKm: best.distanceKm, offsetM: best.offsetM, method: "coordinate-projection" as const } };
    }
    const position = visit.sourcePosition;
    if (!position || position.semantics !== "cumulative" || !["exact", "approximate"].includes(position.qualifier)) { issues.push("source-distance-not-cumulative"); return { ...visit, position: { confidence: "unresolved" as const, reason: "source-distance-not-cumulative" as const } }; }
    if (routeDistanceMateriallyMismatched) { issues.push("route-distance-mismatch"); return { ...visit, position: { confidence: "unresolved" as const, reason: "route-distance-mismatch" as const } }; }
    if (position.normalizedKm > totalKm) { issues.push("source-position-out-of-range"); return { ...visit, position: { confidence: "unresolved" as const, reason: "source-position-out-of-range" as const } }; }
    let componentOffset = 0; let componentIndex = 0; let localPosition = position.normalizedKm;
    for (let i = 0; i < parsed.segments.length; i++) { const length = edges.filter((edge) => edge.componentIndex === i).reduce((sum, e) => sum + e.lengthKm, 0); if (localPosition <= length || i === parsed.segments.length - 1) { componentIndex = i; break; } localPosition -= length; componentOffset += length; }
    return { ...visit, position: { confidence: "approximate" as const, componentIndex, distanceKm: componentOffset + localPosition, method: "source-distance" as const } };
  });
  return { visits: aligned.map((v) => stationVisitEvidenceV1Schema.parse(v)), routeDistanceKm: totalKm, issues: [...new Set(issues)] };
}
