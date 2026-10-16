"use client";

import { useMemo, useRef, useState } from "react";
import CourseAnalysis from "./CourseAnalysis";
import CourseExplorer from "./CourseExplorer";
import CourseBriefView from "./CourseBriefView";
import RouteSectionBrowser, { RouteSectionBrowserHeading } from "./RouteSectionBrowser";
import TerrainEvidenceAction from "./TerrainEvidenceAction";
import KeyMoment from "./KeyMoment";
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

  function selectMoment(title: string) {
    setSelectedSectionKey(null);
    setSelectedMoment(title);
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
          <p className="text-xs font-semibold uppercase tracking-[0.22em] text-[#71805d]">GPX-derived route analysis</p>
          <h2 className="mt-3 break-words text-3xl font-semibold tracking-[-0.035em] sm:text-4xl">{analysis.name}</h2>
          <p className="mt-3 text-sm text-black/45">Route structure and metrics are calculated locally from the selected GPX file.</p>
          <div className="mt-8 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
            <Metric label="Distance" value={`${analysis.metrics.distanceKm.toFixed(2)} km`} />
            <Metric label="Elevation gain" value={`${analysis.metrics.elevationGainM.toLocaleString("en-US")} m`} />
            <Metric label="Elevation loss" value={`${analysis.metrics.elevationLossM.toLocaleString("en-US")} m`} />
            <Metric label="Highest point" value={`${Math.round(analysis.metrics.highestPointM).toLocaleString("en-US")} m`} />
            <Metric label="Lowest point" value={`${Math.round(analysis.metrics.lowestPointM).toLocaleString("en-US")} m`} />
          </div>
          <CourseExplorer selectedMoment={selectedMoment} selectedSectionKey={selectedSectionKey} onSelectSection={selectSection} routeName={analysis.name} routeAnalysis={analysis} keyMoments={analysis.keyMoments} loading={false} error="" showExtendedMetrics />
          <CourseBriefView routeAnalysis={analysis} routeKey={routeFingerprint?.routeFingerprint ?? analysis.name} />
        </div>
      </section>

      <section className="bg-white">
        <div className="mx-auto max-w-7xl px-6 py-16 lg:px-10 lg:py-20">
          <RouteSectionBrowserHeading action={TERRAIN_INTELLIGENCE_V1_ENABLED ? (
            <TerrainEvidenceAction state={terrainEvidenceState} onCheck={() => void loadEvidence()} />
          ) : undefined} />
          <RouteSectionBrowser sections={displayedSections} gradientIntelligence={analysis.gradientIntelligence} selectedSectionKey={selectedSectionKey} onSelectSection={selectSection} imageEvidence={imageEvidence} onSelectImage={setSelectedImage} terrainEvidenceState={terrainEvidenceState} />
        </div>
      </section>

      <section className="bg-[#f4f2ed]">
        <div className="mx-auto max-w-7xl px-6 py-16 lg:px-10 lg:py-20">
          <SectionHeading eyebrow="GPX-derived facts · independent of section boundaries" title="Key Route Moments" />
          <div className="grid gap-8 md:grid-cols-2 xl:grid-cols-3">
            {analysis.keyMoments.map((moment) => (
              <div key={moment.id} className="rounded-3xl border border-black/10 bg-white p-6">
                <KeyMoment title={moment.title} distance={moment.distance} gain={moment.gain} loss={moment.loss} text={moment.text} source={moment.source} onSelect={() => selectMoment(moment.title)} compact />
              </div>
            ))}
          </div>
        </div>
      </section>

      <CourseAnalysis analysis={analysis.metrics} sourceDescription="the GPX file selected in this browser" sourceLabel="GPX-derived" showExtendedMetrics />
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

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="rounded-2xl border border-black/10 bg-white p-4 sm:p-5"><p className="text-[10px] uppercase tracking-[0.15em] text-black/40 sm:text-xs">{label}</p><p className="mt-2 break-words text-xl font-semibold sm:text-2xl">{value}</p></div>;
}

function SectionHeading({ eyebrow, title }: { eyebrow: string; title: string }) {
  return <div className="mb-8"><p className="text-xs font-semibold uppercase tracking-[0.25em] text-[#71805d]">{eyebrow}</p><h2 className="mt-3 text-3xl font-semibold tracking-[-0.035em] sm:text-4xl">{title}</h2></div>;
}
