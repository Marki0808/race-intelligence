import { z } from "zod";
import {
  alignStationEvidenceToGpx,
  extractHtmlStationEvidence,
  extractNextDataStationEvidence,
  inspectStationDocumentIdentity,
  stationVisitEvidenceV1Schema,
  type StationExtractionIssue,
  type StationExtractionResult,
  type StationVisitEvidenceV1,
} from "./aidStationExtraction.ts";
import { officialCourseLabelsMatch, type OfficialRaceCourseIdentity } from "./officialRaceCourseIdentity.ts";

export const AID_STATION_DISCOVERY_SCHEMA_VERSION = 1 as const;

const reasonSchema = z.enum([
  "no-station-evidence",
  "course-selection-required",
  "course-identity-conflict",
  "selected-gpx-mismatch",
  "course-binding-unverified",
  "archive-entry-binding-unverified",
  "source-distance-not-cumulative",
  "route-distance-mismatch",
  "coordinate-off-route",
  "coordinate-match-ambiguous",
  "source-position-out-of-range",
  "source-distance-discrepancy",
  "incomplete-source",
  "malformed-source",
  "crawl-limit-reached",
  "station-roles-unconfirmed",
  "station-count-conflict",
  "start-or-finish-unavailable",
  "visits-not-positioned",
  "visit-order-ambiguous",
  "optional-source-unavailable",
  "source-completeness-unverified",
  "cross-source-station-match-ambiguous",
  "cross-source-identity-conflict",
  "approximate-positioning-unverified",
]);

export const aidStationDiscoveryV1Schema = z.object({
  schemaVersion: z.literal(AID_STATION_DISCOVERY_SCHEMA_VERSION),
  status: z.enum(["available", "unavailable"]),
  selectedContext: z.object({
    eventName: z.string().max(200).nullable(),
    editionYear: z.number().int().min(1900).max(3000).nullable(),
    courseLabel: z.string().max(160).nullable(),
    courseDistanceKm: z.number().finite().nonnegative().nullable(),
  }).strict(),
  gpxProvenance: z.object({
    resourceType: z.enum(["gpx", "zip-entry"]),
    sourcePageUrl: z.string().url().max(2_000),
    selectedResourceUrl: z.string().url().max(2_000),
    selectedEntryId: z.string().max(64).nullable(),
    archiveDigest: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
    bindingStatus: z.enum(["verified", "approximate", "partial", "unverified"]),
    bindingEvidenceIds: z.array(z.string().min(1).max(160)).max(32),
  }).strict(),
  sources: z.array(z.object({
    url: z.string().url().max(2_000),
    depth: z.number().int().min(0).max(2),
    linkedFromUrl: z.string().url().max(2_000).nullable(),
    linkEvidence: z.array(z.string().max(160)).max(4),
  }).strict()).max(3),
  courseChoices: z.array(z.object({ label: z.string().min(1).max(160), distanceKm: z.number().finite().nonnegative().nullable() }).strict()).max(20),
  visits: z.array(stationVisitEvidenceV1Schema).max(500),
  completeness: z.object({
    status: z.enum(["unknown", "complete", "partial", "conflicting"]),
    declaredCount: z.number().int().nonnegative().nullable(),
    extractedCount: z.number().int().nonnegative(),
    basis: z.enum(["explicit-count", "dedicated-course-list", "course-points-corroborated"]).optional(),
    countEvidence: z.object({
      declaredCount: z.number().int().positive(),
      context: z.object({ eventName: z.string().max(200).nullable(), editionYear: z.number().int().nullable(), courseLabel: z.string().max(160).nullable(), courseDistanceKm: z.number().finite().nonnegative().nullable() }).strict(),
      source: z.object({ url: z.string().url().max(2_000), format: z.enum(["html-list", "html-prose"]), locator: z.object({ kind: z.enum(["html-list-item", "html-prose"]), path: z.string().min(1).max(300) }).strict(), excerpt: z.string().max(400) }).strict(),
    }).strict().optional(),
  }).strict(),
  ambiguities: z.array(z.string().max(120)).max(32),
  reasonCodes: z.array(reasonSchema).max(10),
  stationSegmentation: z.object({
    available: z.boolean(),
    reasonCodes: z.array(reasonSchema).max(8),
    positionMode: z.enum(["verified", "official-kilometer-approximate"]).optional(),
  }).strict(),
}).strict();

export type AidStationDiscoveryV1 = z.infer<typeof aidStationDiscoveryV1Schema>;
export type CapturedStationPage = {
  url: string;
  html: string;
  depth: number;
  linkedFromUrl: string | null;
  linkEvidence: string[];
};
export type SelectedStationResource = {
  resourceType: "gpx" | "zip-entry";
  sourcePageUrl: string;
  resourceUrl: string;
  distanceLabel: string | null;
  entryId?: string;
  archiveDigest?: string;
  courseIdentity?: OfficialRaceCourseIdentity;
};

const emptyReasons = (reason: z.infer<typeof reasonSchema>) => [reason];

function distanceFromLabel(label: string | null): number | null {
  if (!label) return null;
  const match = /(?:^|\b)(\d+(?:[.,]\d+)?)\s*(km|kilomet(?:er|re)s?|k)\b/i.exec(label);
  if (!match) return null;
  const distance = Number(match[1].replace(",", "."));
  return Number.isFinite(distance) && distance > 0 ? distance : null;
}

function normalizedUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    url.hash = "";
    return url.href;
  } catch { return null; }
}

function normalizedEventName(value: string | null): string | null {
  return value?.toLocaleLowerCase().replace(/\b(?:edition|event)\s+20\d{2}\b/g, " ").replace(/\b(?:edition|event)\b/g, " ").replace(/20\d{2}/g, " ").replace(/[^\p{L}\p{N}]+/gu, " ").trim() || null;
}

