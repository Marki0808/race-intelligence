"use client";

import { useState } from "react";
import CourseExplorer from "./CourseExplorer";
import KeyMoment from "./KeyMoment";
import type { RaceRecordData } from "./raceTypes";

export default function CourseSection({
  raceRecord,
}: {
  raceRecord: RaceRecordData;
}) {

  const [selectedMoment, setSelectedMoment] = useState<string | null>(null);

  return (
    <div>
      <CourseExplorer
        selectedMoment={selectedMoment}
        race={raceRecord.race}
        edition={raceRecord.edition}
        keyMoments={raceRecord.intelligence.keyMoments}
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
