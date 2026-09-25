import type {
  CourseCharacterData,
  GpxCourseAnalysisData,
  KeyMomentData,
} from "./raceTypes";

export type GpxAnalysisErrorCode =
  | "invalid-gpx"
  | "no-track-points"
  | "multiple-tracks"
  | "insufficient-elevation"
  | "invalid-coordinate"
  | "invalid-route";

export class GpxAnalysisError extends Error {
  readonly code: GpxAnalysisErrorCode;

  constructor(code: GpxAnalysisErrorCode) {
    super(getGpxAnalysisErrorMessage(code));
    this.name = "GpxAnalysisError";
    this.code = code;
  }
}

export type GpxTrackPointInput = {
  latitude: number;
  longitude: number;
  elevationM: number;
};

export type GpxRoutePointData = GpxTrackPointInput & {
  distanceM: number;
};

export type GpxRouteMetricsData = GpxCourseAnalysisData;

export type GpxRouteSegmentData = {
  id: string;
  startKm: number;
  endKm: number;
  distanceKm: number;
  elevationGainM: number;
  elevationLossM: number;
};

export type RouteAnalysisData = {
  name: string;
  points: GpxRoutePointData[];
  metrics: GpxRouteMetricsData;
  majorClimbs: GpxRouteSegmentData[];
  majorDescents: GpxRouteSegmentData[];
  sections: GpxRouteSegmentData[];
  keyMoments: KeyMomentData[];
  courseCharacter: CourseCharacterData;
};

export function getGpxAnalysisErrorMessage(code: GpxAnalysisErrorCode): string {
  switch (code) {
    case "invalid-gpx":
      return "That file does not appear to be a valid GPX route.";
    case "no-track-points":
      return "No track points were found in this GPX file.";
    case "multiple-tracks":
      return "This GPX contains multiple tracks or routes and cannot be analyzed safely yet. Export a single-track or single-route GPX and try again.";
    case "insufficient-elevation":
      return "This GPX does not contain usable elevation data for route analysis.";
    case "invalid-coordinate":
      return "This GPX contains invalid location points and could not be analyzed.";
    case "invalid-route":
      return "This GPX does not describe a usable route.";
  }
}

export function parseGpxText(text: string): {
  name: string | null;
  points: GpxTrackPointInput[];
} {
  const xml = text.replace(/^\uFEFF/, "").trim();
  if (!xml || !hasValidXmlStructure(xml) || !/^<(?:[\w.-]+:)?gpx(?:\s|>)/i.test(stripXmlProlog(xml))) {
    throw new GpxAnalysisError("invalid-gpx");
  }

  const trackCount = countOpeningTags(xml, "trk");
  const routeCount = countOpeningTags(xml, "rte");
  if (trackCount > 1 || (trackCount === 0 && routeCount > 1)) {
    throw new GpxAnalysisError("multiple-tracks");
  }

  const pointTag = trackCount > 0 ? "trkpt" : "rtept";
  const trackPointPattern = new RegExp(
    `<(?:[\\w.-]+:)?${pointTag}\\b([^>]*)>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?${pointTag}\\s*>`,
    "gi",
  );
  const trackPoints = [...xml.matchAll(trackPointPattern)];
  if (trackPoints.length === 0) {
    throw new GpxAnalysisError("no-track-points");
  }

  const points = trackPoints.map((match) => {
    const attributes = parseXmlAttributes(match[1]);
    const latitude = Number(attributes.get("lat"));
    const longitude = Number(attributes.get("lon"));
    const elevationMatch = match[2].match(/<(?:[\w.-]+:)?ele\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?ele\s*>/i);
    const elevationM = elevationMatch ? Number(decodeXmlText(elevationMatch[1])) : Number.NaN;

    return { latitude, longitude, elevationM };
  });

  if (points.some((point) => !Number.isFinite(point.elevationM))) {
    throw new GpxAnalysisError("insufficient-elevation");
  }

  return { name: readRouteName(xml), points };
}

