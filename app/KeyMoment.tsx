"use client";

import type { KeyMomentCardPresentation } from "./routeKeyMomentPresentation";

export default function KeyMoment({ number, card, onSelect, selected = false }: {
  number: string;
  card: KeyMomentCardPresentation;
  onSelect: () => void;
  selected?: boolean;
}) {
  return <article className={`rounded-2xl border bg-white transition-colors duration-200 motion-reduce:transition-none ${selected ? "border-[#71805d] ring-2 ring-[#71805d]/25" : "border-black/10"}`}>
    <button type="button" onClick={onSelect} aria-pressed={selected}
      aria-label={`${selected ? "Clear selection of" : "Select"} Key Moment ${number}: ${card.title}. ${card.value}. ${card.locationSentence}`}
      className="flex min-h-36 w-full flex-col items-start rounded-2xl p-4 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#71805d] sm:p-5">
      <span className="flex items-center gap-3">
        <span aria-hidden="true" className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-bold tabular-nums transition-[transform,background-color,color] duration-200 motion-reduce:transition-none sm:h-9 sm:w-9 ${selected ? "scale-110 bg-[#17211c] text-white" : "bg-[#e9eddf] text-[#435537]"}`}>{number}</span>
        <span className="text-sm font-semibold text-[#17211c] sm:text-base">{card.title}</span>
      </span>
      <span className="mt-3 text-2xl font-semibold tabular-nums tracking-tight text-[#17211c] sm:text-3xl">{card.value}</span>
      <span className="mt-2 text-sm leading-5 text-black/65">{card.locationSentence}</span>
    </button>
  </article>;
}
