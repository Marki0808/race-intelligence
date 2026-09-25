"use client";

import { useEffect, useState } from "react";
import CourseExplorer from "./CourseExplorer";
import KeyMoment from "./KeyMoment";
import { analyzeGpxRoute, parseGpxText } from "./gpxAnalysis";
import type { RouteAnalysisData } from "./gpxAnalysis";
import type { RaceRecordData } from "./raceTypes";

export default function CourseSection({
  raceRecord,
}: {
  raceRecord: RaceRecordData;
}) {
  const [selectedMoment, setSelectedMoment] = useState<string | null>(null);
  const [routeAnalysis, setRouteAnalysis] = useState<RouteAnalysisData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

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
          setRouteAnalysis(analysis);
          setLoading(false);
        }
      } catch {
        if (!cancelled) {
          setError("Could not load or analyze this race GPX.");
          setLoading(false);
        }
      }
    }

    void loadRaceGpx();
    return () => {
      cancelled = true;
    };
  }, [raceRecord.edition.gpxPath, raceRecord.edition.year, raceRecord.race.name]);

  return (
    <div>
      <CourseExplorer
        selectedMoment={selectedMoment}
        routeName={`${raceRecord.race.name} · ${raceRecord.edition.year}`}
        startLocation={raceRecord.edition.startLocation}
        finishLocation={raceRecord.edition.finishLocation}
        routeAnalysis={routeAnalysis}
        keyMoments={raceRecord.intelligence.keyMoments}
        loading={loading}
        error={error}
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
