import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { istria110kRaceRecord } from "./istria110kData.ts";
import { getUnavailableInformationMessage } from "./getAvailabilityMessage.ts";

const gpxText = await readFile(
  new URL("../public/ISTRIA_110K_2027.gpx", import.meta.url),
  "utf8",
);

const trackPoints = [...gpxText.matchAll(/<trkpt\s+lat="([^"]+)"\s+lon="([^"]+)"[^>]*>[\s\S]*?<ele>([^<]+)<\/ele>[\s\S]*?<\/trkpt>/g)].map(
  (match) => ({
    lat: Number(match[1]),
    lon: Number(match[2]),
    ele: Number(match[3]),
    distance: 0,
  }),
);

function haversineDistance(lat1, lon1, lat2, lon2) {
  const earthRadius = 6371000;
  const toRadians = (value) => (value * Math.PI) / 180;
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(lat1)) *
      Math.cos(toRadians(lat2)) *
      Math.sin(dLon / 2) ** 2;

  return 2 * earthRadius * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

for (let index = 1; index < trackPoints.length; index += 1) {
  const previous = trackPoints[index - 1];
  const point = trackPoints[index];
  point.distance =
    previous.distance +
    haversineDistance(previous.lat, previous.lon, point.lat, point.lon);
}

function readMeters(value) {
  return Number(value.replaceAll(",", "").replace("−", "-").match(/[+-]?\d+/)?.[0]);
}

function statsForRange(startKm, endKm) {
  const points = trackPoints.filter(
    (point) => point.distance >= startKm * 1000 && point.distance <= endKm * 1000,
  );
  let gain = 0;
  let loss = 0;

  for (let index = 1; index < points.length; index += 1) {
    const difference = points[index].ele - points[index - 1].ele;
    if (difference > 0) gain += difference;
    else loss += Math.abs(difference);
  }

  return { points, gain: Math.round(gain), loss: Math.round(loss) };
}

test("Istria race and edition identity retain the validated 2027 facts", () => {
  const { race, edition, sources } = istria110kRaceRecord;
  assert.equal(race.id, "istria-110k");
  assert.equal(race.name, "Istria 110K");
  assert.equal(race.editions.length, 1);
  assert.equal(race.editions[0], edition);
  assert.deepEqual(
    {
      year: edition.year,
      distanceKm: edition.distanceKm,
      elevationGainM: edition.elevationGainM,
      startLocation: edition.startLocation,
      finishLocation: edition.finishLocation,
      gpxPath: edition.gpxPath,
    },
    {
      year: 2027,
      distanceKm: 111,
      elevationGainM: 4200,
      startLocation: "Buzet",
      finishLocation: "Umag",
      gpxPath: "/ISTRIA_110K_2027.gpx",
    },
  );
  assert.deepEqual(
    sources.filter((source) => source.type === "official").map((source) => source.url),
    [
      "https://istria.utmb.world/races/110K",
      "https://istria.utmb.world/hr/races/110K",
      "https://istria.utmb.world/races-runners/other-information/FAQ",
      "https://istria.utmb.world/discover/the-event/schedule",
      "https://istria.utmb.world/races-runners/runners/regulations",
    ],
  );
  assert.equal(sources.find((source) => source.type === "gpx")?.url, edition.gpxPath);
});

test("GPX course analysis matches calculations from the checked-in track", () => {
  const { courseAnalysis } = istria110kRaceRecord;
  const totalDistanceKm = trackPoints.at(-1).distance / 1000;
  const totalGain = trackPoints.reduce((gain, point, index) => {
    if (index === 0) return gain;
    return gain + Math.max(point.ele - trackPoints[index - 1].ele, 0);
  }, 0);
  const totalLoss = trackPoints.reduce((loss, point, index) => {
    if (index === 0) return loss;
    return loss + Math.max(trackPoints[index - 1].ele - point.ele, 0);
  }, 0);
  const highPoint = trackPoints.reduce((highest, point) =>
    point.ele > highest.ele ? point : highest,
  );

  assert.equal(trackPoints.length > 0, true);
  assert.equal(courseAnalysis.distanceKm, Number(totalDistanceKm.toFixed(2)));
  assert.equal(courseAnalysis.elevationGainM, Math.round(totalGain));
  assert.equal(courseAnalysis.elevationLossM, Math.round(totalLoss));
  assert.equal(courseAnalysis.highestPointM, highPoint.ele);
  assert.equal(courseAnalysis.highestPointDistanceKm, Number((highPoint.distance / 1000).toFixed(1)));
  assert.equal(courseAnalysis.lowestPointM, Math.min(...trackPoints.map((point) => point.ele)));
});

