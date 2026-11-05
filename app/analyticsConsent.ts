export type AnalyticsConsent = "accepted" | "rejected";
export const ANALYTICS_CONSENT_KEY = "endurset.analytics-consent.v1";
export const GA_MEASUREMENT_ID_PATTERN = /^G-[A-Z0-9]{4,20}$/;
const consentListeners = new Set<() => void>();
let sessionConsent: AnalyticsConsent | null | undefined;

export interface ConsentStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function readAnalyticsConsent(storage: ConsentStorage): AnalyticsConsent | null {
  try {
    const value = storage.getItem(ANALYTICS_CONSENT_KEY);
    return value === "accepted" || value === "rejected" ? value : null;
  } catch {
    return null;
  }
}

export function saveAnalyticsConsent(storage: ConsentStorage, consent: AnalyticsConsent): boolean {
  try {
    storage.setItem(ANALYTICS_CONSENT_KEY, consent);
    return true;
  } catch {
    return false;
  }
}

export function getAnalyticsConsentSnapshot(): AnalyticsConsent | null | undefined {
  if (typeof window === "undefined") return undefined;
  try { return readEffectiveAnalyticsConsent(window.localStorage); } catch { return null; }
}

export function readEffectiveAnalyticsConsent(storage: ConsentStorage, sessionOverride: AnalyticsConsent | null | undefined = sessionConsent): AnalyticsConsent | null {
  return sessionOverride === undefined ? readAnalyticsConsent(storage) : sessionOverride;
}

export function subscribeAnalyticsConsent(listener: () => void): () => void {
  consentListeners.add(listener);
  if (typeof window !== "undefined") window.addEventListener("storage", handleConsentStorageChange);
  return () => {
    consentListeners.delete(listener);
    if (typeof window !== "undefined") window.removeEventListener("storage", handleConsentStorageChange);
  };
}

function handleConsentStorageChange() {
  sessionConsent = undefined;
  consentListeners.forEach((listener) => listener());
}

export function setAnalyticsConsentPreference(consent: AnalyticsConsent): boolean {
  let persisted = false;
  try { persisted = saveAnalyticsConsent(window.localStorage, consent); } catch { persisted = false; }
  sessionConsent = consent;
  consentListeners.forEach((listener) => listener());
  return persisted;
}

export function isValidGaMeasurementId(value: string | undefined): value is string {
  return Boolean(value && GA_MEASUREMENT_ID_PATTERN.test(value));
}

export type SafeAnalyticsEvent =
  | { type: "gpx_upload_attempt" }
  | { type: "gpx_analysis_success" }
  | { type: "gpx_analysis_failure"; category: "invalid_gpx" | "missing_elevation" | "file_limit" | "processing_error" }
  | { type: "sections_mode_selected"; mode: "terrain" | "custom" }
  | { type: "feedback_submit_success" };

export type AnalyticsEventPayload = { name: string; parameters: Record<string, string> };

/** Only fixed event names and allowlisted, non-route-specific values are emitted. */
export function toSafeAnalyticsPayload(event: SafeAnalyticsEvent): AnalyticsEventPayload {
  switch (event.type) {
    case "gpx_upload_attempt": return { name: "gpx_upload_attempt", parameters: {} };
    case "gpx_analysis_success": return { name: "gpx_analysis_success", parameters: {} };
    case "gpx_analysis_failure": return { name: "gpx_analysis_failure", parameters: { error_category: ["invalid_gpx", "missing_elevation", "file_limit", "processing_error"].includes(event.category) ? event.category : "processing_error" } };
    case "sections_mode_selected": return { name: "sections_mode_selected", parameters: { mode: event.mode === "custom" ? "custom" : "terrain" } };
    case "feedback_submit_success": return { name: "feedback_submit_success", parameters: {} };
  }
}

