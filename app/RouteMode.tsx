"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import RouteAnalysisView from "./RouteAnalysisView";
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
import { lookupSharedRoute, runOptionalRouteLookup, type SharedRouteCache } from "./routePersistenceClient";
import type { RouteFingerprintResult } from "./routeFingerprint";
import { consumePendingDiscoveredGpx } from "./discoveredGpxTransfer";
import { TERRAIN_INTELLIGENCE_V1_ENABLED } from "./featureFlags";
import { RouteUnitPreferenceProvider } from "./RouteUnitPreference";

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
        const lookupResult = await runOptionalRouteLookup(async (signal) => {
          const [fingerprint, analysisInputFingerprint] = await Promise.all([
            createRouteFingerprint(parsed.segments.map((segment) => segment.map(({ latitude, longitude }) => ({ latitude, longitude })))),
            createAnalysisInputFingerprint(parsed.segments),
          ]);
          if (!requestGate.current.isCurrent(requestId)) return null;
          const shared = await lookupSharedRoute(fingerprint, analysisInputFingerprint, {
            includeOsm: TERRAIN_INTELLIGENCE_V1_ENABLED,
            signal,
          });
          return { fingerprint, analysisInputFingerprint, shared };
        });
        if (!requestGate.current.isCurrent(requestId)) return;
        let routeAnalysis: RouteAnalysisData;
        if (lookupResult?.shared.cache?.analysis) {
          routeAnalysis = { ...lookupResult.shared.cache.analysis, name: displayName };
          await cacheRouteAnalysis(browserRoutePersistence, lookupResult.fingerprint, routeAnalysis, lookupResult.analysisInputFingerprint);
        } else if (lookupResult) {
          const localResult = await getOrCreateRouteAnalysis(
            browserRoutePersistence,
            lookupResult.fingerprint,
            lookupResult.analysisInputFingerprint,
            displayName,
            () => analyzeGpxRoute(parsed),
          );
          routeAnalysis = localResult.analysis;
        } else {
          routeAnalysis = { ...analyzeGpxRoute(parsed), name: displayName };
        }
        if (!requestGate.current.isCurrent(requestId)) return;
        if (lookupResult) {
          setRouteFingerprint(lookupResult.fingerprint);
          setPersistenceScope(lookupResult.shared.persistenceScope);
          setSharedCache(lookupResult.shared.cache);
        }
        setAnalysis({ ...routeAnalysis, aidStationDiscoveryV1: aidStationDiscoveryV1 ?? null });
      } catch {
        // Fingerprinting and persistence are optimizations; retain the existing local analysis path.
        if (!requestGate.current.isCurrent(requestId)) return;
        setAnalysis({ ...analyzeGpxRoute(parsed), name: displayName, aidStationDiscoveryV1: aidStationDiscoveryV1 ?? null });
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
        Your GPX is analyzed in this browser and is not uploaded or stored. A derived route fingerprint may be checked against shared route records, and map tiles are requested for the area you view.
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

  const analysisView = analysis && <RouteUnitPreferenceProvider><div className="route-analysis-surface"><RouteAnalysisView
    key={routeFingerprint?.routeFingerprint ?? analysis.name}
    analysis={analysis}
    analysisHeadingRef={analysisHeadingRef}
    routeFingerprint={routeFingerprint ?? undefined}
    persistenceScope={persistenceScope}
    sharedCache={sharedCache}
  /></div></RouteUnitPreferenceProvider>;

  if (embedded) {
    return (
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
    );
  }

  return (
    <main className="min-h-screen bg-[#f4f2ed] text-[#17211c]">
      <nav className="border-b border-white/10 bg-[#17211c]">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-6 lg:px-10">
          <Link href="/" className="text-sm font-bold tracking-[0.18em] text-white">
            RACE<span className="text-[#a7c957]">{"//"}</span>SCOPE
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
    </main>
  );
}
