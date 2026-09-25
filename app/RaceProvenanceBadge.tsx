import type { RaceSourceData } from "./raceTypes";

const provenanceLabels: Record<RaceSourceData["type"], string> = {
  official: "Official",
  gpx: "GPX",
  "previous-edition": "Previous edition",
  estimated: "Estimated",
  unknown: "Unknown",
};

const provenanceStyles: Record<RaceSourceData["type"], string> = {
  official: "bg-[#e8f0d6] text-[#536b2e]",
  gpx: "bg-[#e4edf5] text-[#426b8c]",
  "previous-edition": "bg-[#f5efd9] text-[#8a7130]",
  estimated: "bg-[#f4e6dc] text-[#94613f]",
  unknown: "bg-[#ecebea] text-[#66645f]",
};

export default function RaceProvenanceBadge({
  type,
}: {
  type: RaceSourceData["type"];
}) {
  return (
    <span
      className={`rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] ${provenanceStyles[type]}`}
    >
      {provenanceLabels[type]}
    </span>
  );
}
