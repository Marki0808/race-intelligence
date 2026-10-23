"use client";

import type { AidStationDiscoveryV1 } from "./aidStationDiscovery";

type PendingDiscoveredGpx = { text: string; name: string; aidStationDiscoveryV1?: AidStationDiscoveryV1 | null };

let pendingDiscoveredGpx: PendingDiscoveredGpx | null = null;

export function setPendingDiscoveredGpx(route: PendingDiscoveredGpx) {
  pendingDiscoveredGpx = route;
}

export function consumePendingDiscoveredGpx(): PendingDiscoveredGpx | null {
  const route = pendingDiscoveredGpx;
  pendingDiscoveredGpx = null;
  return route;
}
