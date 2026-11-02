"use client";

import { type ReactNode } from "react";
import type { MapillaryImageEvidence, MapillarySectionEvidence } from "./mapillaryTerrainProof";
import type { RouteSection } from "./routeSectionEngine";
import type { GradientIntelligenceV1 } from "./gradientIntelligence";
import type { RouteNarrativeRouteContextV2 } from "./routeNarrativePhases";
import { presentRouteSectionNarrativeV2 } from "./routeSectionNarrativeV2";
import { getRouteImageryPresentation, getTerrainSectionPresentation, numberRouteSectionsForDisplay, type TerrainEvidenceState } from "./routeSectionPresentation";
import { routeSectionSelectionKey } from "./routeSectionSelection";
import TerrainSectionMap from "./TerrainSectionMap";
import RouteSectionProfile from "./RouteSectionProfile";
import type { GpxRoutePointData } from "./gpxAnalysis";
import { TERRAIN_INTELLIGENCE_V1_ENABLED } from "./featureFlags";
import { useRouteUnits } from "./RouteUnitPreference";
import { formatDistanceMeters, formatRouteDistanceKm, formatElevationMeters, type RouteUnitSystem } from "./routeUnits";

const rhythmLabels: Record<RouteSection["dominantRhythm"], string> = {
  climb: "Mostly climbing",
  descent: "Mostly descending",
  rolling: "Rolling elevation",
  flat: "Low elevation change",
};

