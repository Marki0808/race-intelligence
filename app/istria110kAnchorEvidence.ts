import type { RaceRecordData } from "./raceTypes.ts";
import { istria110kRaceRecord } from "./istria110kData.ts";
import {
  ROUTE_ANCHOR_EVIDENCE_SCHEMA_VERSION,
  RACE_CONTEXT_SCHEMA_VERSION,
  type RaceContextV1,
  type RouteAnchorEvidenceV2,
} from "./routeAnchors.ts";

type ContextLocation = RaceContextV1["locations"][number];

function evidenceForContext(
  record: RaceRecordData,
  locationId: string,
  sourceIds: readonly string[],
): { evidence: RouteAnchorEvidenceV2[]; evidenceIds: string[] } {
  const sources = sourceIds.map((sourceId) => {
    const source = record.sources.find((candidate) => candidate.id === sourceId && candidate.type === "official");
    if (!source) throw new TypeError("Istria anchor context references an unknown official source.");
    return source;
  });
  const evidence = sources.map((source) => ({
    schemaVersion: ROUTE_ANCHOR_EVIDENCE_SCHEMA_VERSION,
    evidenceId: "istria-110k-2027:" + locationId + ":context:" + source.id,
    raceId: record.race.id,
    editionYear: record.edition.year,
    sourceEditionYear: null,
    sourceId: source.id,
    evidenceKind: "official-text-context" as const,
    provenance: "official" as const,
    verificationMethod: "text-review" as const,
  }));
  return { evidence, evidenceIds: evidence.map((item) => item.evidenceId) };
}

/**
 * Checked-in context-only fixture derived solely from the current RaceRecordData.
 * It intentionally contains no guessed coordinates or route kilometers.
 */
export function createIstria110kAnchorEvidenceFixture(record: RaceRecordData = istria110kRaceRecord): {
  context: RaceContextV1;
  evidence: RouteAnchorEvidenceV2[];
} {
  const editionInfo = record.edition.information;
  if (editionInfo.aidStations.knownStations.availability !== "available"
    || editionInfo.logistics.start.availability !== "available"
    || editionInfo.logistics.finishServices.availability !== "available") {
    throw new TypeError("Istria anchor context fixture requires the checked-in available race information.");
  }

  const stations = editionInfo.aidStations.knownStations.value;
  const buzetStation = stations.find((station) => station.name === "Buzet");
  const livadeStation = stations.find((station) => station.name === "Livade");
  if (!buzetStation || !livadeStation) throw new TypeError("Expected checked-in Buzet and Livade station context was not found.");

  const raw = [
    {
      locationId: "start-buzet",
      placeId: "buzet",
      name: record.edition.startLocation,
      type: "START" as const,
      sourceIds: editionInfo.logistics.start.sourceIds,
    },
    {
      locationId: "finish-umag",
      placeId: "umag",
      name: record.edition.finishLocation,
      type: "FINISH" as const,
      sourceIds: editionInfo.logistics.finishServices.sourceIds,
    },
    {
      locationId: "aid-buzet",
      placeId: "buzet",
      name: buzetStation.name,
      type: "AID_STATION" as const,
      sourceIds: editionInfo.aidStations.knownStations.sourceIds,
    },
    {
      locationId: "aid-livade",
      placeId: "livade",
      name: livadeStation.name,
      type: "AID_STATION" as const,
      sourceIds: editionInfo.aidStations.knownStations.sourceIds,
    },
  ];

  const built = raw.map((entry) => ({
    entry,
    ...evidenceForContext(record, entry.locationId, entry.sourceIds),
  }));
  const locations: ContextLocation[] = built.map(({ entry, evidenceIds }) => ({
    locationId: entry.locationId,
    placeId: entry.placeId,
    name: entry.name,
    type: entry.type,
    sourceEditionYear: null,
    evidenceIds,
  }));
  const evidence = built.flatMap((entry) => entry.evidence);
  return {
    context: {
      schemaVersion: RACE_CONTEXT_SCHEMA_VERSION,
      raceId: record.race.id,
      editionYear: record.edition.year,
      raceName: record.race.name,
      sourceIds: [...new Set(evidence.flatMap((entry) => entry.sourceId === null ? [] : [entry.sourceId]))].sort(),
      locations,
    },
    evidence,
  };
}