export function safeAnalyticsPage(pathname: string): { path: string; title: string } {
  const cleanPath = pathname.split(/[?#]/, 1)[0];
  const path = cleanPath === "/" || cleanPath === "/route" || cleanPath === "/privacy" ? cleanPath : "/other";
  return { path, title: path === "/privacy" ? "Privacy Policy | Endurset" : path === "/route" ? "GPX Route Analysis | Endurset" : "Endurset — GPX Route Analysis" };
}

type Gtag = (...args: unknown[]) => void;
type AnalyticsWindow = Window & { dataLayer?: unknown[]; gtag?: Gtag };

const GA_COOKIE_PATH = "/";

function setAnalyticsDisabled(window: AnalyticsWindow, measurementId: string, disabled: boolean): void {
  const globals = window as unknown as Record<string, unknown>;
  const key = `ga-disable-${measurementId}`;
  if (disabled) globals[key] = true;
  else delete globals[key];
}

/** Inserts Google's script only after affirmative consent and a valid, configured measurement ID. */
export function startBasicAnalytics(document: Document, window: AnalyticsWindow, measurementId: string, consent: AnalyticsConsent | null, pathname = "/"): boolean {
  if (consent !== "accepted" || !isValidGaMeasurementId(measurementId)) return false;
  const existingScript = document.querySelector('script[data-endurset-ga="true"]');
  // A fresh queue prevents events queued before a withdrawal from being replayed
  // when there is no existing tag to process the denial update.
  window.dataLayer = existingScript ? (window.dataLayer ?? []) : [];
  window.gtag = (...args: unknown[]) => { window.dataLayer?.push(args); };
  if (!existingScript) {
    // Basic Consent Mode keeps the Google tag absent until opt-in. Once accepted,
    // establish explicit defaults before initialization, then apply the choice.
    window.gtag("consent", "default", {
      analytics_storage: "denied",
      ad_storage: "denied",
      ad_user_data: "denied",
      ad_personalization: "denied",
    });
    window.gtag("js", new Date());
  }
  window.gtag("consent", "update", {
    analytics_storage: "granted",
    ad_storage: "denied",
    ad_user_data: "denied",
    ad_personalization: "denied",
  });
  const page = safeAnalyticsPage(pathname);
  window.gtag("config", measurementId, {
    send_page_view: false,
    allow_google_signals: false,
    allow_ad_personalization_signals: false,
    cookie_domain: window.location.hostname,
    cookie_path: GA_COOKIE_PATH,
    page_path: page.path,
    page_title: page.title,
    page_location: `${window.location.origin}${page.path}`,
  });
  // Keep the flag set until the new grant/config commands are queued.
  setAnalyticsDisabled(window, measurementId, false);
  if (existingScript) return true;
  const script = document.createElement("script");
  script.async = true;
  script.dataset.endursetGa = "true";
  script.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(measurementId)}`;
  document.head.appendChild(script);
  return true;
}

export function stopBasicAnalytics(document: Document, window: AnalyticsWindow, measurementId?: string): void {
  // Set Google's documented opt-out global before touching the loaded tag so
  // an already-running gtag.js cannot send another hit during teardown.
  if (isValidGaMeasurementId(measurementId)) setAnalyticsDisabled(window, measurementId, true);
  const gtag = window.gtag;
  // Discard pending analytics commands and leave only the denial update for a
  // loaded tag to observe. The application emits no analytics hits while denied.
  if (gtag) {
    if (window.dataLayer) window.dataLayer.length = 0;
    else window.dataLayer = [];
    try {
      gtag("consent", "update", {
        analytics_storage: "denied",
        ad_storage: "denied",
        ad_user_data: "denied",
        ad_personalization: "denied",
      });
    } catch { /* The global disable flag remains authoritative. */ }
  }
  // Do not remove an already requested script node. It may still be loading,
  // and retaining one node avoids a duplicate Google loader if consent returns.
  // The disable flag and denied state stop it from sending analytics.
  delete window.gtag;
  // Keep the queue available so a loaded Google tag can process the denied
  // consent update. It is reset before any later re-acceptance.
  // Remove only Google Analytics cookies for this host; no cookie values are read or logged.
  try {
    for (const cookie of document.cookie.split(";")) {
      const name = cookie.trim().split("=", 1)[0];
      if (name === "_ga" || name === "_gid" || name.startsWith("_ga_")) {
        const base = `${name}=; Max-Age=0; path=${GA_COOKIE_PATH}; SameSite=Lax`;
        try { document.cookie = base; } catch { /* Best-effort removal. */ }
        // Also expire the explicitly configured domain-scoped cookie. The
        // host-only attempt above covers cookies created without Domain.
        const hostname = window.location?.hostname;
        if (hostname && !hostname.includes(":")) {
          try { document.cookie = `${base}; Domain=${hostname}`; } catch { /* Best-effort removal. */ }
        }
      }
    }
  } catch { /* Cookie access can be restricted by browser settings. */ }
}

export function sendSafeAnalyticsEvent(window: AnalyticsWindow, event: SafeAnalyticsEvent, pathname = "/"): void {
  try { if (readEffectiveAnalyticsConsent(window.localStorage) !== "accepted" || !window.gtag) return; } catch { return; }
  const payload = toSafeAnalyticsPayload(event);
  const page = safeAnalyticsPage(pathname);
  try { window.gtag("event", payload.name, {
      ...payload.parameters,
      page_path: page.path,
      page_title: page.title,
      page_location: `${window.location.origin}${page.path}`,
    });
  } catch { /* Analytics must not affect product behavior. */ }
}

export function sendSafePageView(window: AnalyticsWindow, pathname: string): void {
  try { if (readEffectiveAnalyticsConsent(window.localStorage) !== "accepted" || !window.gtag) return; } catch { return; }
  const page = safeAnalyticsPage(pathname);
  try { window.gtag("event", "page_view", {
      page_path: page.path,
      page_title: page.title,
      page_location: `${window.location.origin}${page.path}`,
    });
  } catch { /* Analytics must not affect navigation. */ }
}
