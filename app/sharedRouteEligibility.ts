import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { raceRegistry } from "./raceRegistry.ts";
import { analyzeGpxRoute, parseGpxText, type RouteAnalysisData } from "./gpxAnalysis.ts";
import { createRouteFingerprint, type RouteFingerprintResult } from "./routeFingerprint.ts";

export type SharedRouteEligibility = {
  routeFingerprint: string;
  routeFingerprintVersion: number;
  raceId: string;
  raceName: string;
  editionYear: number;
  gpxPath: string;
  fingerprint: RouteFingerprintResult;
  analysis: RouteAnalysisData;
};

let eligibilityPromise: Promise<SharedRouteEligibility[]> | null = null;

/** Only source-controlled official race GPX records are eligible for shared persistence. */
export async function getSharedRouteEligibility(fingerprint: string, fingerprintVersion: number): Promise<SharedRouteEligibility | null> {
  const routes = await (eligibilityPromise ??= loadEligibleRoutes());
  return routes.find((route) => route.routeFingerprint === fingerprint && route.routeFingerprintVersion === fingerprintVersion) ?? null;
}

async function loadEligibleRoutes(): Promise<SharedRouteEligibility[]> {
  const publicRoot = resolve(process.cwd(), "public");
  const results = await Promise.all(raceRegistry.flatMap((record) => record.race.editions.map(async (edition) => {
    const relativePath = edition.gpxPath.replace(/^\/+/, "");
    const filePath = resolve(publicRoot, relativePath);
    if (!filePath.startsWith(`${publicRoot}${sep}`)) return null;
    try {
      const parsed = parseGpxText(await readFile(filePath, "utf8"));
      const fingerprint = await createRouteFingerprint(parsed.points);
      return {
        routeFingerprint: fingerprint.routeFingerprint,
        routeFingerprintVersion: fingerprint.routeFingerprintVersion,
        raceId: record.race.id,
        raceName: record.race.name,
        editionYear: edition.year,
        gpxPath: edition.gpxPath,
        fingerprint,
        analysis: analyzeGpxRoute(parsed),
      } satisfies SharedRouteEligibility;
    } catch {
      return null;
    }
  })));
  return results.filter((route): route is SharedRouteEligibility => route !== null);
}
