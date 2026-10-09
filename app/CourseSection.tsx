"use client";

import { useEffect, useState } from "react";
import CourseExplorer from "./CourseExplorer";
import CourseBriefView from "./CourseBriefView";
import KeyMoment from "./KeyMoment";
import { analyzeGpxRoute, parseGpxText } from "./gpxAnalysis";
import type { RouteAnalysisData } from "./gpxAnalysis";
import type { RaceRecordData } from "./raceTypes";

export default function CourseSection({
  raceRecord,
}: {
  raceRecord: RaceRecordData;
}) {
  const editionKey = JSON.stringify([raceRecord.race.id, raceRecord.edition.year, raceRecord.edition.gpxPath]);
  const [selectedMoment, setSelectedMoment] = useState<string | null>(null);
  const [loadState, setLoadState] = useState<
    | { editionKey: string; status: "ready"; analysis: RouteAnalysisData }
    | { editionKey: string; status: "error"; message: string }
    | null
  >(null);
  const currentLoad = loadState?.editionKey === editionKey ? loadState : null;
  const routeAnalysis = currentLoad?.status === "ready" ? currentLoad.analysis : null;
  const currentError = currentLoad?.status === "error" ? currentLoad.message : "";
  const isLoading = currentLoad === null;

  useEffect(() => {
    let cancelled = false;

    async function loadRaceGpx() {
      try {
        const response = await fetch(raceRecord.edition.gpxPath);
        if (!response.ok) throw new Error("The race GPX could not be loaded.");
        const parsed = parseGpxText(await response.text());
        const analysis = analyzeGpxRoute(
          parsed,
          `${raceRecord.race.name} ${raceRecord.edition.year}`,
        );
        if (!cancelled) {
          setLoadState({ editionKey, status: "ready", analysis });
        }
      } catch {
        if (!cancelled) {
          setLoadState({ editionKey, status: "error", message: "Could not load or analyze this race GPX." });
        }
      }
    }

    void loadRaceGpx();
    return () => {
      cancelled = true;
    };
  }, [editionKey, raceRecord.edition.gpxPath, raceRecord.edition.year, raceRecord.race.name]);

  return (
    <div>
      <CourseExplorer
        selectedMoment={selectedMoment}
        routeName={`${raceRecord.race.name} · ${raceRecord.edition.year}`}
        startLocation={raceRecord.edition.startLocation}
        finishLocation={raceRecord.edition.finishLocation}
        routeAnalysis={routeAnalysis}
        keyMoments={raceRecord.intelligence.keyMoments}
        loading={isLoading}
        error={currentError}
      />
      <CourseBriefView
        key={editionKey}
        routeKey={editionKey}
        routeAnalysis={routeAnalysis}
        loading={isLoading}
      />
      <p className="mt-4 text-sm text-black/50">
        Selected: {selectedMoment ?? "None"}
      </p>

      <div className="mt-16">
        {raceRecord.intelligence.keyMoments.map((item) => (
          <KeyMoment
            key={item.id}
            title={item.title}
            onSelect={() => setSelectedMoment(item.title)}
            distance={item.distance}
            focusStartKm={item.focusStartKm}
            focusEndKm={item.focusEndKm}
            gain={item.gain}
            loss={item.loss}
            text={item.text}
            source={item.source}
          />
        ))}
      </div>
    </div>
  );
}
