"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import RouteAnalysisView from "./RouteAnalysisView";
import FeedbackForm from "./FeedbackForm";
import {
  analyzeGpxRoute,
  GpxAnalysisError,
  getGpxAnalysisErrorMessage,
} from "./gpxAnalysis";
import type { RouteAnalysisData } from "./gpxAnalysis";
import { GpxUploadError, getGpxUploadErrorMessage, MAX_GPX_UPLOAD_BYTES, MAX_GPX_UPLOAD_TRACK_POINTS, parseRouteModeGpxText, readGpxUpload } from "./gpxUpload";
import { RouteUploadRequestGate } from "./routeUploadRequestGate";
import { focusCompletedRouteAnalysis } from "./routeAnalysisFocus";
import { createRouteFingerprint } from "./routeFingerprint";
import { createAnalysisInputFingerprint } from "./analysisInputFingerprint";
import { browserRoutePersistence, cacheRouteAnalysis, getOrCreateRouteAnalysis } from "./routePersistence";
import { lookupSharedRoute, runOptionalRouteLookup, type SharedRouteCache, type SharedRouteLookup } from "./routePersistenceClient";
import type { RouteFingerprintResult } from "./routeFingerprint";
import { consumePendingDiscoveredGpx } from "./discoveredGpxTransfer";
import { SHARED_ROUTE_PERSISTENCE_V1_ENABLED, TERRAIN_INTELLIGENCE_V1_ENABLED } from "./featureFlags";
import { RouteUnitPreferenceProvider } from "./RouteUnitPreference";
import { trackSafeAnalyticsEvent } from "./analyticsClient";

function getAnalyticsFailureCategory(error: unknown): "invalid_gpx" | "missing_elevation" | "file_limit" | "processing_error" {
  if (error instanceof GpxUploadError) return error.code === "file-too-large" ? "file_limit" : "invalid_gpx";
  if (error instanceof GpxAnalysisError) {
    if (error.code === "insufficient-elevation") return "missing_elevation";
    if (error.code === "too-many-points") return "file_limit";
    if (["invalid-gpx", "no-track-points", "multiple-tracks", "invalid-coordinate", "invalid-route"].includes(error.code)) return "invalid_gpx";
  }
  return "processing_error";
}

