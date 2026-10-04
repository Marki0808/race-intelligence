import type {
  CourseCharacterData,
  GpxCourseAnalysisData,
  KeyMomentData,
} from "./raceTypes";
import { analyzeRouteDynamics, type RouteDynamicsResult } from "./routeDynamics.ts";
import { buildRouteSections, type RouteSection } from "./routeSectionEngine.ts";
import { createRouteKeyMoments } from "./routeKeyMoments.ts";

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

export type GpxRoutePosition = { distanceM: number; segmentIndex: number };
export type ParsedGpx = {
  name: string | null;
  segments: GpxTrackPointInput[][];
  /** Derived convenience view; every point retains its source segment. */
  points: Array<GpxTrackPointInput & { segmentIndex: number }>;
};

export type GpxRoutePointData = GpxTrackPointInput & {
  distanceM: number;
  segmentIndex: number;
};

export type GpxRouteMetricsData = GpxCourseAnalysisData;

export type GpxRouteSegmentData = {
  id: string;
  segmentIndex?: number;
  startKm: number;
  endKm: number;
  distanceKm: number;
  elevationGainM: number;
  elevationLossM: number;
};

export type RouteAnalysisData = {
  name: string;
  segments: AnalyzedRouteSegment[];
  points: GpxRoutePointData[];
  metrics: GpxRouteMetricsData;
  majorClimbs: GpxRouteSegmentData[];
  majorDescents: GpxRouteSegmentData[];
  sections: GpxRouteSegmentData[];
  routeDynamics: RouteDynamicsResult;
  routeSections: RouteSection[];
  keyMoments: KeyMomentData[];
  courseCharacter: CourseCharacterData;
};

export type AnalyzedRouteSegment = {
  segmentIndex: number;
  startDistanceM: number;
  endDistanceM: number;
  points: GpxRoutePointData[];
};

export function groupAnalyzedPointsBySegment<T extends { segmentIndex?: number }>(points: readonly T[]): T[][] {
  const grouped = new Map<number, T[]>();
  for (const point of points) {
    const segmentIndex = point.segmentIndex ?? 0;
    const segment = grouped.get(segmentIndex) ?? [];
    segment.push(point);
    grouped.set(segmentIndex, segment);
  }
  return [...grouped.values()];
}

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

export function parseGpxText(text: string): ParsedGpx {
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
  const segments = trackCount > 0
    ? parseTrackSegments(xml)
    : [parsePointElements(xml, pointTag)];
  const points = segments.flatMap((segment, segmentIndex) => segment.map((point) => ({ ...point, segmentIndex })));
  if (points.length === 0) {
    throw new GpxAnalysisError("no-track-points");
  }

  if (points.some((point) => !Number.isFinite(point.elevationM))) {
    throw new GpxAnalysisError("insufficient-elevation");
  }

  return { name: readRouteName(xml), segments, points };
}

