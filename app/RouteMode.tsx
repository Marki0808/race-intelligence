"use client";

import { useState } from "react";
import Link from "next/link";
import RouteAnalysisView from "./RouteAnalysisView";
import {
  analyzeGpxRoute,
  GpxAnalysisError,
  parseGpxText,
  getGpxAnalysisErrorMessage,
} from "./gpxAnalysis";
import type { RouteAnalysisData } from "./gpxAnalysis";

export default function RouteMode() {
  const [analysis, setAnalysis] = useState<RouteAnalysisData | null>(null);
  const [error, setError] = useState("");
  const [isProcessing, setIsProcessing] = useState(false);

  async function handleFileChange(
    event: React.ChangeEvent<HTMLInputElement>,
  ) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;

    setAnalysis(null);
    setError("");
    if (!file.name.toLowerCase().endsWith(".gpx")) {
      setError("Please choose a file with the .gpx extension.");
      return;
    }

    setIsProcessing(true);
    try {
      const parsed = parseGpxText(await file.text());
      setAnalysis(analyzeGpxRoute(parsed));
    } catch (caught) {
      setError(
        caught instanceof GpxAnalysisError
          ? getGpxAnalysisErrorMessage(caught.code)
          : "The GPX file could not be read. Try selecting it again.",
      );
    } finally {
      setIsProcessing(false);
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
            Choose a trail GPX file to calculate its distance, elevation profile and route sections locally.
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
              The GPX file stays in this browser and is not stored. If you request Terrain Evidence, route coordinates are sent to this app&apos;s matching endpoint. For optional Mapillary imagery, bounded section search areas are queried server-side; the GPX file and elevation data are not uploaded to Mapillary or stored.
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

      {analysis && <RouteAnalysisView analysis={analysis} />}
    </main>
  );
}
