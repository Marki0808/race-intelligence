import type { ReactNode } from "react";
import RaceProvenanceBadge from "./RaceProvenanceBadge";
import type {
  InformationAvailability as InformationAvailabilityState,
  RaceInformation,
  RaceSourceData,
} from "./raceTypes";
import { getUnavailableInformationMessage } from "./getAvailabilityMessage";

type UnavailableState = Exclude<InformationAvailabilityState, "available">;

export function AvailabilityNotice({
  state,
  subject,
  note,
}: {
  state: UnavailableState;
  subject: string;
  note?: string;
}) {
  return (
    <p className="rounded-xl bg-[#f4f2ed] px-4 py-3 text-sm leading-6 text-black/50">
      {note ?? getUnavailableInformationMessage(state, subject)}
    </p>
  );
}

export function RaceInformationSources({
  sourceIds,
  sources,
}: {
  sourceIds: string[];
  sources: RaceSourceData[];
}) {
  const references = sourceIds
    .map((sourceId) => sources.find((source) => source.id === sourceId))
    .filter((source): source is RaceSourceData => source !== undefined);
  const uniqueReferences = references.filter(
    (source, index) =>
      references.findIndex((candidate) => candidate.id === source.id) === index,
  );

  if (uniqueReferences.length === 0) return null;

  return (
    <div className="mt-3 flex flex-wrap gap-2">
      {uniqueReferences.map((source) => {
        const isExternal = /^https?:\/\//i.test(source.url);

        return (
          <a
            key={source.id}
            href={source.url}
            target={isExternal ? "_blank" : undefined}
            rel={isExternal ? "noreferrer" : undefined}
            className="inline-flex items-center gap-2 text-xs text-[#71805d] underline decoration-[#71805d]/30 underline-offset-4 transition hover:text-[#536b2e]"
          >
            {source.title}
            <RaceProvenanceBadge type={source.type} />
          </a>
        );
      })}
    </div>
  );
}

export function InformationValue<T>({
  information,
  subject,
  sources,
  renderValue,
  showSources = true,
}: {
  information: RaceInformation<T>;
  subject: string;
  sources: RaceSourceData[];
  renderValue: (value: T) => ReactNode;
  showSources?: boolean;
}) {
  return (
    <div>
      {information.availability === "available" ? (
        renderValue(information.value)
      ) : (
        <AvailabilityNotice
          state={information.availability}
          subject={subject}
          note={information.note}
        />
      )}
      {showSources && (
        <RaceInformationSources
          sourceIds={information.sourceIds}
          sources={sources}
        />
      )}
    </div>
  );
}
