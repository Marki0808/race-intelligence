"use client";

type PendingDiscoveredGpx = { text: string; name: string };

let pendingDiscoveredGpx: PendingDiscoveredGpx | null = null;

export function setPendingDiscoveredGpx(route: PendingDiscoveredGpx) {
  pendingDiscoveredGpx = route;
}

export function consumePendingDiscoveredGpx(): PendingDiscoveredGpx | null {
  const route = pendingDiscoveredGpx;
  pendingDiscoveredGpx = null;
  return route;
}
