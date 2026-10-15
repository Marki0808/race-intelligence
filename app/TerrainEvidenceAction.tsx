"use client";

import type { TerrainEvidenceState } from "./routeSectionPresentation";

export default function TerrainEvidenceAction({ state, onCheck }: { state: TerrainEvidenceState; onCheck: () => void }) {
  const loading = state === "loading";
  return (
    <button type="button" onClick={onCheck} disabled={loading} className="rounded-full bg-[#17211c] px-5 py-3 text-sm font-semibold text-white transition hover:bg-[#2b3a31] disabled:opacity-60">
      {loading ? "Checking mapped terrain…" : state === "ready" || state === "unavailable" ? "Refresh mapped terrain" : "Check mapped terrain"}
    </button>
  );
}
