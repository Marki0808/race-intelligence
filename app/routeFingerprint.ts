export const ROUTE_FINGERPRINT_VERSION = 1;
export const ROUTE_FINGERPRINT_RESAMPLE_METERS = 100;
export const ROUTE_FINGERPRINT_SIMPLIFY_TOLERANCE_METERS = 12;
export const ROUTE_FINGERPRINT_COORDINATE_QUANTUM = 0.0001;

export type RouteGeometryPoint = { latitude: number; longitude: number };
export type CanonicalRoutePoint = RouteGeometryPoint;

export type RouteFingerprintResult = {
  routeFingerprintVersion: number;
  routeFingerprint: string;
  normalizedGeometry: CanonicalRoutePoint[];
  normalizedDistanceKm: number;
};

/**
 * Fingerprints the ordered physical route, independently of GPX metadata and race identity.
 * Direction is significant: reversing traversal intentionally creates a different identity.
 */
export async function createRouteFingerprint(
  input: readonly RouteGeometryPoint[],
): Promise<RouteFingerprintResult> {
  const points = validateAndRemoveConsecutiveDuplicates(input);
  if (points.length < 2) throw new RangeError("A route fingerprint requires at least two distinct points.");

  const simplified = simplifyRoute(points, ROUTE_FINGERPRINT_SIMPLIFY_TOLERANCE_METERS);
  const distance = routeLengthMeters(simplified);
  if (distance <= 0) throw new RangeError("A route fingerprint requires a route with positive distance.");

  const normalizedGeometry = resampleAndQuantize(simplified, distance);
  const coordinateUnits = normalizedGeometry.map((point) => [
    Math.round(point.latitude / ROUTE_FINGERPRINT_COORDINATE_QUANTUM),
    Math.round(point.longitude / ROUTE_FINGERPRINT_COORDINATE_QUANTUM),
  ]);
  const supportingDistanceMeters = Math.round(distance / ROUTE_FINGERPRINT_RESAMPLE_METERS) * ROUTE_FINGERPRINT_RESAMPLE_METERS;
  const canonical = [
    `route-fingerprint-v${ROUTE_FINGERPRINT_VERSION}`,
    `simplify-m=${ROUTE_FINGERPRINT_SIMPLIFY_TOLERANCE_METERS}`,
    `resample-m=${ROUTE_FINGERPRINT_RESAMPLE_METERS}`,
    `coordinate-quantum=${ROUTE_FINGERPRINT_COORDINATE_QUANTUM}`,
    `direction=ordered`,
    `distance-m=${supportingDistanceMeters}`,
    coordinateUnits.map(([latitude, longitude]) => `${latitude},${longitude}`).join(";"),
  ].join("\n");

  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return {
    routeFingerprintVersion: ROUTE_FINGERPRINT_VERSION,
    routeFingerprint: `route-v${ROUTE_FINGERPRINT_VERSION}-sha256-${hex}`,
    normalizedGeometry,
    normalizedDistanceKm: Number((distance / 1000).toFixed(3)),
  };
}

function validateAndRemoveConsecutiveDuplicates(input: readonly RouteGeometryPoint[]): RouteGeometryPoint[] {
  const points: RouteGeometryPoint[] = [];
  for (const point of input) {
    if (!Number.isFinite(point.latitude) || Math.abs(point.latitude) > 90 ||
      !Number.isFinite(point.longitude) || Math.abs(point.longitude) > 180) {
      throw new RangeError("Route fingerprint coordinates must be valid latitude/longitude values.");
    }
    const previous = points.at(-1);
    if (!previous || previous.latitude !== point.latitude || previous.longitude !== point.longitude) {
      points.push({ latitude: point.latitude, longitude: point.longitude });
    }
  }
  return points;
}

function simplifyRoute(points: RouteGeometryPoint[], toleranceMeters: number): RouteGeometryPoint[] {
  if (points.length <= 2) return points;
  const referenceLatitude = points[0].latitude * Math.PI / 180;
  const longitudeScale = 111_320 * Math.cos(referenceLatitude);
  const projected = points.map((point) => ({
    x: (point.longitude - points[0].longitude) * longitudeScale,
    y: (point.latitude - points[0].latitude) * 111_320,
  }));
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const pending: Array<[number, number]> = [[0, points.length - 1]];

  while (pending.length) {
    const [start, end] = pending.pop()!;
    let farthestIndex = -1;
    let farthestDistance = toleranceMeters;
    for (let index = start + 1; index < end; index += 1) {
      const distance = pointToSegmentDistance(projected[index], projected[start], projected[end]);
      if (distance > farthestDistance) {
        farthestDistance = distance;
        farthestIndex = index;
      }
    }
    if (farthestIndex >= 0) {
      keep[farthestIndex] = 1;
      pending.push([start, farthestIndex], [farthestIndex, end]);
    }
  }

  return points.filter((_, index) => keep[index] === 1);
}

function pointToSegmentDistance(
  point: { x: number; y: number },
  start: { x: number; y: number },
  end: { x: number; y: number },
) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const denominator = dx * dx + dy * dy;
  const t = denominator === 0 ? 0 : Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / denominator));
  return Math.hypot(point.x - (start.x + t * dx), point.y - (start.y + t * dy));
}

function routeLengthMeters(points: RouteGeometryPoint[]) {
  let total = 0;
  for (let index = 1; index < points.length; index += 1) {
    total += haversineMeters(points[index - 1], points[index]);
  }
  return total;
}

function resampleAndQuantize(points: RouteGeometryPoint[], totalDistanceMeters: number): CanonicalRoutePoint[] {
  const distances = [0];
  for (let index = 1; index < points.length; index += 1) {
    distances.push(distances[index - 1] + haversineMeters(points[index - 1], points[index]));
  }
  const samples: RouteGeometryPoint[] = [points[0]];
  let segmentIndex = 1;
  for (let distance = ROUTE_FINGERPRINT_RESAMPLE_METERS; distance < totalDistanceMeters; distance += ROUTE_FINGERPRINT_RESAMPLE_METERS) {
    while (segmentIndex < distances.length - 1 && distances[segmentIndex] < distance) segmentIndex += 1;
    const startDistance = distances[segmentIndex - 1];
    const segmentLength = distances[segmentIndex] - startDistance;
    const fraction = segmentLength > 0 ? (distance - startDistance) / segmentLength : 0;
    const start = points[segmentIndex - 1];
    const end = points[segmentIndex];
    samples.push({
      latitude: start.latitude + (end.latitude - start.latitude) * fraction,
      longitude: start.longitude + (end.longitude - start.longitude) * fraction,
    });
  }
  samples.push(points.at(-1)!);

  const quantum = ROUTE_FINGERPRINT_COORDINATE_QUANTUM;
  return samples.map((point) => ({
    latitude: Math.round(point.latitude / quantum) * quantum,
    longitude: Math.round(point.longitude / quantum) * quantum,
  }));
}

function haversineMeters(start: RouteGeometryPoint, end: RouteGeometryPoint) {
  const latitudeDelta = (end.latitude - start.latitude) * Math.PI / 180;
  const longitudeDelta = (end.longitude - start.longitude) * Math.PI / 180;
  const startLatitude = start.latitude * Math.PI / 180;
  const endLatitude = end.latitude * Math.PI / 180;
  const value = Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(startLatitude) * Math.cos(endLatitude) * Math.sin(longitudeDelta / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}
