import Link from "next/link";
import RaceGpxDiscovery from "./RaceGpxDiscovery";
import RaceSearch from "./RaceSearch";
import { raceRegistry } from "./raceRegistry";

const faqs = [
  {
    question: "What can I analyze?",
    answer: "Use a supported race, discover a GPX link from an official race page, or upload a GPX route. Route analysis describes the elevation profile, sections and key route moments.",
  },
  {
    question: "Will every race webpage provide a route?",
    answer: "No. Route links depend on what the webpage makes available. If discovery cannot find one, try the event’s direct course page or upload a GPX file.",
  },
  {
    question: "Does the analysis predict my finish time?",
    answer: "No. It summarizes route information from the selected GPX and does not predict an individual runner’s performance.",
  },
];

export default function Home() {
  return (
    <main className="min-h-screen bg-[#f4f2ed] text-[#17211c]">
      <nav className="border-b border-white/10 bg-[#17211c] text-white">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-6 lg:px-10">
          <Link href="/" className="text-sm font-bold tracking-[0.18em]">
            RACE<span className="text-[#a7c957]">{"//"}</span>SCOPE
          </Link>
          <a href="#analyze" className="rounded-full bg-[#a7c957] px-5 py-2.5 text-sm font-semibold text-[#17211c] transition hover:bg-[#b8d86b]">
            Analyze a route
          </a>
        </div>
      </nav>

      <section className="overflow-hidden bg-[#17211c] text-white">
        <div className="mx-auto grid max-w-7xl gap-12 px-6 py-16 sm:py-20 lg:grid-cols-[1.05fr_.95fr] lg:items-center lg:px-10 lg:py-24">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-[#a7c957]">Route and race analysis</p>
            <h1 className="mt-5 max-w-3xl text-5xl font-semibold leading-[0.98] tracking-[-0.045em] sm:text-6xl lg:text-7xl">
              Don&apos;t just analyze the route. Understand it.
            </h1>
            <p className="mt-6 max-w-2xl text-base leading-7 text-white/60 sm:text-lg">
              Explore the elevation profile, follow the route sections and see the key moments in a race or GPX course.
            </p>
            <a href="#analyze" className="mt-8 inline-flex min-h-11 items-center rounded-full bg-[#a7c957] px-6 py-3 text-sm font-semibold text-[#17211c] transition hover:bg-[#b8d86b]">
              Choose how to start
            </a>
          </div>

          <div className="rounded-[2rem] border border-white/10 bg-white/[0.04] p-5 sm:p-7" aria-label="Illustrative route analysis preview">
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#a7c957]">Analysis preview</p>
                <p className="mt-2 text-lg font-semibold">A route, seen in sections</p>
              </div>
              <span className="rounded-full border border-white/15 px-3 py-1 text-[10px] uppercase tracking-[0.12em] text-white/55">Illustrative</span>
            </div>
            <svg className="mt-6 h-36 w-full" viewBox="0 0 520 150" role="img" aria-label="Illustrative elevation profile with no measured route data">
              <path d="M8 126H512M8 94H512M8 62H512M8 30H512" stroke="rgba(255,255,255,.09)" strokeWidth="1" />
              <path d="M8 119 C48 116 55 91 91 96 S135 111 169 82 S213 70 240 77 S280 99 309 60 S350 36 376 56 S422 83 448 43 S482 31 512 17 L512 134 L8 134Z" fill="rgba(167,201,87,.16)" />
              <path d="M8 119 C48 116 55 91 91 96 S135 111 169 82 S213 70 240 77 S280 99 309 60 S350 36 376 56 S422 83 448 43 S482 31 512 17" fill="none" stroke="#a7c957" strokeWidth="4" strokeLinecap="round" />
              <path d="M8 142H171M179 142H344M352 142H512" stroke="rgba(255,255,255,.5)" strokeWidth="3" strokeLinecap="round" />
            </svg>
            <p className="mt-3 text-xs leading-5 text-white/45">Illustrative visual only. No route or measured values are shown.</p>
          </div>
        </div>
      </section>

      <section id="analyze" className="scroll-mt-6">
        <div className="mx-auto max-w-7xl px-6 py-14 sm:py-20 lg:px-10">
          <div className="max-w-2xl">
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-[#71805d]">Choose your starting point</p>
            <h2 className="mt-3 text-3xl font-semibold tracking-[-0.035em] sm:text-4xl">Analyze a race or a route</h2>
          </div>

          <div className="mt-8 grid gap-5 lg:grid-cols-2">
            <article className="min-w-0 rounded-[2rem] border border-black/10 bg-white p-5 shadow-sm sm:p-7">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#71805d]">Race Mode</p>
              <h3 className="mt-3 text-2xl font-semibold">Analyze a race</h3>
              <p className="mt-2 max-w-xl text-sm leading-6 text-black/55">Paste an official race webpage to look for route links, then choose the course you want to analyze. Some pages may not expose a usable route.</p>
              <div className="mt-6"><RaceGpxDiscovery /></div>
            </article>

            <article className="min-w-0 rounded-[2rem] border border-black/10 bg-white p-5 shadow-sm sm:p-7">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#71805d]">Route Mode</p>
              <h3 className="mt-3 text-2xl font-semibold">Analyze a route</h3>
              <p className="mt-2 max-w-xl text-sm leading-6 text-black/55">Choose a GPX file to explore its elevation profile, Route Sections and Key Moments.</p>
              <Link href="/route" className="mt-6 inline-flex min-h-11 items-center justify-center rounded-full bg-[#17211c] px-6 py-3 text-sm font-semibold text-white transition hover:bg-[#293a31]">
                Upload a GPX route
              </Link>
            </article>
          </div>

          <details className="mt-7 rounded-2xl border border-black/10 bg-white/70 p-5 sm:p-6">
            <summary className="cursor-pointer list-none text-sm font-semibold focus-visible:rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#71805d]">
              Looking for a race already in the registry?
            </summary>
            <p className="mt-2 text-sm leading-6 text-black/55">Search supported races by name or official source URL.</p>
            <div className="mt-4" id="race-search-entry"><RaceSearch records={raceRegistry} /></div>
          </details>
        </div>
      </section>

      <section className="border-y border-black/10 bg-white/55">
        <div className="mx-auto grid max-w-7xl gap-8 px-6 py-14 sm:py-16 lg:grid-cols-[.65fr_1fr] lg:px-10">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-[#71805d]">How it works</p>
            <h2 className="mt-3 text-3xl font-semibold tracking-[-0.035em]">Start with the route.</h2>
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            {[
              ["01", "Choose a race page or GPX file."],
              ["02", "Review the elevation profile and route shape."],
              ["03", "Explore sections and key moments."],
            ].map(([number, text]) => (
              <div key={number} className="rounded-2xl border border-black/10 bg-white p-5">
                <p className="text-xs font-semibold tracking-[0.16em] text-[#71805d]">{number}</p>
                <p className="mt-5 text-sm font-medium leading-6">{text}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-4xl px-6 py-14 sm:py-20">
        <p className="text-xs font-semibold uppercase tracking-[0.22em] text-[#71805d]">Frequently asked questions</p>
        <h2 className="mt-3 text-3xl font-semibold tracking-[-0.035em]">Before you begin</h2>
        <div className="mt-6 divide-y divide-black/10 border-y border-black/10">
          {faqs.map((item) => (
            <details key={item.question} className="py-5">
              <summary className="cursor-pointer text-base font-semibold focus-visible:rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#71805d]">{item.question}</summary>
              <p className="mt-3 max-w-3xl text-sm leading-6 text-black/55">{item.answer}</p>
            </details>
          ))}
        </div>
      </section>

      <footer className="border-t border-white/10 bg-[#17211c] px-6 py-8 text-white lg:px-10">
        <div className="mx-auto flex max-w-7xl flex-col justify-between gap-3 text-sm sm:flex-row">
          <div className="font-semibold tracking-[0.18em]">RACE<span className="text-[#a7c957]">{"//"}</span>SCOPE</div>
          <p className="text-white/45">Don&apos;t just analyze the route. Understand it.</p>
        </div>
      </footer>
    </main>
  );
}
