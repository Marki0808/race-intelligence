export type RouteUnitSystem = "metric" | "us-customary";

export const KILOMETERS_PER_MILE = 1.609344;
export const METERS_PER_FOOT = 0.3048;

export function readStoredRouteUnits(storage: Pick<Storage, "getItem"> | null): RouteUnitSystem {
  try {
    const value = storage?.getItem("race-intelligence.route-units.v1");
    return value === "us-customary" ? "us-customary" : "metric";
  } catch { return "metric"; }
}

export function writeStoredRouteUnits(storage: Pick<Storage, "setItem"> | null, units: RouteUnitSystem): boolean {
  try { storage?.setItem("race-intelligence.route-units.v1", units); return storage !== null; }
  catch { return false; }
}

export function formatDistanceMeters(distanceM: number, units: RouteUnitSystem, digits = 2, minimumDigits = 0): string {
  const distance = distanceM / (units === "metric" ? 1000 : 1000 * KILOMETERS_PER_MILE);
  const unit = units === "metric" ? "km" : "mi";
  const boundedDigits = Math.max(0, Math.min(6, Math.trunc(digits)));
  let displayDigits = boundedDigits;
  while (distance > 0 && Number(distance.toFixed(displayDigits)) === 0 && displayDigits < 6) displayDigits += 1;
  return `${formatNumber(distance, displayDigits, Math.min(boundedDigits, Math.max(0, Math.trunc(minimumDigits))))} ${unit}`;
}

export function formatRouteDistanceKm(distanceKm: number, units: RouteUnitSystem, digits = 1): string {
  return formatDistanceMeters(distanceKm * 1000, units, digits);
}

/** Uses conversational distance wording in prose while compact UI continues to use abbreviated units. */
export function formatNarrativeDistance(distanceM: number, units: RouteUnitSystem, digits = 1): string {
  if (units === "metric") return `km ${formatDistanceMeters(distanceM, units, digits).replace(/ km$/, "")}`;
  const miles = distanceM / (1000 * KILOMETERS_PER_MILE);
  const boundedDigits = Math.max(0, Math.min(6, Math.trunc(digits)));
  const rounded = Number(miles.toFixed(boundedDigits));
  const value = new Intl.NumberFormat("en-US", { maximumFractionDigits: boundedDigits }).format(rounded);
  return `mile${rounded === 1 ? "" : "s"} ${value}`;
}

export function formatElevationNumber(elevationM: number, units: RouteUnitSystem, digits = 0): string {
  return formatNumber(units === "metric" ? elevationM : elevationM / METERS_PER_FOOT, digits);
}

export function formatElevationMeters(elevationM: number, units: RouteUnitSystem, digits = 0): string {
  return `${formatElevationNumber(elevationM, units, digits)} ${units === "metric" ? "m" : "ft"}`;
}

export function distanceUnit(units: RouteUnitSystem): "km" | "mi" {
  return units === "metric" ? "km" : "mi";
}

export function elevationUnit(units: RouteUnitSystem): "m" | "ft" {
  return units === "metric" ? "m" : "ft";
}

/** Converts a user-entered presentation value to the existing canonical kilometer representation. */
export function distanceInputToKm(value: string, units: RouteUnitSystem): string {
  if (!value.trim()) return value;
  const normalized = value.trim().replace(",", ".");
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) return value;
  if (units === "metric") return normalized === value.trim() ? value : String(parsed);
  return String(parsed * KILOMETERS_PER_MILE);
}

/** Converts canonical kilometers for display without mutating the stored boundary. */
export function distanceKmToInput(value: string, units: RouteUnitSystem): string {
  if (units === "metric" || !value.trim()) return value;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return value;
  return Number((parsed / KILOMETERS_PER_MILE).toPrecision(12)).toString();
}

function formatNumber(value: number, digits: number, minimumDigits = 0): string {
  if (!Number.isFinite(value)) return "—";
  const boundedDigits = Math.max(0, Math.min(6, Math.trunc(digits)));
  const rounded = Number(value.toFixed(boundedDigits));
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: boundedDigits, minimumFractionDigits: Math.min(boundedDigits, Math.max(0, minimumDigits)) }).format(rounded);
}
