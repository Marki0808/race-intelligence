import {
  readEffectiveAnalyticsConsent,
  sendSafeAnalyticsEvent,
  type SafeAnalyticsEvent,
} from "./analyticsConsent";

/** Event calls are no-ops unless a valid, affirmative preference is stored and GA is initialized. */
export function trackSafeAnalyticsEvent(event: SafeAnalyticsEvent): void {
  if (typeof window === "undefined") return;
  try {
    if (readEffectiveAnalyticsConsent(window.localStorage) !== "accepted") return;
    sendSafeAnalyticsEvent(window, event, window.location.pathname);
  } catch {
    // Analytics is optional and must never interrupt route analysis or feedback.
  }
}
