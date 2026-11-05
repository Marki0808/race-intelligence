"use client";

import { Suspense, useEffect, useState, useSyncExternalStore } from "react";
import { usePathname } from "next/navigation";
import Link from "next/link";
import { Analytics, type BeforeSendEvent } from "@vercel/analytics/next";
import {
  isValidGaMeasurementId,
  getAnalyticsConsentSnapshot,
  sendSafePageView,
  setAnalyticsConsentPreference,
  startBasicAnalytics,
  subscribeAnalyticsConsent,
  stopBasicAnalytics,
  type AnalyticsConsent,
} from "./analyticsConsent";
import { filterVercelAnalyticsEvent } from "./vercelAnalyticsConsent";

const measurementId = process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID;
const OPEN_SETTINGS_EVENT = "endurset:open-privacy-settings";

function gateVercelAnalyticsEvent(event: BeforeSendEvent): BeforeSendEvent | null {
  return filterVercelAnalyticsEvent(event, getAnalyticsConsentSnapshot(), window.location.origin);
}

export default function AnalyticsConsentManager() {
  return <Suspense fallback={null}><ConsentExperience /></Suspense>;
}

function ConsentExperience() {
  const pathname = usePathname();
  const choice = useSyncExternalStore(subscribeAnalyticsConsent, getAnalyticsConsentSnapshot, () => undefined);
  const [open, setOpen] = useState(false);
  const [storageNotice, setStorageNotice] = useState("");

  useEffect(() => {
    const openSettings = () => setOpen(true);
    window.addEventListener(OPEN_SETTINGS_EVENT, openSettings);
    return () => window.removeEventListener(OPEN_SETTINGS_EVENT, openSettings);
  }, []);

  useEffect(() => {
    if (choice === undefined) return;
    try {
      if (choice === "accepted" && isValidGaMeasurementId(measurementId)) {
        startBasicAnalytics(document, window, measurementId, choice, "/");
      } else {
        stopBasicAnalytics(document, window, measurementId);
      }
    } catch {
      try { stopBasicAnalytics(document, window, measurementId); } catch { /* Optional analytics must never break the app. */ }
    }
  }, [choice]);

  useEffect(() => {
    if (choice === "accepted" && isValidGaMeasurementId(measurementId)) {
      try { sendSafePageView(window, pathname); } catch { /* Analytics remains optional. */ }
    }
  }, [choice, pathname]);

  function choose(next: AnalyticsConsent) {
    // Withdraw synchronously in the click handler; React effects run after the
    // event and would otherwise leave a brief window for an already-loaded tag.
    if (next === "rejected") {
      try { stopBasicAnalytics(document, window, measurementId); } catch { /* Consent choice still applies. */ }
    }
    const persisted = setAnalyticsConsentPreference(next);
    setStorageNotice(persisted ? "" : "Your choice applies for this visit, but browser storage is unavailable so it could not be saved.");
    setOpen(false);
  }

  if (choice === undefined) return null;
  return (
    <>
      {(choice === null || open) && (
        <section aria-labelledby="analytics-consent-title" aria-describedby="analytics-consent-description" className="fixed inset-x-3 bottom-14 z-[80] mx-auto max-w-3xl rounded-2xl border border-[#dce2d6] bg-[#fffefa] p-4 text-[#203329] shadow-[0_18px_50px_-20px_rgba(0,0,0,.38)] sm:inset-x-6 sm:bottom-16 sm:p-5" role="region">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 id="analytics-consent-title" className="text-base font-semibold">Optional analytics</h2>
              <p id="analytics-consent-description" className="mt-1 max-w-2xl text-sm leading-5 text-[#526253]">
                Allow Google Analytics and Vercel Web Analytics to measure basic website and product usage. Both stay off unless you accept. Your GPX, route details and feedback are never sent as analytics data. Read the <Link href="/privacy" className="underline underline-offset-2">Privacy Policy</Link> or change this choice later in Privacy settings.
              </p>
              {!isValidGaMeasurementId(measurementId) && <p className="mt-2 text-xs leading-5 text-[#59635d]">Google Analytics is not configured; Vercel Web Analytics requires project activation and your consent.</p>}
              {storageNotice && <p role="status" className="mt-2 text-xs text-[#7a4b12]">{storageNotice}</p>}
            </div>
            {choice !== null && <button type="button" onClick={() => setOpen(false)} aria-label="Close privacy settings" className="rounded px-2 py-1 text-sm text-[#526253] hover:bg-[#f1f2ec] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#71805d]">Close</button>}
          </div>
          <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:justify-end">
            <button type="button" onClick={() => choose("accepted")} className="min-h-11 rounded-full border border-[#26382f] bg-[#26382f] px-5 text-sm font-semibold text-white transition hover:bg-[#354b3f] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#71805d]">Accept analytics</button>
            <button type="button" onClick={() => choose("rejected")} className="min-h-11 rounded-full border border-[#26382f] bg-[#26382f] px-5 text-sm font-semibold text-white transition hover:bg-[#354b3f] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#71805d]">Reject analytics</button>
          </div>
        </section>
      )}
      {choice === "accepted" && <Analytics beforeSend={gateVercelAnalyticsEvent} />}
    </>
  );
}
