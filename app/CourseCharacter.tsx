import type { CourseCharacterData } from "./raceTypes";

export default function CourseCharacter({
  data,
  sourceLabel,
}: {
  data: CourseCharacterData;
  sourceLabel?: string;
}) {
  return (
    <section>
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="text-2xl font-semibold">Course Character</h2>
        {sourceLabel && (
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#71805d]">
            {sourceLabel}
          </p>
        )}
      </div>

      <div className="mt-8 grid gap-6 md:grid-cols-2">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-black/40">
            Terrain
          </p>
          <p className="mt-2 text-sm leading-6 text-black/65">
            {data.terrain}
          </p>
        </div>

        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-black/40">
            Elevation pattern
          </p>
          <p className="mt-2 text-sm leading-6 text-black/65">
            {data.elevationPattern}
          </p>
        </div>

        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-black/40">
            Technicality
          </p>
          <p className="mt-2 text-sm leading-6 text-black/65">
            {data.technicality}
          </p>
        </div>

        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-black/40">
            Course rhythm
          </p>
          <p className="mt-2 text-sm leading-6 text-black/65">
            {data.courseRhythm}
          </p>
        </div>
      </div>

      <div className="mt-8">
        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-black/40">
          Attention points
        </p>

        <ul className="mt-3 space-y-2 text-sm leading-6 text-black/65">
          {data.attentionPoints.map((point) => (
            <li key={point}>• {point}</li>
          ))}
        </ul>
      </div>
    </section>
  );
}
