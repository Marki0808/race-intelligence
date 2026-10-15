"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import CourseExplorer from "./CourseExplorer";
import CourseBriefView from "./CourseBriefView";
import RouteSectionBrowser, { RouteSectionBrowserHeading } from "./RouteSectionBrowser";
import TerrainEvidenceAction from "./TerrainEvidenceAction";
import KeyMoment from "./KeyMoment";
import type { GeoEnrichmentData } from "./geoEnrichment";
import { attachTerrainEvidenceToRouteSections } from "./routeEvidenceAdapter";
import { requestRouteTerrainEvidence } from "./routeTerrainEvidenceClient";
import { createRouteFingerprint } from "./routeFingerprint";
import type { RouteFingerprintResult } from "./routeFingerprint";
import { browserRoutePersistence, cacheOsmEnrichment, getCachedOsmEnrichment, OSM_ENRICHMENT_VERSION } from "./routePersistence";
import type { PersistedOsmEnrichmentRecord } from "./routePersistence";
import { analyzeGpxRoute, parseGpxText } from "./gpxAnalysis";
import type { RouteAnalysisData } from "./gpxAnalysis";
import type { RaceRecordData } from "./raceTypes";
import type { RouteSection } from "./routeSectionEngine";
import { routeSectionSelectionKey } from "./routeSectionSelection";