test("every Key Moment range and displayed gain/loss match the GPX", () => {
  const { keyMoments } = istria110kRaceRecord.intelligence;
  assert.equal(keyMoments.length, 6);

  for (const moment of keyMoments) {
    assert.ok(moment.focusStartKm >= 0, `${moment.id} starts within the track`);
    assert.ok(moment.focusEndKm > moment.focusStartKm, `${moment.id} has a positive range`);
    const stats = statsForRange(moment.focusStartKm, moment.focusEndKm);
    assert.ok(stats.points.length > 0, `${moment.id} contains GPX track points`);
    assert.ok(
      stats.points.at(-1).distance <= trackPoints.at(-1).distance,
      `${moment.id} ends within the GPX track`,
    );
    assert.equal(readMeters(moment.gain), stats.gain, `${moment.id} GPX gain`);
    assert.equal(readMeters(moment.loss), -stats.loss, `${moment.id} GPX loss`);
  }
});

test("the Žbevnica moment identifies the GPX high point without confusing it with gain", () => {
  const { keyMoments } = istria110kRaceRecord.intelligence;
  const highPointMoment = keyMoments.find((moment) => moment.id === "zbevnica");
  const highPoint = trackPoints.reduce((highest, point) =>
    point.ele > highest.ele ? point : highest,
  );

  assert.ok(highPointMoment);
  assert.ok(highPoint.distance >= highPointMoment.focusStartKm * 1000);
  assert.ok(highPoint.distance <= highPointMoment.focusEndKm * 1000);
  assert.match(highPointMoment.text, /1,017 m/);
  assert.equal(readMeters(highPointMoment.gain), 489);
  assert.equal(
    Math.round(highPoint.distance / 100) / 10,
    istria110kRaceRecord.courseAnalysis.highestPointDistanceKm,
  );
});

test("town names are not assigned to unsupported middle-course kilometre ranges", () => {
  const { keyMoments } = istria110kRaceRecord.intelligence;
  assert.equal(keyMoments.find((moment) => moment.id === "middle-course-transition")?.title, "Middle-course transition");
  assert.equal(keyMoments.find((moment) => moment.id === "middle-course-climbs")?.title, "Middle-course climbs");
});

test("aid station information is edition-specific, sourced, and does not invent distances", () => {
  const { race, edition } = istria110kRaceRecord;
  const aidStations = edition.information.aidStations;
  assert.equal(race.editions.find((item) => item.year === edition.year), edition);
  assert.equal(aidStations.stationCount.availability, "available");
  assert.deepEqual(aidStations.stationCount.value, {
    aidStations: 7,
    finishStation: "Umag",
  });
  assert.equal(aidStations.knownStations.availability, "available");
  assert.deepEqual(
    aidStations.knownStations.value.map((station) => station.name),
    ["Buzet", "Livade"],
  );
  assert.equal(aidStations.completeList.availability, "not-found");

  for (const station of aidStations.knownStations.value) {
    assert.equal(station.distanceKm.availability, "not-found");
    assert.equal("value" in station.distanceKm, false);
  }
});

test("cutoff facts distinguish the finish limit from unavailable intermediate cutoffs", () => {
  const { cutoffs } = istria110kRaceRecord.edition.information;
  assert.equal(cutoffs.finish.availability, "available");
  assert.deepEqual(cutoffs.finish.value, { location: "Finish", elapsedHours: 28 });
  assert.equal("distanceKm" in cutoffs.finish.value, false);
  assert.equal(cutoffs.intermediate.availability, "not-found");
  assert.match(cutoffs.intermediate.note, /No official intermediate cutoff locations or times/);
});

test("logistics categories and fact provenance are explicit", () => {
  const { edition, sources } = istria110kRaceRecord;
  const logistics = edition.information.logistics;
  const categories = [
    logistics.start,
    logistics.bibPickupExpo,
    logistics.transport,
    logistics.dropBags,
    logistics.finishServices,
    logistics.awards,
  ];
  assert.equal(categories.every((category) => category.availability === "available"), true);

  function collectInformation(value, found = []) {
    if (!value || typeof value !== "object") return found;
    if ("availability" in value && "sourceIds" in value) {
      found.push(value);
    }
    for (const child of Object.values(value)) collectInformation(child, found);
    return found;
  }

  const facts = collectInformation(edition.information);
  assert.ok(facts.length > 0);
  for (const fact of facts) {
    for (const sourceId of fact.sourceIds) {
      const source = sources.find((item) => item.id === sourceId);
      assert.ok(source, `source ${sourceId} resolves in the race source registry`);
      assert.equal(source.type, "official");
    }
    if (fact.availability === "available") {
      assert.ok(fact.sourceIds.length > 0);
    }
  }
});

test("generic unavailable information messages distinguish all missing states", () => {
  assert.equal(
    getUnavailableInformationMessage("not-found", "Intermediate cutoffs"),
    "Intermediate cutoffs not found in official race information.",
  );
  assert.equal(
    getUnavailableInformationMessage("unknown", "Timezone"),
    "Timezone is not currently known.",
  );
  assert.equal(
    getUnavailableInformationMessage("not-applicable", "Drop bag"),
    "Drop bag does not apply to this race edition.",
  );
});
