import type { RaceRecordData } from "./raceTypes";

export type RaceResolutionResult =
  | { status: "resolved"; record: RaceRecordData }
  | { status: "not-found"; record: null };

export type RaceResolver = ((query: string, url?: string) => RaceResolutionResult) & {
  resolveByRaceEdition: (raceId: string, year: number) => RaceResolutionResult;
};

export function normalizeRaceInput(input: string): string {
  return input.trim().toLowerCase().replace(/\s+/g, " ");
}

export function getRaceRoute(record: RaceRecordData): string {
  return `/race/${encodeURIComponent(record.race.id)}/${record.edition.year}`;
}

function normalizeRaceUrl(input: string): string {
  try {
    const url = new URL(input.trim());
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    const path = url.pathname.toLowerCase().replace(/\/{2,}/g, "/").replace(/\/+$/, "");

    return `${host}${path}`;
  } catch {
    return normalizeRaceInput(input).replace(/\/+$/, "");
  }
}

export function createRaceResolver(records: readonly RaceRecordData[]) {
  const resolveByQuery = (query: string, url?: string): RaceResolutionResult => {
    const normalizedQuery = normalizeRaceInput(query);
    const queryUrl = normalizeRaceUrl(query);
    const providedUrl = url ? normalizeRaceUrl(url) : null;

    const record = records.find((candidate) => {
      const matchesName =
        normalizeRaceInput(candidate.race.name) === normalizedQuery;
      const matchesUrl = candidate.sources.some((source) => {
        const normalizedSourceUrl = normalizeRaceUrl(source.url);
        return (
          normalizedSourceUrl === queryUrl ||
          (providedUrl !== null && normalizedSourceUrl === providedUrl)
        );
      });

      return matchesName || matchesUrl;
    });

    return record
      ? { status: "resolved", record }
      : { status: "not-found", record: null };
  };

  const resolveByRaceEdition = (
    raceId: string,
    year: number,
  ): RaceResolutionResult => {
    const record = records.find(
      (candidate) =>
        candidate.race.id === raceId && candidate.edition.year === year,
    );

    return record
      ? { status: "resolved", record }
      : { status: "not-found", record: null };
  };

  return Object.assign(resolveByQuery, { resolveByRaceEdition }) as RaceResolver;
}
