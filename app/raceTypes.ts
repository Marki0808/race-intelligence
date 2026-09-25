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
  id: string;
  title: string;
  url: string;
  type: "official" | "gpx" | "previous-edition" | "estimated" | "unknown";
};
export type InformationAvailability =
  | "available"
  | "not-found"
  | "unknown"
  | "not-applicable";
export type RaceInformation<T> =
  | {
      availability: "available";
      value: T;
      sourceIds: string[];
    }
  | {
      availability: Exclude<InformationAvailability, "available">;
      note?: string;
      sourceIds: string[];
    };
export type AidStationData = {
  id: string;
  name: string;
  distanceKm: RaceInformation<number>;
  support: RaceInformation<string>;
  services: RaceInformation<string[]>;
  dropBag: RaceInformation<string>;
};
export type RaceAidStationsData = {
  stationCount: RaceInformation<{
    aidStations: number;
    finishStation: string;
  }>;
  knownStations: RaceInformation<AidStationData[]>;
  completeList: RaceInformation<AidStationData[]>;
  generalServices: RaceInformation<string[]>;
};
export type RaceCutoffsData = {
  finish: RaceInformation<{
    location: string;
    elapsedHours: number;
  }>;
  intermediate: RaceInformation<string[]>;
};
export type RaceLogisticsData = {
  start: RaceInformation<string[]>;
  bibPickupExpo: RaceInformation<string[]>;
  transport: RaceInformation<string[]>;
  dropBags: RaceInformation<string[]>;
  finishServices: RaceInformation<string[]>;
  awards: RaceInformation<string[]>;
};
export type RaceEditionInformationData = {
  aidStations: RaceAidStationsData;
  cutoffs: RaceCutoffsData;
  logistics: RaceLogisticsData;
};
export type RaceEditionData = {
  year: number;
  distanceKm: number;
  elevationGainM: number;
  startLocation: string;
  finishLocation: string;
  gpxPath: string;
  information: RaceEditionInformationData;
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
  elevationLossM: number;
  highestPointM: number;
  highestPointDistanceKm: number;
  lowestPointM: number;
};