function normalizedEventNameEvidence(value: string | null): string | null {
  return normalizedEventName(value)?.replace(/\b(?:races?\s+(?:and\s+)?runners?|other\s+information|faqs?)\b/g, " ").replace(/\s+/g, " ").trim() || null;
}

function linkedFaqIdentityConflicts(
  sourceIdentity: ReturnType<typeof inspectStationDocumentIdentity>,
  selectedIdentity: ReturnType<typeof inspectStationDocumentIdentity>,
): boolean {
  if (sourceIdentity.editionYear != null && selectedIdentity.editionYear != null && sourceIdentity.editionYear !== selectedIdentity.editionYear) return true;
  if (sourceIdentity.eventId && selectedIdentity.eventId && sourceIdentity.eventId !== selectedIdentity.eventId) return true;
  const sourceName = normalizedEventNameEvidence(sourceIdentity.eventName);
  const selectedName = normalizedEventNameEvidence(selectedIdentity.eventName);
  if (!sourceName || !selectedName || sourceName === selectedName) return false;
  // FAQ document titles often omit course/sponsor words from the selected title.
  // A meaningful-token subset is compatible; any distinct named event token is not.
  const generic = new Set(["faq", "faqs", "frequently", "asked", "questions", "race", "races", "event", "trail", "ultra", "course", "powered", "by", "the", "and"]);
  const sourceTokens = sourceName.split(/\s+/).filter((token) => !generic.has(token));
  const selectedTokens = new Set(selectedName.split(/\s+/).filter((token) => !generic.has(token)));
  return sourceTokens.some((token) => !selectedTokens.has(token));
}

function normalizedStationName(value: string | null): string | null {
  return value?.toLocaleLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim() || null;
}

function hasRefreshmentEvidence(visit: StationVisitEvidenceV1): boolean {
  return Object.entries(visit.sourceAttributes).some(([key, value]) => {
    if (key.toLocaleLowerCase() !== "supplies" || typeof value !== "string") return false;
    const tokens = value.toLocaleLowerCase().replace(/[^a-z]+/g, " ").trim().split(/\s+/);
    return tokens.some((token) => token === "drink" || token === "drinks" || token === "hotfood" || token === "food");
  });
}

function compatibleCountContext(visit: StationVisitEvidenceV1, count: NonNullable<StationExtractionResult["countEvidence"]>, selectedIdentity: ReturnType<typeof inspectStationDocumentIdentity> | null): boolean {
  const context = count.context;
  if (!context.eventName || !visit.context.eventName || normalizedEventName(context.eventName) !== normalizedEventName(visit.context.eventName)) return false;
  if (context.editionYear == null || visit.context.editionYear == null || context.editionYear !== visit.context.editionYear) return false;
  if (!context.courseLabel || !visit.context.courseLabel || !officialCourseLabelsMatch(context.courseLabel, visit.context.courseLabel)) return false;
  if (context.courseDistanceKm != null && visit.context.courseDistanceKm != null && Math.abs(context.courseDistanceKm - visit.context.courseDistanceKm) > Math.max(3, visit.context.courseDistanceKm * 0.03)) return false;
  if (selectedIdentity && (selectedIdentity.editionYear !== context.editionYear ||
    (selectedIdentity.eventName && normalizedEventName(selectedIdentity.eventName) !== normalizedEventName(context.eventName)) ||
    (selectedIdentity.courseDistanceKm != null && context.courseDistanceKm != null && Math.abs(selectedIdentity.courseDistanceKm - context.courseDistanceKm) > Math.max(3, selectedIdentity.courseDistanceKm * 0.03)))) return false;
  return true;
}

function matchesExpectedCourse(visit: StationVisitEvidenceV1, expected: OfficialRaceCourseIdentity | undefined): boolean {
  if (!expected) return true;
  return officialCourseLabelsMatch(visit.context.courseLabel, expected.courseLabel) &&
    (expected.editionYear == null || visit.context.editionYear === expected.editionYear) &&
    (!expected.eventName || normalizedEventName(visit.context.eventName) === normalizedEventName(expected.eventName));
}

function compatibleSourceContext(a: StationVisitEvidenceV1, b: StationVisitEvidenceV1): boolean {
  const ac = a.context; const bc = b.context;
  if (!ac.eventName || !bc.eventName || normalizedEventName(ac.eventName) !== normalizedEventName(bc.eventName)) return false;
  if (ac.editionYear == null || bc.editionYear == null || ac.editionYear !== bc.editionYear) return false;
  if (!ac.courseLabel || !bc.courseLabel || !officialCourseLabelsMatch(ac.courseLabel, bc.courseLabel)) return false;
  if (ac.courseId && bc.courseId && ac.courseId !== bc.courseId) return false;
  if (ac.courseDistanceKm != null && bc.courseDistanceKm != null && Math.abs(ac.courseDistanceKm - bc.courseDistanceKm) > Math.max(3, Math.max(ac.courseDistanceKm, bc.courseDistanceKm) * 0.03)) return false;
  return true;
}

