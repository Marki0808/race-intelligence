/** Evidence-only course identity helpers for official race-page discovery. */
export type OfficialRaceCourseIdentity = {
  courseLabel: string;
  editionYear: number | null;
  eventName: string | null;
  sourcePageUrl: string;
  evidence: string[];
};

export type CourseResourcePreselection = {
  courseIdentity: OfficialRaceCourseIdentity;
  resourceUrl: string;
  resourceType: "gpx" | "zip-archive";
  evidence: string[];
};

type Resource = {
  url: string;
  sourcePageUrl: string;
  distanceLabel: string | null;
  supportingEvidence: string[];
  linkText: string;
};

const COURSE_PATH_PARENT = /^(?:race|races|course|courses|distance|distances|razdalja|razdalje|distancia|distancias|distanza|distanze)$/i;
const DISTANCE_LABEL = /^(\d{1,3}(?:[.,]\d{1,2})?)\s*(km|k|mi|miles?|m)$/i;
const DISTANCE_IN_PATH = /(?:^|[^a-z0-9])(\d{1,3}(?:[.,]\d{1,2})?)\s*(km|k|mi|miles?|M)(?=$|[^a-z0-9])/gi;

function distanceKey(value: string | null): string | null {
  if (!value) return null;
  const match = DISTANCE_LABEL.exec(value.trim());
  if (!match) return null;
  const number = Number(match[1].replace(",", "."));
  if (!Number.isFinite(number) || number <= 0) return null;
  const unit = match[2];
  // “M” is conventionally used for mile race labels; a lower-case “m” is ambiguous.
  const normalizedUnit = /^(?:k|km)$/i.test(unit) ? "km"
    : /^(?:mi|mile|miles)$/i.test(unit) || unit === "M" ? "mi"
      : null;
  return normalizedUnit ? `${number}|${normalizedUnit}` : null;
}

function coursePathDistance(value: string): string | null {
  const normalized = value.replace(/[._-]+/g, " ");
  const matches = [...normalized.matchAll(DISTANCE_IN_PATH)]
    .map((match) => {
      const unit = match[2] === "M" ? "M" : match[2].toLowerCase();
      const label = `${match[1]} ${unit}`;
      return { label, key: distanceKey(label) };
    })
    .filter((match): match is { label: string; key: string } => match.key !== null);
  const unique = new Map(matches.map((match) => [match.key, match.label]));
  return unique.size === 1 ? [...unique.values()][0] : null;
}

export function officialCourseLabelsMatch(candidate: string | null, expected: string | null): boolean {
  if (!candidate || !expected) return false;
  const expectedKey = distanceKey(expected);
  if (!expectedKey) return candidate.trim().toLocaleLowerCase() === expected.trim().toLocaleLowerCase();
  const direct = distanceKey(candidate);
  if (direct) return direct === expectedKey;
  const keys = [...candidate.matchAll(/\b(\d{1,3}(?:[.,]\d{1,2})?)\s*(km|k|mi|miles?|M)\b/gi)]
    .map((match) => distanceKey(`${match[1]}${match[2] === "M" ? "M" : match[2].toLowerCase()}`));
  const unique = [...new Set(keys.filter((key): key is string => key !== null))];
  return unique.length === 1 && unique[0] === expectedKey;
}

function textContent(value: string): string {
  return value.replace(/<[^>]*>/g, " ").replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&").replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, " ").trim().slice(0, 300);
}

