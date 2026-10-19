"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import CourseExplorer from "./CourseExplorer";
import CourseBriefView from "./CourseBriefView";
import RouteSectionBrowser, { RouteSectionBrowserHeading } from "./RouteSectionBrowser";
import TerrainEvidenceAction from "./TerrainEvidenceAction";
import KeyMoment from "./KeyMoment";
import { toggleKeyMomentSelection } from "./routeSectionSelection";
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
import { TERRAIN_INTELLIGENCE_V1_ENABLED } from "./featureFlags";
import { buildSustainedGradientKeyMoments } from "./routeGradientMoments";
import RouteTakeaways from "./RouteTakeaways";

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
    | { editionKey: string; status: "loading" }
    | { editionKey: string; status: "error"; message: string }
    | null
  >(null);
  const [retryRequest, setRetryRequest] = useState(0);
  const retryPendingRef = useRef(false);
  const gpxRequestIdRef = useRef(0);
  const gpxControllerRef = useRef<AbortController | null>(null);
  const currentLoad = loadState?.editionKey === editionKey ? loadState : null;
  const routeAnalysis = currentLoad?.status === "ready" ? currentLoad.analysis : null;
  const currentError = currentLoad?.status === "error" ? currentLoad.message : "";
  const isLoading = currentLoad === null || currentLoad.status === "loading";
  const [terrainLoad, setTerrainLoad] = useState<{ editionKey: string; status: "loading" | "ready" | "unavailable"; data: GeoEnrichmentData | null } | null>(null);
  const currentTerrain = terrainLoad?.editionKey === editionKey ? terrainLoad : null;
  const terrainState = currentTerrain?.status ?? "not-requested";
  const terrainController = useRef<AbortController | null>(null);
  const terrainRequestActive = useRef(false);
  const displayedSections = useMemo(() => TERRAIN_INTELLIGENCE_V1_ENABLED && routeAnalysis && currentTerrain?.data
    ? attachTerrainEvidenceToRouteSections(routeAnalysis.routeSections, currentTerrain.data)
    : routeAnalysis?.routeSections ?? [], [routeAnalysis, currentTerrain]);
  const keyMoments = useMemo(() => [
    ...raceRecord.intelligence.keyMoments,
    ...buildSustainedGradientKeyMoments(routeAnalysis?.gradientIntelligence, raceRecord.intelligence.keyMoments),
  ], [raceRecord.intelligence.keyMoments, routeAnalysis?.gradientIntelligence]);

  useEffect(() => () => {
    terrainController.current?.abort();
    terrainRequestActive.current = false;
  }, [editionKey]);

  useEffect(() => {
    const controller = new AbortController();
    const requestId = ++gpxRequestIdRef.current;
    gpxControllerRef.current = controller;
    retryPendingRef.current = false;

    async function loadRaceGpx() {
      try {
        const response = await fetch(raceRecord.edition.gpxPath, { signal: controller.signal });
        if (!response.ok) throw new Error("The race GPX could not be loaded.");
        const parsed = parseGpxText(await response.text());
        const analysis = analyzeGpxRoute(
          parsed,
          `${raceRecord.race.name} ${raceRecord.edition.year}`,
        );
        let routeFingerprint: RouteFingerprintResult | null = null;
        if (TERRAIN_INTELLIGENCE_V1_ENABLED) {
          try {
            routeFingerprint = await createRouteFingerprint(parsed.segments.map((segment) => segment.map(({ latitude, longitude }) => ({ latitude, longitude }))));
          } catch { /* Terrain cache reuse is optional; the route remains analyzable. */ }
        }
        if (!controller.signal.aborted && gpxRequestIdRef.current === requestId) {
          setLoadState({ editionKey, status: "ready", analysis, routeFingerprint });
        }
      } catch {
        if (!controller.signal.aborted && gpxRequestIdRef.current === requestId) {
          setLoadState({ editionKey, status: "error", message: "Could not load this race edition’s GPX. Check your connection and try again." });
        }
      } finally {
        if (gpxControllerRef.current === controller) gpxControllerRef.current = null;
      }
    }

    void loadRaceGpx();
    return () => {
      controller.abort();
      if (gpxControllerRef.current === controller) gpxControllerRef.current = null;
    };
  }, [editionKey, raceRecord.edition.gpxPath, raceRecord.edition.year, raceRecord.race.name, retryRequest]);

  function retryRaceGpx() {
    if (currentLoad?.status !== "error" || retryPendingRef.current) return;
    retryPendingRef.current = true;
    setLoadState({ editionKey, status: "loading" });
    setRetryRequest((request) => request + 1);
  }

  async function checkTerrainEvidence() {
    if (!TERRAIN_INTELLIGENCE_V1_ENABLED) return;
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

  function selectMoment(momentId: string) {
    setSelection((current) => ({
      editionKey,
      moment: toggleKeyMomentSelection(current.editionKey === editionKey ? current.moment : null, momentId),
      sectionKey: null,
    }));
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
        heading={raceRecord.race.name || "Race course"}
        eyebrow={`${raceRecord.edition.year} edition · GPX-derived`}
        supportingText="The profile and measurements below come from the selected edition’s GPX track."
        startLocation={raceRecord.edition.startLocation}
        finishLocation={raceRecord.edition.finishLocation}
        routeAnalysis={routeAnalysis}
        keyMoments={keyMoments}
        loading={isLoading}
        error={currentError}
        onRetry={retryRaceGpx}
        showExtendedMetrics
      />
      <CourseBriefView
        key={editionKey}
        routeKey={editionKey}
        routeAnalysis={routeAnalysis}
        loading={isLoading}
      />
      {routeAnalysis && <RouteTakeaways analysis={routeAnalysis} />}
      {routeAnalysis && (
        <section className="mt-12">
          <RouteSectionBrowserHeading action={TERRAIN_INTELLIGENCE_V1_ENABLED ? <TerrainEvidenceAction state={terrainState} onCheck={() => void checkTerrainEvidence()} /> : undefined} />
          <RouteSectionBrowser
            sections={displayedSections}
            gradientIntelligence={routeAnalysis.gradientIntelligence}
            selectedSectionKey={selectedSectionKey}
            onSelectSection={selectSection}
            terrainEvidenceState={terrainState}
          />
        </section>
      )}
      <div className="mt-16">
        {keyMoments.map((item) => (
          <KeyMoment
            key={item.id}
            title={item.title}
            selected={selectedMoment === item.id}
            onSelect={() => selectMoment(item.id)}
            distance={item.distance}
            focusStartKm={item.focusStartKm}
            focusEndKm={item.focusEndKm}
            segmentIndex={item.segmentIndex}
            focusStartPosition={item.focusStartPosition}
            focusEndPosition={item.focusEndPosition}
            routePoints={routeAnalysis?.points}
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
