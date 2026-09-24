import type { RaceRecordData } from "./raceTypes";
import { istria110kRaceRecord } from "./istria110kData.ts";

export const raceRegistry: readonly RaceRecordData[] = [istria110kRaceRecord];
export const homepageRaceRecord: RaceRecordData = istria110kRaceRecord;
