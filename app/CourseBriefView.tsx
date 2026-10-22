"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { composeCourseBrief } from "./courseBriefComposition.ts";
import type { CourseBriefCompositionResult } from "./courseBriefComposition.ts";
import { composeCourseBriefWholeRouteNarrative } from "./courseBriefWholeRouteNarrative.ts";
import type { RouteAnalysisData } from "./gpxAnalysis.ts";

type CourseBriefViewState =
  | { routeKey: string; routeAnalysis: RouteAnalysisData; status: "loading" }
  | { routeKey: string; routeAnalysis: RouteAnalysisData; status: "ready"; result: Extract<CourseBriefCompositionResult, { ok: true }> }
  | { routeKey: string; routeAnalysis: RouteAnalysisData; status: "unavailable" };

export default function CourseBriefView({
  routeAnalysis,
  routeKey,
  loading = false,
}: {
  routeAnalysis: RouteAnalysisData | null;
  routeKey: string;
  loading?: boolean;
}) {
  const [state, setState] = useState<CourseBriefViewState | null>(null);

  useEffect(() => {
    if (!routeAnalysis) return;

    let current = true;
    void composeCourseBrief(routeAnalysis).then((result) => {
      if (!current) return;
      setState(result.ok
        ? { routeKey, routeAnalysis, status: "ready", result }
        : { routeKey, routeAnalysis, status: "unavailable" });
    }).catch(() => {
      if (current) setState({ routeKey, routeAnalysis, status: "unavailable" });
    });

    return () => {
      current = false;
    };
  }, [routeAnalysis, routeKey]);

  const currentState = state?.routeAnalysis === routeAnalysis && state.routeKey === routeKey ? state : null;
  const narrative = useMemo(() => currentState?.status === "ready"
    ? composeCourseBriefWholeRouteNarrative(currentState.result.input, currentState.result.structuralOutput, currentState.result.selection.selectedCandidates)
    : null, [currentState]);
  let content: ReactNode;
  if (loading || (routeAnalysis && (!currentState || currentState.status === "loading"))) {
    content = <p role="status" className="text-sm leading-6 text-black/45">Preparing the GPX-derived course summary…</p>;
  } else if (!routeAnalysis || !currentState || currentState.status !== "ready") {
    content = <p role="status" className="text-sm leading-6 text-black/45">Course Brief is unavailable for this route.</p>;
  } else {
    content = narrative
      ? <div className="min-w-0 space-y-4 text-base leading-7 text-black/70 [overflow-wrap:anywhere]">
          {narrative.paragraphs.map((paragraph) => <p key={`segment-${paragraph.componentIndex}-paragraph-${paragraph.paragraphIndex}`}>{paragraph.text}</p>)}
        </div>
      : <p role="status" className="text-sm leading-6 text-black/45">Course Brief is unavailable for this route.</p>;
  }

  return (
    <section aria-labelledby="course-brief-heading" className="mt-10 min-w-0 rounded-3xl border border-black/10 bg-[#f4f2ed] p-5 sm:p-7">
      <div className="mb-5">
        <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#71805d]">GPX-derived summary</p>
        <h3 id="course-brief-heading" className="mt-2 text-2xl font-semibold tracking-[-0.03em] text-[#17211c]">Course Brief</h3>
      </div>
      {content}
    </section>
  );
}
