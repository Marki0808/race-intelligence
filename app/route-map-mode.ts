export type RouteMapMode = "3d" | "2d";
export const DEFAULT_ROUTE_MAP_MODE: RouteMapMode = "3d";

export function resolveRouteMapModeForAnalysis<T>(stateAnalysis: T, activeAnalysis: T, storedMode: RouteMapMode): RouteMapMode {
  return stateAnalysis === activeAnalysis ? storedMode : DEFAULT_ROUTE_MAP_MODE;
}
