"use client";

type KeyMomentProps = {
  title: string;
  distance: string;
  gain?: string;
  loss?: string;
  text: string;
  source: string;
  onSelect?: () => void;
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
}: KeyMomentProps) {
  return (
    <div>
      <h3
  onClick={onSelect}
  className="mt-12 cursor-pointer text-xl font-semibold"
>
        {title}
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