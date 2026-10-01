"use client";

import { useMemo, useState } from "react";
import CourseAnalysis from "./CourseAnalysis";
import CourseExplorer from "./CourseExplorer";
import KeyMoment from "./KeyMoment";
import type { GeoEnrichmentData } from "./geoEnrichment";
import { thinRouteForMatching } from "./geoEnrichment";
import type { RouteAnalysisData } from "./gpxAnalysis";
import type { MapillaryImageEvidence, MapillarySectionEvidence, MapillaryTerrainProofData, MapillaryTerrainSectionRequest } from "./mapillaryTerrainProof";
import TerrainImageViewer from "./TerrainImageViewer";
import TerrainSectionMap from "./TerrainSectionMap";
import { attachTerrainEvidenceToRouteSections } from "./routeEvidenceAdapter";
import type { RouteSection } from "./routeSectionEngine";

export default function RouteAnalysisView({ analysis }: { analysis: RouteAnalysisData }) {
  const [selectedMoment, setSelectedMoment] = useState<string | null>(null);
  const [geoEvidence, setGeoEvidence] = useState<GeoEnrichmentData | null>(null);
  const [geoLoading, setGeoLoading] = useState(false);
  const [mapillaryEvidence, setMapillaryEvidence] = useState<MapillaryTerrainProofData | null>(null);
  const [selectedImage, setSelectedImage] = useState<MapillaryImageEvidence | null>(null);

  const displayedSections = useMemo(() => geoEvidence
    ? attachTerrainEvidenceToRouteSections(analysis.routeSections, geoEvidence)
    : analysis.routeSections, [analysis.routeSections, geoEvidence]);
  const imageEvidence = useMemo(() => new Map(mapillaryEvidence?.sections.map((section) => [section.id, section]) ?? []), [mapillaryEvidence]);

  async function loadEvidence() {
    if (geoLoading) return;
    setGeoLoading(true);
    const requests = buildMapillaryRequests(analysis.routeSections, analysis.points);
    const [osmResult, imageryResult] = await Promise.allSettled([
      fetch("/api/geo-enrichment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ points: thinRouteForMatching(analysis.points).map(({ latitude, longitude, distanceM }) => ({ latitude, longitude, distanceM })) }),
      }),
      fetch("/api/mapillary", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sections: requests }),
      }),
    ]);
    try {
      if (osmResult.status === "fulfilled" && osmResult.value.ok) {
        setGeoEvidence(await osmResult.value.json() as GeoEnrichmentData);
      } else setGeoEvidence(unknownGeoEvidence());
    } catch {
      setGeoEvidence(unknownGeoEvidence());
    }
    try {
      if (imageryResult.status === "fulfilled" && imageryResult.value.ok) {
        setMapillaryEvidence(await imageryResult.value.json() as MapillaryTerrainProofData);
      } else setMapillaryEvidence(unknownMapillaryEvidence(requests));
    } catch {
      setMapillaryEvidence(unknownMapillaryEvidence(requests));
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
                <RouteSectionCard key={section.id} section={section} imageEvidence={imageEvidence.get(section.id) ?? null} selectedImage={selectedImage} onSelectImage={setSelectedImage} />
              ))}
            </div>
          ) : <p className="text-sm text-black/45">No stable route rhythm could be distinguished from this GPX elevation profile.</p>}
          {(geoEvidence || mapillaryEvidence) && (
            <div className="mt-6 flex flex-wrap gap-4 text-xs text-black/45">
              <span>OSM · {geoEvidence?.availability ?? "pending"}{geoEvidence?.retrieval ? ` · ${geoEvidence.retrieval.retrievalCoveragePercent}% retrieval coverage` : ""}</span>
              <span>Mapillary · {mapillaryEvidence?.sections.some((section) => section.availability === "available") ? "evidence available" : mapillaryEvidence ? "no imagery available" : "pending"}</span>
              <span>© OpenStreetMap contributors · © Mapillary</span>
            </div>
          )}
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
  selectedImage,
  onSelectImage,
}: {
  section: RouteSection;
  imageEvidence: MapillarySectionEvidence | null;
  selectedImage: MapillaryImageEvidence | null;
  onSelectImage: (image: MapillaryImageEvidence) => void;
}) {
  const title: Record<RouteSection["dominantRhythm"], string> = {
    climb: "Climb",
    descent: "Descent",
    rolling: "Rolling",
    flat: "Flat",
  };
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
          <summary className="cursor-pointer text-sm font-semibold">Embedded elevation events ({section.embeddedEvents.length})</summary>
          <ul className="mt-3 space-y-2 text-sm text-black/55">
            {section.embeddedEvents.map((event) => <li key={event.id}>{event.startKm}–{event.endKm} km · {event.rhythm} · +{event.ascentM} m / −{event.descentM} m</li>)}
          </ul>
        </details>
      )}
      <div className="mt-5 grid gap-4 border-t border-black/10 pt-5 sm:grid-cols-2">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.15em] text-black/40">OpenStreetMap · optional evidence</p>
          {section.terrainEvidence?.length ? (
            <p className="mt-2 text-sm text-black/60">{section.terrainEvidence.map((item) => `${terrainLabel(item.terrain)} · ${item.coveragePercent}%`).join(" · ")}</p>
          ) : <p className="mt-2 text-sm text-black/40">{section.terrainEvidence ? "No classifiable surface evidence overlaps this section." : "Not requested"}</p>}
        </div>
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.15em] text-black/40">Mapillary · independent imagery evidence</p>
          <p className="mt-2 text-sm text-black/60">{imageEvidence?.availability ?? "Not requested"}{imageEvidence?.availability === "available" ? ` · ${imageEvidence.images.length} photo${imageEvidence.images.length === 1 ? "" : "s"} · © Mapillary` : imageEvidence?.note ? ` · ${imageEvidence.note}` : ""}</p>
        </div>
      </div>
      {imageEvidence?.images.length && section.mapData && section.mapData.length >= 2 ? (
        <TerrainSectionMap points={section.mapData} images={imageEvidence.images} startDistanceKm={section.startKm} endDistanceKm={section.endKm} selectedImage={selectedImage} onSelectImage={onSelectImage} />
      ) : null}
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