function mergeCorroboratedSources(
  sources: Array<{ page: CapturedStationPage; visits: StationVisitEvidenceV1[]; issues: StationExtractionIssue[]; completeness: AidStationDiscoveryV1["completeness"]; format: "next-data" | "html"; countEvidence?: NonNullable<StationExtractionResult["countEvidence"]> }>,
  resourceUrl: string,
  sourceUrl: string,
  selectedCoursePageUrl: string,
  selectedIdentity: ReturnType<typeof inspectStationDocumentIdentity> | null,
  expectedCourseIdentity?: OfficialRaceCourseIdentity,
): { visits: StationVisitEvidenceV1[]; completeness: AidStationDiscoveryV1["completeness"]; issues: string[]; countEvidence?: NonNullable<StationExtractionResult["countEvidence"]> } {
  const prioritized = sources.filter((source) => source.visits.length > 0).sort((a, b) => {
    const exactA = a.format === "next-data" && a.visits.every((visit) => visit.context.selectedGpxUrl === resourceUrl) ? 1 : 0;
    const exactB = b.format === "next-data" && b.visits.every((visit) => visit.context.selectedGpxUrl === resourceUrl) ? 1 : 0;
    const directA = normalizedUrl(a.page.url) === sourceUrl ? 1 : 0;
    const directB = normalizedUrl(b.page.url) === sourceUrl ? 1 : 0;
    return exactB - exactA || directB - directA || b.visits.length - a.visits.length;
  });
  const chosen = prioritized[0];
  const courseSourceUrls = new Set([sourceUrl, selectedCoursePageUrl].map(normalizedUrl).filter((value): value is string => value !== null));
  let visits = chosen.visits.map((visit) => ({ ...visit, supportingEvidence: [...(visit.supportingEvidence ?? [])] }));
  const issues: string[] = [];
  const corroborated = new Set<number>();
  let unmatchedNamedStationIdentity = false;
  const expectedIdentityMatches = visits.every((visit) => matchesExpectedCourse(visit, expectedCourseIdentity));
  if (!expectedIdentityMatches) issues.push("cross-source-identity-conflict");
  for (const supporting of prioritized.slice(1)) {
    if (!expectedIdentityMatches) continue;
    const samePage = normalizedUrl(supporting.page.url) === normalizedUrl(chosen.page.url);
    const linkedOfficial = courseSourceUrls.has(normalizedUrl(supporting.page.linkedFromUrl ?? "") ?? "") &&
      supporting.page.linkEvidence.some((text) => /\b(aid|water|refreshment|checkpoint|race guide|regulation|faq|faqs)\b/i.test(text));
    if (!samePage && !linkedOfficial) continue;
    const selectedIdentityMismatch = selectedIdentity && (selectedIdentity.editionYear == null || supporting.visits.some((visit) =>
      (selectedIdentity.eventName && normalizedEventName(visit.context.eventName) !== normalizedEventName(selectedIdentity.eventName)) ||
      visit.context.editionYear !== selectedIdentity.editionYear ||
      (selectedIdentity.eventId && visit.context.eventId && selectedIdentity.eventId !== visit.context.eventId)));
    if (selectedIdentityMismatch) { issues.push("cross-source-identity-conflict"); continue; }
    const used = new Set<number>();
    for (const evidenceVisit of supporting.visits) {
      if (!evidenceVisit.roles.some((role) => ["aid-station", "water-only", "checkpoint"].includes(role))) continue;
      const evidenceName = normalizedStationName(evidenceVisit.name);
      if (!evidenceName) continue;
      const evidenceKm = evidenceVisit.sourcePosition?.semantics === "cumulative" ? evidenceVisit.sourcePosition.normalizedKm : null;
      const candidates = visits.map((visit, index) => ({ visit, index }))
        .filter(({ visit, index }) => !used.has(index) && visit.sequenceRole === "intermediate-candidate" && compatibleSourceContext(visit, evidenceVisit) && normalizedStationName(visit.name) === evidenceName)
        .map(({ visit, index }) => ({ visit, index, km: visit.sourcePosition?.semantics === "cumulative" ? visit.sourcePosition.normalizedKm : null }))
        .filter((candidate) => evidenceKm == null || candidate.km == null || Math.abs(candidate.km - evidenceKm) <= 1)
        .sort((a, b) => evidenceKm == null
          ? Math.abs(a.visit.sourceOrder - evidenceVisit.sourceOrder) - Math.abs(b.visit.sourceOrder - evidenceVisit.sourceOrder)
          : Math.abs((a.km ?? evidenceKm) - evidenceKm) - Math.abs((b.km ?? evidenceKm) - evidenceKm));
      if (evidenceKm == null && candidates.length > 1) {
        // Source order is not enough to identify one of several visits to the same
        // place. Keep the evidence unattached instead of choosing the nearest row.
        issues.push("cross-source-station-match-ambiguous");
        continue;
      }
      const best = candidates[0];
      const bestScore = best && (evidenceKm == null ? Math.abs(best.visit.sourceOrder - evidenceVisit.sourceOrder) : Math.abs((best.km ?? evidenceKm) - evidenceKm));
      const nextScore = candidates[1] && (evidenceKm == null ? Math.abs(candidates[1].visit.sourceOrder - evidenceVisit.sourceOrder) : Math.abs((candidates[1].km ?? evidenceKm) - evidenceKm));
      if (!best) {
        unmatchedNamedStationIdentity = true;
        issues.push("cross-source-station-match-ambiguous");
        continue;
      }
      if (nextScore != null && bestScore != null && Math.abs(nextScore - bestScore) <= 0.001) {
        issues.push("cross-source-station-match-ambiguous");
        continue;
      }
      used.add(best.index); corroborated.add(best.index);
      const combinedRoles = [...new Set([...best.visit.roles, ...evidenceVisit.roles])];
      visits[best.index] = {
        ...best.visit,
        roles: combinedRoles,
        classification: combinedRoles.length ? "explicit-role" : best.visit.classification,
        ...(best.visit.sourcePosition == null && evidenceVisit.sourcePosition ? { sourcePosition: evidenceVisit.sourcePosition } : {}),
        supportingEvidence: [...(best.visit.supportingEvidence ?? []), { url: evidenceVisit.source.url, format: evidenceVisit.source.format, locator: evidenceVisit.source.locator, excerpt: evidenceVisit.source.excerpt }].slice(0, 4),
      };
    }
  }
  const hasEndpoints = visits.length >= 2 && visits[0].sequenceRole === "start" && visits.at(-1)?.sequenceRole === "finish";
  const countSources = sources.filter((source) => {
    if (!source.countEvidence || !expectedIdentityMatches || !visits.length ||
      !compatibleCountContext(visits[0], source.countEvidence, selectedIdentity)) return false;
    const sameSelectedCoursePage = normalizedUrl(source.page.url) === normalizedUrl(selectedCoursePageUrl);
    const linkedOfficial = courseSourceUrls.has(normalizedUrl(source.page.linkedFromUrl ?? "") ?? "") &&
      source.page.linkEvidence.some((text) => /\b(?:aid|water|refreshment|faq|faqs)\b/i.test(text));
    return sameSelectedCoursePage || linkedOfficial;
  });
  const uniqueCounts = [...new Set(countSources.map((source) => source.countEvidence!.declaredCount))];
  const linkedCountConflict = sources.some((source) => {
    if (!source.issues.includes("conflicting-counts")) return false;
    if (normalizedUrl(source.page.url) === normalizedUrl(selectedCoursePageUrl)) return true;
    return courseSourceUrls.has(normalizedUrl(source.page.linkedFromUrl ?? "") ?? "") &&
      source.page.linkEvidence.some((text) => /\b(?:aid|water|refreshment|faq|faqs)\b/i.test(text));
  });
  const countSource = uniqueCounts.length === 1 ? countSources[0] : undefined;
  const countEvidence = countSource?.countEvidence;
  const intermediate = visits.slice(1, -1);
  const validOrderedCoursePointSequence = chosen.format === "next-data" && hasEndpoints && intermediate.length > 0 &&
    intermediate.every((visit) => visit.sequenceRole === "intermediate-candidate" &&
      visit.sourcePosition?.semantics === "cumulative" && hasRefreshmentEvidence(visit) &&
      !visit.roles.some((role) => role === "checkpoint" || role === "water-only")) &&
    visits.every((visit, index) => index === 0 || visit.sourceOrder > visits[index - 1].sourceOrder) &&
    !chosen.issues.some((issue) => ["incomplete-source", "out-of-order-visits", "duplicate-source-position"].includes(issue));
  const countMatchesSequence = Boolean(countEvidence && validOrderedCoursePointSequence && countEvidence.declaredCount === intermediate.length);
  const countConflict = uniqueCounts.length > 1 || linkedCountConflict ||
    Boolean(countEvidence && validOrderedCoursePointSequence && countEvidence.declaredCount !== intermediate.length);
  if (countConflict) issues.push("station-count-conflict");
  if (countMatchesSequence && countEvidence) {
    const countSupport = { url: countEvidence.source.url, format: countEvidence.source.format, locator: countEvidence.source.locator, excerpt: countEvidence.source.excerpt };
    visits = visits.map((visit, index) => {
      if (index === 0 || index === visits.length - 1) return visit;
      const explicitlyConfirmed = visit.roles.includes("aid-station");
      return {
        ...visit,
        roles: explicitlyConfirmed ? visit.roles : [...visit.roles, "aid-station"],
        classification: explicitlyConfirmed ? visit.classification : "inferred-role" as const,
        supportingEvidence: [...(visit.supportingEvidence ?? []), ...(explicitlyConfirmed ? [] : [countSupport])].slice(0, 4),
      };
    });
  }
  const everyIntermediateCorroborated = visits.length > 2 && visits.slice(1, -1).every((visit, index) =>
    visit.sequenceRole === "intermediate-candidate" && (corroborated.has(index + 1) || countMatchesSequence && hasRefreshmentEvidence(visit)) && visit.roles.some((role) => ["aid-station", "water-only", "checkpoint"].includes(role)),
  );
  // A partial named support list can be ambiguous among repeated visits to the same place.
  // Keep that diagnostic and leave the name evidence unattached, but do not let it invalidate
  // an otherwise complete GPX-bound sequence independently corroborated by an exact course count.
  const unresolvedStationIdentity = issues.includes("cross-source-station-match-ambiguous") &&
    (!countMatchesSequence || unmatchedNamedStationIdentity);
  const completeByCrossSource = chosen.format === "next-data" && everyIntermediateCorroborated && hasEndpoints &&
    !issues.includes("cross-source-identity-conflict") && !unresolvedStationIdentity &&
    !countConflict && !chosen.issues.some((issue) => ["incomplete-source", "out-of-order-visits", "duplicate-source-position"].includes(issue));
  const explicitCountMatches = completeByCrossSource && countEvidence?.declaredCount === visits.length - 2;
  const completeness = completeByCrossSource
    ? { status: "complete" as const, declaredCount: explicitCountMatches ? countEvidence!.declaredCount : null, extractedCount: visits.length, basis: "course-points-corroborated" as const }
    : chosen.completeness;
  return { visits, completeness, issues: [...new Set(issues)], ...(countEvidence ? { countEvidence } : {}) };
}

