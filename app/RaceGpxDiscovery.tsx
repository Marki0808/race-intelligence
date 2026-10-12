"use client";

import { useState } from "react";
import type { FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { setPendingDiscoveredGpx } from "./discoveredGpxTransfer";

type Candidate = {
  gpxUrl: string;
  sourcePageUrl: string;
  linkText: string;
  supportingEvidence: string[];
  distanceLabel: string | null;
  discoveryStatus: "link-evidence-only";
  ambiguity: "multiple-candidates" | null;
};

type DiscoveryResponse = { status: string; candidates?: Candidate[]; category?: string };

function isSafeDisplayUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch { return false; }
}

export default function RaceGpxDiscovery() {
  const router = useRouter();
  const [raceUrl, setRaceUrl] = useState("");
  const [submittedUrl, setSubmittedUrl] = useState("");
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [selectedUrl, setSelectedUrl] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "no-results" | "error" | "downloading" | "ready">("idle");
  const [message, setMessage] = useState("");

  async function handleDiscovery(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setCandidates([]);
    setSelectedUrl("");
    setSubmittedUrl(raceUrl.trim());
    setMessage("");
    setStatus("loading");
    try {
      const response = await fetch("/api/race-gpx-discovery", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: raceUrl.trim() }),
      });
      const result = await response.json() as DiscoveryResponse;
      if (result.status === "success" && Array.isArray(result.candidates)) {
        const safeCandidates = result.candidates.filter((candidate) =>
          candidate && isSafeDisplayUrl(candidate.gpxUrl) && isSafeDisplayUrl(candidate.sourcePageUrl) &&
          candidate.discoveryStatus === "link-evidence-only" && typeof candidate.linkText === "string" &&
          Array.isArray(candidate.supportingEvidence) && candidate.supportingEvidence.every((item) => typeof item === "string"),
        );
        if (safeCandidates.length) {
          setCandidates(safeCandidates);
          setStatus("idle");
          return;
        }
      }
      if (result.status === "no-results") {
        setStatus("no-results");
        return;
      }
      setMessage(result.status === "invalid-url"
        ? "Enter a valid HTTPS race webpage URL."
        : "We couldn’t discover a route from that page. You can upload a GPX file instead.");
      setStatus("error");
    } catch {
      setMessage("Race-page discovery is temporarily unavailable. You can upload a GPX file instead.");
      setStatus("error");
    }
  }

  async function handleConfirmSelection() {
    const selected = candidates.find((candidate) => candidate.gpxUrl === selectedUrl);
    if (!selected || status === "downloading") return;
    setStatus("downloading");
    setMessage("");
    try {
      const response = await fetch("/api/race-gpx-download", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourcePageUrl: submittedUrl, gpxUrl: selected.gpxUrl }),
      });
      if (!response.ok || !response.headers.get("content-type")?.toLowerCase().includes("application/gpx+xml")) {
        let failure: { status?: string; category?: string } = {};
        try { failure = await response.json() as typeof failure; } catch { /* use generic message */ }
        const detail = failure.status === "invalid-gpx" ? "The selected link did not contain a supported GPX route."
          : failure.status === "candidate-not-found" ? "The race page changed. Search it again and choose a current route link."
            : failure.category === "timeout" ? "The selected route took too long to download."
              : "The selected route could not be retrieved safely.";
        setMessage(`${detail} You can upload a GPX file instead.`);
        setStatus("error");
        return;
      }
      const text = await response.text();
      if (!text || new TextEncoder().encode(text).byteLength > 4 * 1024 * 1024) {
        setMessage("The selected GPX was empty or exceeded the supported download size. You can upload a GPX file instead.");
        setStatus("error");
        return;
      }
      const fallbackName = selected.distanceLabel ? `Discovered route · ${selected.distanceLabel}` : "Discovered route";
      setPendingDiscoveredGpx({ text, name: fallbackName });
      setStatus("ready");
      setMessage("GPX validated. Opening the existing route analysis…");
      router.push("/route");
    } catch {
      setMessage("The selected route could not be retrieved safely. You can upload a GPX file instead.");
      setStatus("error");
    }
  }

  const busy = status === "loading" || status === "downloading" || status === "ready";

  return (
    <div className="mt-5 rounded-2xl border border-white/10 bg-black/10 p-4 sm:p-5">
      <form onSubmit={handleDiscovery} className="flex min-w-0 flex-col gap-3">
        <label htmlFor="official-race-url" className="text-sm font-semibold text-white">Official race webpage</label>
        <input
          id="official-race-url"
          type="url"
          inputMode="url"
          autoComplete="url"
          maxLength={2_048}
          value={raceUrl}
          onChange={(event) => setRaceUrl(event.target.value)}
          placeholder="https://race-website.example/course"
          disabled={busy}
          className="min-w-0 w-full rounded-xl border border-white/20 bg-white/5 px-4 py-3 text-sm text-white outline-none placeholder:text-white/35 focus:border-[#a7c957] disabled:opacity-60"
        />
        <button type="submit" disabled={busy || !raceUrl.trim()} className="min-h-11 rounded-full bg-[#a7c957] px-5 py-2.5 text-sm font-semibold text-[#17211c] disabled:cursor-wait disabled:opacity-60">
          {status === "loading" ? "Searching race page…" : "Find GPX route links"}
        </button>
      </form>

      {status === "loading" && <p aria-live="polite" className="mt-3 text-sm text-white/65">Checking the page for route links…</p>}
      {status === "downloading" && <p aria-live="polite" className="mt-3 text-sm text-white/65">Retrieving and validating the selected GPX…</p>}
      {status === "no-results" && <div role="status" className="mt-3 text-sm leading-6 text-white/70">No GPX route links were found on that page. <Link href="/route" className="font-semibold text-[#a7c957] underline">Upload a GPX file instead.</Link></div>}
      {(status === "error" || status === "ready") && <div role="status" className="mt-3 text-sm leading-6 text-white/70">{message} {status === "error" && <Link href="/route" className="font-semibold text-[#a7c957] underline">Open manual GPX upload.</Link>}</div>}

      {candidates.length > 0 && status !== "downloading" && status !== "ready" && (
        <fieldset className="mt-4 space-y-3" disabled={busy}>
          <legend className="text-sm font-semibold text-white">Choose the course you want to analyze</legend>
          <p className="text-xs leading-5 text-amber-100/75">These are unverified links found on the page. Select the correct distance, then confirm; the file is checked before analysis.</p>
          {candidates.map((candidate) => (
            <label key={candidate.gpxUrl} className="block min-w-0 cursor-pointer rounded-xl border border-white/10 bg-white/5 p-3 text-sm">
              <span className="flex min-w-0 items-start gap-3">
                <input type="radio" name="selected-gpx-candidate" value={candidate.gpxUrl} checked={selectedUrl === candidate.gpxUrl} onChange={() => setSelectedUrl(candidate.gpxUrl)} className="mt-1 accent-[#a7c957]" />
                <span className="min-w-0 flex-1">
                  <span className="block break-words font-semibold text-white">{(candidate.distanceLabel ?? candidate.linkText) || "GPX route link"}</span>
                  <span className="mt-1 block break-all text-xs text-white/45">Source: {candidate.sourcePageUrl}</span>
                  {candidate.supportingEvidence.map((item, index) => <span key={`${index}-${item}`} className="mt-1 block break-words text-xs text-white/60">{item}</span>)}
                </span>
              </span>
            </label>
          ))}
          <button type="button" onClick={handleConfirmSelection} disabled={!selectedUrl || busy} className="min-h-11 w-full rounded-full border border-[#a7c957]/70 px-5 py-2.5 text-sm font-semibold text-[#d5e8a2] disabled:cursor-not-allowed disabled:opacity-40">
            Confirm selection and analyze GPX
          </button>
        </fieldset>
      )}
      <p className="mt-3 text-[11px] leading-5 text-white/40">Discovered routes are not bound to a race edition; we do not infer edition identity from a link. Analysis is labeled as GPX-derived. This service has per-process limits, not deployment-wide rate limiting.</p>
    </div>
  );
}
