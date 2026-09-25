"use client";

type KeyMomentProps = {
  title: string;
  distance: string;
  gain?: string;
  loss?: string;
  text: string;
  source: string;
  onSelect?: () => void;
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
  compact = false,
}: KeyMomentProps) {
  return (
    <div>
      <h3 className={compact ? "text-xl font-semibold" : "mt-12 text-xl font-semibold"}>
        <button
          type="button"
          onClick={onSelect}
          className={onSelect ? "cursor-pointer text-left" : "cursor-default text-left"}
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