export function analyzeGpxRoute(
  input: { name?: string | null; points: GpxTrackPointInput[] },
  fallbackName = "Uploaded route",
): RouteAnalysisData {
  if (input.points.length < 2) {
    throw new GpxAnalysisError("no-track-points");
  }

  for (const point of input.points) {
    if (
      !Number.isFinite(point.latitude) ||
      !Number.isFinite(point.longitude) ||
      Math.abs(point.latitude) > 90 ||
      Math.abs(point.longitude) > 180
    ) {
      throw new GpxAnalysisError("invalid-coordinate");
    }
    if (!Number.isFinite(point.elevationM)) {
      throw new GpxAnalysisError("insufficient-elevation");
    }
  }

  const points: GpxRoutePointData[] = [];
  let distanceM = 0;
  let elevationGain = 0;
  let elevationLoss = 0;

  input.points.forEach((point, index) => {
    if (index > 0) {
      const previous = input.points[index - 1];
      distanceM += haversineDistance(
        previous.latitude,
        previous.longitude,
        point.latitude,
        point.longitude,
      );
      const elevationChange = point.elevationM - previous.elevationM;
      if (elevationChange > 0) elevationGain += elevationChange;
      else elevationLoss += Math.abs(elevationChange);
    }
    points.push({ ...point, distanceM });
  });

  if (distanceM <= 0) {
    throw new GpxAnalysisError("invalid-route");
  }

  const highestPoint = points.reduce((highest, point) =>
    point.elevationM > highest.elevationM ? point : highest,
  );
  const lowestPoint = points.reduce((lowest, point) =>
    point.elevationM < lowest.elevationM ? point : lowest,
  );
  const metrics: GpxRouteMetricsData = {
    distanceKm: Number((distanceM / 1000).toFixed(2)),
    elevationGainM: Math.round(elevationGain),
    elevationLossM: Math.round(elevationLoss),
    highestPointM: highestPoint.elevationM,
    highestPointDistanceKm: Number((highestPoint.distanceM / 1000).toFixed(1)),
    lowestPointM: lowestPoint.elevationM,
  };

  const majorClimbs = findMajorSegments(points, "climb");
  const majorDescents = findMajorSegments(points, "descent");
  const sections = createRouteSections(points);
  const keyMoments = createRouteMoments(
    points,
    metrics,
    majorClimbs,
    majorDescents,
  );

  return {
    name: input.name?.trim() || fallbackName,
    points,
    metrics,
    majorClimbs,
    majorDescents,
    sections,
    keyMoments,
    courseCharacter: createCourseCharacter(metrics, majorClimbs, majorDescents),
  };
}

function findMajorSegments(
  points: GpxRoutePointData[],
  direction: "climb" | "descent",
): GpxRouteSegmentData[] {
  const totalKm = points.at(-1)!.distanceM / 1000;
  const windowKm = Math.min(5, totalKm);
  const lastStartKm = Math.max(0, totalKm - windowKm);
  const starts: number[] = [];
  for (let startKm = 0; startKm < lastStartKm; startKm += 1) starts.push(startKm);
  starts.push(lastStartKm);

  const candidates = starts
    .map((startKm, index) => summarizeRange(points, startKm, startKm + windowKm, `candidate-${index}`))
    .filter((segment) =>
      direction === "climb"
        ? segment.elevationGainM > 0
        : segment.elevationLossM > 0,
    )
    .sort((a, b) => {
      const difference =
        direction === "climb"
          ? b.elevationGainM - a.elevationGainM
          : b.elevationLossM - a.elevationLossM;
      return difference || a.startKm - b.startKm;
    });

  const selected: GpxRouteSegmentData[] = [];
  for (const candidate of candidates) {
    if (selected.every((segment) =>
      candidate.endKm <= segment.startKm || candidate.startKm >= segment.endKm,
    )) {
      selected.push({ ...candidate, id: `${direction}-${selected.length + 1}` });
    }
    if (selected.length === 3) break;
  }
  return selected.sort((a, b) => a.startKm - b.startKm);
}

function createRouteSections(points: GpxRoutePointData[]): GpxRouteSegmentData[] {
  const totalKm = points.at(-1)!.distanceM / 1000;
  const sections: GpxRouteSegmentData[] = [];
  for (let startKm = 0, index = 0; startKm < totalKm; startKm += 10, index += 1) {
    sections.push(
      summarizeRange(points, startKm, Math.min(startKm + 10, totalKm), `section-${index + 1}`),
    );
  }
  return sections;
}

