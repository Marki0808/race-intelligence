import type {
  AidStationData,
  CourseCharacterData,
  KeyMomentData,
  RaceData,
  RaceEditionData,
  RaceEditionInformationData,
  RaceInformation,
  RaceRecordData,
} from "./raceTypes";

const officialSourceIds = {
  race: "official-110k",
  raceHr: "official-110k-hr",
  faq: "official-faq",
  schedule: "official-schedule",
  regulations: "official-regulations",
} as const;

function availableInformation<T>(
  value: T,
  sourceIds: string[],
): RaceInformation<T> {
  return { availability: "available", value, sourceIds };
}

function notFoundInformation<T>(
  note: string,
  sourceIds: string[],
): RaceInformation<T> {
  return { availability: "not-found", note, sourceIds };
}

const istria110kEditionInformation: RaceEditionInformationData = {
  aidStations: {
    stationCount: availableInformation(
      { aidStations: 7, finishStation: "Umag" },
      [officialSourceIds.faq],
    ),
    knownStations: availableInformation(
      [
        {
          id: "buzet",
          name: "Buzet",
          distanceKm: notFoundInformation<number>(
            "No official kilometer position found.",
            [officialSourceIds.faq, officialSourceIds.race],
          ),
          support: availableInformation(
            "One support person may assist with an official support wristband, starting five minutes before the runner arrives.",
            [officialSourceIds.faq],
          ),
          services: availableInformation(
            ["Showers", "Beds", "Hot meals"],
            [officialSourceIds.faq],
          ),
          dropBag: availableInformation(
            "The large transition bag is available here. The small start bag and transition bag are returned to Umag after use.",
            [officialSourceIds.faq],
          ),
        },
        {
          id: "livade",
          name: "Livade",
          distanceKm: notFoundInformation<number>(
            "No official kilometer position found.",
            [officialSourceIds.faq, officialSourceIds.race],
          ),
          support: availableInformation(
            "One support person may assist with an official support wristband, starting five minutes before the runner arrives.",
            [officialSourceIds.faq],
          ),
          services: notFoundInformation<string[]>(
            "Station-specific services were not found in the checked official information.",
            [officialSourceIds.faq],
          ),
          dropBag: notFoundInformation<string>(
            "Station-specific drop bag information was not found in the checked official information.",
            [officialSourceIds.faq],
          ),
        },
      ],
      [officialSourceIds.faq],
    ),
    completeList: notFoundInformation<AidStationData[]>(
      "The full station list and official kilometer positions were not found in the checked official information. The FAQ says detailed station locations and opening hours are provided in the Race Info document.",
      [officialSourceIds.faq, officialSourceIds.race],
    ),
    generalServices: availableInformation(
      [
        "The FAQ lists fruit, sweet and salty snacks, bread, pastries, cheese, water, cola, isotonic drinks, coffee, tea and soup among aid station refreshments.",
        "Cups are not provided; runners need to bring their own drink vessel.",
      ],
      [officialSourceIds.faq],
    ),
  },
  cutoffs: {
    finish: availableInformation(
      { location: "Finish", elapsedHours: 28 },
      [officialSourceIds.faq, officialSourceIds.regulations],
    ),
    intermediate: notFoundInformation<string[]>(
      "No official intermediate cutoff locations or times were found in the checked official information.",
      [officialSourceIds.faq, officialSourceIds.regulations],
    ),
  },
  logistics: {
    start: availableInformation(
      ["Saturday, April 3, 2027", "07:00", "Buzet"],
      [officialSourceIds.schedule, officialSourceIds.race],
    ),
    bibPickupExpo: availableInformation(
      [
        "Thursday, April 1: 14:00–20:00 for all race distances.",
        "Friday, April 2: 09:00–12:00 for 168K and 110K; 14:00–20:00 for 110K, 69K, 42K and 21K.",
        "Sports Hall ‘Marija i Lina’, Školska ulica 14, Umag.",
      ],
      [officialSourceIds.schedule, officialSourceIds.faq],
    ),
    transport: availableInformation(
      [
        "The 110K bus departs at 05:15 on Saturday, April 3, from the Sports Hall in Umag.",
        "The FAQ describes the start-city bus shuttle as a booked service; gathering is in front of the sports hall.",
      ],
      [officialSourceIds.schedule, officialSourceIds.faq],
    ),
    dropBags: availableInformation(
      [
        "110K runners receive a small personal bag at the start and a large transition bag for Buzet.",
        "After use, both bags are returned to Umag.",
        "Buzet has showers and beds for runners using the transition stop.",
      ],
      [officialSourceIds.faq],
    ),
    finishServices: availableInformation(
      [
        "The finish line is at Trg Slobode in Umag.",
        "A buffet hot meal is served at one of the official hotels in Umag, with a free shuttle to and from the sports hall.",
        "Showers and massage are available at the sports hall.",
      ],
      [officialSourceIds.schedule, officialSourceIds.faq],
    ),
    awards: availableInformation(
      ["Awards ceremony: Sunday, April 4, 2027 at 13:00, at the Finish Line."],
      [officialSourceIds.schedule],
    ),
  },
};

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
  information: istria110kEditionInformation,
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
    elevationLossM: 4240,
    highestPointM: 1017,
    highestPointDistanceKm: 23.6,
    lowestPointM: 3,
  },
  sources: [
  {
    id: officialSourceIds.race,
    title: "Official Istria 110K race page",
    url: "https://istria.utmb.world/races/110K",
    type: "official",
  },
  {
    id: officialSourceIds.raceHr,
    title: "Official Istria 110K race page (Croatian)",
    url: "https://istria.utmb.world/hr/races/110K",
    type: "official",
  },
  {
    id: officialSourceIds.faq,
    title: "Official Istria 100 by UTMB FAQ",
    url: "https://istria.utmb.world/races-runners/other-information/FAQ",
    type: "official",
  },
  {
    id: officialSourceIds.schedule,
    title: "Official event schedule",
    url: "https://istria.utmb.world/discover/the-event/schedule",
    type: "official",
  },
  {
    id: officialSourceIds.regulations,
    title: "Official race regulations",
    url: "https://istria.utmb.world/races-runners/runners/regulations",
    type: "official",
  },
  {
    id: "official-gpx-110k-2027",
    title: "Official Istria 110K GPX",
    url: "/ISTRIA_110K_2027.gpx",
    type: "gpx",
  },
],
};