export default function RouteSectionBrowser({
  sections,
  routePoints = [],
  selectedSectionKey,
  onSelectSection,
  gradientIntelligence,
  narrativeContext,
  imageEvidence = new Map(),
  onSelectImage = () => undefined,
  terrainEvidenceState = "not-requested",
  sectionLabels,
  sectionKind = "Route Section",
  emptyMessage,
}: {
  sections: readonly RouteSection[];
  routePoints?: readonly GpxRoutePointData[];
  selectedSectionKey: string | null;
  onSelectSection: (section: RouteSection | null) => void;
  gradientIntelligence?: GradientIntelligenceV1;
  narrativeContext?: RouteNarrativeRouteContextV2;
  imageEvidence?: ReadonlyMap<string, MapillarySectionEvidence | null>;
  onSelectImage?: (image: MapillaryImageEvidence) => void;
  terrainEvidenceState?: TerrainEvidenceState;
  sectionLabels?: ReadonlyMap<string, { from: string; to: string }>;
  sectionKind?: "Route Section" | "Aid Station Section" | "Custom Section";
  emptyMessage?: string;
}) {
  const { units } = useRouteUnits();
  const orderedSections = numberRouteSectionsForDisplay(sections);
  return (
    <div>
      {sections.length ? (
        <>
          <ol className="divide-y divide-black/10 overflow-hidden rounded-2xl border border-black/10 bg-white" aria-label={sectionKind === "Aid Station Section" ? "Ordered aid station sections" : "Ordered route sections"}>
            {orderedSections.map(({ section, ordinal }) => {
              const isSelected = routeSectionSelectionKey(section) === selectedSectionKey;
              const boundaryLabels = sectionLabels?.get(routeSectionSelectionKey(section));
              return (
                <li key={routeSectionSelectionKey(section)}>
                  <button
                    type="button"
                    aria-pressed={isSelected}
                    aria-expanded={isSelected}
                    aria-controls={isSelected ? `route-section-detail-${section.segmentIndex}-${ordinal}` : undefined}
                    onClick={() => onSelectSection(isSelected ? null : section)}
                    className={`flex min-h-[68px] w-full items-center justify-between gap-3 px-4 py-3 text-left transition focus-visible:z-10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[#71805d] sm:px-5 ${isSelected ? "bg-[#e9eddf]" : "hover:bg-[#f4f2ed]"}`}
                  >
                    <span className="flex min-w-0 items-center gap-3">
                      <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-sm font-semibold ${isSelected ? "bg-[#536b3e] text-white" : "bg-[#f4f2ed] text-black/60"}`}>{ordinal}</span>
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-semibold text-[#17211c]">{boundaryLabels ? `${boundaryLabels.from} → ${boundaryLabels.to}` : `${rhythmLabels[section.dominantRhythm]} · ${formatRouteDistanceKm(section.startKm, units, 2)}–${formatRouteDistanceKm(section.endKm, units, 2)}`}</span>
                        <span className="mt-1 block text-xs tabular-nums text-[var(--analysis-muted)]">{formatRouteDistanceKm(section.distanceKm, units, 2)} · +{formatElevationMeters(section.ascentM, units)} / −{formatElevationMeters(section.descentM, units)}</span>
                      </span>
                    </span>
                    <span className="shrink-0 text-xs font-semibold text-[#536b3e]">{isSelected ? "Selected" : "Details"}</span>
                  </button>
                  {isSelected && (
                    <div id={`route-section-detail-${section.segmentIndex}-${ordinal}`} className="border-t border-black/10 p-3 sm:p-4" aria-live="polite">
                      <SectionDetail
                        section={section}
                        ordinal={ordinal}
                        routePoints={routePoints}
                        gradientIntelligence={gradientIntelligence}
                        narrativeContext={narrativeContext}
                        routeSections={sections}
                        imageEvidence={imageEvidence.get(routeSectionSelectionKey(section)) ?? null}
                        terrainEvidenceState={terrainEvidenceState}
                        sectionKind={sectionKind}
                        units={units}
                        boundaryLabels={boundaryLabels}
                        onSelectImage={onSelectImage}
                        onClose={() => onSelectSection(null)}
                      />
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
        </>
      ) : (
        <p className="text-sm text-[var(--analysis-muted)]">{emptyMessage ?? "No stable route rhythm could be distinguished from this GPX elevation profile."}</p>
      )}
    </div>
  );
}

export function RouteSectionBrowserHeading({ action, controls }: { action?: ReactNode; controls?: ReactNode }) {
  return (
    <div className="mb-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.25em] text-[var(--analysis-accent-text)]">GPX-derived · primary route segmentation</p>
          <h2 className="mt-3 text-3xl font-semibold tracking-[-0.035em] sm:text-4xl">Route Sections</h2>
          {controls}
        </div>
        {action}
      </div>
      <p className="mt-4 max-w-2xl text-sm leading-6 text-[var(--analysis-muted)]">Choose a section to explore its profile, route and available evidence.</p>
    </div>
  );
}

function SectionDetail({
  section,
  ordinal,
  routePoints,
  gradientIntelligence,
  narrativeContext,
  routeSections,
  imageEvidence,
  terrainEvidenceState,
  sectionKind,
  units,
  boundaryLabels,
  onSelectImage,
  onClose,
}: {
  section: RouteSection;
  ordinal: number;
  routePoints: readonly GpxRoutePointData[];
  gradientIntelligence: GradientIntelligenceV1 | undefined;
  narrativeContext?: RouteNarrativeRouteContextV2;
  routeSections: readonly RouteSection[];
  imageEvidence: MapillarySectionEvidence | null;
  terrainEvidenceState: TerrainEvidenceState;
  sectionKind: "Route Section" | "Aid Station Section" | "Custom Section";
  units: RouteUnitSystem;
  boundaryLabels?: { from: string; to: string };
  onSelectImage: (image: MapillaryImageEvidence) => void;
  onClose: () => void;
}) {
  const isAidStationSection = sectionKind === "Aid Station Section";
  const title = boundaryLabels ? `${boundaryLabels.from} → ${boundaryLabels.to}` : rhythmLabels[section.dominantRhythm];
  const terrain = getTerrainSectionPresentation(section, terrainEvidenceState);
  const imagery = getRouteImageryPresentation(imageEvidence);
  const expectation = isAidStationSection && boundaryLabels ? null
    : presentRouteSectionNarrativeV2(gradientIntelligence, routeSections, section, narrativeContext, units);
  const whatToExpect = expectation?.paragraphs.length ? expectation.paragraphs : [`${rhythmLabels[section.dominantRhythm]} across this section.`];

  return (
    <article className="rounded-3xl border border-[#71805d]/30 bg-[#f4f2ed] p-5 sm:p-8" aria-label={`${sectionKind} ${ordinal} details`}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--analysis-accent-text)]">{sectionKind} {ordinal} · {section.segmentIndex === 0 ? "Track segment 1" : `Track segment ${section.segmentIndex + 1}`}</p>
          <h3 className="mt-2 text-2xl font-semibold">{title} · {formatRouteDistanceKm(section.startKm, units, 2)}–{formatRouteDistanceKm(section.endKm, units, 2)}</h3>
        </div>
        <button type="button" aria-label={`Close ${sectionKind} ${ordinal} details`} onClick={onClose} className="min-h-11 rounded-full border border-black/15 bg-white px-4 text-sm font-semibold text-black/70 hover:bg-[#e9eddf] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#71805d]">Close details</button>
      </div>
      {isAidStationSection && boundaryLabels ? (
        <section className="mt-5 border-t border-black/10 pt-5" aria-label="Aid station interval">
          <SectionSubheading>Between aid stations</SectionSubheading>
          <p className="mt-3 text-sm leading-6 text-black/70">From {boundaryLabels.from} to {boundaryLabels.to} along the selected GPX route.</p>
        </section>
      ) : (
        <section className="mt-5 border-t border-black/10 pt-5" aria-label="What to Expect">
          <SectionSubheading>What to Expect</SectionSubheading>
          <div className="mt-3 max-w-4xl space-y-3 text-sm leading-6 text-black/70" aria-live="polite">
            {whatToExpect.map((paragraph, index) => (
              <p key={`${expectation?.sectionId ?? section.id}-${expectation?.segmentIndex ?? section.segmentIndex}-expectation-${index}`}>{paragraph}</p>
            ))}
          </div>
          {whatToExpect.some((paragraph) => /\b\d+(?:\.\d+)?%/.test(paragraph)) && <p className="mt-2 text-xs leading-5 text-[var(--analysis-muted)]">Grade figures are average grades over the stated interval, measured from the smoothed GPX profile.</p>}
        </section>
      )}
      <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <SectionMetric label="Ascent" value={`+${formatElevationMeters(section.ascentM, units)}`} />
        <SectionMetric label="Descent" value={`−${formatElevationMeters(section.descentM, units)}`} />
        <SectionMetric label="Elevation range" value={`${formatElevationMeters(section.elevationMinM, units)}–${formatElevationMeters(section.elevationMaxM, units)}`} />
        <SectionMetric label="Section pattern" value={title} />
      </div>
      <RouteSectionProfile section={section} routePoints={routePoints} sectionKind={sectionKind} />
      <div className="mt-6 border-t border-black/10 pt-5">
        <SectionSubheading>Section map · GPX-derived</SectionSubheading>
        <TerrainSectionMap points={routePoints} section={section} startDistanceKm={section.startKm} endDistanceKm={section.endKm} units={units} />
      </div>
      {TERRAIN_INTELLIGENCE_V1_ENABLED && sectionKind === "Route Section" && <section className="mt-6 min-w-0 border-t border-black/10 pt-5" aria-label="Mapped terrain evidence">
        <SectionSubheading>Mapped terrain</SectionSubheading>
        {terrain.status === "available" ? (
          <div className="mt-2 space-y-4">
            {[terrain.surface, ...(terrain.highway ? [terrain.highway] : [])].map((field) => (
              <div key={field.heading}>
                <h4 className="text-sm font-semibold text-black/70">{field.heading}</h4>
                <p className="mt-1 text-xs text-[var(--analysis-muted)]">{field.coverageLabel}</p>
                {field.categories.length ? (
                  <ul className="mt-2 grid grid-cols-1 gap-x-6 gap-y-1.5 text-sm text-black/60 sm:grid-cols-2">
                    {field.categories.map((item) => <li key={item.label} className="flex min-w-0 justify-between gap-3"><span className="truncate">{item.label}</span><span className="shrink-0 tabular-nums">{item.distanceLabel} · {item.sharePercent}%</span></li>)}
                  </ul>
                ) : <p className="mt-2 text-sm text-[var(--analysis-muted)]">No usable mapped categories were found.</p>}
                <p className="mt-2 text-xs font-medium text-[var(--analysis-muted)]">{field.unknownLabel}</p>
                {field.reasons.length > 0 && <p className="mt-1 text-xs text-[var(--analysis-muted)]">{field.reasons.join(" · ")}.</p>}
              </div>
            ))}
            <p className="text-[11px] leading-5 text-[var(--analysis-muted)]">{terrain.sourceNote}</p>
          </div>
        ) : <p className="mt-2 text-sm text-[var(--analysis-muted)]">{terrain.message}</p>}
      </section>}
      {imagery && (
        <section className="mt-6 min-w-0 border-t border-black/10 pt-5" aria-label="Route imagery">
          <SectionSubheading>Route imagery · Mapillary</SectionSubheading>
          {imagery.status === "available" ? (
            <>
              <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                {imagery.images.map((image) => (
                  <button key={image.id} type="button" onClick={() => onSelectImage(image)} aria-label={`Open Mapillary image around ${formatDistanceMeters(image.distanceAlongRouteKm * 1000, units)}`} className="group min-w-0 min-h-11 overflow-hidden rounded-xl border border-black/10 bg-white text-left transition hover:border-[#71805d] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#71805d]">
                    <span className="block aspect-[4/3] bg-[#e7e8e2] bg-cover bg-center" style={image.thumbnailUrl ? { backgroundImage: `url("${image.thumbnailUrl}")` } : undefined} />
                    <span className="block truncate px-2.5 py-2 text-xs text-[var(--analysis-muted)]">~{formatDistanceMeters(image.distanceAlongRouteKm * 1000, units)} · © Mapillary</span>
                  </button>
                ))}
              </div>
              <p className="mt-2 text-[11px] text-[var(--analysis-muted)]">© Mapillary</p>
            </>
          ) : <p className="mt-2 text-sm text-[var(--analysis-muted)]">{imagery.message}</p>}
        </section>
      )}
    </article>
  );
}

function SectionMetric({ label, value }: { label: string; value: string }) {
  return <div><p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--analysis-muted)]">{label}</p><p className="mt-1 text-sm font-semibold text-black/70">{value}</p></div>;
}

function SectionSubheading({ children }: { children: ReactNode }) {
  return <h4 className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--analysis-muted)]">{children}</h4>;
}
