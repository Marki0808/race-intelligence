"use client";

import { useMemo, useRef, useState, type Ref } from "react";
import CourseExplorer from "./CourseExplorer";
import { DEFAULT_ROUTE_MAP_MODE, resolveRouteMapModeForAnalysis, type RouteMapMode } from "./route-map-mode";
import ClimbingProfile from "./ClimbingProfile";
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
import { buildAidStationSections } from "./aidStationSections";
import CustomSectionControls from "./CustomSectionControls";
import { appendCustomSectionBoundary, buildCustomRouteSections, createCustomSectionPlan, insertProfileCustomBoundary, removeCustomSectionBoundary, undoLastProfileBoundary, type CustomSectionPlan } from "./customRouteSections";
import { buildGradientIntelligenceV1 } from "./gradientIntelligence";
import { buildRouteNarrativeRouteContextV2 } from "./routeNarrativePhases";
import { useRouteUnits } from "./RouteUnitPreference";
import { trackSafeAnalyticsEvent } from "./analyticsClient";
import { formatDistanceMeters } from "./routeUnits";

export default function RouteAnalysisView({
  analysis,
  routeFingerprint,
  persistenceScope = "local",
  sharedCache = null,
  analysisHeadingRef,
}: {
  analysis: RouteAnalysisData;
  routeFingerprint?: RouteFingerprintResult;
  persistenceScope?: "local" | "shared";
  sharedCache?: SharedRouteCache | null;
  analysisHeadingRef?: Ref<HTMLHeadingElement>;
}) {
  const { units } = useRouteUnits();
  type ViewState = { analysis: RouteAnalysisData; selectedMoment: string | null; selectedSectionKey: string | null; segmentationMode: "terrain" | "custom" | "aid-station"; selectedImage: MapillaryImageEvidence | null; mapMode: RouteMapMode };
  const [viewState, setViewState] = useState<ViewState>(() => ({ analysis, selectedMoment: null, selectedSectionKey: null, segmentationMode: "terrain", selectedImage: null, mapMode: DEFAULT_ROUTE_MAP_MODE }));
  const currentViewState = viewState.analysis === analysis ? viewState : { analysis, selectedMoment: null, selectedSectionKey: null, segmentationMode: "terrain" as const, selectedImage: null, mapMode: resolveRouteMapModeForAnalysis(viewState.analysis, analysis, viewState.mapMode) };
  const { selectedMoment, selectedSectionKey, segmentationMode, selectedImage, mapMode } = currentViewState;
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
  const [profileEditorState, setProfileEditorState] = useState(() => ({ analysis, active: false, status: "" }));
  const [profileBoundaryUndoIds, setProfileBoundaryUndoIds] = useState<string[]>([]);
  const profileBoundaryEditing = profileEditorState.analysis === analysis && profileEditorState.active;
  const profileBoundaryStatus = profileEditorState.analysis === analysis ? profileEditorState.status : "";
  const routeDistanceM = analysis.points.at(-1)?.distanceM ?? 0;
  const customSections = useMemo(() => buildCustomRouteSections(analysis, customPlan, units), [analysis, customPlan, units]);
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
      ...(current.analysis === analysis ? current : { analysis, selectedMoment: null, selectedSectionKey: null, segmentationMode: "terrain" as const, selectedImage: null, mapMode: DEFAULT_ROUTE_MAP_MODE }),
      ...patch,
      analysis,
    }));
  }

  function updateCustomPlan(plan: CustomSectionPlan) {
    setCustomPlanState({ analysis, plan });
  }

  function addCustomBoundary() {
    const nextPlan = appendCustomSectionBoundary(customPlan, routeDistanceM);
    if (profileBoundaryEditing && nextPlan !== customPlan) {
      const added = nextPlan.boundaries.find((boundary) => !customPlan.boundaries.some((existing) => existing.id === boundary.id));
      if (added) setProfileBoundaryUndoIds((ids) => [...ids, added.id]);
    }
    updateCustomPlan(nextPlan);
  }

  function startProfileBoundaryEditing() {
    updateViewState({ segmentationMode: "custom", selectedSectionKey: null, selectedMoment: null });
    setProfileBoundaryUndoIds([]);
    setProfileEditorState({ analysis, active: true, status: "Profile boundary selection is on. Click or tap the elevation profile to add a boundary." });
  }

  function stopProfileBoundaryEditing() {
    setProfileBoundaryUndoIds([]);
    setProfileEditorState({ analysis, active: false, status: "Profile boundary selection is off." });
  }

  function addProfileBoundary(distanceM: number) {
    const result = insertProfileCustomBoundary(customPlan, routeDistanceM, distanceM);
    if (result.status === "added") {
      updateCustomPlan(result.plan);
      const added = result.plan.boundaries.find((boundary) => !customPlan.boundaries.some((existing) => existing.id === boundary.id));
      if (added) setProfileBoundaryUndoIds((ids) => [...ids, added.id]);
      setProfileEditorState({ analysis, active: true, status: `Boundary added at ${formatDistanceMeters(result.distanceKm * 1000, units)}. ${result.plan.boundaries.length} custom ${result.plan.boundaries.length === 1 ? "boundary" : "boundaries"}.` });
      return;
    }
    const messages = {
      "invalid-route": "A boundary cannot be added because route distance is unavailable.",
      "invalid-distance": "That profile position is unavailable. Choose a point inside the chart.",
      endpoint: "Start and Finish are fixed; choose an interior point on the route.",
      "too-close": "Choose a point farther from Start, Finish, and the other boundaries.",
      limit: "You have reached the limit of 20 custom boundaries.",
    } as const;
    setProfileEditorState({ analysis, active: true, status: messages[result.status] });
  }

  function removeProfileBoundary(boundaryId: string) {
    const result = removeCustomSectionBoundary(customPlan, boundaryId);
    if (!result.removed) return;
    updateCustomPlan(result.plan);
    setProfileBoundaryUndoIds((ids) => ids.filter((id) => id !== boundaryId));
    setProfileEditorState({ analysis, active: true, status: `Boundary at ${formatDistanceMeters(Number(result.removed.distanceKm) * 1000, units)} removed.` });
  }

  function undoProfileBoundary() {
    const result = undoLastProfileBoundary(customPlan, profileBoundaryUndoIds);
    setProfileBoundaryUndoIds(result.history);
    if (!result.removed) return;
    updateCustomPlan(result.plan);
    setProfileEditorState({ analysis, active: true, status: `Last added boundary at ${formatDistanceMeters(Number(result.removed.distanceKm) * 1000, units)} undone.` });
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
      <section className="bg-transparent">
        <div className="route-analysis-content py-3 sm:py-4 lg:py-5">
          <CourseExplorer
            className="mt-4 sm:mt-6"
            selectedMoment={selectedMoment}
            selectedSectionKey={selectedSectionKey}
            selectionSections={activeSections}
            sectionKind={showingAidStationSections ? "Aid Station Section" : showingCustomSections ? "Custom Section" : "Route Section"}
            onSelectSection={selectSection}
            routeName={analysis.name}
            heading="GPX Route Analysis"
            headingRef={analysisHeadingRef}
            eyebrow="YOUR ROUTE · GPX-DERIVED"
            supportingText="Route structure and measurements are calculated locally from the GPX file selected in this browser."
            routeAnalysis={analysis}
            keyMoments={keyMoments}
            loading={false}
            error=""
            showExtendedMetrics
            showUnitToggle
            profileBoundaryEditing={profileBoundaryEditing}
            profileBoundaryStatus={profileBoundaryStatus}
            canUndoProfileBoundary={profileBoundaryUndoIds.some((id) => customPlan.boundaries.some((boundary) => boundary.id === id))}
            customBoundaries={customPlan.boundaries}
            showCustomBoundaries={showingCustomSections}
            onStartProfileBoundaryEditing={startProfileBoundaryEditing}
            onStopProfileBoundaryEditing={stopProfileBoundaryEditing}
            onAddProfileBoundary={addProfileBoundary}
            onRemoveProfileBoundary={removeProfileBoundary}
            onUndoProfileBoundary={undoProfileBoundary}
            mapMode={mapMode}
            onMapModeChange={(nextMapMode) => updateViewState({ mapMode: nextMapMode })}
          />
          <ClimbingProfile routeDynamics={analysis.routeDynamics} />
          <CourseBriefView routeAnalysis={analysis} routeKey={routeFingerprint?.routeFingerprint ?? analysis.name} units={units} />
        </div>
      </section>

      <section className="bg-transparent">
        <div className="route-analysis-content py-3 sm:py-4 lg:py-5">
          <div className="rounded-3xl bg-[#f8f7f3] px-4 py-6 sm:px-6 sm:py-8 lg:px-8 lg:py-10">
          <RouteSectionBrowserHeading controls={(
            <>
              <div className="mt-4 inline-flex flex-wrap rounded-full border border-black/10 bg-[#f4f2ed] p-1" role="group" aria-label="Route section view">
                <button type="button" aria-pressed={segmentationMode === "terrain" || (segmentationMode === "aid-station" && !showingAidStationSections)} onClick={() => { trackSafeAnalyticsEvent({ type: "sections_mode_selected", mode: "terrain" }); stopProfileBoundaryEditing(); updateViewState({ segmentationMode: "terrain", selectedSectionKey: null }); }} className={`min-h-10 rounded-full px-4 text-sm font-semibold transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#71805d] ${segmentationMode === "terrain" || (segmentationMode === "aid-station" && !showingAidStationSections) ? "bg-[#17211c] text-white" : "text-[var(--analysis-muted)] hover:bg-white"}`}>Terrain Sections</button>
                <button type="button" aria-pressed={showingCustomSections} onClick={() => { trackSafeAnalyticsEvent({ type: "sections_mode_selected", mode: "custom" }); stopProfileBoundaryEditing(); updateViewState({ segmentationMode: "custom", selectedSectionKey: null }); }} className={`min-h-10 rounded-full px-4 text-sm font-semibold transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#71805d] ${showingCustomSections ? "bg-[#17211c] text-white" : "text-[var(--analysis-muted)] hover:bg-white"}`}>Custom Sections</button>
                {aidStationSections.available && <button type="button" aria-label={aidStationSections.positionMode === "official-kilometer-approximate" ? `Aid Station Sections, boundaries use approximate official source positions displayed in ${units === "metric" ? "kilometers" : "miles"}` : "Aid Station Sections"} aria-pressed={showingAidStationSections} onClick={() => { stopProfileBoundaryEditing(); updateViewState({ segmentationMode: "aid-station", selectedSectionKey: null }); }} className={`min-h-10 rounded-full px-4 text-sm font-semibold transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#71805d] ${showingAidStationSections ? "bg-[#17211c] text-white" : "text-[var(--analysis-muted)] hover:bg-white"}`}>
                  {aidStationSections.positionMode === "official-kilometer-approximate" ? `Aid Station Sections · approx. ${units === "metric" ? "km" : "mi"}` : "Aid Station Sections"}
                </button>}
              </div>
              {showingCustomSections && <CustomSectionControls plan={customPlan} routeDistanceM={routeDistanceM} errors={customSections.available ? [] : customSections.errors} onChange={updateCustomPlan} onAdd={addCustomBoundary} />}
            </>
          )} action={TERRAIN_INTELLIGENCE_V1_ENABLED ? (
            <TerrainEvidenceAction state={terrainEvidenceState} onCheck={() => void loadEvidence()} />
          ) : undefined} />
          <RouteSectionBrowser sections={activeSections} routePoints={analysis.points} gradientIntelligence={activeGradientIntelligence} narrativeContext={routeNarrativeContext} selectedSectionKey={selectedSectionKey} onSelectSection={selectSection} imageEvidence={showingAidStationSections || showingCustomSections ? new Map() : imageEvidence} onSelectImage={(image) => updateViewState({ selectedImage: image })} terrainEvidenceState={terrainEvidenceState} sectionKind={showingAidStationSections ? "Aid Station Section" : showingCustomSections ? "Custom Section" : "Route Section"} sectionLabels={showingAidStationSections ? aidStationSections.labels : showingCustomSections && customSections.available ? customSections.labels : undefined} emptyMessage={showingCustomSections && !customSections.available ? "Enter valid custom boundaries to display sections." : undefined} mapMode={mapMode} onMapModeChange={(nextMapMode) => updateViewState({ mapMode: nextMapMode })} />
          </div>
        </div>
      </section>

      <KeyRouteMoments moments={keyMoments} routePoints={analysis.points} totalDistanceM={analysis.metrics.distanceKm * 1000} selectedMoment={selectedMoment} onSelect={selectMoment} />
      <TerrainImageViewer image={selectedImage} onClose={() => updateViewState({ selectedImage: null })} units={units} />
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
