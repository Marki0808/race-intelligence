"use client";

type KeyMomentProps = {
  title: string;
  distance: string;
  gain?: string;
  loss?: string;
  text: string;
  source: string;
  onSelect?: () => void;
  selected?: boolean;
  compact?: boolean;
  focusStartKm?: number;
focusEndKm?: number;
};

export default function KeyMoment({
  title,
  distance,
  gain,
  loss,
  text,
  source,
  onSelect,
  selected = false,
  compact = false,
}: KeyMomentProps) {
  return (
    <div>
      <h3 className={compact ? "text-xl font-semibold" : "mt-12 text-xl font-semibold"}>
        <button
          type="button"
          onClick={onSelect}
          aria-pressed={onSelect ? selected : undefined}
          className={`${onSelect ? "cursor-pointer text-left" : "cursor-default text-left"} ${selected ? "text-[#53663c] underline decoration-[#a7c957] decoration-2 underline-offset-4" : ""} focus-visible:rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#71805d]`}
        >
          {title}
        </button>
      </h3>

      <div className="mt-4 flex flex-wrap gap-x-4 gap-y-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-black/45">
        <span>{distance}</span>

        {gain && <span className="text-[#71805d]">{gain}</span>}

        {loss && <span className="text-black/45">{loss}</span>}
      </div>

      <p className="mt-4 text-sm leading-6 text-black/55">
        {text}
      </p>

      <div className="mt-5 text-[10px] font-semibold uppercase tracking-[0.18em] text-[#71805d]">
        🔵 {source}
      </div>
    </div>
  );
}
