import Link from "next/link";
import CourseAnalysis from "./CourseAnalysis";
import CourseCharacter from "./CourseCharacter";
import CourseSection from "./CourseSection";
import RaceEditionInformation from "./RaceEditionInformation";
import RaceSources from "./RaceSources";
import type { RaceRecordData } from "./raceTypes";

export default function RacePageContent({
  record,
}: {
  record: RaceRecordData;
}) {
  return (
    <main className="min-h-screen bg-[#f4f2ed] text-[#17211c]">
      <nav className="fixed left-0 right-0 top-0 z-50 border-b border-white/10 bg-[#17211c]/95 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-6 lg:px-10">
          <Link href="/" className="text-sm font-bold tracking-[0.18em] text-white">
            RACE<span className="text-[#a7c957]">{"//"}</span>SCOPE
          </Link>
          <div className="flex items-center gap-8 text-sm text-white/60">
            <a href="#course" className="transition hover:text-white">
              Course
            </a>
            <a href="#analysis" className="transition hover:text-white">
              Course analysis
            </a>
            <a href="#sources" className="transition hover:text-white">
              Sources
            </a>
          </div>
        </div>
      </nav>

      <section className="bg-[#17211c] pt-16 text-white">
        <div className="mx-auto max-w-7xl px-6 pb-20 pt-24 lg:px-10 lg:pb-28 lg:pt-32">
          <p className="text-xs font-medium uppercase tracking-[0.22em] text-[#a7c957]">
            {record.race.name} · {record.edition.year} Edition
          </p>
          <h1 className="mt-7 max-w-5xl text-5xl font-semibold leading-[0.96] tracking-[-0.045em] sm:text-6xl lg:text-[6rem]">
            Understand the course.
          </h1>
          <div className="mt-8 flex flex-col gap-3 text-base text-white/55 sm:flex-row sm:items-center sm:gap-5">
            <span>{record.edition.startLocation}</span>
            <span className="text-[#a7c957]">→</span>
            <span>{record.edition.finishLocation}</span>
          </div>

          <div className="mt-14 grid grid-cols-2 gap-6 border-t border-white/10 pt-8 sm:grid-cols-4">
            <div>
              <p className="text-xs uppercase tracking-[0.18em] text-white/35">
                Distance
              </p>
              <p className="mt-2 text-2xl font-semibold">
                {record.edition.distanceKm} km
              </p>
            </div>
            <div>
              <p className="text-xs uppercase tracking-[0.18em] text-white/35">
                Elevation
              </p>
              <p className="mt-2 text-2xl font-semibold">
                {record.edition.elevationGainM.toLocaleString("en-US")} m+
              </p>
            </div>
            <div>
              <p className="text-xs uppercase tracking-[0.18em] text-white/35">
                Start
              </p>
              <p className="mt-2 text-2xl font-semibold">
                {record.edition.startLocation}
              </p>
            </div>
            <div>
              <p className="text-xs uppercase tracking-[0.18em] text-white/35">
                Finish
              </p>
              <p className="mt-2 text-2xl font-semibold">
                {record.edition.finishLocation}
              </p>
            </div>
          </div>
        </div>
      </section>

      <section id="course" className="bg-[#f4f2ed]">
        <div className="mx-auto max-w-7xl px-6 py-20 lg:px-10 lg:py-28">
          <div className="max-w-3xl">
            <p className="text-xs font-semibold uppercase tracking-[0.25em] text-[#71805d]">
              Course explorer
            </p>
            <h2 className="mt-4 text-4xl font-semibold tracking-[-0.035em] sm:text-5xl">
              See the shape of the race.
            </h2>
            <p className="mt-6 text-lg leading-8 text-black/55">
              A visual overview of the route, elevation and major course
              moments — designed to help you build a mental map before race
              day.
            </p>
          </div>

          <CourseSection raceRecord={record} />
          <CourseCharacter data={record.intelligence.courseCharacter} />
        </div>
      </section>

      <RaceEditionInformation
        information={record.edition.information}
        sources={record.sources}
      />
      <RaceSources sources={record.sources} />
      <CourseAnalysis analysis={record.courseAnalysis} />

      <footer className="border-t border-white/10 bg-[#17211c] px-6 py-10 text-white lg:px-10">
        <div className="mx-auto flex max-w-7xl flex-col justify-between gap-4 text-sm sm:flex-row">
          <Link href="/" className="font-semibold tracking-[0.18em]">
            RACE<span className="text-[#a7c957]">{"//"}</span>SCOPE
          </Link>
          <p className="text-white/35">We analyze the race. You know yourself.</p>
        </div>
      </footer>
    </main>
  );
}
