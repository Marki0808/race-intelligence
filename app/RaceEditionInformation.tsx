import type { ReactNode } from "react";
import {
  InformationValue,
  RaceInformationSources,
} from "./InformationAvailability";
import type {
  AidStationData,
  RaceEditionInformationData,
  RaceInformation,
  RaceSourceData,
} from "./raceTypes";

export default function RaceEditionInformation({
  information,
  sources,
}: {
  information: RaceEditionInformationData;
  sources: RaceSourceData[];
}) {
  return (
    <>
      <section id="aid-stations" className="bg-[#f4f2ed]">
        <div className="mx-auto max-w-7xl px-6 py-16 lg:px-10 lg:py-20">
          <SectionHeading eyebrow="Race day support" title="Aid Stations" />
          <div className="mt-10 grid gap-6 lg:grid-cols-2">
            <div className="rounded-3xl border border-black/10 bg-white p-6">
              <h3 className="text-lg font-semibold">Station count</h3>
              <InformationValue
                information={information.aidStations.stationCount}
                subject="Aid station count"
                sources={sources}
                renderValue={(value) => (
                  <p className="mt-3 text-sm leading-6 text-black/60">
                    {value.aidStations} aid stations, plus the final station in {value.finishStation}.
                  </p>
                )}
              />
              <div className="mt-6 border-t border-black/10 pt-5">
                <h4 className="text-sm font-semibold">General station supplies</h4>
                <InformationValue
                  information={information.aidStations.generalServices}
                  subject="General aid station supplies"
                  sources={sources}
                  renderValue={(items) => <DetailList items={items} />}
                />
              </div>
            </div>

            <div className="rounded-3xl border border-black/10 bg-white p-6">
              <h3 className="text-lg font-semibold">Known named stations</h3>
              <InformationValue
                information={information.aidStations.knownStations}
                subject="Named aid stations"
                sources={sources}
                renderValue={(stations) => (
                  <div className="mt-4 space-y-4">
                    {stations.map((station) => (
                      <AidStationCard
                        key={station.id}
                        station={station}
                        sources={sources}
                      />
                    ))}
                  </div>
                )}
              />
              <div className="mt-6 border-t border-black/10 pt-5">
                <h4 className="text-sm font-semibold">Full station list</h4>
                <InformationValue
                  information={information.aidStations.completeList}
                  subject="Full station list"
                  sources={sources}
                  renderValue={() => null}
                />
              </div>
            </div>
          </div>
        </div>
      </section>

      <section id="cutoffs" className="bg-white">
        <div className="mx-auto max-w-7xl px-6 py-16 lg:px-10 lg:py-20">
          <SectionHeading eyebrow="Time limits" title="Cutoffs" />
          <div className="mt-10 grid gap-6 lg:grid-cols-2">
            <div className="rounded-3xl border border-black/10 bg-[#f4f2ed] p-6">
              <h3 className="text-lg font-semibold">Finish cutoff</h3>
              <InformationValue
                information={information.cutoffs.finish}
                subject="Finish cutoff"
                sources={sources}
                renderValue={(value) => (
                  <p className="mt-3 text-sm leading-6 text-black/60">
                    {value.location} · {value.elapsedHours} hours elapsed.
                  </p>
                )}
              />
            </div>
            <div className="rounded-3xl border border-black/10 bg-[#f4f2ed] p-6">
              <h3 className="text-lg font-semibold">Intermediate cutoffs</h3>
              <InformationValue
                information={information.cutoffs.intermediate}
                subject="Intermediate cutoff information"
                sources={sources}
                renderValue={(items) => <DetailList items={items} />}
              />
            </div>
          </div>
        </div>
      </section>

      <section id="race-logistics" className="bg-[#f4f2ed]">
        <div className="mx-auto max-w-7xl px-6 py-16 lg:px-10 lg:py-20">
          <SectionHeading eyebrow="Before and after the start" title="Race Logistics" />
          <div className="mt-10 grid gap-5 md:grid-cols-2 xl:grid-cols-3">
            {(
              [
                ["start", "Start"],
                ["bibPickupExpo", "Bib pickup & expo"],
                ["transport", "Transport to the start"],
                ["dropBags", "Drop bags"],
                ["finishServices", "Finish & post-race"],
                ["awards", "Awards"],
              ] as const
            ).map(([key, title]) => (
              <div
                key={key}
                className="rounded-3xl border border-black/10 bg-white p-6"
              >
                <h3 className="text-lg font-semibold">{title}</h3>
                <InformationValue
                  information={information.logistics[key]}
                  subject={`${title} information`}
                  sources={sources}
                  renderValue={(items) => <DetailList items={items} />}
                />
              </div>
            ))}
          </div>
        </div>
      </section>
    </>
  );
}

function AidStationCard({
  station,
  sources,
}: {
  station: AidStationData;
  sources: RaceSourceData[];
}) {
  const sourceIds = [
    ...station.distanceKm.sourceIds,
    ...station.support.sourceIds,
    ...station.services.sourceIds,
    ...station.dropBag.sourceIds,
  ];

  return (
    <article className="rounded-2xl border border-black/10 bg-[#f4f2ed] p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h4 className="font-semibold">{station.name}</h4>
        <InformationValue
          information={station.distanceKm}
          subject={`${station.name} distance`}
          sources={sources}
          showSources={false}
          renderValue={(distance) => (
            <span className="text-xs text-black/55">{distance} km</span>
          )}
        />
      </div>
      <dl className="mt-4 space-y-4">
        <StationFact
          label="Support"
          information={station.support}
          sources={sources}
          valueRenderer={(value) => <p>{value}</p>}
        />
        <StationFact
          label="Services"
          information={station.services}
          sources={sources}
          valueRenderer={(items) => <DetailList items={items} />}
        />
        <StationFact
          label="Drop bag"
          information={station.dropBag}
          sources={sources}
          valueRenderer={(value) => <p>{value}</p>}
        />
      </dl>
      <RaceInformationSources sourceIds={sourceIds} sources={sources} />
    </article>
  );
}

function StationFact<T>({
  label,
  information,
  sources,
  valueRenderer,
}: {
  label: string;
  information: RaceInformation<T>;
  sources: RaceSourceData[];
  valueRenderer: (value: T) => ReactNode;
}) {
  return (
    <div>
      <dt className="text-xs font-semibold uppercase tracking-[0.15em] text-black/40">
        {label}
      </dt>
      <dd className="mt-1 text-sm leading-6 text-black/60">
        <InformationValue
          information={information}
          subject={`${label} at this station`}
          sources={sources}
          showSources={false}
          renderValue={valueRenderer}
        />
      </dd>
    </div>
  );
}

function DetailList({ items }: { items: string[] }) {
  return (
    <ul className="mt-3 space-y-2 text-sm leading-6 text-black/60">
      {items.map((item) => (
        <li key={item} className="flex gap-2">
          <span aria-hidden="true" className="text-[#71805d]">•</span>
          <span>{item}</span>
        </li>
      ))}
    </ul>
  );
}

function SectionHeading({ eyebrow, title }: { eyebrow: string; title: string }) {
  return (
    <div>
      <p className="text-xs font-semibold uppercase tracking-[0.25em] text-[#71805d]">
        {eyebrow}
      </p>
      <h2 className="mt-3 text-3xl font-semibold tracking-[-0.035em] sm:text-4xl">
        {title}
      </h2>
    </div>
  );
}
