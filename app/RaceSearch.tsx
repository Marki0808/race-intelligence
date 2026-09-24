"use client";

import { useMemo, useState } from "react";
import type { FormEvent } from "react";
import Link from "next/link";
import {
  createRaceResolver,
  getRaceRoute,
  type RaceResolutionResult,
} from "./raceResolver";
import type { RaceRecordData } from "./raceTypes";

export default function RaceSearch({
  records,
}: {
  records: readonly RaceRecordData[];
}) {
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<RaceResolutionResult | null>(null);
  const resolveRace = useMemo(() => createRaceResolver(records), [records]);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setResult(resolveRace(query));
  }

  return (
    <div className="mt-9 max-w-2xl">
      <form onSubmit={handleSubmit} className="flex flex-col gap-3 sm:flex-row">
        <label className="sr-only" htmlFor="race-search">
          Enter a race name or paste a race URL
        </label>
        <input
          id="race-search"
          type="text"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setResult(null);
          }}
          placeholder="Enter a race name or paste a race URL"
          className="min-w-0 flex-1 rounded-full border border-white/20 bg-white/5 px-5 py-3 text-sm text-white outline-none transition placeholder:text-white/40 focus:border-[#a7c957]"
        />
        <button
          type="submit"
          className="rounded-full bg-[#a7c957] px-6 py-3 text-sm font-semibold text-[#17211c] transition hover:bg-[#b8d86b]"
        >
          Find race
        </button>
      </form>

      {result?.status === "resolved" && (
        <div
          aria-live="polite"
          className="mt-4 rounded-2xl border border-white/10 bg-white/5 p-5"
        >
          <p className="text-sm font-semibold text-[#a7c957]">Race found</p>
          <h2 className="mt-2 text-lg font-semibold text-white">
            {result.record.race.name} · {result.record.edition.year}
          </h2>
          <dl className="mt-4 grid grid-cols-2 gap-x-5 gap-y-3 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-white/40">Distance</dt>
              <dd className="mt-1 text-white/80">
                {result.record.edition.distanceKm} km
              </dd>
            </div>
            <div>
              <dt className="text-white/40">Elevation gain</dt>
              <dd className="mt-1 text-white/80">
                {result.record.edition.elevationGainM.toLocaleString("en-US")} m+
              </dd>
            </div>
            <div>
              <dt className="text-white/40">Start</dt>
              <dd className="mt-1 text-white/80">
                {result.record.edition.startLocation}
              </dd>
            </div>
            <div>
              <dt className="text-white/40">Finish</dt>
              <dd className="mt-1 text-white/80">
                {result.record.edition.finishLocation}
              </dd>
            </div>
          </dl>
          <Link
            href={getRaceRoute(result.record)}
            className="mt-5 inline-flex rounded-full bg-[#a7c957] px-5 py-2.5 text-sm font-semibold text-[#17211c] transition hover:bg-[#b8d86b]"
          >
            Open race
          </Link>
        </div>
      )}

      {result?.status === "not-found" && (
        <p aria-live="polite" className="mt-4 text-sm text-white/60">
          We couldn&apos;t find that race yet.
        </p>
      )}
    </div>
  );
}