function summarizeRange(
  points: GpxRoutePointData[],
  startKm: number,
  endKm: number,
  id: string,
): GpxRouteSegmentData {
  const startM = startKm * 1000;
  const endM = endKm * 1000;
  const firstAfterStart = points.findIndex((point) => point.distanceM >= startM);
  const lastBeforeEnd = points.findLastIndex((point) => point.distanceM <= endM);
  let startIndex = firstAfterStart < 0 ? points.length - 1 : firstAfterStart;
  let endIndex = lastBeforeEnd < 0 ? startIndex : lastBeforeEnd;
  if (startIndex > endIndex) {
    const midpoint = (startM + endM) / 2;
    const nearestIndex = points.reduce(
      (bestIndex, point, index) =>
        Math.abs(point.distanceM - midpoint) <
        Math.abs(points[bestIndex].distanceM - midpoint)
          ? index
          : bestIndex,
      0,
    );
    startIndex = nearestIndex;
    endIndex = nearestIndex;
  }
  const selectedPoints = points.slice(startIndex, endIndex + 1);
  let gain = 0;
  let loss = 0;
  for (let index = 1; index < selectedPoints.length; index += 1) {
    const change = selectedPoints[index].elevationM - selectedPoints[index - 1].elevationM;
    if (change > 0) gain += change;
    else loss += Math.abs(change);
  }

  const firstPoint = selectedPoints[0] ?? points[0];
  const lastPoint = selectedPoints.at(-1) ?? firstPoint;
  const actualStartKm = firstPoint.distanceM / 1000;
  const actualEndKm = lastPoint.distanceM / 1000;

  return {
    id,
    startKm: Number(actualStartKm.toFixed(2)),
    endKm: Number(actualEndKm.toFixed(2)),
    distanceKm: Number((actualEndKm - actualStartKm).toFixed(2)),
    elevationGainM: Math.round(gain),
    elevationLossM: Math.round(loss),
  };
}

function createRouteMoments(
  points: GpxRoutePointData[],
  metrics: GpxRouteMetricsData,
  climbs: GpxRouteSegmentData[],
  descents: GpxRouteSegmentData[],
): KeyMomentData[] {
  const totalKm = points.at(-1)!.distanceM / 1000;
  const momentSpecs: Array<{ title: string; segment: GpxRouteSegmentData }> = [];

  if (climbs[0]) momentSpecs.push({ title: "Major climb", segment: climbs[0] });

  const highPointIndex = points.findIndex(
    (point) => point.elevationM === metrics.highestPointM &&
      Number((point.distanceM / 1000).toFixed(1)) === metrics.highestPointDistanceKm,
  );
  const contextKm = Math.min(5, totalKm);
  const highPointKm = highPointIndex >= 0 ? points[highPointIndex].distanceM / 1000 : 0;
  const highStartKm = Math.max(0, Math.min(highPointKm - contextKm / 2, totalKm - contextKm));
  momentSpecs.push({
    title: "High point",
    segment: summarizeRange(points, highStartKm, highStartKm + contextKm, "high-point"),
  });

  if (descents[0]) momentSpecs.push({ title: "Major descent", segment: descents[0] });
  if (climbs[1]) momentSpecs.push({ title: "Further climbing", segment: climbs[1] });

  const finalStartKm = Math.max(0, totalKm - Math.min(5, totalKm));
  momentSpecs.push({
    title: "Final approach",
    segment: summarizeRange(points, finalStartKm, totalKm, "final-approach"),
  });

  const uniqueMoments = momentSpecs.filter(
    (moment, index) =>
      momentSpecs.findIndex((candidate) => candidate.title === moment.title) === index,
  );

  return uniqueMoments.map(({ title, segment }, index) => ({
    id: `route-moment-${index + 1}`,
    number: String(index + 1).padStart(2, "0"),
    title,
    distance:
      title === "High point"
        ? `~${metrics.highestPointDistanceKm} km`
        : `${segment.startKm}–${segment.endKm} km`,
    focusStartKm: segment.startKm,
    focusEndKm: segment.endKm,
    gain: `+${segment.elevationGainM.toLocaleString("en-US")} m`,
    loss: `−${segment.elevationLossM.toLocaleString("en-US")} m`,
    text: `GPX-derived elevation changes across this route section.`,
    source: "GPX-derived",
  }));
}

