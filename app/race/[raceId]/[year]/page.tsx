import { notFound } from "next/navigation";
import RacePageContent from "../../../RacePageContent";
import { raceRegistry } from "../../../raceRegistry";
import { createRaceResolver } from "../../../raceResolver";

const resolveRace = createRaceResolver(raceRegistry);

export default async function RaceEditionPage({
  params,
}: {
  params: Promise<{ raceId: string; year: string }>;
}) {
  const { raceId, year: yearParam } = await params;
  const year = Number(yearParam);

  if (!Number.isInteger(year)) {
    notFound();
  }

  const result = resolveRace.resolveByRaceEdition(raceId, year);

  if (result.status === "not-found") {
    notFound();
  }

  return <RacePageContent record={result.record} />;
}