export default function RouteMode({ embedded = false }: { embedded?: boolean }) {
  const [analysis, setAnalysis] = useState<RouteAnalysisData | null>(null);
  const [error, setError] = useState("");
  const [isProcessing, setIsProcessing] = useState(false);
  const [isDraggingFile, setIsDraggingFile] = useState(false);
  const [routeFingerprint, setRouteFingerprint] = useState<RouteFingerprintResult | null>(null);
  const [persistenceScope, setPersistenceScope] = useState<"local" | "shared">("local");
  const [sharedCache, setSharedCache] = useState<SharedRouteCache | null>(null);
  const requestGate = useRef(new RouteUploadRequestGate());
  const analysisHeadingRef = useRef<HTMLHeadingElement>(null);

  const beginRouteRequest = useCallback(() => {
    const requestId = requestGate.current.begin();
    if (requestId === null) return null;
    setAnalysis(null);
    setRouteFingerprint(null);
    setPersistenceScope("local");
    setSharedCache(null);
    setError("");
    setIsProcessing(true);
    return requestId;
  }, []);

  const runRouteRequest = useCallback(async (requestId: number, operation: () => Promise<void>) => {
    try {
      await operation();
    } catch (caught) {
      if (requestGate.current.isCurrent(requestId)) {
        trackSafeAnalyticsEvent({ type: "gpx_analysis_failure", category: getAnalyticsFailureCategory(caught) });
        setError(caught instanceof GpxUploadError
          ? getGpxUploadErrorMessage(caught.code)
          : caught instanceof GpxAnalysisError
            ? getGpxAnalysisErrorMessage(caught.code)
            : "The GPX file could not be read or analyzed. Choose a valid GPX file and try again.");
      }
    } finally {
      if (requestGate.current.finish(requestId)) setIsProcessing(false);
    }
  }, []);

  const analyzeParsedRoute = useCallback(async (
    parsed: ReturnType<typeof parseRouteModeGpxText>,
    displayName: string,
    requestId: number,
    aidStationDiscoveryV1?: RouteAnalysisData["aidStationDiscoveryV1"],
  ) => {
      try {
        const [fingerprint, analysisInputFingerprint] = await Promise.all([
          createRouteFingerprint(parsed.segments.map((segment) => segment.map(({ latitude, longitude }) => ({ latitude, longitude })))),
          createAnalysisInputFingerprint(parsed.segments),
        ]);
        if (!requestGate.current.isCurrent(requestId)) return;
        let shared: SharedRouteLookup | null = null;
        if (SHARED_ROUTE_PERSISTENCE_V1_ENABLED) {
          shared = await runOptionalRouteLookup((signal) => lookupSharedRoute(fingerprint, analysisInputFingerprint, {
            includeOsm: TERRAIN_INTELLIGENCE_V1_ENABLED,
            signal,
          }));
        }
        if (!requestGate.current.isCurrent(requestId)) return;
        let routeAnalysis: RouteAnalysisData;
        if (shared?.cache?.analysis) {
          routeAnalysis = { ...shared.cache.analysis, name: displayName };
          await cacheRouteAnalysis(browserRoutePersistence, fingerprint, routeAnalysis, analysisInputFingerprint);
        } else {
          const localResult = await getOrCreateRouteAnalysis(
            browserRoutePersistence,
            fingerprint,
            analysisInputFingerprint,
            displayName,
            () => analyzeGpxRoute(parsed),
          );
          routeAnalysis = localResult.analysis;
        }
        if (!requestGate.current.isCurrent(requestId)) return;
        setRouteFingerprint(fingerprint);
        setPersistenceScope(shared?.persistenceScope ?? "local");
        setSharedCache(shared?.cache ?? null);
        setAnalysis({ ...routeAnalysis, aidStationDiscoveryV1: aidStationDiscoveryV1 ?? null });
        trackSafeAnalyticsEvent({ type: "gpx_analysis_success" });
      } catch {
        // Fingerprinting and persistence are optimizations; retain the existing local analysis path.
        if (!requestGate.current.isCurrent(requestId)) return;
        setAnalysis({ ...analyzeGpxRoute(parsed), name: displayName, aidStationDiscoveryV1: aidStationDiscoveryV1 ?? null });
        trackSafeAnalyticsEvent({ type: "gpx_analysis_success" });
      }
  }, []);

  const analyzeText = useCallback(async (text: string, fallbackName: string, aidStationDiscoveryV1?: RouteAnalysisData["aidStationDiscoveryV1"]) => {
    const requestId = beginRouteRequest();
    if (requestId === null) return;
    await runRouteRequest(requestId, async () => {
      const parsed = parseRouteModeGpxText(text);
      await analyzeParsedRoute(parsed, parsed.name ?? fallbackName, requestId, aidStationDiscoveryV1);
    });
  }, [analyzeParsedRoute, beginRouteRequest, runRouteRequest]);

  useEffect(() => () => requestGate.current.invalidate(), []);

  useEffect(() => {
    if (!analysis) return;
    const frame = window.requestAnimationFrame(() => {
      const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      focusCompletedRouteAnalysis(Boolean(analysis), analysisHeadingRef.current, prefersReducedMotion);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [analysis]);

  useEffect(() => {
    const pending = consumePendingDiscoveredGpx();
    if (pending) {
      queueMicrotask(() => {
        void analyzeText(pending.text, pending.name, pending.aidStationDiscoveryV1);
      });
    }
  }, [analyzeText]);

  async function handleSelectedFile(file: File | undefined) {
    if (!file) return;
    trackSafeAnalyticsEvent({ type: "gpx_upload_attempt" });
    const requestId = beginRouteRequest();
    if (requestId === null) return;
    await runRouteRequest(requestId, async () => {
      const { parsed, fallbackName } = await readGpxUpload(file);
      const displayName = parsed.name ?? fallbackName;
      await analyzeParsedRoute(parsed, displayName, requestId);
    });
  }

  async function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    input.value = "";
    await handleSelectedFile(file);
  }

  const uploadPanel = (
    <div
      onDragOver={(event) => { event.preventDefault(); if (!isProcessing) setIsDraggingFile(true); }}
      onDragLeave={(event) => {
        const nextTarget = event.relatedTarget;
        if (!(nextTarget instanceof Node) || !event.currentTarget.contains(nextTarget)) setIsDraggingFile(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        setIsDraggingFile(false);
        if (!isProcessing) void handleSelectedFile(event.dataTransfer.files?.[0]);
      }}
      className={`max-w-2xl rounded-3xl border p-5 transition-colors sm:p-6 ${isDraggingFile ? "border-[#b9d975] bg-[#a7c957]/15" : "border-white/15 bg-white/[0.07]"}`}
    >
      <input
        id="route-gpx-file"
        type="file"
        accept=".gpx,.xml,application/gpx+xml,application/xml,text/xml"
        onChange={handleFileChange}
        disabled={isProcessing}
        className="peer sr-only"
        aria-describedby="route-upload-guidance route-privacy-note"
      />
      <label htmlFor="route-gpx-file" className="inline-flex min-h-12 cursor-pointer items-center justify-center rounded-full bg-[#b9d975] px-6 text-sm font-bold text-[#17211c] transition hover:bg-[#c9e98a] peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-4 peer-focus-visible:outline-[#d8eea5] peer-disabled:cursor-wait">
        Choose GPX file
      </label>
      <p id="route-upload-guidance" className="mt-3 text-xs leading-5 text-white/65">
        Drop a .gpx or .xml file here, or use the file picker. Files must contain valid GPX data and stay within {MAX_GPX_UPLOAD_BYTES / (1024 * 1024)} MiB and {MAX_GPX_UPLOAD_TRACK_POINTS.toLocaleString("en-US")} track points.
      </p>
      <p className="mt-3 text-sm font-semibold text-[#d5eba2]">Free to use. No account required.</p>
      <p id="route-privacy-note" className="mt-2 text-xs leading-5 text-white/60">
        Your GPX file is analyzed in this browser. No route fingerprint or route geometry is sent to Endurset servers or checked against shared-route records. Maps request tiles for the area you view. <Link href="/privacy" className="underline underline-offset-2">Privacy details</Link>.
      </p>
      {isProcessing && (
        <p role="status" aria-live="polite" aria-atomic="true" className="mt-4 rounded-xl border border-[#b9d975]/35 bg-[#a7c957]/10 px-4 py-3 text-sm font-medium text-[#e1f2bc]">
          Reading your GPX and analyzing the route…
        </p>
      )}
      {error && <p role="alert" className="mt-4 rounded-xl bg-white/10 px-4 py-3 text-sm leading-6 text-white">{error}</p>}
      <p className="sr-only" aria-live="polite">{isDraggingFile ? "Release to analyze this GPX file." : ""}</p>
    </div>
  );

  const analysisView = analysis && <RouteUnitPreferenceProvider><div className={`route-analysis-surface${embedded ? " route-analysis-frame" : ""}`}><RouteAnalysisView
    key={routeFingerprint?.routeFingerprint ?? analysis.name}
    analysis={analysis}
    analysisHeadingRef={analysisHeadingRef}
    routeFingerprint={routeFingerprint ?? undefined}
    persistenceScope={persistenceScope}
    sharedCache={sharedCache}
  /></div></RouteUnitPreferenceProvider>;

  if (embedded) {
    return (
      <>
        <section id="analyze" className="topo-upload scroll-mt-24 text-white">
          <div className="mx-auto max-w-7xl px-6 py-16 sm:py-20 lg:px-10">
            <div className="grid gap-9 lg:grid-cols-[.8fr_1fr] lg:items-center">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[#c2df7a]">Start with your GPX</p>
                <h2 className="mt-3 text-3xl font-semibold tracking-[-0.035em] sm:text-4xl">Analyze your route</h2>
                <p className="mt-4 max-w-lg text-sm leading-6 text-white/75 sm:text-base">
                  Choose a route file to explore its elevation profile, meaningful sections and key moments.
                </p>
              </div>
              {uploadPanel}
            </div>
            {analysisView}
          </div>
        </section>
        {analysis && <FeedbackForm />}
      </>
    );
  }

  return (
    <main className="min-h-screen bg-[#f4f2ed] text-[#17211c]">
      <nav className="border-b border-white/10 bg-[#17211c]">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-6 lg:px-10">
          <Link href="/" className="rounded bg-[#f4f2ed] px-2 py-1" aria-label="Endurset home">
            <Image src="/brand/endurset-e.png" alt="" width={417} height={314} priority sizes="36px" className="block h-auto w-9 min-[380px]:hidden" />
            <Image src="/brand/endurset-wordmark.png" alt="" width={2015} height={314} priority sizes="(max-width: 640px) 34vw, 160px" className="hidden h-auto w-[clamp(102px,34vw,160px)] min-[380px]:block" />
          </Link>
          <Link href="/" className="text-sm text-white/60 transition hover:text-white">
            Home
          </Link>
        </div>
      </nav>

      <section className="bg-[#17211c] text-white">
        <div className="mx-auto max-w-7xl px-6 py-16 lg:px-10 lg:py-24">
          <p className="text-xs font-semibold uppercase tracking-[0.22em] text-[#a7c957]">
            Route Analysis · GPX-derived
          </p>
          <h1 className="mt-5 max-w-4xl text-5xl font-semibold leading-[0.96] tracking-[-0.045em] sm:text-6xl lg:text-7xl">
            Analyze a GPX route.
          </h1>
          <p className="mt-6 max-w-2xl text-base leading-7 text-white/55 sm:text-lg">
            Upload a GPX file to calculate its distance, elevation profile and route sections.
          </p>

          <div className="mt-9">{uploadPanel}</div>
        </div>
      </section>

      {analysisView}
      {analysis && <FeedbackForm />}
    </main>
  );
}