function createCourseCharacter(
  metrics: GpxRouteMetricsData,
  climbs: GpxRouteSegmentData[],
  descents: GpxRouteSegmentData[],
): CourseCharacterData {
  const climbRhythm = climbs.length > 1
    ? "multiple major climbing windows"
    : climbs.length === 1
      ? "one major climbing window"
      : "no major climbing window";
  const descentRhythm = descents.length > 1
    ? "multiple major descending windows"
    : descents.length === 1
      ? "one major descending window"
      : "no major descending window";
  const attentionPoints = [
    `The GPX records ${metrics.elevationGainM.toLocaleString("en-US")} m of cumulative climbing.`,
    `The highest recorded elevation is ${Math.round(metrics.highestPointM).toLocaleString("en-US")} m.`,
    ...climbs.slice(0, 2).map(
      (segment) => `A major climb occurs around ${segment.startKm}–${segment.endKm} km.`,
    ),
    ...descents.slice(0, 2).map(
      (segment) => `A major descent occurs around ${segment.startKm}–${segment.endKm} km.`,
    ),
  ];

  return {
    terrain: "Unknown — the GPX track does not establish the route surface.",
    elevationPattern: `The GPX records ${metrics.elevationGainM.toLocaleString("en-US")} m of climbing and ${metrics.elevationLossM.toLocaleString("en-US")} m of descending over ${metrics.distanceKm} km.`,
    technicality: "Unknown — technical difficulty cannot be established from route coordinates and elevation alone.",
    courseRhythm: `The GPX elevation profile shows ${climbRhythm} and ${descentRhythm}.`,
    attentionPoints,
  };
}

function stripXmlProlog(xml: string): string {
  return xml.replace(/^\s*(?:<\?xml[^?]*\?>\s*)?(?:<!--[^]*?-->\s*)*/, "");
}

function hasValidXmlStructure(xml: string): boolean {
  const tags = [...xml.matchAll(/<(?:[^>"']|"[^"]*"|'[^']*')*>/g)].map((match) => match[0]);
  if (tags.length === 0 || xml.replace(/<(?:[^>"']|"[^"]*"|'[^']*')*>/g, "").includes("<")) {
    return false;
  }

  const stack: string[] = [];
  let rootCount = 0;
  for (const tag of tags) {
    if (/^<!--|^<\?|^<!\[CDATA\[|^<!DOCTYPE/i.test(tag)) continue;
    const closing = /^<\s*\//.test(tag);
    const selfClosing = /\/\s*>$/.test(tag);
    const name = tag.match(/^<\s*\/?\s*([\w:.-]+)/)?.[1];
    if (!name) return false;
    if (closing) {
      if (stack.pop() !== name) return false;
    } else {
      if (stack.length === 0) rootCount += 1;
      if (!selfClosing) stack.push(name);
    }
  }
  return stack.length === 0 && rootCount === 1;
}

function countOpeningTags(xml: string, name: string): number {
  const matcher = new RegExp(`<(?:(?:[\\w.-]+):)?${name}\\b`, "gi");
  return [...xml.matchAll(matcher)].length;
}

function parseXmlAttributes(text: string): Map<string, string> {
  const attributes = new Map<string, string>();
  const matcher = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  for (const match of text.matchAll(matcher)) {
    attributes.set(match[1], match[2] ?? match[3] ?? "");
  }
  return attributes;
}

function readRouteName(xml: string): string | null {
  const metadata = xml.match(/<(?:[\w.-]+:)?metadata\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?metadata\s*>/i)?.[1];
  const track = xml.match(/<(?:[\w.-]+:)?trk\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?trk\s*>/i)?.[1]
    ?? xml.match(/<(?:[\w.-]+:)?rte\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?rte\s*>/i)?.[1];
  const nameText = metadata?.match(/<(?:[\w.-]+:)?name\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?name\s*>/i)?.[1]
    ?? track?.match(/<(?:[\w.-]+:)?name\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?name\s*>/i)?.[1];
  const name = nameText ? decodeXmlText(nameText).trim() : "";
  return name || null;
}

function decodeXmlText(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function haversineDistance(
  latitude1: number,
  longitude1: number,
  latitude2: number,
  longitude2: number,
): number {
  const earthRadiusM = 6371000;
  const toRadians = (value: number) => (value * Math.PI) / 180;
  const deltaLatitude = toRadians(latitude2 - latitude1);
  const deltaLongitude = toRadians(longitude2 - longitude1);
  const a =
    Math.sin(deltaLatitude / 2) ** 2 +
    Math.cos(toRadians(latitude1)) *
      Math.cos(toRadians(latitude2)) *
      Math.sin(deltaLongitude / 2) ** 2;
  return 2 * earthRadiusM * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
