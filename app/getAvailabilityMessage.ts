import type { InformationAvailability } from "./raceTypes";

type UnavailableState = Exclude<InformationAvailability, "available">;

export function getUnavailableInformationMessage(
  state: UnavailableState,
  subject: string,
): string {
  switch (state) {
    case "not-found":
      return `${subject} not found in official race information.`;
    case "unknown":
      return `${subject} is not currently known.`;
    case "not-applicable":
      return `${subject} does not apply to this race edition.`;
  }
}