export function analyzeGpxRoute(
  input: { name?: string | null; points?: readonly (GpxTrackPointInput & { segmentIndex?: number })[]; segments?: readonly (readonly GpxTrackPointInput[])[] },
  fallbackName = "Uploaded route",
): RouteAnalysisData {
  const sourceSegments = input.segments ?? groupPointsBySegment(input.points ?? []);
  if (!sourceSegments.some((segment) => segment.length >= 2)) {
    throw new GpxAnalysisError("no-track-points");
  }

  for (const point of sourceSegments.flat()) {
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
  const segments: AnalyzedRouteSegment[] = [];
  let distanceM = 0;
  let elevationGain = 0;
  let elevationLoss = 0;

  sourceSegments.forEach((segment, segmentIndex) => {
    const segmentPoints: GpxRoutePointData[] = [];
    const startDistanceM = distanceM;
    segment.forEach((point, index) => {
    if (index > 0) {
      const previous = segment[index - 1];
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
    const analyzedPoint = { ...point, distanceM, segmentIndex };
    points.push(analyzedPoint);
    segmentPoints.push(analyzedPoint);
    });
    segments.push({ segmentIndex, startDistanceM, endDistanceM: distanceM, points: segmentPoints });
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

  const majorClimbs = segments.flatMap(({ segmentIndex, points: segmentPoints }) => summarizeSegmentWindows(segmentPoints, segmentIndex, "climb"));
  const majorDescents = segments.flatMap(({ segmentIndex, points: segmentPoints }) => summarizeSegmentWindows(segmentPoints, segmentIndex, "descent"));
  const sections = segments.flatMap(({ segmentIndex, points: segmentPoints }) => segmentPoints.length > 1 ? summarizeRouteSections(segmentPoints, segmentIndex) : []);
  const routeDynamics = analyzeRouteDynamics(points);
  const routeSections = buildRouteSections(routeDynamics, points);
  const keyMoments = createRouteKeyMoments(points, metrics, routeDynamics);

  return {
    name: input.name?.trim() || fallbackName,
    segments,
    points,
    metrics,
    majorClimbs,
    majorDescents,
    sections,
    routeDynamics,
    routeSections,
    keyMoments,
    courseCharacter: createCourseCharacter(metrics, majorClimbs, majorDescents),
  };
}

function localizeSegment(points: readonly GpxRoutePointData[]) {
  const offsetM = points[0]?.distanceM ?? 0;
  return { offsetM, points: points.map((point) => ({ ...point, distanceM: point.distanceM - offsetM })) };
}

function summarizeSegmentWindows(points: readonly GpxRoutePointData[], segmentIndex: number, direction: "climb" | "descent") {
  if (points.length < 2) return [];
  const { offsetM, points: local } = localizeSegment(points);
  return findMajorSegments(local, direction).map((segment) => ({
    ...segment,
    id: `segment-${segmentIndex}-${segment.id}`,
    segmentIndex,
    startKm: Number((segment.startKm + offsetM / 1000).toFixed(2)),
    endKm: Number((segment.endKm + offsetM / 1000).toFixed(2)),
  }));
}

function summarizeRouteSections(points: readonly GpxRoutePointData[], segmentIndex: number) {
  const { offsetM, points: local } = localizeSegment(points);
  return createRouteSections(local).map((section) => ({
    ...section,
    id: `segment-${segmentIndex}-${section.id}`,
    segmentIndex,
    startKm: Number((section.startKm + offsetM / 1000).toFixed(2)),
    endKm: Number((section.endKm + offsetM / 1000).toFixed(2)),
  }));
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

function groupPointsBySegment(points: readonly (GpxTrackPointInput & { segmentIndex?: number })[]) {
  const groups: Array<Array<GpxTrackPointInput & { segmentIndex?: number }>> = [];
  for (const point of points) {
    const index = point.segmentIndex ?? 0;
    while (groups.length <= index) groups.push([]);
    groups[index].push(point);
  }
  return groups;
}

function parseTrackSegments(xml: string): GpxTrackPointInput[][] {
  const segmentPattern = /<(?:[\w.-]+:)?trkseg\b[^>]*\/\s*>|<(?:[\w.-]+:)?trkseg\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?trkseg\s*>/gi;
  return [...xml.matchAll(segmentPattern)].map((match) => match[1] ? parsePointElements(match[1], "trkpt") : []);
}

function parsePointElements(xml: string, tag: "trkpt" | "rtept"): GpxTrackPointInput[] {
  const pattern = new RegExp(`<((?:[\\w.-]+:)?)${tag}\\b([^>]*)>([\\s\\S]*?)<\\/\\1${tag}\\s*>`, "gi");
  return [...xml.matchAll(pattern)].map((match) => {
    const attributes = parseXmlAttributes(match[2]);
    const latitude = Number(attributes.get("lat"));
    const longitude = Number(attributes.get("lon"));
    const elevationMatch = match[3].match(/<(?:[\w.-]+:)?ele\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?ele\s*>/i);
    const elevationM = elevationMatch ? Number(decodeXmlText(elevationMatch[1])) : Number.NaN;
    return { latitude, longitude, elevationM };
  });
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
