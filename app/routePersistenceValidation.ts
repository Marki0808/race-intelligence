export type PersistenceRequest =
  | { operation: "lookup"; persistenceScope: "shared"; routeFingerprint: string; routeFingerprintVersion: number; analysisInputFingerprint: string }
  | { operation: "enrich"; persistenceScope: "shared"; routeFingerprint: string; routeFingerprintVersion: number; needs: { osm: boolean; mapillary: boolean } };

export function validatePersistenceRequest(value: unknown): PersistenceRequest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (body.persistenceScope !== "shared" || typeof body.routeFingerprint !== "string" ||
    !/^route-v\d+-sha256-[a-f0-9]{64}$/.test(body.routeFingerprint) ||
    typeof body.routeFingerprintVersion !== "number" || !Number.isInteger(body.routeFingerprintVersion) ||
    body.routeFingerprintVersion < 1 || !body.routeFingerprint.startsWith(`route-v${body.routeFingerprintVersion}-`)) return null;
  if (body.operation === "lookup" && hasExactKeys(body, ["operation", "persistenceScope", "routeFingerprint", "routeFingerprintVersion", "analysisInputFingerprint"]) &&
    typeof body.analysisInputFingerprint === "string" && /^analysis-input-v\d+-sha256-[a-f0-9]{64}$/.test(body.analysisInputFingerprint)) return {
    operation: "lookup", persistenceScope: "shared", routeFingerprint: body.routeFingerprint,
    routeFingerprintVersion: body.routeFingerprintVersion, analysisInputFingerprint: body.analysisInputFingerprint,
  };
  if (body.operation === "enrich" && hasExactKeys(body, ["operation", "persistenceScope", "routeFingerprint", "routeFingerprintVersion", "needs"]) &&
    body.needs && typeof body.needs === "object" && !Array.isArray(body.needs)) {
    const needs = body.needs as Record<string, unknown>;
    if (!hasExactKeys(needs, ["osm", "mapillary"]) || typeof needs.osm !== "boolean" || typeof needs.mapillary !== "boolean" || (!needs.osm && !needs.mapillary)) return null;
    return {
      operation: "enrich", persistenceScope: "shared", routeFingerprint: body.routeFingerprint,
      routeFingerprintVersion: body.routeFingerprintVersion, needs: { osm: needs.osm, mapillary: needs.mapillary },
    };
  }
  return null;
}

function hasExactKeys(value: Record<string, unknown>, expected: string[]) {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}
