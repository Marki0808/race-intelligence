"use client";

import { useMemo, useState } from "react";
import CourseAnalysis from "./CourseAnalysis";
import CourseExplorer from "./CourseExplorer";
import KeyMoment from "./KeyMoment";
import type { GeoEnrichmentData } from "./geoEnrichment";
import { thinRouteForMatching } from "./geoEnrichment";
import type { RouteAnalysisData } from "./gpxAnalysis";
import type { MapillaryImageEvidence, MapillarySectionEvidence, MapillaryTerrainProofData } from "./mapillaryTerrainProof";
import TerrainImageViewer from "./TerrainImageViewer";
import TerrainSectionMap from "./TerrainSectionMap";
import { attachTerrainEvidenceToRouteSections } from "./routeEvidenceAdapter";
import { sortRouteEmbeddedEventsForDisplay, type RouteSection } from "./routeSectionEngine";
import { getRouteImageryPresentation, getSurfaceEvidencePresentation } from "./routeSectionPresentation";
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
  const [geoEvidence, setGeoEvidence] = useState<GeoEnrichmentData | null>(() => sharedCache?.osm?.mergedData ?? null);
  const [geoLoading, setGeoLoading] = useState(false);
  const [mapillaryEvidence, setMapillaryEvidence] = useState<MapillaryTerrainProofData | null>(() => sharedCache?.mapillary
    ? mapMapillaryEvidenceToSections(sharedCache.mapillary, analysis.routeSections)
    : null);
  const [selectedImage, setSelectedImage] = useState<MapillaryImageEvidence | null>(null);

  const displayedSections = useMemo(() => geoEvidence
    ? attachTerrainEvidenceToRouteSections(analysis.routeSections, geoEvidence)
    : analysis.routeSections, [analysis.routeSections, geoEvidence]);
  const imageEvidence = useMemo(() => new Map(mapillaryEvidence?.sections.map((section) => [section.id, section]) ?? []), [mapillaryEvidence]);

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
            setGeoEvidence(record?.mergedData ?? sharedResult.osm as GeoEnrichmentData);
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

      if (!shouldRefresh && cachedOsm?.classifiableRanges.length) setGeoEvidence(cachedOsm.mergedData);
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
          body: JSON.stringify({ points: thinRouteForMatching(analysis.points).map(({ latitude, longitude, distanceM }) => ({ latitude, longitude, distanceM })) }),
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
            setGeoEvidence(merged.mergedData);
          }
        } catch {
          setGeoEvidence(cachedOsm?.mergedData ?? osmResult);
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
          <CourseExplorer selectedMoment={selectedMoment} routeName={analysis.name} routeAnalysis={analysis} keyMoments={analysis.keyMoments} loading={false} error="" showExtendedMetrics />
        </div>
      </section>

      <section className="bg-white">
        <div className="mx-auto max-w-7xl px-6 py-16 lg:px-10 lg:py-20">
          <SectionHeading eyebrow="GPX-derived · primary route segmentation" title="Route Sections" />
          <div className="mb-8 flex flex-wrap items-center justify-between gap-4">
            <p className="max-w-2xl text-sm leading-6 text-black/50">Longer stretches with a stable running rhythm. Map evidence enriches each section when available; it does not set section boundaries.</p>
            <button type="button" onClick={() => void loadEvidence()} disabled={geoLoading} className="rounded-full bg-[#17211c] px-5 py-3 text-sm font-semibold text-white transition hover:bg-[#2b3a31] disabled:opacity-60">
              {geoLoading ? "Checking optional map evidence…" : geoEvidence || mapillaryEvidence ? "Refresh map evidence" : "Check optional map evidence"}
            </button>
          </div>
          {analysis.routeSections.length ? (
            <div className="space-y-5">
              {displayedSections.map((section) => (
                <RouteSectionCard key={section.id} section={section} imageEvidence={imageEvidence.get(section.id) ?? null} onSelectImage={setSelectedImage} />
              ))}
            </div>
          ) : <p className="text-sm text-black/45">No stable route rhythm could be distinguished from this GPX elevation profile.</p>}
        </div>
      </section>

      <section className="bg-[#f4f2ed]">
        <div className="mx-auto max-w-7xl px-6 py-16 lg:px-10 lg:py-20">
          <SectionHeading eyebrow="GPX-derived facts · independent of section boundaries" title="Key Route Moments" />
          <div className="grid gap-8 md:grid-cols-2 xl:grid-cols-3">
            {analysis.keyMoments.map((moment) => (
              <div key={moment.id} className="rounded-3xl border border-black/10 bg-white p-6">
                <KeyMoment title={moment.title} distance={moment.distance} gain={moment.gain} loss={moment.loss} text={moment.text} source={moment.source} onSelect={() => setSelectedMoment(moment.title)} compact />
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

function RouteSectionCard({
  section,
  imageEvidence,
  onSelectImage,
}: {
  section: RouteSection;
  imageEvidence: MapillarySectionEvidence | null;
  onSelectImage: (image: MapillaryImageEvidence) => void;
}) {
  const title: Record<RouteSection["dominantRhythm"], string> = {
    climb: "Climb",
    descent: "Descent",
    rolling: "Rolling",
    flat: "Flat",
  };
  const surface = getSurfaceEvidencePresentation(section, section.terrainEvidenceCoveragePercent !== undefined);
  const imagery = getRouteImageryPresentation(imageEvidence);
  return (
    <article className="rounded-3xl border border-black/10 bg-[#f4f2ed] p-6 sm:p-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#71805d]">Route Section {section.id.replace("route-section-", "")}</p>
          <h3 className="mt-2 text-2xl font-semibold">{title[section.dominantRhythm]} · {section.startKm}–{section.endKm} km</h3>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-black/55">{section.description}</p>
        </div>
        <span className="rounded-full border border-black/10 bg-white px-3 py-1.5 text-xs text-black/55">{section.distanceKm} km</span>
      </div>
      <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <SectionMetric label="Ascent" value={`+${section.ascentM} m`} />
        <SectionMetric label="Descent" value={`−${section.descentM} m`} />
        <SectionMetric label="Elevation range" value={`${section.elevationMinM}–${section.elevationMaxM} m`} />
        <SectionMetric label="Running rhythm" value={title[section.dominantRhythm]} />
      </div>
      <MiniProfile section={section} />
      {section.embeddedEvents.length > 0 && (
        <details className="mt-5 rounded-2xl border border-black/10 bg-white/75 p-4">
          <summary className="cursor-pointer text-sm font-semibold">Notable changes within this section ({section.embeddedEvents.length})</summary>
          <ul className="mt-3 space-y-2 text-sm text-black/55">
            {sortRouteEmbeddedEventsForDisplay(section.embeddedEvents).map((event) => <li key={event.id}>{event.startKm}–{event.endKm} km · {event.distanceKm} km {event.rhythm} · +{event.ascentM} m / −{event.descentM} m</li>)}
          </ul>
        </details>
      )}
      <div className="mt-6 border-t border-black/10 pt-5">
        <SectionSubheading>Section map · GPX-derived</SectionSubheading>
        <TerrainSectionMap points={section.mapData ?? []} startDistanceKm={section.startKm} endDistanceKm={section.endKm} />
      </div>
      <section className="mt-6 min-w-0 border-t border-black/10 pt-5" aria-label="Surface evidence">
        <SectionSubheading>Surface evidence · OpenStreetMap</SectionSubheading>
        {surface.status === "mapped" ? (
          <div className="mt-2">
            <p className="text-sm font-medium text-black/70">{surface.coverageLabel}</p>
            <p className="mt-3 text-xs text-black/45">{surface.distributionLabel}</p>
            <ul className="mt-2 grid grid-cols-1 gap-x-6 gap-y-1.5 text-sm text-black/60 sm:grid-cols-2">
              {surface.categories.map((item) => <li key={item.label} className="flex min-w-0 justify-between gap-3"><span className="truncate">{item.label}</span><span className="shrink-0 tabular-nums">{item.sharePercent}%</span></li>)}
            </ul>
            <p className="mt-3 text-[11px] text-black/35">© OpenStreetMap contributors</p>
          </div>
        ) : <p className="mt-2 text-sm text-black/45">{surface.message}</p>}
      </section>
      {imagery && (
        <section className="mt-6 min-w-0 border-t border-black/10 pt-5" aria-label="Route imagery">
          <SectionSubheading>Route imagery · Mapillary</SectionSubheading>
          {imagery.status === "available" ? (
            <>
              <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                {imagery.images.map((image) => (
                  <button key={image.id} type="button" onClick={() => onSelectImage(image)} aria-label={`Open Mapillary image around ${image.distanceAlongRouteKm.toFixed(2)} km`} className="group min-w-0 overflow-hidden rounded-xl border border-black/10 bg-white text-left transition hover:border-[#71805d] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#71805d]">
                    <span className="block aspect-[4/3] bg-[#e7e8e2] bg-cover bg-center" style={image.thumbnailUrl ? { backgroundImage: `url("${image.thumbnailUrl}")` } : undefined} />
                    <span className="block truncate px-2.5 py-2 text-xs text-black/55">~{image.distanceAlongRouteKm.toFixed(2)} km · © Mapillary</span>
                  </button>
                ))}
              </div>
              <p className="mt-2 text-[11px] text-black/35">© Mapillary</p>
            </>
          ) : <p className="mt-2 text-sm text-black/40">{imagery.message}</p>}
        </section>
      )}
    </article>
  );
}

function MiniProfile({ section }: { section: RouteSection }) {
  const width = 900;
  const height = 100;
  const points = section.elevationProfile;
  if (points.length < 2) return null;
  const elevations = points.map((point) => point.elevationM);
  const min = Math.min(...elevations);
  const max = Math.max(...elevations);
  const range = Math.max(1, max - min);
  const line = points.map((point, index) => {
    const x = (index / (points.length - 1)) * width;
    const y = height - ((point.elevationM - min) / range) * (height - 8) - 4;
    return `${x},${y}`;
  }).join(" ");
  return <svg viewBox={`0 0 ${width} ${height}`} className="mt-6 h-20 w-full rounded-xl bg-white/70 p-2" preserveAspectRatio="none" role="img" aria-label={`${section.dominantRhythm} elevation profile for ${section.startKm} to ${section.endKm} km`}><polyline points={line} fill="none" stroke="#71805d" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" /></svg>;
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

function isPersistedMapillary(value: PersistedMapillaryEnrichmentRecord | MapillaryTerrainProofData): value is PersistedMapillaryEnrichmentRecord {
  return "data" in value && "schemaVersion" in value;
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="rounded-2xl border border-black/10 bg-white p-4 sm:p-5"><p className="text-[10px] uppercase tracking-[0.15em] text-black/40 sm:text-xs">{label}</p><p className="mt-2 break-words text-xl font-semibold sm:text-2xl">{value}</p></div>;
}

function SectionMetric({ label, value }: { label: string; value: string }) {
  return <div><p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-black/40">{label}</p><p className="mt-1 text-sm font-semibold text-black/70">{value}</p></div>;
}

function SectionHeading({ eyebrow, title }: { eyebrow: string; title: string }) {
  return <div className="mb-8"><p className="text-xs font-semibold uppercase tracking-[0.25em] text-[#71805d]">{eyebrow}</p><h2 className="mt-3 text-3xl font-semibold tracking-[-0.035em] sm:text-4xl">{title}</h2></div>;
}

function SectionSubheading({ children }: { children: string }) {
  return <h4 className="text-[10px] font-semibold uppercase tracking-[0.15em] text-black/40">{children}</h4>;
}
