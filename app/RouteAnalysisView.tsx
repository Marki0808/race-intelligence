"use client";

import { useMemo, useRef, useState } from "react";
import CourseExplorer from "./CourseExplorer";
import CourseBriefView from "./CourseBriefView";
import RouteSectionBrowser, { RouteSectionBrowserHeading } from "./RouteSectionBrowser";
import TerrainEvidenceAction from "./TerrainEvidenceAction";
import KeyRouteMoments from "./KeyRouteMoments";
import type { GeoEnrichmentData } from "./geoEnrichment";
import { requestRouteTerrainEvidence } from "./routeTerrainEvidenceClient";
import type { RouteAnalysisData } from "./gpxAnalysis";
import type { MapillaryImageEvidence, MapillaryTerrainProofData } from "./mapillaryTerrainProof";
import TerrainImageViewer from "./TerrainImageViewer";
import { attachTerrainEvidenceToRouteSections } from "./routeEvidenceAdapter";
import type { RouteSection } from "./routeSectionEngine";
import { routeSectionSelectionKey } from "./routeSectionSelection";
import { mapillaryEvidenceByRouteSection } from "./routeSectionEvidence";
import { buildMapillaryRequests } from "./routeMapillaryRequests";
import { enrichSharedRoute, type SharedRouteCache } from "./routePersistenceClient";
import type { RouteFingerprintResult } from "./routeFingerprint";
import {
  browserRoutePersistence,
  cacheMapillaryEnrichment,
  cacheOsmEnrichment,
  getCachedOsmEnrichment,
  hasReusableMapillaryEvidence,
  MAPILLARY_ENRICHMENT_VERSION,
  mapMapillaryEvidenceToSections,
  OSM_ENRICHMENT_VERSION,
} from "./routePersistence";
import type { PersistedMapillaryEnrichmentRecord, PersistedOsmEnrichmentRecord } from "./routePersistence";
import type { TerrainEvidenceState } from "./routeSectionPresentation";
import { TERRAIN_INTELLIGENCE_V1_ENABLED } from "./featureFlags";
import { toggleKeyMomentSelection } from "./routeSectionSelection";
import { buildSustainedGradientKeyMoments } from "./routeGradientMoments";
import { expandKeyMomentsForDisplay } from "./routeKeyMomentPresentation";
import RouteTakeaways from "./RouteTakeaways";
import { buildAidStationSections } from "./aidStationSections";
import CustomSectionControls from "./CustomSectionControls";
import { appendCustomSectionBoundary, buildCustomRouteSections, createCustomSectionPlan, type CustomSectionPlan } from "./customRouteSections";
import { buildGradientIntelligenceV1 } from "./gradientIntelligence";
import { buildRouteNarrativeRouteContextV2 } from "./routeNarrativePhases";