function pageSignals(html: string): { labels: Array<{ label: string; source: string }>; eventName: string | null; editionYear: number | null } {
  const labels: Array<{ label: string; source: string }> = [];
  let eventName: string | null = null;
  let editionYear: number | null = null;
  const nextData = /<script\b(?=[^>]*\bid\s*=\s*(["'])__NEXT_DATA__\1)[^>]*>([\s\S]*?)<\/script\s*>/i.exec(html);
  if (nextData) {
    try {
      const data = JSON.parse(nextData[2]) as {
        query?: Record<string, unknown>;
        props?: { pageProps?: { event?: Record<string, unknown>; track?: Record<string, unknown> } };
      };
      const props = data.props?.pageProps;
      for (const [key, value] of Object.entries(data.query ?? {})) {
        if ((key === "race" || key === "course") && typeof value === "string") labels.push({ label: value, source: `structured query ${key}` });
      }
      eventName = typeof props?.event?.name === "string" ? props.event.name.slice(0, 160) : null;
      const eventDate = [props?.event?.begin, props?.event?.startDate, props?.event?.eventDate]
        .find((value) => typeof value === "string");
      const year = typeof eventDate === "string" ? /\b(20\d{2})\b/.exec(eventDate)?.[1] : null;
      editionYear = year ? Number(year) : null;
    } catch {
      // Malformed structured data is ignored; visible page evidence can still corroborate the URL.
    }
  }
  for (const tag of ["title", "h1"]) {
    const expression = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}\\s*>`, "gi");
    for (const match of html.matchAll(expression)) {
      const label = textContent(match[1]);
      if (label) labels.push({ label, source: tag });
      if (!eventName && tag === "title" && label) eventName = label.slice(0, 160);
      if (editionYear == null && label) {
        const year = /\b(20\d{2})\b/.exec(label)?.[1];
        if (year) editionYear = Number(year);
      }
    }
  }
  return { labels, eventName, editionYear };
}

/** Requires a distance-specific race/course path and an exact matching page label. */
export function identifyOfficialRaceCourse(inputUrl: string, html: string): OfficialRaceCourseIdentity | null {
  let url: URL;
  try { url = new URL(inputUrl); } catch { return null; }
  if (url.protocol !== "https:" || url.username || url.password) return null;
  const parts = url.pathname.split("/").filter(Boolean);
  const leaf = parts.at(-1) ?? "";
  const parent = parts.at(-2) ?? "";
  if (!COURSE_PATH_PARENT.test(parent)) return null;
  let pathLabel: string;
  try { pathLabel = decodeURIComponent(leaf); } catch { return null; }
  const exactPathLabel = DISTANCE_LABEL.test(pathLabel) ? pathLabel.trim() : null;
  const expectedLabel = exactPathLabel ?? coursePathDistance(pathLabel);
  if (!expectedLabel) return null;
  const expectedKey = distanceKey(expectedLabel);
  if (!expectedKey) return null;
  const signals = pageSignals(html);
  const corroborating = signals.labels.find(({ label }) => officialCourseLabelsMatch(label, expectedLabel));
  if (!corroborating) return null;
  // Keep a stable course token instead of carrying an entire page title into matching.
  const courseLabel = expectedLabel.slice(0, 160);
  return {
    courseLabel,
    editionYear: signals.editionYear,
    eventName: signals.eventName,
    sourcePageUrl: url.href,
    evidence: [exactPathLabel ? `course URL path: ${pathLabel}` : `course URL path confirms distance: ${courseLabel}`, `${corroborating.source} confirms course label: ${courseLabel}`],
  };
}

function editionYears(resource: Resource): number[] {
  const evidence = [resource.url, resource.linkText, resource.distanceLabel ?? "", ...resource.supportingEvidence].join(" ");
  // Filenames commonly delimit years with underscores, which are word characters
  // and therefore do not satisfy \b on either side.
  return [...new Set([...evidence.matchAll(/(?:^|[^\d])(20\d{2})(?!\d)/g)].map((match) => Number(match[1])))];
}

/** Preselects only one exact course-labeled resource with no unlabeled variant or edition conflict. */
export function findUniqueCourseResourcePreselection(
  identity: OfficialRaceCourseIdentity,
  rootUrl: string,
  resources: readonly Resource[],
): CourseResourcePreselection | null {
  const targetKey = distanceKey(identity.courseLabel);
  if (!targetKey || !resources.length) return null;
  const matching = resources.filter((resource) => distanceKey(resource.distanceLabel) === targetKey);
  if (matching.length !== 1) return null;
  // An unlabeled resource could be another variant of the selected course.
  if (resources.some((resource) => resource !== matching[0] && !resource.distanceLabel)) return null;
  const selected = matching[0];
  const targetUrl = new URL(rootUrl);
  const sourceUrl = new URL(selected.sourcePageUrl);
  if (sourceUrl.origin !== targetUrl.origin) return null;
  const candidateYears = editionYears(selected);
  if (candidateYears.length > 1) return null;
  const candidateYear = candidateYears[0] ?? null;
  if (identity.editionYear != null) {
    if (candidateYear != null && candidateYear !== identity.editionYear) return null;
    // A resource found on another page needs its own explicit edition evidence.
    if (candidateYear == null && sourceUrl.href !== targetUrl.href) return null;
  } else if (sourceUrl.href !== targetUrl.href) {
    return null;
  }
  const resourceType = selected.url.toLowerCase().split(/[?#]/, 1)[0].endsWith(".zip") ? "zip-archive" : "gpx";
  return {
    courseIdentity: identity,
    resourceUrl: selected.url,
    resourceType,
    evidence: ["exact course-label match", ...(identity.editionYear != null && candidateYear === identity.editionYear ? [`edition ${identity.editionYear} match`] : []), "single matching official resource"],
  };
}
