"use client";

import { useRef, useState } from "react";
import type { FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { setPendingDiscoveredGpx } from "./discoveredGpxTransfer";

type Candidate = {
  gpxUrl: string;
  sourcePageUrl: string;
  linkText: string;
  displayLabel: string;
  supportingEvidence: string[];
  distanceLabel: string | null;
  discoveryStatus: "link-evidence-only";
  ambiguity: "multiple-candidates" | null;
};

type ArchiveCandidate = {
  archiveUrl: string;
  sourcePageUrl: string;
  linkText: string;
  displayLabel: string;
  supportingEvidence: string[];
  distanceLabel: string | null;
  resourceType: "zip-archive";
  discoveryStatus: "archive-link-evidence-only";
  ambiguity: "multiple-candidates" | null;
};

type ExtractedGpxChoice = { id: string; displayLabel: string };

type EventChoice = {
  url: string;
  sourcePageUrl: string;
  linkText: string;
  displayName: string;
  supportingEvidence: string[];
};

type DiscoveryResponse = { status: string; candidates?: Candidate[]; archives?: ArchiveCandidate[]; events?: EventChoice[]; category?: string };

function isSafeDisplayUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch { return false; }
}

export default function RaceGpxDiscovery() {
  const router = useRouter();
  const discoveryInFlight = useRef(false);
  const [raceUrl, setRaceUrl] = useState("");
  const [submittedUrl, setSubmittedUrl] = useState("");
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [archives, setArchives] = useState<ArchiveCandidate[]>([]);
  const [archiveFiles, setArchiveFiles] = useState<ExtractedGpxChoice[]>([]);
  const [archiveDigest, setArchiveDigest] = useState("");
  const [events, setEvents] = useState<EventChoice[]>([]);
  const [selectedUrl, setSelectedUrl] = useState("");
  const [selectedArchiveUrl, setSelectedArchiveUrl] = useState("");
  const [selectedArchiveFileId, setSelectedArchiveFileId] = useState("");
  const [selectedEventUrl, setSelectedEventUrl] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "no-results" | "unsupported" | "error" | "downloading" | "archive-selection" | "ready">("idle");
  const [message, setMessage] = useState("");

  async function discoverPage(url: string) {
    if (discoveryInFlight.current) return;
    discoveryInFlight.current = true;
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), 15_000);
    setCandidates([]);
    setArchives([]);
    setArchiveFiles([]);
    setArchiveDigest("");
    setEvents([]);
    setSelectedUrl("");
    setSelectedArchiveUrl("");
    setSelectedArchiveFileId("");
    setSelectedEventUrl("");
    setSubmittedUrl(url);
    setMessage("");
    setStatus("loading");
    try {
      const response = await fetch("/api/race-gpx-discovery", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
        signal: controller.signal,
      });
      const result = await response.json() as DiscoveryResponse;
      if (result.status === "success" && Array.isArray(result.candidates)) {
        const safeCandidates = result.candidates.filter((candidate) =>
          candidate && isSafeDisplayUrl(candidate.gpxUrl) && isSafeDisplayUrl(candidate.sourcePageUrl) &&
          candidate.discoveryStatus === "link-evidence-only" && typeof candidate.linkText === "string" &&
          typeof candidate.displayLabel === "string" && candidate.displayLabel.length > 0 &&
          Array.isArray(candidate.supportingEvidence) && candidate.supportingEvidence.every((item) => typeof item === "string"),
        );
        const safeArchives = Array.isArray(result.archives) ? result.archives.filter((archive) =>
          archive && isSafeDisplayUrl(archive.archiveUrl) && isSafeDisplayUrl(archive.sourcePageUrl) &&
          archive.resourceType === "zip-archive" && archive.discoveryStatus === "archive-link-evidence-only" &&
          typeof archive.displayLabel === "string" && archive.displayLabel.length > 0 &&
          Array.isArray(archive.supportingEvidence) && archive.supportingEvidence.every((item) => typeof item === "string"),
        ) : [];
        if (safeCandidates.length || safeArchives.length) {
          setCandidates(safeCandidates);
          setArchives(safeArchives);
          setStatus("idle");
          return;
        }
      }
      if (result.status === "event-selection-required" && Array.isArray(result.events)) {
        const safeEvents = result.events.filter((choice) =>
          choice && isSafeDisplayUrl(choice.url) && isSafeDisplayUrl(choice.sourcePageUrl) &&
          new URL(choice.url).origin === new URL(choice.sourcePageUrl).origin &&
          typeof choice.displayName === "string" && choice.displayName.trim().length > 0 &&
          typeof choice.linkText === "string" && Array.isArray(choice.supportingEvidence) &&
          choice.supportingEvidence.every((item) => typeof item === "string"),
        );
        if (safeEvents.length >= 2) {
          setEvents(safeEvents);
          setStatus("idle");
          return;
        }
      }
      if (result.status === "unsupported-resources") {
        setMessage("This page links to a route resource this flow cannot process. You can upload a GPX file instead.");
        setStatus("unsupported");
        return;
      }
      if (result.status === "no-results") {
        setStatus("no-results");
        return;
      }
      setMessage(result.status === "invalid-url"
        ? "Enter a valid HTTPS race webpage URL."
        : result.status === "provider-failure" && result.category === "invalid-response"
          ? "We couldn’t inspect usable page content. Try the event’s direct course page, or upload a GPX file instead."
        : "We couldn’t discover a route from that page. You can upload a GPX file instead.");
      setStatus("error");
    } catch {
      setMessage("Race-page discovery is temporarily unavailable. You can upload a GPX file instead.");
      setStatus("error");
    } finally {
      window.clearTimeout(timeoutId);
      discoveryInFlight.current = false;
    }
  }

  async function handleDiscovery(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await discoverPage(raceUrl.trim());
  }

  async function handleEventSelection() {
    if (!events.some((choice) => choice.url === selectedEventUrl) || status === "loading") return;
    await discoverPage(selectedEventUrl);
  }

  async function handleConfirmSelection() {
    const selected = candidates.find((candidate) => candidate.gpxUrl === selectedUrl);
    const selectedArchive = archives.find((archive) => archive.archiveUrl === selectedArchiveUrl);
    if ((!selected && !selectedArchive) || status === "downloading") return;
    setStatus("downloading");
    setMessage("");
    try {
      const response = await fetch("/api/race-gpx-download", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(selectedArchive
          ? { sourcePageUrl: submittedUrl, resourceType: "zip", archiveUrl: selectedArchive.archiveUrl }
          : { sourcePageUrl: submittedUrl, gpxUrl: selected!.gpxUrl }),
      });
      if (selectedArchive && response.ok && response.headers.get("content-type")?.toLowerCase().includes("application/json")) {
        const result = await response.json() as { status?: unknown; archiveDigest?: unknown; files?: unknown };
        const files = Array.isArray(result.files) ? result.files : [];
        const validFiles = files.filter((file): file is ExtractedGpxChoice =>
          !!file && typeof file === "object" && typeof (file as ExtractedGpxChoice).id === "string" &&
          /^gpx-\d+$/.test((file as ExtractedGpxChoice).id) &&
          typeof (file as ExtractedGpxChoice).displayLabel === "string" && (file as ExtractedGpxChoice).displayLabel.length <= 40,
        );
        if (result.status !== "archive-choices" || typeof result.archiveDigest !== "string" || !/^[a-f0-9]{64}$/.test(result.archiveDigest) ||
          validFiles.length !== files.length || !validFiles.length || validFiles.length > 32 || new Set(validFiles.map((file) => file.id)).size !== validFiles.length) {
          setMessage("The archive response could not be validated. You can upload a GPX file instead.");
          setStatus("error");
          return;
        }
        setArchiveDigest(result.archiveDigest);
        if (validFiles.length === 1) {
          await downloadArchiveEntry(selectedArchive, result.archiveDigest, validFiles[0].id);
          return;
        }
        setArchiveFiles(validFiles);
        setSelectedArchiveFileId("");
        setStatus("archive-selection");
        setMessage("We found more than one valid GPX file in this archive. Choose the route you want to analyze.");
        return;
      }
      if (!response.ok || !response.headers.get("content-type")?.toLowerCase().includes("application/gpx+xml")) {
        await showDownloadFailure(response);
        return;
      }
      const text = await response.text();
      if (!text || new TextEncoder().encode(text).byteLength > 4 * 1024 * 1024) {
        setMessage("The selected GPX was empty or exceeded the supported download size. You can upload a GPX file instead.");
        setStatus("error");
        return;
      }
      const fallbackName = selected?.distanceLabel ? `Discovered route · ${selected.distanceLabel}` : "Discovered route";
      openDiscoveredGpx(text, fallbackName);
    } catch {
      setMessage("The selected route could not be retrieved safely. You can upload a GPX file instead.");
      setStatus("error");
    }
  }

  async function showDownloadFailure(response: Response) {
    let failure: { status?: string; category?: string } = {};
    try { failure = await response.json() as typeof failure; } catch { /* use generic message */ }
    const detail = failure.status === "invalid-gpx" || failure.status === "no-gpx-in-archive" ? "No valid GPX route was found in the selected resource."
      : failure.status === "invalid-archive" ? "The selected ZIP archive is damaged or uses an unsupported format."
        : failure.status === "unsafe-archive" ? "The selected ZIP archive contains unsafe file paths or entries and was rejected."
          : failure.status === "archive-too-large" ? "The selected ZIP archive exceeds the supported compressed or expanded size limits."
            : failure.status === "archive-changed" ? "The archive changed while you were choosing a file. Search again and confirm the current archive."
              : failure.status === "candidate-not-found" ? "The race page changed. Search it again and choose a current route link."
                : failure.category === "timeout" ? "The selected route took too long to download."
                  : failure.category === "invalid-response" ? "The download was too large or was not a supported file response."
                    : "The selected route could not be retrieved safely.";
    setMessage(`${detail} You can upload a GPX file instead.`);
    setStatus("error");
  }

  async function downloadArchiveEntry(archive: ArchiveCandidate, digest: string, entryId: string) {
    setStatus("downloading");
    setMessage("Retrieving the selected GPX from the unchanged archive…");
    try {
      const response = await fetch("/api/race-gpx-download", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourcePageUrl: submittedUrl, resourceType: "zip-entry", archiveUrl: archive.archiveUrl, archiveDigest: digest, entryId }),
      });
      if (!response.ok || !response.headers.get("content-type")?.toLowerCase().includes("application/gpx+xml")) {
        await showDownloadFailure(response);
        return;
      }
      const text = await response.text();
      if (!text || new TextEncoder().encode(text).byteLength > 4 * 1024 * 1024) {
        setMessage("The selected GPX was empty or exceeded the supported size. You can upload a GPX file instead.");
        setStatus("error");
        return;
      }
      openDiscoveredGpx(text, archive.distanceLabel ? `Discovered route · ${archive.distanceLabel}` : "Discovered route from archive");
    } catch {
      setMessage("The selected route could not be retrieved safely. You can upload a GPX file instead.");
      setStatus("error");
    }
  }

  function openDiscoveredGpx(text: string, name: string) {
    setPendingDiscoveredGpx({ text, name });
    setStatus("ready");
    setMessage("GPX validated. Opening the existing route analysis…");
    router.push("/route");
  }

  function handleAnalyzeArchiveFile() {
    const selectedArchive = archives.find((archive) => archive.archiveUrl === selectedArchiveUrl);
    const selectedFile = archiveFiles.find((file) => file.id === selectedArchiveFileId);
    if (!selectedArchive || !selectedFile || !archiveDigest) return;
    void downloadArchiveEntry(selectedArchive, archiveDigest, selectedFile.id);
  }

  const busy = status === "loading" || status === "downloading" || status === "ready";

  return (
    <div className="mt-5 rounded-2xl border border-white/10 bg-[#202c26] p-4 sm:p-5">
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
          className="min-h-11 min-w-0 w-full rounded-xl border border-white/30 bg-white/10 px-4 py-3 text-sm text-white outline-none placeholder:text-white/55 focus-visible:border-[#a7c957] focus-visible:ring-2 focus-visible:ring-[#a7c957]/50 disabled:cursor-not-allowed disabled:opacity-60"
        />
        <button type="submit" disabled={busy || !raceUrl.trim()} className="min-h-11 rounded-full bg-[#a7c957] px-5 py-2.5 text-sm font-semibold text-[#17211c] disabled:cursor-not-allowed disabled:opacity-60">
          {status === "loading" ? "Searching race page…" : "Find GPX route links"}
        </button>
      </form>

      {status === "loading" && <p aria-live="polite" className="mt-3 text-sm text-white/65">Checking the page for route links…</p>}
      {status === "downloading" && <p aria-live="polite" className="mt-3 text-sm text-white/65">Retrieving and validating the selected GPX…</p>}
      {status === "downloading" && selectedArchiveUrl && <p aria-live="polite" className="mt-1 text-xs text-white/45">Opening the confirmed ZIP in memory and checking its contents. Nothing is extracted to disk.</p>}
      {status === "no-results" && (
        <div role="status" className="mt-3 text-white/70">
          <h2 className="text-base font-semibold leading-6 text-white">We couldn&apos;t find a route on this page.</h2>
          <p className="mt-1 text-sm leading-6">
            If this is an organizer&apos;s homepage, open the specific race or course page and paste its URL here. You can also{" "}
            <Link href="/route" className="font-semibold text-[#a7c957] underline">upload a GPX file directly.</Link>
          </p>
        </div>
      )}
      {status === "unsupported" && <div role="status" className="mt-3 text-sm leading-6 text-white/70">{message} <Link href="/route" className="font-semibold text-[#a7c957] underline">Open manual GPX upload.</Link></div>}
      {(status === "error" || status === "ready") && <div role="status" className="mt-3 text-sm leading-6 text-white/70">{message} {status === "error" && <Link href="/route" className="font-semibold text-[#a7c957] underline">Open manual GPX upload.</Link>}</div>}

      {events.length > 0 && status !== "loading" && (
        <fieldset className="mt-4 space-y-3">
          <legend className="text-sm font-semibold text-white">Choose the event you want to search</legend>
          <p className="text-xs leading-5 text-amber-100/75">This organizer page links to several events. Choose one so routes from different events are not mixed.</p>
          {events.map((choice) => (
            <label key={choice.url} className="block min-w-0 cursor-pointer rounded-xl border border-white/10 bg-white/5 p-3 text-sm">
              <span className="flex min-w-0 items-start gap-3">
                <input type="radio" name="selected-race-event" value={choice.url} checked={selectedEventUrl === choice.url} onChange={() => setSelectedEventUrl(choice.url)} className="mt-1 accent-[#a7c957]" />
                <span className="min-w-0 flex-1">
                  <span className="block break-words font-semibold text-white">{choice.displayName}</span>
                  <span className="mt-1 block break-all text-xs text-white/45">Source: {choice.sourcePageUrl}</span>
                  {choice.supportingEvidence.map((item, index) => <span key={`${index}-${item}`} className="mt-1 block break-words text-xs text-white/60">{item}</span>)}
                </span>
              </span>
            </label>
          ))}
          <button type="button" onClick={handleEventSelection} disabled={!selectedEventUrl || busy} className="min-h-11 w-full rounded-full border border-[#a7c957]/70 px-5 py-2.5 text-sm font-semibold text-[#d5e8a2] disabled:cursor-not-allowed disabled:opacity-40">
            Search this event for GPX links
          </button>
        </fieldset>
      )}

      {(candidates.length > 0 || archives.length > 0) && status !== "downloading" && status !== "ready" && status !== "archive-selection" && (
        <fieldset className="mt-4 space-y-3" disabled={busy}>
          <legend className="text-sm font-semibold text-white">Choose a route resource</legend>
          <p className="text-xs leading-5 text-amber-100/75">These links are not verified route files yet. Choose a course, then confirm before anything is downloaded.</p>
          {candidates.map((candidate) => (
            <label key={candidate.gpxUrl} className="block min-w-0 cursor-pointer rounded-xl border border-white/10 bg-white/5 p-3 text-sm">
              <span className="flex min-w-0 items-start gap-3">
                <input type="radio" name="selected-gpx-candidate" value={candidate.gpxUrl} checked={selectedUrl === candidate.gpxUrl} onChange={() => { setSelectedUrl(candidate.gpxUrl); setSelectedArchiveUrl(""); }} className="mt-1 accent-[#a7c957]" />
                <span className="min-w-0 flex-1">
                  <span className="block break-words font-semibold text-white">{candidate.displayLabel}</span>
                  <span className="mt-1 block break-all text-xs text-white/45">Source: {candidate.sourcePageUrl}</span>
                  {candidate.supportingEvidence.map((item, index) => <span key={`${index}-${item}`} className="mt-1 block break-words text-xs text-white/60">{item}</span>)}
                </span>
              </span>
            </label>
          ))}
          {archives.map((archive) => (
            <label key={archive.archiveUrl} className="block min-w-0 cursor-pointer rounded-xl border border-amber-200/15 bg-amber-100/5 p-3 text-sm">
              <span className="flex min-w-0 items-start gap-3">
                <input type="radio" name="selected-gpx-candidate" value={archive.archiveUrl} checked={selectedArchiveUrl === archive.archiveUrl} onChange={() => { setSelectedArchiveUrl(archive.archiveUrl); setSelectedUrl(""); }} className="mt-1 accent-[#a7c957]" />
                <span className="min-w-0 flex-1">
                  <span className="block break-words font-semibold text-white">ZIP archive · {archive.displayLabel}</span>
                  {archive.distanceLabel && <span className="mt-1 block text-xs text-white/65">Course label from page: {archive.distanceLabel}</span>}
                  <span className="mt-1 block text-xs leading-5 text-amber-100/75">This is an archive, not a validated GPX. We will inspect it only after you confirm.</span>
                  <span className="mt-1 block break-all text-xs text-white/45">Source: {archive.sourcePageUrl}</span>
                  {archive.supportingEvidence.map((item, index) => <span key={`${index}-${item}`} className="mt-1 block break-words text-xs text-white/60">{item}</span>)}
                </span>
              </span>
            </label>
          ))}
          <button type="button" onClick={handleConfirmSelection} disabled={(!selectedUrl && !selectedArchiveUrl) || busy} className="min-h-11 w-full rounded-full border border-[#a7c957]/70 px-5 py-2.5 text-sm font-semibold text-[#d5e8a2] disabled:cursor-not-allowed disabled:opacity-40">
            {selectedArchiveUrl ? "Confirm archive and inspect GPX files" : "Confirm selection and analyze GPX"}
          </button>
        </fieldset>
      )}
      {status === "archive-selection" && (
        <fieldset className="mt-4 space-y-3">
          <legend className="text-sm font-semibold text-white">Choose the GPX route inside the archive</legend>
          <p role="status" className="text-xs leading-5 text-white/65">{message} These files passed GPX route validation. File names are not treated as race or edition identity. <Link href="/route" className="font-semibold text-[#a7c957] underline">Open manual GPX upload instead.</Link></p>
          {archiveFiles.map((file) => (
            <label key={file.id} className="block cursor-pointer rounded-xl border border-white/10 bg-white/5 p-3 text-sm text-white">
              <input type="radio" className="mr-3 accent-[#a7c957]" name="archive-gpx-file" checked={selectedArchiveFileId === file.id} onChange={() => setSelectedArchiveFileId(file.id)} />
              {file.displayLabel}
            </label>
          ))}
          <button type="button" onClick={handleAnalyzeArchiveFile} disabled={!selectedArchiveFileId} className="min-h-11 w-full rounded-full border border-[#a7c957]/70 px-5 py-2.5 text-sm font-semibold text-[#d5e8a2] disabled:cursor-not-allowed disabled:opacity-40">Analyze selected GPX</button>
        </fieldset>
      )}
      <p className="mt-3 text-[11px] leading-5 text-white/40">Discovered routes are not bound to a race edition; we do not infer edition identity from a link. Analysis is labeled as GPX-derived. This service has per-process limits, not deployment-wide rate limiting.</p>
    </div>
  );
}