function initialResult(resource: SelectedStationResource, reason: z.infer<typeof reasonSchema>, sources: CapturedStationPage[], courseChoices: AidStationDiscoveryV1["courseChoices"] = []): AidStationDiscoveryV1 {
  const sourcePageUrl = normalizedUrl(resource.sourcePageUrl) ?? "https://invalid.example/";
  const selectedResourceUrl = normalizedUrl(resource.resourceUrl) ?? "https://invalid.example/";
  return aidStationDiscoveryV1Schema.parse({
    schemaVersion: AID_STATION_DISCOVERY_SCHEMA_VERSION,
    status: "unavailable",
    selectedContext: { eventName: null, editionYear: null, courseLabel: resource.distanceLabel, courseDistanceKm: distanceFromLabel(resource.distanceLabel) },
    gpxProvenance: {
      resourceType: resource.resourceType,
      sourcePageUrl,
      selectedResourceUrl,
      selectedEntryId: resource.entryId ?? null,
      archiveDigest: resource.archiveDigest ?? null,
      bindingStatus: "unverified",
      bindingEvidenceIds: [],
    },
    sources: sources.slice(0, 3).map(({ url, depth, linkedFromUrl, linkEvidence }) => ({
      url: normalizedUrl(url) ?? "https://invalid.example/",
      depth: Math.max(0, Math.min(2, Math.trunc(depth))),
      linkedFromUrl: linkedFromUrl ? normalizedUrl(linkedFromUrl) : null,
      linkEvidence: linkEvidence.slice(0, 4).map((text) => text.slice(0, 160)),
    })),
    courseChoices: courseChoices.slice(0, 20),
    visits: [],
    completeness: { status: "unknown", declaredCount: null, extractedCount: 0 },
    ambiguities: [],
    reasonCodes: emptyReasons(reason),
    stationSegmentation: { available: false, reasonCodes: [reason] },
  });
}

