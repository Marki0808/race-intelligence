import type { GpxCourseAnalysisData } from "./raceTypes";

export default function CourseAnalysis({
  analysis,
  sourceDescription = "the official GPX track",
  sourceLabel,
  showExtendedMetrics = false,
}: {
  analysis: GpxCourseAnalysisData;
  sourceDescription?: string;
  sourceLabel?: string;
  showExtendedMetrics?: boolean;
}) {
  const metrics = [
    {
      label: "Distance",
      value: `${analysis.distanceKm.toFixed(2)} km`,
      description: `Derived from ${sourceDescription}.`,
    },
    {
      label: "Elevation gain",
      value: `${analysis.elevationGainM.toLocaleString("en-US")} m`,
      description: `Calculated from ${sourceDescription} using the course analysis engine.`,
    },
    {
      label: "Highest point",
      value: `${analysis.highestPointM.toLocaleString("en-US")} m`,
      description: `Reached at approximately ${analysis.highestPointDistanceKm} km into the course.`,
    },
    ...(showExtendedMetrics
      ? [
          {
            label: "Elevation loss",
            value: `${analysis.elevationLossM.toLocaleString("en-US")} m`,
            description: `Calculated from ${sourceDescription} using the course analysis engine.`,
          },
          {
            label: "Lowest point",
            value: `${analysis.lowestPointM.toLocaleString("en-US")} m`,
            description: `Lowest recorded elevation in ${sourceDescription}.`,
          },
        ]
      : []),
  ];

  return (
    <section id="analysis" className="bg-[#17211c] text-white">
      <div className="mx-auto max-w-7xl px-6 py-20 lg:px-10 lg:py-28">
        <div className="max-w-3xl">
          <p className="text-xs font-semibold uppercase tracking-[0.25em] text-[#a7c957]">
            Course analysis{sourceLabel ? ` · ${sourceLabel}` : ""}
          </p>

          <h2 className="mt-4 text-4xl font-semibold tracking-[-0.035em] sm:text-5xl">
            Understand the character of the course.
          </h2>

          <p className="mt-6 text-lg leading-8 text-white/55">
            The goal is not to predict your race. It is to make the course
            easier to understand before you arrive at the start line.
          </p>
        </div>

        <div className="mt-14 grid gap-5 md:grid-cols-2 lg:grid-cols-3">
          {metrics.map((metric) => (
            <div
              key={metric.label}
              className="rounded-[1.5rem] border border-white/10 bg-white/5 p-7"
            >
              <p className="text-xs uppercase tracking-[0.18em] text-white/35">
                {metric.label}
              </p>
              <p className="mt-4 text-4xl font-semibold">{metric.value}</p>
              <p className="mt-4 text-sm leading-6 text-white/45">
                {metric.description}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
