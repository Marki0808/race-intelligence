"use client";

import type { RouteSection } from "./routeSectionEngine";
import { routeSectionSelectionKey } from "./routeSectionSelection";
import { buildLiveCustomSectionMetrics } from "./liveCustomSectionSummaryModel";
import { formatRouteDistanceKm, type RouteUnitSystem } from "./routeUnits";

export default function LiveCustomSectionSummary({
  sections,
  selectedSection,
  units,
  onSelectSection,
  onViewFullSectionAnalysis,
}: {
  sections: readonly RouteSection[];
  selectedSection: RouteSection | null;
  units: RouteUnitSystem;
  onSelectSection: (section: RouteSection | null) => void;
  onViewFullSectionAnalysis: (section: RouteSection) => void;
}) {
  const metrics = selectedSection ? buildLiveCustomSectionMetrics(selectedSection, units) : [];
  const selectedKey = selectedSection ? routeSectionSelectionKey(selectedSection) : "";

  return (
    <section aria-label="Live section summary" className="mt-3 min-h-[17rem] rounded-xl border border-[#f2d675]/35 bg-[#f2d675]/[0.08] p-4 sm:min-h-[14rem] sm:p-5 lg:min-h-[12rem]">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span aria-hidden="true" className="h-2.5 w-2.5 shrink-0 rounded-full bg-[#f2d675] ring-2 ring-[#f2d675]/25" />
          <h3 className="truncate text-sm font-semibold text-white/95">Live section summary</h3>
          <label className="sr-only" htmlFor="live-custom-section-select">Select a section to inspect</label>
          <select id="live-custom-section-select" value={selectedKey} onChange={(event) => onSelectSection(sections.find((section) => routeSectionSelectionKey(section) === event.currentTarget.value) ?? null)} className="min-h-9 min-w-0 max-w-full rounded-lg border border-white/15 bg-[#17211c] px-2 text-xs font-medium text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#a7c957]" aria-label="Select a section to inspect">
            <option value="">Choose a section</option>
            {sections.map((section, index) => <option key={routeSectionSelectionKey(section)} value={routeSectionSelectionKey(section)}>Section {index + 1} · {formatRouteDistanceKm(section.startKm, units, 2)}–{formatRouteDistanceKm(section.endKm, units, 2)}</option>)}
          </select>
        </div>
        {selectedSection && <button type="button" onClick={() => onViewFullSectionAnalysis(selectedSection)} className="min-h-9 shrink-0 rounded-full border border-white/20 px-3 py-1.5 text-xs font-semibold text-white/90 transition hover:bg-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#a7c957]">View full section analysis</button>}
      </div>
      {selectedSection ? (
        <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3 lg:grid-cols-5" aria-live="polite">
          {metrics.map((metric) => <div key={metric.label} className="min-w-0">
            <dt className="text-[10px] font-semibold uppercase tracking-[0.12em] text-white/60">{metric.label}</dt>
            <dd className="mt-0.5 break-words text-xs font-semibold tabular-nums text-white/90 sm:text-sm">{metric.value}</dd>
            {metric.detail && <dd className="text-[10px] tabular-nums text-white/55">{metric.detail}</dd>}
          </div>)}
        </dl>
      ) : <p className="mt-3 text-xs leading-5 text-white/65" role="status">{sections.length ? "Choose a section above to highlight it and review its metrics." : "Select a profile section or add a custom boundary to preview its summary."}</p>}
    </section>
  );
}