function mapIssues(issues: readonly StationExtractionIssue[]): z.infer<typeof reasonSchema>[] {
  const mapped: z.infer<typeof reasonSchema>[] = [];
  for (const issue of issues) {
    if (issue === "conflicting-counts") mapped.push("station-count-conflict");
    else if (["course-selection-required", "course-identity-conflict", "selected-gpx-mismatch", "source-distance-discrepancy", "incomplete-source", "malformed-source"].includes(issue)) {
      mapped.push(issue as z.infer<typeof reasonSchema>);
    }
  }
  return mapped;
}

/** Builds optional station metadata after server rediscovery and selected GPX validation. Failure is represented as data, not an exception. */
export function buildAidStationDiscoveryV1(
  pages: readonly CapturedStationPage[],
  resource: SelectedStationResource,
  gpxText: string,
  optionalSourceUnavailable = false,
): AidStationDiscoveryV1 {
  const fallbackReason = "no-station-evidence";
  try {
    const resourceUrl = normalizedUrl(resource.resourceUrl);
    const sourceUrl = normalizedUrl(resource.sourcePageUrl);
    if (!resourceUrl || !sourceUrl) return initialResult(resource, "selected-gpx-mismatch", [...pages]);
    const selectedCoursePageUrl = normalizedUrl(resource.courseIdentity?.sourcePageUrl ?? "") ?? sourceUrl;
    const selectedPage = pages.find((page) => normalizedUrl(page.url) === selectedCoursePageUrl)
      ?? pages.find((page) => normalizedUrl(page.url) === sourceUrl);
    const inspectedSelectedIdentity = selectedPage ? inspectStationDocumentIdentity(selectedPage.html, sourceUrl) : null;
    // This identity comes from the server's secure, exact-course resource preselection;
    // it can fill gaps in generic HTML titles without trusting a client-supplied identity.
    const trustedCourseIdentity = resource.courseIdentity &&
      normalizedUrl(resource.courseIdentity.sourcePageUrl) === selectedCoursePageUrl
      ? resource.courseIdentity
      : undefined;
    const selectedIdentity = inspectedSelectedIdentity ? {
      ...inspectedSelectedIdentity,
      eventName: trustedCourseIdentity?.eventName ?? inspectedSelectedIdentity.eventName,
      editionYear: trustedCourseIdentity?.editionYear ?? inspectedSelectedIdentity.editionYear,
      courseLabel: trustedCourseIdentity?.courseLabel ?? inspectedSelectedIdentity.courseLabel,
      courseDistanceKm: distanceFromLabel(trustedCourseIdentity?.courseLabel ?? null) ?? inspectedSelectedIdentity.courseDistanceKm,
    } : trustedCourseIdentity ? {
      eventName: trustedCourseIdentity.eventName,
      eventId: null,
      editionYear: trustedCourseIdentity.editionYear,
      courseLabel: trustedCourseIdentity.courseLabel,
      courseDistanceKm: distanceFromLabel(trustedCourseIdentity.courseLabel),
      gpxUrl: null,
    } : null;
    const courseDistanceKm = distanceFromLabel(resource.distanceLabel);
    const parsedSources: Array<{ page: CapturedStationPage; visits: StationVisitEvidenceV1[]; issues: StationExtractionIssue[]; completeness: AidStationDiscoveryV1["completeness"]; format: "next-data" | "html"; countEvidence?: NonNullable<StationExtractionResult["countEvidence"]> }> = [];
    let selectionRequired = false;
    let identityConflict = false;
    let selectedGpxMismatch = false;
    let malformedSource = false;
    let incompleteSource = false;
    const courseChoices = new Map<string, { label: string; distanceKm: number | null }>();
    for (const page of pages.slice(0, 3)) {
      const pageUrl = normalizedUrl(page.url);
      if (!pageUrl || new URL(pageUrl).origin !== new URL(sourceUrl).origin) continue;
      const structured = extractNextDataStationEvidence(page.html, pageUrl, {
        selectedGpxUrl: resource.resourceType === "gpx" ? resourceUrl : undefined,
      });
      if (structured.status === "rejected" && structured.issues.includes("course-identity-conflict")) identityConflict = true;
      if (structured.status === "rejected" && structured.issues.includes("selected-gpx-mismatch")) selectedGpxMismatch = true;
      if (structured.status === "course-selection-required") selectionRequired = true;
      if (structured.status === "rejected" && structured.issues.includes("course-identity-conflict")) identityConflict = true;
      if (structured.status === "rejected" && structured.issues.includes("selected-gpx-mismatch")) selectedGpxMismatch = true;
      if (structured.status === "rejected" && structured.issues.includes("malformed-source")) malformedSource = true;
      if (structured.status === "rejected" && structured.issues.includes("incomplete-source")) incompleteSource = true;
      if (structured.visits.length) parsedSources.push({ page, visits: structured.visits, issues: structured.issues, completeness: structured.completeness, format: "next-data" });

      // A page may expose both GPX-bound structured course points and an explicit HTML station list.
      // Parse both so the latter can corroborate roles without replacing coordinate evidence.
      const linkedFaqFromSelectedCourse = selectedIdentity !== null &&
        new URL(pageUrl).origin === new URL(sourceUrl).origin &&
        normalizedUrl(page.linkedFromUrl ?? "") === selectedCoursePageUrl &&
        page.linkEvidence.some((text) => /\b(?:faq|faqs|frequently asked questions)\b/i.test(text));
      const faqIdentity = linkedFaqFromSelectedCourse ? inspectStationDocumentIdentity(page.html, pageUrl) : null;
      const pageIsSelectedCourse = pageUrl === selectedCoursePageUrl && Boolean(trustedCourseIdentity);
      const canInheritCourseEdition = linkedFaqFromSelectedCourse && selectedIdentity?.editionYear != null &&
        Boolean(selectedIdentity.eventName) && !linkedFaqIdentityConflicts(faqIdentity!, selectedIdentity!);
      if (linkedFaqFromSelectedCourse && !canInheritCourseEdition && faqIdentity && linkedFaqIdentityConflicts(faqIdentity, selectedIdentity!)) identityConflict = true;
      const html = extractHtmlStationEvidence(page.html, pageUrl, {
        selectedCourseLabel: trustedCourseIdentity?.courseLabel ?? resource.distanceLabel,
        selectedCourseDistanceKm: distanceFromLabel(trustedCourseIdentity?.courseLabel ?? null) ?? courseDistanceKm ?? undefined,
        ...((canInheritCourseEdition || pageIsSelectedCourse) ? {
          eventName: selectedIdentity?.eventName ?? trustedCourseIdentity?.eventName ?? null,
          editionYear: selectedIdentity?.editionYear ?? trustedCourseIdentity?.editionYear ?? null,
          expectedEditionYear: selectedIdentity?.editionYear ?? trustedCourseIdentity?.editionYear ?? undefined,
        } : {}),
        ...(pageIsSelectedCourse ? { validatedCourseScope: true } : {}),
      });
      if (html.status === "course-selection-required") selectionRequired = true;
      for (const choice of html.courseChoices) courseChoices.set(`${choice.label.toLocaleLowerCase()}|${choice.distanceKm ?? ""}`, choice);
      if (html.status === "rejected" && html.issues.includes("course-identity-conflict")) identityConflict = true;
      if (html.status === "rejected" && html.issues.includes("selected-gpx-mismatch")) selectedGpxMismatch = true;
      if (html.issues.includes("malformed-source")) malformedSource = true;
      if (html.issues.includes("incomplete-source")) incompleteSource = true;
      if (html.visits.length || html.countEvidence) parsedSources.push({ page, visits: html.visits, issues: html.issues, completeness: html.completeness, format: "html", ...(html.countEvidence ? { countEvidence: html.countEvidence } : {}) });
    }
    if (!parsedSources.some((source) => source.visits.length > 0)) {
      const reason = selectedGpxMismatch ? "selected-gpx-mismatch" : identityConflict ? "course-identity-conflict" : selectionRequired ? "course-selection-required" : malformedSource ? "malformed-source" : incompleteSource ? "incomplete-source" : optionalSourceUnavailable ? "optional-source-unavailable" : fallbackReason;
      return initialResult(resource, reason, [...pages], [...courseChoices.values()]);
    }

    // Preserve the exact GPX-bound source as canonical; enrich it only with explicitly matching,
    // same-course and same-edition official evidence captured in the bounded crawl.
    const merged = mergeCorroboratedSources(parsedSources, resourceUrl, sourceUrl, selectedCoursePageUrl, selectedIdentity, resource.courseIdentity);
    const chosen = [...parsedSources].sort((a, b) => {
      const exactA = a.format === "next-data" && a.visits.every((visit) => visit.context.selectedGpxUrl === resourceUrl) ? 1 : 0;
      const exactB = b.format === "next-data" && b.visits.every((visit) => visit.context.selectedGpxUrl === resourceUrl) ? 1 : 0;
      const directA = normalizedUrl(a.page.url) === sourceUrl ? 1 : 0;
      const directB = normalizedUrl(b.page.url) === sourceUrl ? 1 : 0;
      return exactB - exactA || directB - directA || b.visits.length - a.visits.length;
    })[0];
    const visits = merged.visits;
    const expectedCourseIdentity = resource.courseIdentity;
    const identityMatches = !expectedCourseIdentity || visits.every((visit) =>
      officialCourseLabelsMatch(visit.context.courseLabel, expectedCourseIdentity.courseLabel) &&
      (expectedCourseIdentity.editionYear == null || visit.context.editionYear === expectedCourseIdentity.editionYear) &&
      (!expectedCourseIdentity.eventName || visit.context.eventName?.trim().toLocaleLowerCase() === expectedCourseIdentity.eventName.trim().toLocaleLowerCase()),
    );
    const explicitDistanceMatches = courseDistanceKm != null && visits.some((visit) => visit.context.courseDistanceKm != null && Math.abs(visit.context.courseDistanceKm - courseDistanceKm) <= Math.max(0.05, courseDistanceKm * 0.001));
    const exactEmbeddedGpx = resource.resourceType === "gpx" && chosen.format === "next-data" && visits.every((visit) => normalizedUrl(visit.context.selectedGpxUrl ?? "") === resourceUrl);
    const explicitEdition = visits.every((visit) => visit.context.editionYear != null);
    const linkedIdentityMatches = selectedIdentity !== null && selectedIdentity.editionYear !== null &&
      visits.every((visit) => visit.context.editionYear === selectedIdentity.editionYear) &&
      normalizedEventName(selectedIdentity.eventName) !== null &&
      visits.every((visit) => normalizedEventName(visit.context.eventName) === normalizedEventName(selectedIdentity.eventName)) &&
      (!selectedIdentity.eventId || visits.every((visit) => !visit.context.eventId || visit.context.eventId === selectedIdentity.eventId));
    const linkedIdentityConflict = normalizedUrl(chosen.page.url) !== sourceUrl && selectedIdentity !== null &&
      ((selectedIdentity.editionYear !== null && visits.some((visit) => visit.context.editionYear !== selectedIdentity.editionYear)) ||
       (normalizedEventName(selectedIdentity.eventName) !== null && visits.some((visit) => normalizedEventName(visit.context.eventName) !== normalizedEventName(selectedIdentity.eventName))) ||
       (selectedIdentity.eventId !== null && visits.some((visit) => visit.context.eventId !== null && visit.context.eventId !== selectedIdentity.eventId)));
    const directCoursePage = normalizedUrl(chosen.page.url) === sourceUrl;
    const linkedCoursePage = normalizedUrl(chosen.page.linkedFromUrl ?? "") === sourceUrl &&
      chosen.page.linkEvidence.some((text) => /\b(aid|water|refreshment|checkpoint|ravitaillement|race guide|regulation)\b/i.test(text)) &&
      linkedIdentityMatches && (selectedIdentity?.courseDistanceKm == null || courseDistanceKm != null && Math.abs(selectedIdentity.courseDistanceKm - courseDistanceKm) <= Math.max(0.05, courseDistanceKm * 0.001));
    const courseValidated = identityMatches && (exactEmbeddedGpx || (explicitDistanceMatches && (directCoursePage || linkedCoursePage)));
    const editionValidated = explicitEdition && identityMatches;
    const evidenceIds = [
      ...(exactEmbeddedGpx ? ["embedded-gpx-url-match"] : ["selected-course-page-match"]),
      ...(resource.resourceType === "zip-entry" ? ["rediscovered-archive-candidate", "archive-digest-entry-match"] : []),
      "explicit-edition-context",
    ].slice(0, 32);
    let aligned = visits;
    const alignmentIssues: string[] = [];
    let bindingStatus: AidStationDiscoveryV1["gpxProvenance"]["bindingStatus"] = "unverified";
    const canAlign = courseValidated && editionValidated;
    if (canAlign && !linkedIdentityConflict) {
      const alignment = alignStationEvidenceToGpx(visits, gpxText, {
        validatedCourse: courseValidated,
        editionValidated,
        bindingEvidenceIds: evidenceIds,
        eventName: visits[0]?.context.eventName ?? expectedCourseIdentity?.eventName ?? null,
        editionYear: visits[0]?.context.editionYear ?? expectedCourseIdentity?.editionYear ?? null,
        courseLabel: visits[0]?.context.courseLabel ?? expectedCourseIdentity?.courseLabel ?? resource.distanceLabel,
        courseId: visits[0]?.context.courseId ?? null,
        selectedGpxUrl: resourceUrl,
        selectedCourseDistanceKm: visits[0]?.context.courseDistanceKm ?? courseDistanceKm,
      });
      aligned = alignment.visits;
      alignmentIssues.push(...alignment.issues);
      const confidences = aligned.map((visit) => visit.position.confidence);
      bindingStatus = confidences.every((confidence) => confidence === "verified") ? "verified"
        : confidences.every((confidence) => confidence !== "unresolved") ? "approximate"
          : "partial";
    } else {
      const reason = linkedIdentityConflict || !identityMatches ? "course-identity-mismatch" as const : "course-binding-unverified" as const;
      alignmentIssues.push(reason === "course-identity-mismatch" ? "course-identity-conflict" : "course-binding-unverified");
      if (resource.resourceType === "zip-entry" && !courseValidated) alignmentIssues.push("archive-entry-binding-unverified");
      aligned = visits.map((visit) => ({ ...visit, position: { confidence: "unresolved" as const, reason } }));
    }
    const reasonCodes = [...new Set([...mapIssues(chosen.issues), ...merged.issues.filter((issue): issue is z.infer<typeof reasonSchema> => reasonSchema.safeParse(issue).success), ...alignmentIssues.filter((issue): issue is z.infer<typeof reasonSchema> => reasonSchema.safeParse(issue).success)])].slice(0, 10);
    if (optionalSourceUnavailable && reasonCodes.length < 10 && !reasonCodes.includes("optional-source-unavailable")) reasonCodes.push("optional-source-unavailable");
    if (!reasonCodes.length && !aligned.length) reasonCodes.push("no-station-evidence");
    const allVisitsPositioned = aligned.every((visit) => visit.position.confidence !== "unresolved" && visit.position.distanceKm != null && visit.position.componentIndex != null);
    const visitPositionsOrdered = aligned.every((visit, index) => index === 0 ||
      visit.position.componentIndex! >= aligned[index - 1].position.componentIndex! &&
      visit.position.distanceKm! >= aligned[index - 1].position.distanceKm! - 0.01);
    const positionQualifiedCompleteness = merged.completeness.status === "complete" && (!allVisitsPositioned || !visitPositionsOrdered)
      ? "partial" as const
      : merged.completeness.status;
    const segmentationReasons: z.infer<typeof reasonSchema>[] = [];
    const verifiedPositionMode = aligned.length >= 2 && aligned.every((visit) => visit.position.confidence === "verified");
    const approximateKilometerPositionMode = aligned.length >= 3 &&
      aligned[0].sequenceRole === "start" && aligned[0].position.confidence === "verified" && aligned[0].position.method === "route-endpoint" &&
      aligned.at(-1)?.sequenceRole === "finish" && aligned.at(-1)?.position.confidence === "verified" && aligned.at(-1)?.position.method === "route-endpoint" &&
      aligned.slice(1, -1).every((visit) => visit.sequenceRole === "intermediate-candidate" &&
        visit.position.confidence === "approximate" && visit.position.method === "source-distance" &&
        visit.sourcePosition?.semantics === "cumulative" && visit.sourcePosition.qualifier === "exact" &&
        visit.sourcePosition.normalizedKm === visit.position.distanceKm &&
        visit.roles.some((role) => ["aid-station", "water-only", "checkpoint"].includes(role))) &&
      new Set(aligned.map((visit) => visit.position.componentIndex)).size === 1 &&
      !alignmentIssues.some((issue) => ["route-distance-mismatch", "source-position-out-of-range", "source-distance-not-cumulative", "course-identity-mismatch"].includes(issue));
    if (optionalSourceUnavailable) segmentationReasons.push("optional-source-unavailable");
    if (merged.completeness.status !== "complete") segmentationReasons.push("source-completeness-unverified");
    if (aligned.length < 2 || aligned[0]?.sequenceRole !== "start" || aligned.at(-1)?.sequenceRole !== "finish") segmentationReasons.push("start-or-finish-unavailable");
    if (aligned.some((visit) => visit.sequenceRole === "intermediate-candidate" && !visit.roles.some((role) => ["aid-station", "water-only", "checkpoint"].includes(role)))) segmentationReasons.push("station-roles-unconfirmed");
    if (aligned.some((visit) => visit.position.confidence === "unresolved" || visit.position.distanceKm == null || visit.position.componentIndex == null)) segmentationReasons.push("visits-not-positioned");
    if (!verifiedPositionMode && !approximateKilometerPositionMode) segmentationReasons.push("approximate-positioning-unverified");
    for (let index = 1; index < aligned.length; index++) {
      const previous = aligned[index - 1]; const current = aligned[index];
      if ((current.position.componentIndex != null && previous.position.componentIndex != null && current.position.componentIndex < previous.position.componentIndex) ||
        (current.position.distanceKm != null && previous.position.distanceKm != null && current.position.distanceKm < previous.position.distanceKm - 0.01)) {
        segmentationReasons.push("visit-order-ambiguous"); break;
      }
    }
    const segmentationAvailable = segmentationReasons.length === 0 && merged.completeness.status === "complete" && aligned.length >= 2;
    const result: AidStationDiscoveryV1 = {
      schemaVersion: AID_STATION_DISCOVERY_SCHEMA_VERSION,
      status: "available",
      selectedContext: {
        eventName: visits[0]?.context.eventName ?? expectedCourseIdentity?.eventName ?? null,
        editionYear: visits[0]?.context.editionYear ?? expectedCourseIdentity?.editionYear ?? null,
        courseLabel: visits[0]?.context.courseLabel ?? expectedCourseIdentity?.courseLabel ?? resource.distanceLabel,
        courseDistanceKm: visits[0]?.context.courseDistanceKm ?? courseDistanceKm,
      },
      gpxProvenance: {
        resourceType: resource.resourceType,
        sourcePageUrl: sourceUrl,
        selectedResourceUrl: resourceUrl,
        selectedEntryId: resource.entryId ?? null,
        archiveDigest: resource.archiveDigest ?? null,
        bindingStatus,
        bindingEvidenceIds: canAlign ? evidenceIds : [],
      },
      sources: [...pages].slice(0, 3).map(({ url, depth, linkedFromUrl, linkEvidence }) => ({
        url: normalizedUrl(url) ?? "https://invalid.example/",
        depth: Math.max(0, Math.min(2, Math.trunc(depth))),
        linkedFromUrl: linkedFromUrl ? normalizedUrl(linkedFromUrl) : null,
        linkEvidence: linkEvidence.slice(0, 4).map((text) => text.slice(0, 160)),
      })),
      courseChoices: [...courseChoices.values()].slice(0, 20),
      visits: aligned,
      completeness: {
        ...merged.completeness,
        ...(merged.countEvidence ? { countEvidence: merged.countEvidence } : {}),
        ...(optionalSourceUnavailable && positionQualifiedCompleteness !== "conflicting" ? { status: "partial" as const } : { status: positionQualifiedCompleteness }),
        extractedCount: aligned.length,
      },
      ambiguities: [...new Set([...aligned.flatMap((visit) => visit.ambiguities), ...alignmentIssues])].slice(0, 32),
      reasonCodes,
      stationSegmentation: {
        available: segmentationAvailable,
        reasonCodes: segmentationReasons.slice(0, 8),
        ...(segmentationAvailable ? { positionMode: verifiedPositionMode ? "verified" as const : "official-kilometer-approximate" as const } : {}),
      },
    };
    return aidStationDiscoveryV1Schema.parse(result);
  } catch {
    return initialResult(resource, "malformed-source", [...pages]);
  }
}
