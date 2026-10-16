import type { CourseCharacterData, RaceSourceData } from "./raceTypes";

export default function CourseCharacter({
  data,
  terrainSource,
}: {
  data: CourseCharacterData;
  terrainSource?: RaceSourceData;
}) {
  return (
    <section>
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="text-2xl font-semibold">Course Character</h2>
      </div>

      <div className="mt-8 grid gap-6 md:grid-cols-2">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-black/40">
            Organizer&apos;s terrain description
          </p>
          <p className="mt-2 text-sm leading-6 text-black/65">
            {data.terrain}
          </p>
          {terrainSource && /^https?:\/\//i.test(terrainSource.url) && (
            <a href={terrainSource.url} target="_blank" rel="noreferrer" className="mt-2 inline-block text-xs font-medium text-[#71805d] underline underline-offset-4">
              Source: {terrainSource.title} ↗
            </a>
          )}
        </div>

        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-black/40">
            Elevation pattern · GPX-derived
          </p>
          <p className="mt-2 text-sm leading-6 text-black/65">
            {data.elevationPattern}
          </p>
        </div>

        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-black/40">
            Course rhythm · GPX-derived
          </p>
          <p className="mt-2 text-sm leading-6 text-black/65">
            {data.courseRhythm}
          </p>
        </div>
      </div>

      <div className="mt-8">
        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-black/40">
          Attention points · GPX-derived
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