export default function CourseSection({
  raceRecord,
}: {
  raceRecord: RaceRecordData;
}) {
  const editionKey = JSON.stringify([raceRecord.race.id, raceRecord.edition.year, raceRecord.edition.distanceKm, raceRecord.edition.gpxPath]);
  const [selection, setSelection] = useState<{ editionKey: string; moment: string | null; sectionKey: string | null }>(() => ({ editionKey, moment: null, sectionKey: null }));
  const selectedMoment = selection.editionKey === editionKey ? selection.moment : null;
  const selectedSectionKey = selection.editionKey === editionKey ? selection.sectionKey : null;
  const [loadState, setLoadState] = useState<
    | { editionKey: string; status: "ready"; analysis: RouteAnalysisData; routeFingerprint: RouteFingerprintResult | null }
    | { editionKey: string; status: "error"; message: string }
    | null
  >(null);
  const currentLoad = loadState?.editionKey === editionKey ? loadState : null;
  const routeAnalysis = currentLoad?.status === "ready" ? currentLoad.analysis : null;
  const currentError = currentLoad?.status === "error" ? currentLoad.message : "";
  const isLoading = currentLoad === null;
  const [terrainLoad, setTerrainLoad] = useState<{ editionKey: string; status: "loading" | "ready" | "unavailable"; data: GeoEnrichmentData | null } | null>(null);
  const currentTerrain = terrainLoad?.editionKey === editionKey ? terrainLoad : null;
  const terrainState = currentTerrain?.status ?? "not-requested";
  const terrainController = useRef<AbortController | null>(null);
  const terrainRequestActive = useRef(false);
  const displayedSections = useMemo(() => routeAnalysis && currentTerrain?.data
    ? attachTerrainEvidenceToRouteSections(routeAnalysis.routeSections, currentTerrain.data)
    : routeAnalysis?.routeSections ?? [], [routeAnalysis, currentTerrain]);

  useEffect(() => () => {
    terrainController.current?.abort();
    terrainRequestActive.current = false;
  }, [editionKey]);

  useEffect(() => {
    let cancelled = false;

    async function loadRaceGpx() {
      try {
        const response = await fetch(raceRecord.edition.gpxPath);
        if (!response.ok) throw new Error("The race GPX could not be loaded.");
        const parsed = parseGpxText(await response.text());
        const analysis = analyzeGpxRoute(
          parsed,
          `${raceRecord.race.name} ${raceRecord.edition.year}`,
        );
        let routeFingerprint: RouteFingerprintResult | null = null;
        try {
          routeFingerprint = await createRouteFingerprint(parsed.segments.map((segment) => segment.map(({ latitude, longitude }) => ({ latitude, longitude }))));
        } catch { /* Terrain cache reuse is optional; the route remains analyzable. */ }
        if (!cancelled) {
          setLoadState({ editionKey, status: "ready", analysis, routeFingerprint });
        }
      } catch {
        if (!cancelled) {
          setLoadState({ editionKey, status: "error", message: "Could not load or analyze this race GPX." });
        }
      }
    }

    void loadRaceGpx();
    return () => {
      cancelled = true;
    };
  }, [editionKey, raceRecord.edition.gpxPath, raceRecord.edition.year, raceRecord.race.name]);

  async function checkTerrainEvidence() {
    if (!routeAnalysis || currentTerrain?.status === "loading" || terrainRequestActive.current) return;
    terrainRequestActive.current = true;
    const refresh = currentTerrain?.status === "ready";
    terrainController.current?.abort();
    const controller = new AbortController();
    terrainController.current = controller;
    setTerrainLoad({ editionKey, status: "loading", data: currentTerrain?.data ?? null });
    try {
      const fingerprint = currentLoad?.status === "ready" ? currentLoad.routeFingerprint : null;
      let cached: PersistedOsmEnrichmentRecord | null = null;
      if (fingerprint) {
        try {
          cached = (await getCachedOsmEnrichment(browserRoutePersistence, fingerprint.routeFingerprint, fingerprint.routeFingerprintVersion, routeAnalysis.metrics.distanceKm, OSM_ENRICHMENT_VERSION))?.record ?? null;
          if (!refresh && cached?.classifiableRanges.length) {
            if (!controller.signal.aborted) setTerrainLoad({ editionKey, status: "ready", data: withOsmConflicts(cached) });
            return;
          }
        } catch { /* Local cache is optional; continue through the existing API. */ }
      }
      const result = await requestRouteTerrainEvidence(routeAnalysis.points, controller.signal);
      if (controller.signal.aborted) return;
      let data = result.status === "unavailable" && cached ? withOsmConflicts(cached) : result.data;
      if (fingerprint) {
        try {
          const merged = await cacheOsmEnrichment(browserRoutePersistence, fingerprint.routeFingerprint, data, routeAnalysis.metrics.distanceKm, { routeFingerprintVersion: fingerprint.routeFingerprintVersion });
          data = withOsmConflicts(merged);
        } catch {
          if (cached) data = withOsmConflicts(cached);
        }
      }
      if (controller.signal.aborted) return;
      setTerrainLoad({ editionKey, status: result.status === "unavailable" && cached ? "ready" : result.status, data });
    } catch {
      if (!controller.signal.aborted) setTerrainLoad({ editionKey, status: "unavailable", data: currentTerrain?.data ?? null });
    } finally {
      terrainRequestActive.current = false;
      if (terrainController.current === controller) terrainController.current = null;
    }
  }

  function selectMoment(title: string) {
    setSelection({ editionKey, moment: title, sectionKey: null });
  }

  function selectSection(section: RouteSection | null) {
    setSelection((current) => ({
      editionKey,
      moment: section ? null : current.editionKey === editionKey ? current.moment : null,
      sectionKey: section ? routeSectionSelectionKey(section) : null,
    }));
  }

  return (
    <div>
      <CourseExplorer
        selectedMoment={selectedMoment}
        selectedSectionKey={selectedSectionKey}
        onSelectSection={selectSection}
        routeName={`${raceRecord.race.name} · ${raceRecord.edition.year}`}
        startLocation={raceRecord.edition.startLocation}
        finishLocation={raceRecord.edition.finishLocation}
        routeAnalysis={routeAnalysis}
        keyMoments={raceRecord.intelligence.keyMoments}
        loading={isLoading}
        error={currentError}
      />
      <CourseBriefView
        key={editionKey}
        routeKey={editionKey}
        routeAnalysis={routeAnalysis}
        loading={isLoading}
      />
      {routeAnalysis && (
        <section className="mt-12">
          <RouteSectionBrowserHeading action={<TerrainEvidenceAction state={terrainState} onCheck={() => void checkTerrainEvidence()} />} />
          <RouteSectionBrowser
            sections={displayedSections}
            gradientIntelligence={routeAnalysis.gradientIntelligence}
            selectedSectionKey={selectedSectionKey}
            onSelectSection={selectSection}
            terrainEvidenceState={terrainState}
          />
        </section>
      )}
      <p className="mt-4 text-sm text-black/50">
        Selected: {selectedMoment ?? "None"}
      </p>

      <div className="mt-16">
        {raceRecord.intelligence.keyMoments.map((item) => (
          <KeyMoment
            key={item.id}
            title={item.title}
            onSelect={() => selectMoment(item.title)}
            distance={item.distance}
            focusStartKm={item.focusStartKm}
            focusEndKm={item.focusEndKm}
            gain={item.gain}
            loss={item.loss}
            text={item.text}
            source={item.source}
          />
        ))}
      </div>
    </div>
  );
}

function withOsmConflicts(record: PersistedOsmEnrichmentRecord): GeoEnrichmentData {
  return { ...record.mergedData, conflicts: record.conflicts };
}
