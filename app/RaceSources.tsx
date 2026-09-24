import type { RaceSourceData } from "./raceTypes";

const provenanceLabels: Record<RaceSourceData["type"], string> = {
  official: "Official",
  gpx: "GPX",
  "previous-edition": "Previous edition",
  estimated: "Estimated",
};

const provenanceStyles: Record<RaceSourceData["type"], string> = {
  official: "bg-[#e8f0d6] text-[#536b2e]",
  gpx: "bg-[#e4edf5] text-[#426b8c]",
  "previous-edition": "bg-[#f5efd9] text-[#8a7130]",
  estimated: "bg-[#f4e6dc] text-[#94613f]",
};

export default function RaceSources({
  sources,
}: {
  sources: RaceSourceData[];
}) {
  return (
    <section id="sources" className="bg-[#f4f2ed]">
      <div className="mx-auto max-w-7xl px-6 py-20 lg:px-10 lg:py-28">
        <div className="grid gap-12 lg:grid-cols-[0.8fr_1.2fr]">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.25em] text-[#71805d]">
              Source & provenance
            </p>
            <h2 className="mt-4 text-4xl font-semibold tracking-[-0.035em] sm:text-5xl">
              Sources
            </h2>
          </div>

          <div className="overflow-hidden rounded-[1.5rem] border border-black/10 bg-white">
            {sources.map((source, index) => {
              const isExternal = /^https?:\/\//i.test(source.url);

              return (
                <div
                  key={`${source.type}-${source.url}`}
                  className={`grid grid-cols-[auto_1fr] gap-4 p-5 ${
                    index < sources.length - 1 ? "border-b border-black/10" : ""
                  }`}
                >
                  <span
                    aria-hidden="true"
                    className={`mt-1 h-2.5 w-2.5 rounded-full ${
                      source.type === "official"
                        ? "bg-[#718f3b]"
                        : source.type === "gpx"
                          ? "bg-[#5f87a6]"
                          : source.type === "previous-edition"
                            ? "bg-[#c2a344]"
                            : "bg-[#b77b50]"
                    }`}
                  />
                  <div>
                    <div className="flex flex-wrap items-center gap-3">
                      <p className="font-semibold">{source.title}</p>
                      <span
                        className={`rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] ${provenanceStyles[source.type]}`}
                      >
                        {provenanceLabels[source.type]}
                      </span>
                    </div>
                    {isExternal ? (
                      <a
                        href={source.url}
                        target="_blank"
                        rel="noreferrer"
                        className="mt-2 inline-block text-sm text-[#71805d] underline decoration-[#71805d]/30 underline-offset-4 transition hover:text-[#536b2e]"
                      >
                        Open source ↗
                      </a>
                    ) : (
                      <p className="mt-2 break-all text-sm text-black/45">
                        Source reference: {source.url}
                      </p>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}
