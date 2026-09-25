import type {
  CourseCharacterData,
  KeyMomentData,
  RaceData,
  RaceEditionData,
  RaceRecordData,
} from "./raceTypes";
export const istria110kCourseCharacter: CourseCharacterData = {
  terrain: "Mountain and mixed trail terrain, with a rocky and demanding first mountain section.",
  elevationPattern: "A strong early climb leads to the highest point, followed by major descents and repeated climbing through the middle of the course.",
  technicality: "The mountain section toward Buzet is notably rocky and demanding; the later sections become generally easier.",
  courseRhythm: "The course changes character several times: a hard mountain opening, a major descent toward Buzet, repeated climbing through the middle, and a more gradual final approach.",
  attentionPoints: [
    "Large elevation gain appears early in the race.",
    "The highest point is reached around the Žbevnica section.",
    "A major descent follows the high mountain section toward Buzet.",
    "The middle part continues with repeated climbing and descending.",
    "The final third contains less elevation gain overall."
  ],
};

export const istria110kKeyMoments: KeyMomentData[] = [
  {
    id: "early-mountain-climb",
    number: "01",
    title: "Early mountain climb",
    distance: "0–20 km",
    focusStartKm: 0,
    focusEndKm: 20,
    gain: "+1,087 m",
    loss: "−367 m",
    text: "The course gains substantial elevation early, with the main climb concentrated in the first part of the course.",
    source: "GPX-derived",
  },
  {
    id: "zbevnica",
    number: "02",
    title: "Žbevnica",
    distance: "~23.6 km",
    focusStartKm: 20,
    focusEndKm: 30,
    gain: "+489 m",
    loss: "−398 m",
    text: "The GPX reaches its highest point, 1,017 m, at approximately 23.6 km. Official course information identifies Žbevnica among the route's highest peaks.",
    source: "GPX-derived",
  },
    {
    id: "long-descent",
    number: "03",
    title: "Long descent",
    distance: "37.6–41.6 km",
    focusStartKm: 37.6,
    focusEndKm: 41.6,
    gain: "+3 m",
    loss: "−455 m",
    text: "This 4 km GPX range records minor climbing and a sustained descent.",
    source: "GPX-derived",
  },
    {
    id: "middle-course-transition",
    number: "04",
    title: "Middle-course transition",
    distance: "40–55 km",
    focusStartKm: 40,
    focusEndKm: 55,
    gain: "+699 m",
    loss: "−712 m",
    text: "This 15 km GPX section contains substantial climbing and descending.",
    source: "GPX-derived",
  },
    {
    id: "middle-course-climbs",
    number: "05",
    title: "Middle-course climbs",
    distance: "55–75 km",
    focusStartKm: 55,
    focusEndKm: 75,
    gain: "+961 m",
    loss: "−881 m",
    text: "The GPX records another substantial block of climbing and descending through this section.",
    source: "GPX-derived",
  },
    {
    id: "final-approach",
    number: "06",
    title: "Final approach",
    distance: "75–110.7 km",
    focusStartKm: 75,
    focusEndKm: 110.7,
    gain: "+719 m",
    loss: "−926 m",
    text: "The final third has less cumulative climbing per kilometre than the earlier sections and trends downhill toward the official finish in Umag, according to the GPX.",
    source: "GPX-derived",
  },
];
const istria110k2027Edition: RaceEditionData = {
  year: 2027,
  distanceKm: 111,
  elevationGainM: 4200,
  startLocation: "Buzet",
  finishLocation: "Umag",
  gpxPath: "/ISTRIA_110K_2027.gpx",
};

export const istria110kRace: RaceData = {
  id: "istria-110k",
  name: "Istria 110K",
  editions: [istria110k2027Edition],
};

export const istria110kRaceRecord: RaceRecordData = {
  race: istria110kRace,
  edition: istria110k2027Edition,
  intelligence: {
    courseCharacter: istria110kCourseCharacter,
    keyMoments: istria110kKeyMoments,
  },
  courseAnalysis: {
    distanceKm: 110.73,
    elevationGainM: 4168,
    highestPointM: 1017,
    highestPointDistanceKm: 23.6,
  },
  sources: [
  {
    title: "Official Istria 110K race page",
    url: "https://istria.utmb.world/races/110K",
    type: "official",
  },
  {
    title: "Official Istria 110K race page (Croatian)",
    url: "https://istria.utmb.world/hr/races/110K",
    type: "official",
  },
  {
    title: "Official Istria 100 by UTMB FAQ",
    url: "https://istria.utmb.world/races-runners/other-information/FAQ",
    type: "official",
  },
  {
    title: "Official event schedule",
    url: "https://istria.utmb.world/discover/the-event/schedule",
    type: "official",
  },
  {
    title: "Official race regulations",
    url: "https://istria.utmb.world/races-runners/runners/regulations",
    type: "official",
  },
  {
    title: "Official Istria 110K GPX",
    url: "/ISTRIA_110K_2027.gpx",
    type: "gpx",
  },
],
};
