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
import RouteTakeaways from "./RouteTakeaways";

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
  const [selectedMoment, setSelectedMoment] = useState<string | null>(null);
  const [selectedSectionKey, setSelectedSectionKey] = useState<string | null>(null);
  const [geoEvidence, setGeoEvidence] = useState<GeoEnrichmentData | null>(() => sharedCache?.osm ? withOsmConflicts(sharedCache.osm) : null);
  const [geoLoading, setGeoLoading] = useState(false);
  const evidenceRequestActive = useRef(false);
  const [terrainEvidenceState, setTerrainEvidenceState] = useState<TerrainEvidenceState>(() => sharedCache?.osm ? "ready" : "not-requested");
  const [mapillaryEvidence, setMapillaryEvidence] = useState<MapillaryTerrainProofData | null>(() => sharedCache?.mapillary
    ? mapMapillaryEvidenceToSections(sharedCache.mapillary, analysis.routeSections)
    : null);
  const [selectedImage, setSelectedImage] = useState<MapillaryImageEvidence | null>(null);

  const displayedSections = useMemo(() => TERRAIN_INTELLIGENCE_V1_ENABLED && geoEvidence
    ? attachTerrainEvidenceToRouteSections(analysis.routeSections, geoEvidence)
    : analysis.routeSections, [analysis.routeSections, geoEvidence]);
  const imageEvidence = useMemo(
    () => mapillaryEvidenceByRouteSection(analysis.routeSections, mapillaryEvidence),
    [analysis.routeSections, mapillaryEvidence],
  );
  const keyMoments = useMemo(() => [
    ...analysis.keyMoments,
    ...buildSustainedGradientKeyMoments(analysis.gradientIntelligence, analysis.keyMoments),
  ], [analysis.keyMoments, analysis.gradientIntelligence]);

  function selectMoment(momentId: string) {
    setSelectedSectionKey(null);
    setSelectedMoment((current) => toggleKeyMomentSelection(current, momentId));
  }

  function selectSection(section: RouteSection | null) {
    setSelectedSectionKey(section ? routeSectionSelectionKey(section) : null);
    if (section) setSelectedMoment(null);
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
          <RouteSectionBrowserHeading action={TERRAIN_INTELLIGENCE_V1_ENABLED ? (
            <TerrainEvidenceAction state={terrainEvidenceState} onCheck={() => void loadEvidence()} />
          ) : undefined} />
          <RouteSectionBrowser sections={displayedSections} routePoints={analysis.points} gradientIntelligence={analysis.gradientIntelligence} selectedSectionKey={selectedSectionKey} onSelectSection={selectSection} imageEvidence={imageEvidence} onSelectImage={setSelectedImage} terrainEvidenceState={terrainEvidenceState} />
        </div>
      </section>

      <KeyRouteMoments moments={keyMoments} routePoints={analysis.points} totalDistanceM={analysis.metrics.distanceKm * 1000} selectedMoment={selectedMoment} onSelect={selectMoment} />
      <RouteTakeaways analysis={analysis} />

      <TerrainImageViewer image={selectedImage} onClose={() => setSelectedImage(null)} />
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
