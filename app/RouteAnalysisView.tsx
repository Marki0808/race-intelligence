"use client";

import { useMemo, useState } from "react";
import CourseAnalysis from "./CourseAnalysis";
import CourseCharacter from "./CourseCharacter";
import CourseExplorer from "./CourseExplorer";
import KeyMoment from "./KeyMoment";
import type { GeoEnrichmentData, EvidenceValue } from "./geoEnrichment";
import { thinRouteForMatching } from "./geoEnrichment";
import type { RouteAnalysisData, GpxRouteSegmentData } from "./gpxAnalysis";
import { aggregateTerrainEvidence } from "./terrainAggregation";
import type { TerrainCategory } from "./terrainAggregation";
import TerrainSectionMap from "./TerrainSectionMap";
import TerrainImageViewer from "./TerrainImageViewer";
import { getTerrainSummaryPresentation, terrainCategoryLabel } from "./terrainEvidencePresentation";
import type { MapillaryImageEvidence, MapillaryRoutePoint, MapillarySectionEvidence, MapillaryTerrainProofData, MapillaryTerrainSectionRequest } from "./mapillaryTerrainProof";

export default function RouteAnalysisView({
  analysis,
}: {
  analysis: RouteAnalysisData;
}) {
  const [selectedMoment, setSelectedMoment] = useState<string | null>(null);
  const [geoEvidence, setGeoEvidence] = useState<GeoEnrichmentData | null>(null);
  const [geoLoading, setGeoLoading] = useState(false);
  const [mapillaryEvidence, setMapillaryEvidence] = useState<MapillaryTerrainProofData | null>(null);
  const [selectedTerrainImage, setSelectedTerrainImage] = useState<MapillaryImageEvidence | null>(null);

  async function loadMapillaryEvidence(terrainSections: MapillaryTerrainSectionRequest[]) {
    if (!terrainSections.length) return;
    try {
      const response = await fetch("/api/mapillary", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sections: terrainSections }),
      });
      if (!response.ok) throw new Error("Mapillary lookup failed");
      setMapillaryEvidence(await response.json() as MapillaryTerrainProofData);
    } catch {
      setMapillaryEvidence({
        source: { type: "mapillary", name: "Mapillary", attribution: "© Mapillary" },
        sections: terrainSections.map(({ id }) => ({ id, availability: "unknown", images: [], note: "Terrain imagery could not be loaded for this section." })),
      });
    }
  }

  async function loadGeoEvidence() {
    setGeoLoading(true);
    try {
      const response = await fetch("/api/geo-enrichment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          points: thinRouteForMatching(analysis.points).map(({ latitude, longitude, distanceM }) => ({ latitude, longitude, distanceM })),
        }),
      });
      if (!response.ok) throw new Error("OSM lookup failed");
      const data = await response.json() as GeoEnrichmentData;
      setGeoEvidence(data);
      const sections = aggregateTerrainEvidence(data).sections.map((section) => ({
        id: section.id,
        startDistanceKm: section.startDistanceKm,
        endDistanceKm: section.endDistanceKm,
        points: getSectionRoutePoints(analysis.points, section.startDistanceKm, section.endDistanceKm),
      })).filter((section) => section.points.length >= 2);
      await loadMapillaryEvidence(sections);
    } catch {
      setGeoEvidence({
        source: { type: "osm", name: "OpenStreetMap", attribution: "© OpenStreetMap contributors" },
        availability: "unknown",
        segments: [],
        matchedRoutePercent: 0,
        note: "Terrain evidence is currently unavailable for this route.",
        attribution: "© OpenStreetMap contributors",
      });
    } finally {
      setGeoLoading(false);
    }
  }

  return (
    <>
      <section className="bg-[#f4f2ed]">
        <div className="mx-auto max-w-7xl px-6 py-16 lg:px-10 lg:py-20">
          <p className="text-xs font-semibold uppercase tracking-[0.22em] text-[#71805d]">
            GPX-derived route analysis
          </p>
          <h2 className="mt-3 break-words text-3xl font-semibold tracking-[-0.035em] sm:text-4xl">
            {analysis.name}
          </h2>
          <p className="mt-3 text-sm text-black/45">
            All metrics and sections below are calculated from the selected GPX file.
          </p>
          <div className="mt-8 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
            <Metric label="Distance" value={`${analysis.metrics.distanceKm.toFixed(2)} km`} />
            <Metric label="Elevation gain" value={`${analysis.metrics.elevationGainM.toLocaleString("en-US")} m`} />
            <Metric label="Elevation loss" value={`${analysis.metrics.elevationLossM.toLocaleString("en-US")} m`} />
            <Metric label="Highest point" value={`${Math.round(analysis.metrics.highestPointM).toLocaleString("en-US")} m`} />
            <Metric label="Lowest point" value={`${Math.round(analysis.metrics.lowestPointM).toLocaleString("en-US")} m`} />
          </div>

          <CourseExplorer
            selectedMoment={selectedMoment}
            routeName={analysis.name}
            routeAnalysis={analysis}
            keyMoments={analysis.keyMoments}
            loading={false}
            error=""
            showExtendedMetrics
          />
        </div>
      </section>

      <section className="bg-white">
        <div className="mx-auto max-w-7xl px-6 py-16 lg:px-10 lg:py-20">
          <section aria-labelledby="terrain-evidence-heading">
            <div className="flex flex-wrap items-end justify-between gap-5">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.22em] text-[#71805d]">
                  Map evidence · OpenStreetMap
                </p>
                <h2 id="terrain-evidence-heading" className="mt-3 text-3xl font-semibold tracking-[-0.035em] sm:text-4xl">
                  Terrain Evidence
                </h2>
                <p className="mt-3 max-w-2xl text-sm leading-6 text-black/50">
                  Mapped path tags are evidence from OpenStreetMap, not a prediction of trail conditions or personal difficulty.
                </p>
              </div>
              {!geoEvidence && (
                <button
                  type="button"
                  onClick={() => void loadGeoEvidence()}
                  disabled={geoLoading}
                  className="rounded-full bg-[#17211c] px-5 py-3 text-sm font-semibold text-white transition hover:bg-[#2b3a31] disabled:opacity-60"
                >
                  {geoLoading ? "Looking up map evidence…" : "Check OpenStreetMap"}
                </button>
              )}
            </div>
            {geoEvidence ? (
              <GeoEvidencePanel data={geoEvidence} routePoints={analysis.points} mapillary={mapillaryEvidence} selectedImage={selectedTerrainImage} onSelectImage={setSelectedTerrainImage} />
            ) : (
              <p className="mt-6 text-sm text-black/45">No map lookup has been requested for this route.</p>
            )}
          </section>
        </div>
      </section>

      <section className="bg-white">
        <div className="mx-auto max-w-7xl px-6 py-16 lg:px-10 lg:py-20">
          <SectionHeading eyebrow="GPX-derived" title="Key route moments" />
          <div className="grid gap-8 md:grid-cols-2 xl:grid-cols-3">
            {analysis.keyMoments.map((moment) => (
              <div
                key={moment.id}
                className="rounded-3xl border border-black/10 bg-[#f4f2ed] p-6"
              >
                <KeyMoment
                  title={moment.title}
                  distance={moment.distance}
                  gain={moment.gain}
                  loss={moment.loss}
                  text={moment.text}
                  source={moment.source}
                  onSelect={() => setSelectedMoment(moment.title)}
                  compact
                />
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="bg-[#f4f2ed]">
        <div className="mx-auto max-w-7xl px-6 py-16 lg:px-10 lg:py-20">
          <SectionHeading eyebrow="GPX-derived" title="Route sections" />
          <div className="mt-10 grid gap-8 lg:grid-cols-3">
            <SegmentGroup title="Major climbs" segments={analysis.majorClimbs} metric="gain" />
            <SegmentGroup title="Major descents" segments={analysis.majorDescents} metric="loss" />
            <SegmentGroup title="10 km route sections" segments={analysis.sections} metric="both" />
          </div>
        </div>
      </section>

      <section className="bg-white">
        <div className="mx-auto max-w-7xl px-6 py-16 lg:px-10 lg:py-20">
          <p className="mb-5 text-xs font-semibold uppercase tracking-[0.22em] text-[#71805d]">
            GPX-derived observations · terrain details not established by this file
          </p>
          <CourseCharacter data={analysis.courseCharacter} sourceLabel="GPX-derived" />
        </div>
      </section>

      <CourseAnalysis
        analysis={analysis.metrics}
        sourceDescription="the GPX file selected in this browser"
        sourceLabel="GPX-derived"
        showExtendedMetrics
      />
      <TerrainImageViewer image={selectedTerrainImage} onClose={() => setSelectedTerrainImage(null)} />
    </>
  );
}

function GeoEvidencePanel({
  data,
  routePoints,
  mapillary,
  selectedImage,
  onSelectImage,
}: {
  data: GeoEnrichmentData;
  routePoints: RouteAnalysisData["points"];
  mapillary: MapillaryTerrainProofData | null;
  selectedImage: MapillaryImageEvidence | null;
  onSelectImage: (image: MapillaryImageEvidence) => void;
}) {
  const aggregation = useMemo(() => aggregateTerrainEvidence(data), [data]);
  const routeSummary = getTerrainSummaryPresentation(aggregation);
  const sectionGeometry = useMemo(() => new Map(aggregation.sections.map((section) => [
    section.id,
    getSectionRoutePoints(routePoints, section.startDistanceKm, section.endDistanceKm),
  ])), [aggregation.sections, routePoints]);
  const imageEvidence = useMemo(() => new Map(mapillary?.sections.map((section) => [section.id, section]) ?? []), [mapillary]);
  const fields: Array<[string, keyof Pick<GeoEnrichmentData["segments"][number], "surface" | "pathType" | "trackCondition" | "smoothness" | "hikingDifficulty" | "trailVisibility" | "incline" | "width" | "informal" | "trailblazed" | "assistedTrail">]> = [
    ["Surface", "surface"],
    ["Path type", "pathType"],
    ["Track condition", "trackCondition"],
    ["Smoothness", "smoothness"],
    ["Hiking difficulty", "hikingDifficulty"],
    ["Trail visibility", "trailVisibility"],
    ["Incline", "incline"],
    ["Width", "width"],
    ["Informal", "informal"],
    ["Trailblazed", "trailblazed"],
    ["Assisted trail", "assistedTrail"],
  ];
  return (
    <div className="mt-8 rounded-3xl border border-black/10 bg-[#f4f2ed] p-6 sm:p-8">
      <div className="flex flex-wrap justify-between gap-3 text-sm">
        <p className="font-semibold">
          {aggregation.availability === "available"
            ? `${Math.round(aggregation.evidenceCoverage * 100)}% of route has classifiable ${aggregation.source.name} surface evidence`
            : data.note ?? "Terrain evidence is currently unavailable for this route."}
        </p>
        <p className="text-black/45">Availability: {aggregation.availability}</p>
      </div>
      {aggregation.availability === "available" && data.note && (
        <p className="mt-2 text-xs text-black/45">{data.note}</p>
      )}
      {aggregation.supportingTerrainEvidence.length > 0 && (
        <div className="mt-5 rounded-2xl border border-black/10 bg-white/70 p-5">
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-[0.15em] text-black/40">Route-level summary</p>
              <p className="mt-1 text-lg font-semibold">{routeSummary.heading}</p>
            </div>
            <p className="text-xs text-black/45">Share of mapped surface evidence · OSM-derived</p>
          </div>
          {routeSummary.limited ? (
            <div className="mt-4 flex flex-wrap gap-2">
              {routeSummary.mappedEvidenceText && (
                <span className="rounded-full border border-black/10 px-3 py-1.5 text-xs text-black/60">
                  {routeSummary.mappedEvidenceText}
                </span>
              )}
              {routeSummary.coverageText && (
                <span className="rounded-full border border-black/10 px-3 py-1.5 text-xs text-black/60">
                  {routeSummary.coverageText}
                </span>
              )}
            </div>
          ) : (
            <div className="mt-4 flex flex-wrap gap-2">
              {routeSummary.evidenceItems.map((item, index) => (
                <span key={`${item}-${index}`} className="rounded-full border border-black/10 px-3 py-1.5 text-xs text-black/60">
                  {item}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
      {aggregation.sections.length > 0 && (
        <div className="mt-6 space-y-4">
          {aggregation.sections.map((section) => (
            <TerrainSectionCard
              key={section.id}
              section={section}
              points={sectionGeometry.get(section.id) ?? []}
              imageEvidence={imageEvidence.get(section.id) ?? null}
              selectedImage={selectedImage}
              onSelectImage={onSelectImage}
            />
          ))}
        </div>
      )}

      {data.segments.length > 0 && (
        <details className="mt-6 rounded-2xl border border-black/10 bg-white/60 p-5">
          <summary className="cursor-pointer text-sm font-semibold">View raw OSM map evidence</summary>
          <div className="mt-5 space-y-4">
            {data.segments.map((segment) => (
              <article key={segment.id} className="rounded-xl border border-black/10 bg-white p-4">
                <div className="flex flex-wrap justify-between gap-2">
                  <h4 className="text-sm font-semibold">{segment.startDistanceKm}–{segment.endDistanceKm} km</h4>
                  <span className="text-xs text-black/45">{segment.matchQuality} match · {Math.round(segment.evidenceCoverage * 100)}% matched</span>
                </div>
                <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                  {fields.map(([label, key]) => (
                    <EvidenceField key={key} label={label} evidence={segment[key] as EvidenceValue} />
                  ))}
                </dl>
                {segment.osmWays.length > 0 && (
                  <div className="mt-4 space-y-2 text-xs text-black/40">
                    {segment.osmWays.map((way) => (
                      <p key={way.sourceId}>
                        {way.sourceId} · {Object.entries(way.tags).map(([tag, value]) => `${tag}=${value}`).join(" · ")}
                      </p>
                    ))}
                  </div>
                )}
              </article>
            ))}
          </div>
        </details>
      )}

      <p className="mt-6 text-xs text-black/45">
        Source: <a className="underline" href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">{data.attribution}</a>. OSM data is available under the Open Database License.
      </p>
    </div>
  );
}

function TerrainSectionCard({
  section,
  points,
  imageEvidence,
  selectedImage,
  onSelectImage,
}: {
  section: ReturnType<typeof aggregateTerrainEvidence>["sections"][number];
  points: MapillaryRoutePoint[];
  imageEvidence: MapillarySectionEvidence | null;
  selectedImage: MapillaryImageEvidence | null;
  onSelectImage: (image: MapillaryImageEvidence) => void;
}) {
  return (
    <article className="rounded-2xl border border-black/10 bg-white p-5 sm:p-6">
      <div className="flex flex-wrap justify-between gap-3">
        <div>
          <h3 className="font-semibold">{terrainSectionTitle(section.dominantTerrain)}</h3>
          <p className="mt-1 text-sm text-black/50">
            {section.startDistanceKm}–{section.endDistanceKm} km · {section.lengthKm} km
          </p>
        </div>
        <p className="text-xs text-black/45">
          Evidence · OpenStreetMap · {Math.round(section.evidenceCoverage * 100)}% coverage
        </p>
      </div>
      {points.length >= 2 && (
        <TerrainSectionMap
          points={points}
          images={imageEvidence?.images ?? []}
          startDistanceKm={section.startDistanceKm}
          endDistanceKm={section.endDistanceKm}
          selectedImage={selectedImage}
          onSelectImage={onSelectImage}
        />
      )}
      <div className="mt-3 flex flex-wrap justify-between gap-2 text-xs text-black/45">
        <span>Terrain imagery · {imageEvidence?.availability ?? "pending"}</span>
        <span>{imageEvidence?.availability === "available" ? `${imageEvidence.images.length} photo${imageEvidence.images.length === 1 ? "" : "s"} · click a map point · © Mapillary` : imageEvidence?.note ?? "Terrain imagery lookup pending."}</span>
      </div>
      <div className="mt-5 grid gap-4 sm:grid-cols-2">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.15em] text-black/40">Dominant terrain</p>
          <p className="mt-1 text-base font-semibold">{terrainCategoryLabel(section.dominantTerrain)}</p>
        </div>
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.15em] text-black/40">Evidence confidence</p>
          <p className="mt-1 text-sm capitalize">{section.matchQuality} · {section.provenance}</p>
        </div>
      </div>
      {section.supportingTerrainEvidence.length > 1 && (
        <p className="mt-4 text-xs leading-5 text-black/45">
          Supporting surfaces: {section.supportingTerrainEvidence.map((item) =>
            `${terrainCategoryLabel(item.category)} (${Math.round(item.evidenceShare * 100)}%)`,
          ).join(" · ")}
        </p>
      )}
    </article>
  );
}

function thinSectionPoints(points: RouteAnalysisData["points"], maxPoints = 120) {
  if (points.length <= maxPoints) return points.map(({ latitude, longitude, distanceM }) => ({ latitude, longitude, distanceM }));
  const step = (points.length - 1) / (maxPoints - 1);
  return Array.from({ length: maxPoints }, (_, index) => {
    const point = points[Math.round(index * step)];
    return { latitude: point.latitude, longitude: point.longitude, distanceM: point.distanceM };
  });
}

function getSectionRoutePoints(
  routePoints: RouteAnalysisData["points"],
  startKm: number,
  endKm: number,
) {
  const startM = startKm * 1000;
  const endM = endKm * 1000;
  const points = routePoints.filter((point) => point.distanceM >= startM && point.distanceM <= endM);
  const nearestStart = routePoints.reduce<typeof routePoints[number] | null>((nearest, point) =>
    !nearest || Math.abs(point.distanceM - startM) < Math.abs(nearest.distanceM - startM) ? point : nearest, null);
  const nearestEnd = routePoints.reduce<typeof routePoints[number] | null>((nearest, point) =>
    !nearest || Math.abs(point.distanceM - endM) < Math.abs(nearest.distanceM - endM) ? point : nearest, null);
  for (const endpoint of [nearestStart, nearestEnd]) {
    if (endpoint && !points.some((point) => point.distanceM === endpoint.distanceM)) points.push(endpoint);
  }
  points.sort((a, b) => a.distanceM - b.distanceM);
  return thinSectionPoints(points);
}

function terrainSectionTitle(category: TerrainCategory) {
  const titles: Record<TerrainCategory, string> = {
    paved: "Paved section",
    gravel: "Gravel section",
    "dirt-ground": "Dirt / ground section",
    "rocky-rough": "Rocky trail section",
    "natural-trail": "Natural trail section",
    "mixed-trail": "Mixed trail section",
    unknown: "Terrain evidence section",
  };
  return titles[category];
}

function EvidenceField({ label, evidence }: { label: string; evidence: EvidenceValue }) {
  const displayedValue = evidence.value ?? (evidence.availability === "not-found" ? "Not found in OpenStreetMap" : "Unknown — no reliable map match");
  return (
    <div>
      <dt className="text-[10px] font-semibold uppercase tracking-[0.15em] text-black/40">{label}</dt>
      <dd className="mt-1 text-sm font-medium">{displayedValue}</dd>
      <dd className="mt-1 text-[10px] uppercase tracking-wide text-black/35">{evidence.provenance} · {evidence.availability}</dd>
    </div>
  );
}

function SegmentGroup({
  title,
  segments,
  metric,
}: {
  title: string;
  segments: GpxRouteSegmentData[];
  metric: "gain" | "loss" | "both";
}) {
  return (
    <div>
      <h3 className="text-lg font-semibold">{title}</h3>
      {segments.length === 0 ? (
        <p className="mt-4 text-sm leading-6 text-black/45">
          No distinct section of this type was identified in the GPX elevation data.
        </p>
      ) : (
        <ul className="mt-4 space-y-3">
          {segments.map((segment) => (
            <li key={segment.id} className="rounded-2xl border border-black/10 bg-white p-4">
              <p className="text-sm font-semibold">
                {segment.startKm}–{segment.endKm} km
              </p>
              <p className="mt-2 text-xs text-black/50">
                {metric !== "loss" && `+${segment.elevationGainM.toLocaleString("en-US")} m gain`}
                {metric === "both" && " · "}
                {metric !== "gain" && `−${segment.elevationLossM.toLocaleString("en-US")} m loss`}
              </p>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-3 text-[10px] font-semibold uppercase tracking-[0.18em] text-[#71805d]">
        GPX-derived
      </p>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-black/10 bg-white p-4 sm:p-5">
      <p className="text-[10px] uppercase tracking-[0.15em] text-black/40 sm:text-xs">
        {label}
      </p>
      <p className="mt-2 break-words text-xl font-semibold sm:text-2xl">{value}</p>
    </div>
  );
}

function SectionHeading({ eyebrow, title }: { eyebrow: string; title: string }) {
  return (
    <div className="mb-10">
      <p className="text-xs font-semibold uppercase tracking-[0.25em] text-[#71805d]">
        {eyebrow}
      </p>
      <h2 className="mt-3 text-3xl font-semibold tracking-[-0.035em] sm:text-4xl">
        {title}
      </h2>
    </div>
  );
}
