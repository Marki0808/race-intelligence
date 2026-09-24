import CourseCharacter from "./CourseCharacter";
import CourseSection from "./CourseSection";
import RaceSources from "./RaceSources";
import { homepageRaceRecord, raceRegistry } from "./raceRegistry";
import RaceSearch from "./RaceSearch";
import CourseAnalysis from "./CourseAnalysis";

export default function Home() {
  return (
    <main className="min-h-screen bg-[#f4f2ed] text-[#17211c]">
      {/* NAVIGATION */}
      <nav className="fixed left-0 right-0 top-0 z-50 border-b border-white/10 bg-[#17211c]/95 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-6 lg:px-10">
          <div className="text-sm font-bold tracking-[0.18em] text-white">
            RACE<span className="text-[#a7c957]">{"//"}</span>SCOPE
          </div>

          <div className="hidden items-center gap-8 text-sm text-white/60 md:flex">
            <a href="#course" className="transition hover:text-white">
              Explore
            </a>
            <a href="#analysis" className="transition hover:text-white">
              Course analysis
            </a>
            <a href="#sources" className="transition hover:text-white">
              Sources
            </a>
          </div>

          <button className="rounded-full bg-[#a7c957] px-5 py-2.5 text-sm font-semibold text-[#17211c] transition hover:bg-[#b8d86b]">
            Analyze a race
          </button>
        </div>
      </nav>

      {/* HERO */}
      <section className="relative overflow-hidden bg-[#17211c] pt-16 text-white">
        <div className="absolute inset-0 opacity-30">
          <div
            className="absolute inset-[-20%]"
            style={{
              backgroundImage: `
                radial-gradient(circle at 20% 20%, transparent 0 80px, rgba(167,201,87,0.18) 81px 82px, transparent 83px 150px),
                radial-gradient(circle at 70% 60%, transparent 0 120px, rgba(255,255,255,0.08) 121px 122px, transparent 123px 220px)
              `,
              backgroundSize: "420px 420px, 520px 520px",
            }}
          />
        </div>

        <div className="relative mx-auto max-w-7xl px-6 pb-24 pt-24 lg:px-10 lg:pb-32 lg:pt-32">
          <div className="max-w-5xl">
            <div className="mb-7 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs font-medium uppercase tracking-[0.22em]">
              <span className="text-[#a7c957]">Istria 110K</span>
              <span className="text-white/30">•</span>
              <span className="text-white/45">2027 Edition</span>
            </div>

            <h1 className="max-w-5xl text-5xl font-semibold leading-[0.92] tracking-[-0.045em] sm:text-6xl lg:text-[7rem]">
              Understand
              <br />
              the course.
            </h1>

            <div className="mt-8 flex flex-col gap-3 text-base text-white/55 sm:flex-row sm:items-center sm:gap-5">
              <span>Buzet</span>
              <span className="text-[#a7c957]">→</span>
              <span>Umag</span>
            </div>

            <p className="mt-7 max-w-2xl text-lg leading-8 text-white/60 sm:text-xl">
              Explore the course, understand its key sections and see the
              information behind the race before race day.
            </p>

            <RaceSearch records={raceRegistry} />

            <div className="mt-10 flex flex-wrap gap-3">
              <a
                href="#course"
                className="rounded-full bg-[#a7c957] px-6 py-3 text-sm font-semibold text-[#17211c] transition hover:bg-[#b8d86b]"
              >
                Explore the course
              </a>

              <a
                href="#sources"
                className="rounded-full border border-white/20 px-6 py-3 text-sm text-white transition hover:bg-white/10"
              >
                View sources
              </a>
            </div>
          </div>

          <div className="mt-20 grid grid-cols-1 gap-6 border-t border-white/10 pt-8 sm:grid-cols-3">
            <div>
              <p className="text-xs uppercase tracking-[0.18em] text-white/35">
                Distance
              </p>
              <p className="mt-2 text-2xl font-semibold">111 km</p>
            </div>

            <div>
              <p className="text-xs uppercase tracking-[0.18em] text-white/35">
                Elevation
              </p>
              <p className="mt-2 text-2xl font-semibold">4,200 m+</p>
            </div>

            <div>
              <p className="text-xs uppercase tracking-[0.18em] text-white/35">
                Time limit
              </p>
              <p className="mt-2 text-2xl font-semibold">28 h</p>
            </div>
          </div>
        </div>
      </section>

      {/* RACE OVERVIEW */}
      <section className="border-b border-black/10 bg-[#f4f2ed]">
        <div className="mx-auto max-w-7xl px-6 py-10 lg:px-10">
          <div className="grid gap-8 lg:grid-cols-[1fr_2fr] lg:items-center">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.25em] text-[#71805d]">
                Race overview
              </p>

              <p className="mt-3 max-w-md text-sm leading-6 text-black/55">
                A point-to-point trail race through the interior of Istria,
                from Buzet to the finish in Umag.
              </p>
            </div>

            <div className="grid grid-cols-2 gap-y-8 sm:grid-cols-4">
              <div>
                <p className="text-xs uppercase tracking-[0.18em] text-black/35">
                  Date
                </p>
                <p className="mt-2 text-sm font-semibold">3 April 2027</p>
              </div>

              <div>
                <p className="text-xs uppercase tracking-[0.18em] text-black/35">
                  Start
                </p>
                <p className="mt-2 text-sm font-semibold">07:00 · Buzet</p>
              </div>

              <div>
                <p className="text-xs uppercase tracking-[0.18em] text-black/35">
                  Finish
                </p>
                <p className="mt-2 text-sm font-semibold">Umag</p>
              </div>

              <div>
                <p className="text-xs uppercase tracking-[0.18em] text-black/35">
                  Time limit
                </p>
                <p className="mt-2 text-sm font-semibold">28 hours</p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* COURSE INTRO */}
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

          {/* COURSE VISUAL */}
          <CourseSection raceRecord={homepageRaceRecord} />
          <CourseCharacter data={homepageRaceRecord.intelligence.courseCharacter} />
          <RaceSources sources={homepageRaceRecord.sources} />
  
        </div>
      </section>


      <CourseAnalysis analysis={homepageRaceRecord.courseAnalysis} />

      {/* FOOTER */}
      <footer className="border-t border-white/10 bg-[#17211c] px-6 py-10 text-white lg:px-10">
        <div className="mx-auto flex max-w-7xl flex-col justify-between gap-4 text-sm sm:flex-row">
          <div className="font-semibold tracking-[0.18em]">
            RACE<span className="text-[#a7c957]">{"//"}</span>SCOPE
          </div>

          <p className="text-white/35">
            We analyze the race. You know yourself.
          </p>
        </div>
      </footer>
    </main>
  );
}