function buildMapillaryRequests(sections: RouteSection[], points: RouteAnalysisData["points"]): MapillaryTerrainSectionRequest[] {
  return sections.map((section) => {
    const startM = section.startKm * 1000;
    const endM = section.endKm * 1000;
    const matching = points.filter((point) => point.distanceM >= startM && point.distanceM <= endM);
    const endpoints = [nearestPoint(points, startM), nearestPoint(points, endM)].filter((point): point is RouteAnalysisData["points"][number] => point !== null);
    const combined = [...new Map([...matching, ...endpoints].map((point) => [point.distanceM, point])).values()].sort((a, b) => a.distanceM - b.distanceM);
    const sampled = thinRouteForMatching(combined, 120).map(({ latitude, longitude, distanceM }) => ({ latitude, longitude, distanceM }));
    return { id: section.id, startDistanceKm: section.startKm, endDistanceKm: section.endKm, points: sampled };
  }).filter((section) => section.points.length >= 2);
}

function nearestPoint(points: RouteAnalysisData["points"], distanceM: number) {
  return points.reduce<RouteAnalysisData["points"][number] | null>((nearest, point) => !nearest || Math.abs(point.distanceM - distanceM) < Math.abs(nearest.distanceM - distanceM) ? point : nearest, null);
}

function unknownGeoEvidence(): GeoEnrichmentData {
  return {
    source: { type: "osm", name: "OpenStreetMap", attribution: "© OpenStreetMap contributors" },
    availability: "unknown", segments: [], matchedRoutePercent: 0,
    note: "OpenStreetMap terrain evidence is currently unavailable for this route.",
    attribution: "© OpenStreetMap contributors",
  };
}

function unknownMapillaryEvidence(requests: MapillaryTerrainSectionRequest[]): MapillaryTerrainProofData {
  return {
    source: { type: "mapillary", name: "Mapillary", attribution: "© Mapillary" },
    sections: requests.map(({ id }) => ({ id, availability: "unknown", images: [], note: "Terrain imagery could not be loaded for this section." })),
  };
}

function terrainLabel(value: string) {
  const labels: Record<string, string> = { paved: "Paved", gravel: "Gravel", "dirt-ground": "Dirt / ground", "rocky-rough": "Rocky", "natural-trail": "Natural trail", "mixed-trail": "Mixed trail" };
  return labels[value] ?? value;
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
