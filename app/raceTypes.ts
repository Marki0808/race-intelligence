export type KeyMomentData = {
  id: string;
  number: string;
  title: string;
  distance: string;
  focusStartKm: number;
  focusEndKm: number;
  gain?: string;
  loss?: string;
  text: string;
  source: string;
};

export type CourseCharacterData = {
  terrain: string;
  elevationPattern: string;
  technicality: string;
  courseRhythm: string;
  attentionPoints: string[];
};
export type RaceIntelligenceData = {
  courseCharacter: CourseCharacterData;
  keyMoments: KeyMomentData[];
};
export type RaceSourceData = {
  title: string;
  url: string;
  type: "official" | "gpx" | "previous-edition" | "estimated" | "unknown";
};
export type RaceEditionData = {
  year: number;
  distanceKm: number;
  elevationGainM: number;
  startLocation: string;
  finishLocation: string;
  gpxPath: string;
};
export type RaceData = {
  id: string;
  name: string;
  editions: RaceEditionData[];
};
export type RaceRecordData = {
  race: RaceData;
  edition: RaceEditionData;
  intelligence: RaceIntelligenceData;
  courseAnalysis: GpxCourseAnalysisData;
  sources: RaceSourceData[];
};

export type GpxCourseAnalysisData = {
  distanceKm: number;
  elevationGainM: number;
  highestPointM: number;
  highestPointDistanceKm: number;
};
