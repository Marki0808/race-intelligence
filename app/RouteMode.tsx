"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import RouteAnalysisView from "./RouteAnalysisView";
import {
  analyzeGpxRoute,
  GpxAnalysisError,
  parseGpxText,
  getGpxAnalysisErrorMessage,
} from "./gpxAnalysis";
import type { RouteAnalysisData } from "./gpxAnalysis";
import { createRouteFingerprint } from "./routeFingerprint";
import { createAnalysisInputFingerprint } from "./analysisInputFingerprint";
import { browserRoutePersistence, cacheRouteAnalysis, getOrCreateRouteAnalysis } from "./routePersistence";
import { lookupSharedRoute, type SharedRouteCache } from "./routePersistenceClient";
import type { RouteFingerprintResult } from "./routeFingerprint";
import { consumePendingDiscoveredGpx } from "./discoveredGpxTransfer";

export default function RouteMode() {
  const [analysis, setAnalysis] = useState<RouteAnalysisData | null>(null);
  const [error, setError] = useState("");
  const [isProcessing, setIsProcessing] = useState(false);
  const [routeFingerprint, setRouteFingerprint] = useState<RouteFingerprintResult | null>(null);
  const [persistenceScope, setPersistenceScope] = useState<"local" | "shared">("local");
  const [sharedCache, setSharedCache] = useState<SharedRouteCache | null>(null);

  const analyzeText = useCallback(async (text: string, fallbackName: string) => {
    setAnalysis(null);
    setRouteFingerprint(null);
    setPersistenceScope("local");
    setSharedCache(null);
    setError("");
    setIsProcessing(true);
    try {
      const parsed = parseGpxText(text);
      const displayName = parsed.name ?? fallbackName;
      try {
        const [fingerprint, analysisInputFingerprint] = await Promise.all([
          createRouteFingerprint(parsed.segments.map((segment) => segment.map(({ latitude, longitude }) => ({ latitude, longitude })))),
          createAnalysisInputFingerprint(parsed.segments),
        ]);
        const shared = await lookupSharedRoute(fingerprint, analysisInputFingerprint);
        let routeAnalysis: RouteAnalysisData;
        if (shared.cache?.analysis) {
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
        setRouteFingerprint(fingerprint);
        setPersistenceScope(shared.persistenceScope);
        setSharedCache(shared.cache);
        setAnalysis(routeAnalysis);
      } catch {
        // Fingerprinting and persistence are optimizations; retain the existing local analysis path.
        setAnalysis({ ...analyzeGpxRoute(parsed), name: displayName });
      }
    } catch (caught) {
      setError(
        caught instanceof GpxAnalysisError
          ? getGpxAnalysisErrorMessage(caught.code)
          : "The GPX file could not be read. Try selecting it again.",
      );
    } finally {
      setIsProcessing(false);
    }
  }, []);

  useEffect(() => {
    const pending = consumePendingDiscoveredGpx();
    if (pending) {
      queueMicrotask(() => {
        void analyzeText(pending.text, pending.name);
      });
    }
  }, [analyzeText]);

  async function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;

    if (!file.name.toLowerCase().endsWith(".gpx")) {
      setAnalysis(null);
      setError("Please choose a file with the .gpx extension.");
      return;
    }
    try {
      await analyzeText(await file.text(), file.name.replace(/\.gpx$/i, ""));
    } catch {
      setError("The GPX file could not be read. Try selecting it again.");
    }
  }

  return (
    <main className="min-h-screen bg-[#f4f2ed] text-[#17211c]">
      <nav className="border-b border-white/10 bg-[#17211c]">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-6 lg:px-10">
          <Link href="/" className="text-sm font-bold tracking-[0.18em] text-white">
            RACE<span className="text-[#a7c957]">{"//"}</span>SCOPE
          </Link>
          <Link href="/" className="text-sm text-white/60 transition hover:text-white">
            Race Search
          </Link>
        </div>
      </nav>

      <section className="bg-[#17211c] text-white">
        <div className="mx-auto max-w-7xl px-6 py-16 lg:px-10 lg:py-24">
          <p className="text-xs font-semibold uppercase tracking-[0.22em] text-[#a7c957]">
            Route Mode · GPX-derived
          </p>
          <h1 className="mt-5 max-w-4xl text-5xl font-semibold leading-[0.96] tracking-[-0.045em] sm:text-6xl lg:text-7xl">
            Analyze a GPX route.
          </h1>
          <p className="mt-6 max-w-2xl text-base leading-7 text-white/55 sm:text-lg">
            Upload a GPX file or choose a discovered route link to calculate its distance, elevation profile and route sections.
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
              accept=".gpx,application/gpx+xml,application/xml,text/xml"
              onChange={handleFileChange}
              disabled={isProcessing}
              className="mt-4 block w-full min-w-0 cursor-pointer text-sm text-white/65 file:mr-4 file:rounded-full file:border-0 file:bg-[#a7c957] file:px-5 file:py-2.5 file:text-sm file:font-semibold file:text-[#17211c] hover:file:bg-[#b8d86b] disabled:cursor-wait"
            />
            <p className="mt-4 text-xs leading-5 text-white/40">
              Discovered links are checked as a supported single-track GPX before analysis. They are treated as GPX-derived routes and are not bound to a race edition. The GPX file itself is not stored. For registered public courses, the route fingerprint, analysis and optional map evidence may be shared through this app&apos;s server. Other uploaded routes remain in this browser&apos;s local cache. Terrain Evidence sends route coordinates to this app&apos;s matching endpoint; Mapillary receives bounded section search areas, not the GPX file or elevation data.
            </p>
            {isProcessing && (
              <p aria-live="polite" className="mt-4 text-sm text-[#a7c957]">
                Analyzing GPX-derived route data…
              </p>
            )}
            {error && (
              <p
                role="status"
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
        routeFingerprint={routeFingerprint ?? undefined}
        persistenceScope={persistenceScope}
        sharedCache={sharedCache}
      />}
    </main>
  );
}
