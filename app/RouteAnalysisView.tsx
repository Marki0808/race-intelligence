"use client";

import { useMemo, useState } from "react";
import CourseAnalysis from "./CourseAnalysis";
import CourseExplorer from "./CourseExplorer";
import CourseBriefView from "./CourseBriefView";
import RouteSectionBrowser, { RouteSectionBrowserHeading } from "./RouteSectionBrowser";
import KeyMoment from "./KeyMoment";
import type { GeoEnrichmentData } from "./geoEnrichment";
import { thinRouteForMatching } from "./geoEnrichment";
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
  const [mapillaryEvidence, setMapillaryEvidence] = useState<MapillaryTerrainProofData | null>(() => sharedCache?.mapillary
    ? mapMapillaryEvidenceToSections(sharedCache.mapillary, analysis.routeSections)
    : null);
  const [selectedImage, setSelectedImage] = useState<MapillaryImageEvidence | null>(null);

  const displayedSections = useMemo(() => geoEvidence
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
    if (geoLoading) return;
    setGeoLoading(true);
    try {
      let cachedOsm: PersistedOsmEnrichmentRecord | null = sharedCache?.osm ?? null;
      let cachedMapillary: PersistedMapillaryEnrichmentRecord | null = sharedCache?.mapillary ?? null;
      const shouldRefresh = geoEvidence !== null || mapillaryEvidence !== null;
      if (persistenceScope === "shared" && routeFingerprint) {
        if (!shouldRefresh && (cachedOsm?.classifiableRanges.length || (cachedMapillary && hasReusableMapillaryEvidence(cachedMapillary)))) return;
        try {
          const sharedResult = await enrichSharedRoute(routeFingerprint, {
            osm: shouldRefresh || !cachedOsm?.classifiableRanges.length,
            mapillary: shouldRefresh || !cachedMapillary || !hasReusableMapillaryEvidence(cachedMapillary),
          });
          if (sharedResult.osm) {
            const record = isPersistedOsm(sharedResult.osm) ? sharedResult.osm : null;
            setGeoEvidence(record ? withOsmConflicts(record) : sharedResult.osm as GeoEnrichmentData);
          }
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

      if (!shouldRefresh && cachedOsm?.classifiableRanges.length) setGeoEvidence(withOsmConflicts(cachedOsm));
        if (!shouldRefresh && cachedMapillary && hasReusableMapillaryEvidence(cachedMapillary)) {
        setMapillaryEvidence(mapMapillaryEvidenceToSections(cachedMapillary, analysis.routeSections));
      }

      const requests = buildMapillaryRequests(analysis.routeSections, analysis.points);
      const requestOsm = !routeFingerprint || shouldRefresh || !cachedOsm?.classifiableRanges.length;
      const requestMapillary = !routeFingerprint || shouldRefresh || !cachedMapillary || !hasReusableMapillaryEvidence(cachedMapillary);
      const [osmResult, imageryResult] = await Promise.all([
        requestOsm ? fetch("/api/geo-enrichment", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ points: thinRouteForMatching(analysis.points).map(({ latitude, longitude, distanceM, segmentIndex }) => ({ latitude, longitude, distanceM, segmentIndex })) }),
        }).then(async (response) => response.ok ? await response.json() as GeoEnrichmentData : unknownGeoEvidence()).catch(() => unknownGeoEvidence()) : Promise.resolve(null),
        requestMapillary ? fetch("/api/mapillary", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sections: requests }),
        }).then(async (response) => response.ok ? await response.json() as MapillaryTerrainProofData : unknownMapillaryEvidence(requests)).catch(() => unknownMapillaryEvidence(requests)) : Promise.resolve(null),
      ]);

      if (osmResult) {
        try {
          if (!routeFingerprint) {
            setGeoEvidence(osmResult);
          } else {
            const merged = await cacheOsmEnrichment(browserRoutePersistence, routeFingerprint.routeFingerprint, osmResult, analysis.metrics.distanceKm, { routeFingerprintVersion: routeFingerprint.routeFingerprintVersion });
            setGeoEvidence(withOsmConflicts(merged));
          }
        } catch {
          setGeoEvidence(cachedOsm ? withOsmConflicts(cachedOsm) : osmResult);
        }
      }
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
    } finally {
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
          <RouteSectionBrowserHeading action={(
            <button type="button" onClick={() => void loadEvidence()} disabled={geoLoading} className="rounded-full bg-[#17211c] px-5 py-3 text-sm font-semibold text-white transition hover:bg-[#2b3a31] disabled:opacity-60">
              {geoLoading ? "Checking optional map evidence…" : geoEvidence || mapillaryEvidence ? "Refresh map evidence" : "Check optional map evidence"}
            </button>
          )} />
          <RouteSectionBrowser sections={displayedSections} gradientIntelligence={analysis.gradientIntelligence} selectedSectionKey={selectedSectionKey} onSelectSection={selectSection} imageEvidence={imageEvidence} onSelectImage={setSelectedImage} />
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

function unknownGeoEvidence(): GeoEnrichmentData {
  return {
    source: { type: "osm", name: "OpenStreetMap", attribution: "© OpenStreetMap contributors" },
    availability: "unknown", segments: [], matchedRoutePercent: 0,
    note: "OpenStreetMap terrain evidence is currently unavailable for this route.",
    attribution: "© OpenStreetMap contributors",
  };
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