export default function RouteAnalysisView({
  analysis,
  routeFingerprint,
  persistenceScope = "local",
  sharedCache = null,
}: {
  analysis: RouteAnalysisData;
  routeFingerprint?: RouteFingerprintResult;
  persistenceScope?: "local" | "shared";
  sharedCache?: SharedRouteCache | null;
}) {
  type ViewState = { analysis: RouteAnalysisData; selectedMoment: string | null; selectedSectionKey: string | null; segmentationMode: "terrain" | "custom" | "aid-station"; selectedImage: MapillaryImageEvidence | null };
  const [viewState, setViewState] = useState<ViewState>(() => ({ analysis, selectedMoment: null, selectedSectionKey: null, segmentationMode: "terrain", selectedImage: null }));
  const currentViewState = viewState.analysis === analysis ? viewState : { analysis, selectedMoment: null, selectedSectionKey: null, segmentationMode: "terrain" as const, selectedImage: null };
  const { selectedMoment, selectedSectionKey, segmentationMode, selectedImage } = currentViewState;
  const [geoEvidence, setGeoEvidence] = useState<GeoEnrichmentData | null>(() => sharedCache?.osm ? withOsmConflicts(sharedCache.osm) : null);
  const [geoLoading, setGeoLoading] = useState(false);
  const evidenceRequestActive = useRef(false);
  const [terrainEvidenceState, setTerrainEvidenceState] = useState<TerrainEvidenceState>(() => sharedCache?.osm ? "ready" : "not-requested");
  const [mapillaryEvidence, setMapillaryEvidence] = useState<MapillaryTerrainProofData | null>(() => sharedCache?.mapillary
    ? mapMapillaryEvidenceToSections(sharedCache.mapillary, analysis.routeSections)
    : null);
  const displayedSections = useMemo(() => TERRAIN_INTELLIGENCE_V1_ENABLED && geoEvidence
    ? attachTerrainEvidenceToRouteSections(analysis.routeSections, geoEvidence)
    : analysis.routeSections, [analysis.routeSections, geoEvidence]);
  const aidStationSections = useMemo(() => buildAidStationSections(analysis.aidStationDiscoveryV1, {
    points: analysis.points,
    routeDynamics: analysis.routeDynamics,
    metrics: analysis.metrics,
  }), [analysis.aidStationDiscoveryV1, analysis.points, analysis.routeDynamics, analysis.metrics]);
  const [customPlanState, setCustomPlanState] = useState(() => ({ analysis, plan: createCustomSectionPlan() }));
  const customPlan = useMemo(() => customPlanState.analysis === analysis ? customPlanState.plan : createCustomSectionPlan(), [customPlanState, analysis]);
  const routeDistanceM = analysis.points.at(-1)?.distanceM ?? 0;
  const customSections = useMemo(() => buildCustomRouteSections(analysis, customPlan), [analysis, customPlan]);
  const showingCustomSections = segmentationMode === "custom";
  const showingAidStationSections = segmentationMode === "aid-station" && aidStationSections.available;
  const activeSections = showingCustomSections
    ? customSections.available ? customSections.sections : []
    : showingAidStationSections ? aidStationSections.sections : displayedSections;
  const activeGradientIntelligence = useMemo(() => {
    if (showingCustomSections) return customSections.available ? buildGradientIntelligenceV1(analysis.routeDynamics, customSections.sections) : undefined;
    return showingAidStationSections ? undefined : analysis.gradientIntelligence;
  }, [analysis.gradientIntelligence, analysis.routeDynamics, customSections, showingAidStationSections, showingCustomSections]);
  const routeNarrativeContext = useMemo(
    () => buildRouteNarrativeRouteContextV2(analysis.routeDynamics, analysis.routeSections),
    [analysis.routeDynamics, analysis.routeSections],
  );
  const imageEvidence = useMemo(
    () => mapillaryEvidenceByRouteSection(analysis.routeSections, mapillaryEvidence),
    [analysis.routeSections, mapillaryEvidence],
  );
  const keyMoments = useMemo(() => expandKeyMomentsForDisplay([
    ...analysis.keyMoments,
    ...buildSustainedGradientKeyMoments(analysis.gradientIntelligence, analysis.keyMoments),
  ]), [analysis.keyMoments, analysis.gradientIntelligence]);

  function updateViewState(patch: Partial<Omit<ViewState, "analysis">>) {
    setViewState((current) => ({
      ...(current.analysis === analysis ? current : { analysis, selectedMoment: null, selectedSectionKey: null, segmentationMode: "terrain" as const, selectedImage: null }),
      ...patch,
      analysis,
    }));
  }

  function updateCustomPlan(plan: CustomSectionPlan) {
    setCustomPlanState({ analysis, plan });
  }

  function addCustomBoundary() {
    updateCustomPlan(appendCustomSectionBoundary(customPlan, routeDistanceM));
  }

  function selectMoment(momentId: string) {
    updateViewState({ selectedSectionKey: null, selectedMoment: toggleKeyMomentSelection(selectedMoment, momentId) });
  }

  function selectSection(section: RouteSection | null) {
    updateViewState({ selectedSectionKey: section ? routeSectionSelectionKey(section) : null, ...(section ? { selectedMoment: null } : {}) });
  }

  async function loadEvidence() {
    if (!TERRAIN_INTELLIGENCE_V1_ENABLED) return;
    if (geoLoading || evidenceRequestActive.current) return;
    evidenceRequestActive.current = true;
    setGeoLoading(true);
    setTerrainEvidenceState("loading");
    try {
      let cachedOsm: PersistedOsmEnrichmentRecord | null = sharedCache?.osm ?? null;
      let cachedMapillary: PersistedMapillaryEnrichmentRecord | null = sharedCache?.mapillary ?? null;
      const shouldRefresh = geoEvidence !== null || mapillaryEvidence !== null;
      if (persistenceScope === "shared" && routeFingerprint) {
        if (!shouldRefresh && (cachedOsm?.classifiableRanges.length || (cachedMapillary && hasReusableMapillaryEvidence(cachedMapillary)))) {
          setTerrainEvidenceState("ready");
          return;
        }
        try {
          const sharedResult = await enrichSharedRoute(routeFingerprint, {
            osm: shouldRefresh || !cachedOsm?.classifiableRanges.length,
            mapillary: shouldRefresh || !cachedMapillary || !hasReusableMapillaryEvidence(cachedMapillary),
          });
          if (sharedResult.osm) {
            const record = isPersistedOsm(sharedResult.osm) ? sharedResult.osm : null;
            setGeoEvidence(record ? withOsmConflicts(record) : sharedResult.osm as GeoEnrichmentData);
          }
          setTerrainEvidenceState(sharedResult.osm || cachedOsm || geoEvidence ? "ready" : "unavailable");
          if (sharedResult.mapillary) {
            const record = isPersistedMapillary(sharedResult.mapillary) ? sharedResult.mapillary : null;
            setMapillaryEvidence(record
              ? mapMapillaryEvidenceToSections(record, analysis.routeSections)
              : sharedResult.mapillary as MapillaryTerrainProofData);
          }
          return;
        } catch {
          // Shared server persistence is optional; fall back to the existing browser and direct evidence flow.
        }
      }

      try {
        if (routeFingerprint) {
          const [osmCache, mapillaryCache] = await Promise.all([
            getCachedOsmEnrichment(browserRoutePersistence, routeFingerprint.routeFingerprint, routeFingerprint.routeFingerprintVersion, analysis.metrics.distanceKm, OSM_ENRICHMENT_VERSION),
            browserRoutePersistence.getMapillary(routeFingerprint.routeFingerprint, routeFingerprint.routeFingerprintVersion, MAPILLARY_ENRICHMENT_VERSION),
          ]);
          cachedOsm = osmCache?.record ?? null;
          cachedMapillary = mapillaryCache;
        }
      } catch { /* Persistence is optional; continue with live requests. */ }

      if (!shouldRefresh && cachedOsm?.classifiableRanges.length) {
        setGeoEvidence(withOsmConflicts(cachedOsm));
        setTerrainEvidenceState("ready");
      }
      if (!shouldRefresh && cachedMapillary && hasReusableMapillaryEvidence(cachedMapillary)) {
        setMapillaryEvidence(mapMapillaryEvidenceToSections(cachedMapillary, analysis.routeSections));
      }

      const requests = buildMapillaryRequests(analysis.routeSections, analysis.points);
      const requestOsm = !routeFingerprint || shouldRefresh || !cachedOsm?.classifiableRanges.length;
      const requestMapillary = !routeFingerprint || shouldRefresh || !cachedMapillary || !hasReusableMapillaryEvidence(cachedMapillary);
      const [osmResult, imageryResult] = await Promise.all([
        requestOsm ? requestRouteTerrainEvidence(analysis.points) : Promise.resolve(null),
        requestMapillary ? fetch("/api/mapillary", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sections: requests }),
        }).then(async (response) => response.ok ? await response.json() as MapillaryTerrainProofData : unknownMapillaryEvidence(requests)).catch(() => unknownMapillaryEvidence(requests)) : Promise.resolve(null),
      ]);

      if (osmResult) {
        setTerrainEvidenceState(osmResult.status === "unavailable" && cachedOsm ? "ready" : osmResult.status);
        try {
          if (!routeFingerprint) {
            setGeoEvidence(osmResult.data);
          } else {
            const merged = await cacheOsmEnrichment(browserRoutePersistence, routeFingerprint.routeFingerprint, osmResult.data, analysis.metrics.distanceKm, { routeFingerprintVersion: routeFingerprint.routeFingerprintVersion });
            setGeoEvidence(withOsmConflicts(merged));
          }
        } catch {
          setGeoEvidence(cachedOsm ? withOsmConflicts(cachedOsm) : osmResult.data);
        }
      } else if (cachedOsm) setTerrainEvidenceState("ready");
      else setTerrainEvidenceState("unavailable");
      if (imageryResult) {
        try {
          if (!routeFingerprint) {
            setMapillaryEvidence(imageryResult);
          } else {
            const merged = await cacheMapillaryEnrichment(browserRoutePersistence, routeFingerprint.routeFingerprint, imageryResult, { routeFingerprintVersion: routeFingerprint.routeFingerprintVersion });
            setMapillaryEvidence(mapMapillaryEvidenceToSections(merged, analysis.routeSections));
          }
        } catch {
          setMapillaryEvidence(cachedMapillary
            ? mapMapillaryEvidenceToSections(cachedMapillary, analysis.routeSections)
            : imageryResult);
        }
      }
    } catch {
      setTerrainEvidenceState(geoEvidence ? "ready" : "unavailable");
    } finally {
      evidenceRequestActive.current = false;
      setGeoLoading(false);
    }
  }

  return (
    <>
      <section className="bg-[#f4f2ed]">
        <div className="mx-auto max-w-7xl px-6 py-16 lg:px-10 lg:py-20">
          <CourseExplorer
            selectedMoment={selectedMoment}
            selectedSectionKey={selectedSectionKey}
            selectionSections={activeSections}
            sectionKind={showingAidStationSections ? "Aid Station Section" : showingCustomSections ? "Custom Section" : "Route Section"}
            onSelectSection={selectSection}
            routeName={analysis.name}
            heading="GPX Route Analysis"
            eyebrow="YOUR ROUTE · GPX-DERIVED"
            supportingText="Route structure and measurements are calculated locally from the GPX file selected in this browser."
            routeAnalysis={analysis}
            keyMoments={keyMoments}
            loading={false}
            error=""
            showExtendedMetrics
          />
          <CourseBriefView routeAnalysis={analysis} routeKey={routeFingerprint?.routeFingerprint ?? analysis.name} />
        </div>
      </section>

      <section className="bg-white">
        <div className="mx-auto max-w-7xl px-6 py-16 lg:px-10 lg:py-20">
          <RouteSectionBrowserHeading controls={(
            <>
              <div className="mt-4 inline-flex flex-wrap rounded-full border border-black/10 bg-[#f4f2ed] p-1" role="group" aria-label="Route section view">
                <button type="button" aria-pressed={segmentationMode === "terrain" || (segmentationMode === "aid-station" && !showingAidStationSections)} onClick={() => updateViewState({ segmentationMode: "terrain", selectedSectionKey: null })} className={`min-h-10 rounded-full px-4 text-sm font-semibold transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#71805d] ${segmentationMode === "terrain" || (segmentationMode === "aid-station" && !showingAidStationSections) ? "bg-[#17211c] text-white" : "text-black/55 hover:bg-white"}`}>Terrain Sections</button>
                <button type="button" aria-pressed={showingCustomSections} onClick={() => updateViewState({ segmentationMode: "custom", selectedSectionKey: null })} className={`min-h-10 rounded-full px-4 text-sm font-semibold transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#71805d] ${showingCustomSections ? "bg-[#17211c] text-white" : "text-black/55 hover:bg-white"}`}>Custom Sections</button>
                {aidStationSections.available && <button type="button" aria-label={aidStationSections.positionMode === "official-kilometer-approximate" ? "Aid Station Sections, boundaries use approximate official kilometer positions" : "Aid Station Sections"} aria-pressed={showingAidStationSections} onClick={() => updateViewState({ segmentationMode: "aid-station", selectedSectionKey: null })} className={`min-h-10 rounded-full px-4 text-sm font-semibold transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#71805d] ${showingAidStationSections ? "bg-[#17211c] text-white" : "text-black/55 hover:bg-white"}`}>
                  {aidStationSections.positionMode === "official-kilometer-approximate" ? "Aid Station Sections · approx. km" : "Aid Station Sections"}
                </button>}
              </div>
              {showingCustomSections && <CustomSectionControls plan={customPlan} routeDistanceM={routeDistanceM} errors={customSections.available ? [] : customSections.errors} onChange={updateCustomPlan} onAdd={addCustomBoundary} />}
            </>
          )} action={TERRAIN_INTELLIGENCE_V1_ENABLED ? (
            <TerrainEvidenceAction state={terrainEvidenceState} onCheck={() => void loadEvidence()} />
          ) : undefined} />
          <RouteSectionBrowser sections={activeSections} routePoints={analysis.points} gradientIntelligence={activeGradientIntelligence} narrativeContext={routeNarrativeContext} selectedSectionKey={selectedSectionKey} onSelectSection={selectSection} imageEvidence={showingAidStationSections || showingCustomSections ? new Map() : imageEvidence} onSelectImage={(image) => updateViewState({ selectedImage: image })} terrainEvidenceState={terrainEvidenceState} sectionKind={showingAidStationSections ? "Aid Station Section" : showingCustomSections ? "Custom Section" : "Route Section"} sectionLabels={showingAidStationSections ? aidStationSections.labels : showingCustomSections && customSections.available ? customSections.labels : undefined} emptyMessage={showingCustomSections && !customSections.available ? "Enter valid custom boundaries to display sections." : undefined} />
        </div>
      </section>

      <KeyRouteMoments moments={keyMoments} routePoints={analysis.points} totalDistanceM={analysis.metrics.distanceKm * 1000} selectedMoment={selectedMoment} onSelect={selectMoment} />
      <RouteTakeaways analysis={analysis} />

      <TerrainImageViewer image={selectedImage} onClose={() => updateViewState({ selectedImage: null })} />
    </>
  );
}

function unknownMapillaryEvidence(requests: ReturnType<typeof buildMapillaryRequests>): MapillaryTerrainProofData {
  return {
    source: { type: "mapillary", name: "Mapillary", attribution: "© Mapillary" },
    sections: requests.map(({ id }) => ({ id, availability: "unknown", images: [], note: "Terrain imagery could not be loaded for this section." })),
  };
}

function isPersistedOsm(value: PersistedOsmEnrichmentRecord | GeoEnrichmentData): value is PersistedOsmEnrichmentRecord {
  return "mergedData" in value;
}

function withOsmConflicts(record: PersistedOsmEnrichmentRecord): GeoEnrichmentData {
  return { ...record.mergedData, conflicts: record.conflicts };
}

function isPersistedMapillary(value: PersistedMapillaryEnrichmentRecord | MapillaryTerrainProofData): value is PersistedMapillaryEnrichmentRecord {
  return "data" in value && "schemaVersion" in value;
}
