import type { GpxCourseAnalysisData } from "./raceTypes";

export default function CourseAnalysis({
  analysis,
}: {
  analysis: GpxCourseAnalysisData;
}) {
  return (
    <section id="analysis" className="bg-[#17211c] text-white">
      <div className="mx-auto max-w-7xl px-6 py-20 lg:px-10 lg:py-28">
        <div className="max-w-3xl">
          <p className="text-xs font-semibold uppercase tracking-[0.25em] text-[#a7c957]">
            Course analysis
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
          <div className="rounded-[1.5rem] border border-white/10 bg-white/5 p-7">
            <p className="text-xs uppercase tracking-[0.18em] text-white/35">
              Distance
            </p>
            <p className="mt-4 text-4xl font-semibold">
              {analysis.distanceKm.toFixed(2)} km
            </p>
            <p className="mt-4 text-sm leading-6 text-white/45">
              Derived from the official GPX track.
            </p>
          </div>

          <div className="rounded-[1.5rem] border border-white/10 bg-white/5 p-7">
            <p className="text-xs uppercase tracking-[0.18em] text-white/35">
              Elevation gain
            </p>
            <p className="mt-4 text-4xl font-semibold">
              {analysis.elevationGainM.toLocaleString("en-US")} m
            </p>
            <p className="mt-4 text-sm leading-6 text-white/45">
              Derived from the uploaded GPX using the course analysis engine.
            </p>
          </div>

          <div className="rounded-[1.5rem] border border-white/10 bg-white/5 p-7">
            <p className="text-xs uppercase tracking-[0.18em] text-white/35">
              Highest point
            </p>
            <p className="mt-4 text-4xl font-semibold">
              {analysis.highestPointM.toLocaleString("en-US")} m
            </p>
            <p className="mt-4 text-sm leading-6 text-white/45">
              Reached at approximately {analysis.highestPointDistanceKm} km into
              the course.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
