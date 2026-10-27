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

function yearFromExplicitDateValue(value: string): number | null {
  const text = textContent(value);
  const hasDateShape = /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2}(?:st|nd|rd|th)?[,]?\s+20\d{2}\b/i.test(text) ||
    /\b\d{1,2}[./-]\d{1,2}[./-]20\d{2}\b/.test(text) ||
    /\b20\d{2}-\d{2}-\d{2}(?:[T\s]|$)/.test(text);
  if (!hasDateShape) return null;
  const years = [...new Set(text.match(/\b20\d{2}\b/g)?.map(Number) ?? [])];
  return years.length === 1 ? years[0] : null;
}

/** Reads edition years only from machine-readable dates or an explicitly labeled Date field. */
function explicitHtmlDateYears(html: string): number[] {
  const years = new Set<number>();
  for (const match of html.matchAll(/<time\b[^>]*\bdatetime\s*=\s*(["'])(.*?)\1[^>]*>/gi)) {
    const year = yearFromExplicitDateValue(match[2]);
    if (year != null) years.add(year);
  }
  // Course pages often put the label and value in separate layout wrappers
  // (for example, a heading in one Divi column and a paragraph in another).
  // Read only a bounded field region and stop at the next semantic label so a
  // nearby schedule or cutoff date cannot become the event edition.
  const labels = [...html.matchAll(/<(h[1-6]|dt|th|strong|b)\b[^>]*>([\s\S]{0,180}?)<\/\1\s*>/gi)];
  for (const match of labels.filter((item) => /^(?:event\s+)?date\s*:?$/i.test(textContent(item[2])))) {
    const valueStart = (match.index ?? 0) + match[0].length;
    const nextLabel = labels.find((candidate) => (candidate.index ?? 0) > (match.index ?? 0));
    const valueEnd = Math.min(valueStart + 900, nextLabel?.index ?? html.length);
    const year = yearFromExplicitDateValue(html.slice(valueStart, valueEnd));
    if (year != null) years.add(year);
  }
  return [...years];
}

function explicitlyLabeledCourseDistance(html: string): string | null {
  const visible = textContentForIdentity(html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " "));
  const values = [...visible.matchAll(/\b(?:dužina|duzina|distance|course\s+length|length)\b\s*:?\s*(\d{1,3}(?:[.,]\d{1,2})?\s*(?:km|k|mi|miles?|M)\b)/gi)]
    .map((match) => match[1].replace(/\s+/g, " ").trim());
  const keys = new Map(values.map((value) => [distanceKey(value), value]));
  keys.delete(null);
  return keys.size === 1 ? [...keys.values()][0] : null;
}

function textContentForIdentity(value: string): string {
  return value.replace(/<[^>]*>/g, " ").replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&").replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, " ").trim().slice(0, 12000);
}

function hasStaticGpxLink(html: string): boolean {
  return /<a\b[^>]*\bhref\s*=\s*(["'])[^"']+\.gpx(?:[?#][^"']*)?\1/i.test(html);
}

function pageSignals(html: string): { labels: Array<{ label: string; source: string }>; eventName: string | null; editionYear: number | null; editionEvidence: string | null; editionConflict: boolean } {
  const labels: Array<{ label: string; source: string }> = [];
  let eventName: string | null = null;
  let editionYear: number | null = null;
  let editionEvidence: string | null = null;
  let editionConflict = false;
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
  const dateYears = explicitHtmlDateYears(html);
  if (dateYears.length > 1 || (dateYears.length === 1 && editionYear != null && dateYears[0] !== editionYear)) {
    editionConflict = true;
    editionYear = null;
  } else if (editionYear == null && dateYears.length === 1) {
    editionYear = dateYears[0];
    editionEvidence = `labeled official course date: ${editionYear}`;
  }
  return { labels, eventName, editionYear, editionEvidence, editionConflict };
}

/** Requires a distance-specific URL or a directly linked, explicitly labeled single-course page. */
export function identifyOfficialRaceCourse(inputUrl: string, html: string): OfficialRaceCourseIdentity | null {
  let url: URL;
  try { url = new URL(inputUrl); } catch { return null; }
  if (url.protocol !== "https:" || url.username || url.password) return null;
  const parts = url.pathname.split("/").filter(Boolean);
  const leaf = parts.at(-1) ?? "";
  const parent = parts.at(-2) ?? "";
  const pathScoped = COURSE_PATH_PARENT.test(parent);
  let pathLabel: string;
  try { pathLabel = decodeURIComponent(leaf); } catch { return null; }
  const exactPathLabel = DISTANCE_LABEL.test(pathLabel) ? pathLabel.trim() : null;
  const expectedLabel = exactPathLabel ?? coursePathDistance(pathLabel);
  const expectedKey = distanceKey(expectedLabel);
  const signals = pageSignals(html);
  if (signals.editionConflict) return null;
  if (!pathScoped || !expectedKey) {
    // Some official course pages use a short, non-distance slug (for example,
    // /gujdek). Bind only when the page itself has exactly one labeled course
    // distance, a named H1, and a static GPX download link. Event homepages with
    // several distances and pages without a route resource remain unscoped.
    const labeledDistance = explicitlyLabeledCourseDistance(html);
    const namedHeading = signals.labels.some(({ label, source }) => source === "h1" && /[\p{L}]{2,}/u.test(label));
    if (!parts.length || !labeledDistance || !namedHeading || !hasStaticGpxLink(html)) return null;
    const courseLabel = labeledDistance.slice(0, 160);
    return {
      courseLabel,
      editionYear: signals.editionYear,
      eventName: signals.eventName,
      sourcePageUrl: url.href,
      evidence: [`selected official course page identifies a labeled distance: ${courseLabel}`, "named course heading", "official page links a GPX resource", ...(signals.editionEvidence ? [signals.editionEvidence] : [])],
    };
  }
  if (!expectedLabel || !expectedKey) return null;
  const corroborating = signals.labels.find(({ label }) => officialCourseLabelsMatch(label, expectedLabel));
  if (!corroborating) return null;
  // Keep a stable course token instead of carrying an entire page title into matching.
  const courseLabel = expectedLabel.slice(0, 160);
  return {
    courseLabel,
    editionYear: signals.editionYear,
    eventName: signals.eventName,
    sourcePageUrl: url.href,
    evidence: [exactPathLabel ? `course URL path: ${pathLabel}` : `course URL path confirms distance: ${courseLabel}`, `${corroborating.source} confirms course label: ${courseLabel}`, ...(signals.editionEvidence ? [signals.editionEvidence] : [])],
  };
}

function explicitEditionYears(resource: Resource): number[] {
  // A file/path year describes a route artifact/version, not necessarily the
  // event edition. Only explicitly labeled edition/event metadata can conflict
  // with the event date established by the selected course page.
  const evidence = [resource.linkText, ...resource.supportingEvidence]
    .filter((item) => !/^filename:/i.test(item))
    .join(" ");
  const years = [...evidence.matchAll(/\b(?:edition|event|race)\s*(?:year)?\s*[:#-]?\s*(20\d{2})\b|\b(20\d{2})\s+(?:edition|event|race)\b/gi)]
    .map((match) => Number(match[1] ?? match[2]));
  return [...new Set(years)];
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
  const candidateYears = explicitEditionYears(selected);
  if (candidateYears.length > 1) return null;
  const candidateYear = candidateYears[0] ?? null;
  const linkedFromExactCoursePage = sourceUrl.href === targetUrl.href;
  if (identity.editionYear != null) {
    if (candidateYear != null && candidateYear !== identity.editionYear) return null;
    // A unique exact-course resource directly linked by the selected official
    // course page remains bound even when its filename reflects an older route
    // revision. A resource found elsewhere needs explicit matching edition
    // metadata; a filename year alone cannot establish the event edition.
    if (!linkedFromExactCoursePage && candidateYear !== identity.editionYear) return null;
  } else if (!linkedFromExactCoursePage) {
    return null;
  }
  const resourceType = selected.url.toLowerCase().split(/[?#]/, 1)[0].endsWith(".zip") ? "zip-archive" : "gpx";
  return {
    courseIdentity: identity,
    resourceUrl: selected.url,
    resourceType,
    evidence: ["exact course-label match", ...(candidateYear != null ? [`explicit edition ${candidateYear} match`] : []), ...(linkedFromExactCoursePage ? ["direct link from selected official course page"] : []), "single matching official resource"],
  };
}
