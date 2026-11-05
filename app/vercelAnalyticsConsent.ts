import type { BeforeSendEvent } from "@vercel/analytics/next";
import type { AnalyticsConsent } from "./analyticsConsent";

const SAFE_PAGE_PATHS = new Set(["/", "/route", "/privacy"]);

/** Drops Vercel events without current opt-in and strips query/hash or unknown paths. */
export function filterVercelAnalyticsEvent(
  event: BeforeSendEvent,
  consent: AnalyticsConsent | null | undefined,
  siteOrigin: string,
): BeforeSendEvent | null {
  if (consent !== "accepted") return null;

  try {
    const origin = new URL(siteOrigin).origin;
    const url = new URL(event.url, origin);
    if (url.origin !== origin) return null;
    const path = SAFE_PAGE_PATHS.has(url.pathname) ? url.pathname : "/other";
    return { ...event, url: `${origin}${path}` };
  } catch {
    return null;
  }
}
