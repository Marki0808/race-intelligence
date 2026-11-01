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

export default function RouteMode() {
  const [analysis, setAnalysis] = useState<RouteAnalysisData | null>(null);
  const [error, setError] = useState("");
  const [isProcessing, setIsProcessing] = useState(false);
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

  async function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    const requestId = beginRouteRequest();
    if (requestId === null) return;
    await runRouteRequest(requestId, async () => {
      const { parsed, fallbackName } = await readGpxUpload(file);
      const displayName = parsed.name ?? fallbackName;
      await analyzeParsedRoute(parsed, displayName, requestId);
    });
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

          <div className="mt-9 max-w-2xl rounded-3xl border border-white/10 bg-white/5 p-5 sm:p-6">
            <label
              htmlFor="route-gpx-file"
              className="block text-sm font-semibold text-white"
            >
              Select a GPX file
            </label>
            <input
              id="route-gpx-file"
              type="file"
              accept=".gpx,.xml,application/gpx+xml,application/xml,text/xml"
              onChange={handleFileChange}
              disabled={isProcessing}
              className="mt-4 block w-full min-w-0 cursor-pointer text-sm text-white/65 file:mr-4 file:rounded-full file:border-0 file:bg-[#a7c957] file:px-5 file:py-2.5 file:text-sm file:font-semibold file:text-[#17211c] hover:file:bg-[#b8d86b] disabled:cursor-wait"
            />
            <p className="mt-3 text-xs leading-5 text-white/45">
              Choose a .gpx or .xml file containing valid GPX data. Uploads are limited to {MAX_GPX_UPLOAD_BYTES / (1024 * 1024)} MiB and {MAX_GPX_UPLOAD_TRACK_POINTS.toLocaleString("en-US")} track points.
            </p>
            <p className="mt-3 text-xs leading-5 text-white/40">
              The GPX file is not uploaded or stored. A derived route fingerprint is checked against the public-route registry; non-matching route analysis remains in this browser&apos;s local cache. Mapillary imagery lookups use bounded section search areas, not GPX text or elevation data.
            </p>
            {isProcessing && (
              <p role="status" aria-live="polite" aria-atomic="true" className="mt-4 rounded-xl border border-[#a7c957]/30 bg-[#a7c957]/10 px-4 py-3 text-sm font-medium text-[#c5e57d]">
                Reading your GPX and analyzing the route…
              </p>
            )}
            {error && (
              <p
                role="alert"
                className="mt-4 rounded-xl bg-white/5 px-4 py-3 text-sm leading-6 text-white/70"
              >
                {error}
              </p>
            )}
          </div>
        </div>
      </section>

      {analysis && <RouteAnalysisView
        key={routeFingerprint?.routeFingerprint ?? analysis.name}
        analysis={analysis}
        analysisHeadingRef={analysisHeadingRef}
        routeFingerprint={routeFingerprint ?? undefined}
        persistenceScope={persistenceScope}
        sharedCache={sharedCache}
      />}
    </main>
  );
}
