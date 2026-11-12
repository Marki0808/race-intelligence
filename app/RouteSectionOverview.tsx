"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { GpxRoutePointData } from "./gpxAnalysis";
import type { RouteSection } from "./routeSectionEngine";
import { createRouteSectionOverviewLayout, describeRouteSectionOverview } from "./routeSectionOverviewModel";
import { formatElevationNumber, elevationUnit, type RouteUnitSystem } from "./routeUnits";

export default function RouteSectionOverview({ section, routePoints, units }: {
  section: RouteSection;
  routePoints: readonly GpxRoutePointData[];
  units: RouteUnitSystem;
}) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [width, setWidth] = useState(900);
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const measure = () => {
      const measuredWidth = svg.getBoundingClientRect().width;
      if (measuredWidth > 0) setWidth((current) => current === Math.round(measuredWidth) ? current : Math.round(measuredWidth));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(svg);
    return () => observer.disconnect();
  }, []);

  const layout = useMemo(() => createRouteSectionOverviewLayout(routePoints, section, width, units), [routePoints, section, width, units]);
  if (!layout) return <p className="mt-4 rounded-lg bg-[#202c26] px-3 py-2 text-xs text-white/65" role="status">Full-route elevation overview is unavailable for this profile.</p>;

  const edge = { left: 42, right: 12, top: 22, bottom: 28 };
  const plotBottom = layout.height - edge.bottom;
  const sectionDescription = layout.selectedRange
    ? describeRouteSectionOverview(layout.selectedRange.startDistanceM, layout.selectedRange.endDistanceM, layout.totalDistanceM, units)
    : `Full route elevation overview from start to finish over ${layout.totalDistanceM} meters. The selected section bounds could not be placed reliably on this route profile.`;
  const renderRun = (points: typeof layout.components[number]["points"], key: string, color: string, opacity: number, strokeWidth: number) => points.length > 1
    ? <polyline key={key} points={points.map((point) => `${layout.xForDistance(point.distanceM)},${layout.yForElevation(point.elevationM)}`).join(" ")} fill="none" stroke={color} strokeOpacity={opacity} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
    : points.length === 1
      ? <circle key={key} cx={layout.xForDistance(points[0].distanceM)} cy={layout.yForElevation(points[0].elevationM)} r="2" fill={color} fillOpacity={opacity} />
      : null;

  return <figure className="mt-4 min-w-0">
    <figcaption className="mb-1 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
      <span className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--analysis-muted)]">FULL ROUTE OVERVIEW</span>
      <span className="text-[10px] text-white/55">{layout.selectedRange ? "Selected section highlighted" : "Section bounds unavailable"}</span>
    </figcaption>
    <svg
      ref={svgRef}
      viewBox={`0 0 ${layout.width} ${layout.height}`}
      className="block h-[124px] w-full rounded-lg bg-[#17211c]"
      preserveAspectRatio="none"
      role="img"
      aria-label={`${sectionDescription} Elevation is shown in ${elevationUnit(units)} and horizontal positions use full-route distance. Disconnected track components are drawn separately.`}
    >
      {layout.elevationScale.ticks.map((tick) => <line key={`elevation-${tick}`} x1={edge.left} x2={layout.width - edge.right} y1={layout.yForElevation(tick)} y2={layout.yForElevation(tick)} stroke="white" strokeOpacity="0.08" />)}
      {layout.selectedRange && <rect x={layout.selectedRange.startX} y={edge.top} width={Math.max(0, layout.selectedRange.endX - layout.selectedRange.startX)} height={plotBottom - edge.top} fill="#f2a23a" fillOpacity="0.16" />}
      {layout.components.map((run, index) => renderRun(run.points, `route-${run.segmentIndex}-${index}`, "#a7c957", 0.35, 2))}
      {layout.selectedRuns.map((run, index) => renderRun(run.points, `selected-${run.segmentIndex}-${index}`, "#f2a23a", 1, 3.5))}
      {layout.selectedRange && <>
        <line x1={layout.selectedRange.startX} x2={layout.selectedRange.startX} y1={edge.top} y2={plotBottom} stroke="#f2a23a" strokeWidth="1.5"><title>Selected section starts at {layout.selectedRange.startDistanceM} meters</title></line>
        <line x1={layout.selectedRange.endX} x2={layout.selectedRange.endX} y1={edge.top} y2={plotBottom} stroke="#f2a23a" strokeWidth="1.5"><title>Selected section ends at {layout.selectedRange.endDistanceM} meters</title></line>
      </>}
      <line x1={edge.left} x2={layout.width - edge.right} y1={plotBottom} y2={plotBottom} stroke="white" strokeOpacity="0.35" />
      {layout.distanceTicks.map((tick) => <g key={`distance-${tick.distanceM}`}>
        <line x1={tick.x} x2={tick.x} y1={plotBottom} y2={plotBottom + 3} stroke="white" strokeOpacity="0.45" />
        <text x={tick.x} y={layout.height - 7} textAnchor={tick.distanceM === 0 ? "start" : tick.isFinish ? "end" : "middle"} fill="white" fillOpacity="0.68" fontSize="9">{tick.label}</text>
      </g>)}
      <text x={edge.left + 2} y="14" textAnchor="start" fill="white" fillOpacity="0.7" fontSize="8" fontWeight="600">START</text>
      <text x={layout.width - edge.right - 2} y="14" textAnchor="end" fill="white" fillOpacity="0.7" fontSize="8" fontWeight="600">FINISH</text>
    </svg>
    <span className="sr-only">Selected section boundary distances are {layout.selectedRange ? `${layout.selectedRange.startDistanceM} meters to ${layout.selectedRange.endDistanceM} meters` : "unavailable"}. Elevation scale values use {units === "metric" ? "meters" : "feet"}; axis labels use {units === "metric" ? "kilometers" : "miles"}.</span>
    <span className="sr-only">Elevation ticks: {layout.elevationScale.ticks.map((tick) => formatElevationNumber(tick, units)).join(", ")} {elevationUnit(units)}.</span>
  </figure>;
}
