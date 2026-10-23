"use client";

import { useEffect, useRef, useState, type PointerEvent } from "react";
import type { GpxRoutePointData } from "./gpxAnalysis";
import type { RouteSection } from "./routeSectionEngine";
import { nearestRouteProfilePoint } from "./routeProfileInspection";
import { createRouteSectionProfileLayout } from "./routeSectionProfilePresentation";

const EDGE = { left: 62, right: 16, top: 16, bottom: 38 };

/** Component-local view of actual GPX samples on the full-route kilometre scale. */
export default function RouteSectionProfile({ section, routePoints, sectionKind = "Route Section" }: { section: RouteSection; routePoints: readonly GpxRoutePointData[]; sectionKind?: "Route Section" | "Aid Station Section" }) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const gesture = useRef<{ pointerId: number; x: number; y: number; moved: boolean; held: boolean } | null>(null);
  const timer = useRef<number | null>(null);
  const [size, setSize] = useState({ width: 900, height: 224 });
  const [inspected, setInspected] = useState<GpxRoutePointData | null>(null);
  const samples = routePoints.filter((point) => point.segmentIndex === section.segmentIndex &&
    Number.isFinite(point.distanceM) && Number.isFinite(point.elevationM) &&
    point.distanceM >= section.startPosition.distanceM && point.distanceM <= section.endPosition.distanceM);
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const measure = () => {
      const box = svg.getBoundingClientRect();
      if (box.width && box.height) setSize((current) => current.width === Math.round(box.width) && current.height === Math.round(box.height) ? current : { width: Math.round(box.width), height: Math.round(box.height) });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(svg);
    return () => observer.disconnect();
  }, []);
  useEffect(() => () => { if (timer.current !== null) window.clearTimeout(timer.current); }, []);
  if (samples.length < 2 || section.endPosition.distanceM <= section.startPosition.distanceM) return <p className="mt-5 rounded-xl bg-[#202c26] p-4 text-sm text-white/65">A section profile is unavailable because this component has fewer than two GPX samples in the section bounds.</p>;

  const width = size.width;
  const height = size.height;
  const plotHeight = Math.max(1, height - EDGE.top - EDGE.bottom);
  const startM = section.startPosition.distanceM;
  const endM = section.endPosition.distanceM;
  const elevations = samples.map((point) => point.elevationM);
  const layout = createRouteSectionProfileLayout(startM, endM, Math.min(...elevations), Math.max(...elevations), width, height);
  if (!layout) return <p className="mt-5 rounded-xl bg-[#202c26] p-4 text-sm text-white/65">A section profile is unavailable because its distance bounds are invalid.</p>;
  const { xForDistance: x, yForElevation: y, elevationScale: elevation, distanceTicks: visibleTicks } = layout;
  const totalRouteDistanceM = Math.max(...routePoints.map((point) => point.distanceM));
  const sampleStart = samples[0];
  const sampleEnd = samples.at(-1)!;
  const accessible = `${sectionKind} profile from ${formatKm(startM)} to ${formatKm(endM)} kilometres on the full route scale. Elevation ranges from ${Math.round(Math.min(...elevations))} to ${Math.round(Math.max(...elevations))} metres. ${samples.length} actual GPX samples from track component ${section.segmentIndex + 1}.`;
  const inspect = (clientX: number, clientY: number) => {
    const box = svgRef.current?.getBoundingClientRect();
    if (!box || box.width <= 0) return;
    const px = (clientX - box.left) / box.width * width;
    const py = (clientY - box.top) / box.height * height;
    if (px < EDGE.left || px > width - EDGE.right || py < EDGE.top || py > height - EDGE.bottom) { setInspected(null); return; }
    const distanceM = startM + (px - EDGE.left) / (width - EDGE.left - EDGE.right) * (endM - startM);
    const elevationM = elevation.maximum - (py - EDGE.top) / (height - EDGE.top - EDGE.bottom) * (elevation.maximum - elevation.minimum);
    setInspected(nearestRouteProfilePoint(samples, distanceM, elevationM));
  };
  const pointerDown = (event: PointerEvent<SVGSVGElement>) => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    gesture.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, moved: false, held: false };
    if (event.pointerType === "touch") timer.current = window.setTimeout(() => {
      const current = gesture.current;
      if (current?.pointerId === event.pointerId && !current.moved) { current.held = true; inspect(event.clientX, event.clientY); }
    }, 450);
  };
  const pointerMove = (event: PointerEvent<SVGSVGElement>) => {
    const current = gesture.current;
    if (current?.pointerId === event.pointerId && Math.hypot(event.clientX - current.x, event.clientY - current.y) > 8) {
      current.moved = true;
      if (timer.current !== null) { window.clearTimeout(timer.current); timer.current = null; }
    }
    if (event.pointerType === "mouse" || current?.held) inspect(event.clientX, event.clientY);
  };
  const inspectedX = inspected ? x(inspected.distanceM) : null;
  const inspectedY = inspected ? y(inspected.elevationM) : null;
  return <div className="mt-6">
    <p className="mb-2 text-xs font-semibold uppercase tracking-[0.16em] text-black/45">Section elevation profile · full-route distance</p>
    <svg ref={svgRef} viewBox={`0 0 ${width} ${height}`} className="h-52 w-full rounded-xl bg-[#17211c] touch-pan-y sm:h-56" role="img" aria-label={accessible}
      onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={() => { if (timer.current !== null) window.clearTimeout(timer.current); timer.current = null; gesture.current = null; }}
      onPointerCancel={() => { if (timer.current !== null) window.clearTimeout(timer.current); timer.current = null; gesture.current = null; setInspected(null); }} onPointerLeave={(event) => { if (event.pointerType === "mouse") setInspected(null); }}>
      {elevation.ticks.map((tick) => <g key={`y-${tick}`}><line x1={EDGE.left} x2={width - EDGE.right} y1={y(tick)} y2={y(tick)} stroke="#ffffff" strokeOpacity="0.12" /><text x={EDGE.left - 8} y={y(tick) + 4} textAnchor="end" fill="#ffffff" fillOpacity="0.66" fontSize="11">{Math.round(tick)}</text></g>)}
      <text x="12" y={EDGE.top + plotHeight / 2} transform={`rotate(-90 12 ${EDGE.top + plotHeight / 2})`} textAnchor="middle" fill="#ffffff" fillOpacity="0.55" fontSize="10">Elevation (m)</text>
      {visibleTicks.map((tick) => <g key={`x-${tick.distanceM}`}><line x1={tick.x} x2={tick.x} y1={EDGE.top} y2={height - EDGE.bottom} stroke="#ffffff" strokeOpacity="0.05" /><text x={tick.x} y={height - 12} textAnchor={tick.distanceM === startM ? "start" : tick.distanceM === endM ? "end" : "middle"} fill="#ffffff" fillOpacity="0.68" fontSize="10">{tick.label}</text></g>)}
      {groupSamplesByComponent(samples).map((component) => <polyline key={component[0].segmentIndex} points={component.map((point) => `${x(point.distanceM)},${y(point.elevationM)}`).join(" ")} fill="none" stroke="#a7c957" strokeWidth="3" strokeLinejoin="round" strokeLinecap="round" />)}
      {inspected && inspectedX !== null && inspectedY !== null && <g pointerEvents="none"><line x1={inspectedX} x2={inspectedX} y1={EDGE.top} y2={height - EDGE.bottom} stroke="#f2d675" strokeDasharray="3 3" /><circle cx={inspectedX} cy={inspectedY} r="5" fill="#f2d675" stroke="#17211c" strokeWidth="2" /></g>}
    </svg>
    <p className="sr-only">Section starts at {formatKm(startM)} kilometres and ends at {formatKm(endM)} kilometres. Its first displayed GPX sample is {Math.round(sampleStart.elevationM)} metres and its last is {Math.round(sampleEnd.elevationM)} metres.</p>
    <p className="mt-2 min-h-5 text-xs tabular-nums text-black/50" aria-live="polite">{inspected ? `${formatKm(inspected.distanceM)} km · ${Math.round(inspected.elevationM)} m elevation · GPX sample` : "Point to inspect; on touch screens, press and hold."}</p>
    <span className="sr-only">Route length is approximately {formatKm(totalRouteDistanceM)} kilometres.</span>
  </div>;
}

function groupSamplesByComponent(samples: readonly GpxRoutePointData[]) {
  const groups = new Map<number, GpxRoutePointData[]>();
  for (const sample of samples) { const group = groups.get(sample.segmentIndex) ?? []; group.push(sample); groups.set(sample.segmentIndex, group); }
  return [...groups.values()];
}
function formatKm(value: number) { return (value / 1000).toFixed(2).replace(/0+$/, "").replace(/\.$/, ""); }
