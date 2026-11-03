import Link from "next/link";
import Image from "next/image";
import RouteMode from "./RouteMode";

const faqs = [
  {
    question: "What is GPX route analysis?",
    answer: "It turns the track and elevation data in a GPX file into a route overview, elevation profile, automatic sections, key moments and plain-language descriptions.",
  },
  {
    question: "What can I learn from analyzing a trail route?",
    answer: "See how distance and elevation are distributed, where important climbs and descents occur, and how the route changes from one section to the next. The analysis describes the file; it does not know current trail conditions.",
  },
  {
    question: "Which GPX files are supported?",
    answer: "Choose a .gpx or .xml file containing valid GPX track data. Files are limited to 20 MiB and 100,000 track points. Elevation data is needed for elevation analysis.",
  },
  {
    question: "Is my GPX file uploaded or stored?",
    answer: "The GPX file is read and analyzed in your browser and is not uploaded or stored by this app. A derived route fingerprint may be checked against shared route records. Map tiles are requested for the geographic area you view, and route analysis is kept in this browser’s local cache when it does not match a shared route.",
  },
  {
    question: "Can I create my own route sections?",
    answer: "Yes. In Custom Sections, add kilometer boundaries and optional names to divide the route around your own checkpoints or planned aid stations. These are your markers; the app does not automatically verify aid-station locations.",
  },
  {
    question: "How accurate are elevation gain and gradient calculations?",
    answer: "They depend on the elevation values in your GPX. Reported ascent and descent use elevations sampled every 50 m and a 50 m-radius median filter. Gradients and section descriptions use a separately resampled and smoothed profile. These calculations do not correct elevations against an external terrain model.",
  },
  {
    question: "Can this predict how difficult a race will be for me?",
    answer: "No. It can help you understand a route’s measured distance and elevation structure, but it does not predict race time, trail surface, conditions or your personal effort.",
  },
];

const benefits = [
  {
    number: "01",
    title: "Understand the climbs",
    body: "See where the major ascents sit along the course and how climbing and descending are distributed. The elevation profile makes the route’s shape easier to picture before race day.",
  },
  {
    number: "02",
    title: "Explore meaningful sections",
    body: "Automatic Route Sections organize the profile into readable stretches. Add your own Custom Sections around checkpoints or planned aid stations when you want to follow a personal plan.",
  },
  {
    number: "03",
    title: "Know what to expect",
    body: "Grounded in the GPX elevation profile, concise descriptions explain important climbs, descents and transitions in the order they unfold.",
  },
];

function AnalysisPreview() {
  return (
    <div className="rounded-[1.75rem] border border-[#dce2d6] bg-white/81 p-4 shadow-[0_20px_60px_-36px_rgba(31,51,39,.35)] sm:p-6" aria-label="Illustrative route analysis preview">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-[#667a58]">Route overview</p>
          <p className="mt-1 text-lg font-semibold tracking-tight text-[#203329]">A course, read in sections</p>
        </div>
        <span className="shrink-0 rounded-full border border-[#dce2d6] bg-[#f7f8f3] px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-[#667a58]">Illustrative example</span>
      </div>
      <div className="mt-5 overflow-hidden rounded-xl border border-[#e6e9e1] bg-[#fbfcf9] p-2 sm:p-3">
        <svg className="h-48 w-full sm:h-56" viewBox="0 0 600 250" role="img" aria-labelledby="preview-title preview-description">
          <title id="preview-title">Illustrative trail elevation profile</title>
          <desc id="preview-description">A fictional route rises through a long climb, rolls briefly, then descends. Four colored bands mark example route sections and three dots mark example moments.</desc>
          <rect x="0" y="0" width="150" height="250" fill="#eef2e8" />
          <rect x="150" y="0" width="150" height="250" fill="#f7f8f3" />
          <rect x="300" y="0" width="150" height="250" fill="#eef2e8" />
          <rect x="450" y="0" width="150" height="250" fill="#f7f8f3" />
          <path d="M20 195H580M20 145H580M20 95H580M20 45H580" stroke="#dce2d6" strokeWidth="1" />
          <path d="M20 204 C56 198 72 176 98 181 S139 169 160 148 S203 108 228 98 S268 81 292 100 S328 126 353 115 S389 103 411 126 S446 157 467 165 S504 174 523 190 S554 201 580 196 L580 215 L20 215Z" fill="#b8cf80" fillOpacity=".32" />
          <path d="M20 204 C56 198 72 176 98 181 S139 169 160 148 S203 108 228 98 S268 81 292 100 S328 126 353 115 S389 103 411 126 S446 157 467 165 S504 174 523 190 S554 201 580 196" fill="none" stroke="#496b43" strokeWidth="4" strokeLinecap="round" />
          <path d="M150 24V220M300 24V220M450 24V220" stroke="#b9c4b1" strokeDasharray="4 5" />
          <circle cx="225" cy="99" r="6" fill="#a0bf4c" stroke="white" strokeWidth="3" />
          <circle cx="292" cy="100" r="6" fill="#a0bf4c" stroke="white" strokeWidth="3" />
          <circle cx="411" cy="126" r="6" fill="#a0bf4c" stroke="white" strokeWidth="3" />
          <text x="18" y="239" fill="#687568" fontSize="11">START</text>
          <text x="145" y="239" fill="#687568" fontSize="11">01</text>
          <text x="295" y="239" fill="#687568" fontSize="11">02</text>
          <text x="445" y="239" fill="#687568" fontSize="11">03</text>
          <text x="546" y="239" fill="#687568" fontSize="11">FINISH</text>
        </svg>
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_auto] sm:items-center">
        <p className="text-sm leading-6 text-[#445348]">The route rises through a sustained climb, rolls briefly, then descends toward the finish.</p>
        <div className="flex gap-2 text-[11px] font-medium text-[#667a58]" aria-hidden="true"><span>● Key moments</span><span>━ Elevation</span></div>
      </div>
      <p className="mt-3 text-[11px] text-[#778276]">Fictional profile and description. No real route or measured values are shown.</p>
    </div>
  );
}

export default function Home() {
  return (
    <main className="min-h-screen bg-[#f5f5ef] text-[#203329]">
      <header className="sticky top-0 z-50 border-b border-[#dce2d6]/80 bg-[#f8f8f2]/95 text-[#203329] backdrop-blur supports-[backdrop-filter]:bg-[#f8f8f2]/85">
        <nav aria-label="Main navigation" className="mx-auto flex h-[4.25rem] max-w-7xl items-center justify-between gap-4 px-5 sm:px-8 lg:px-10">
          <Link href="/" className="shrink-0" aria-label="Endurset home">
            <Image src="/brand/endurset-e.png" alt="" width={417} height={314} priority sizes="36px" className="block h-auto w-9 min-[380px]:hidden" />
            <Image src="/brand/endurset-wordmark.png" alt="" width={2015} height={314} priority sizes="(max-width: 640px) 34vw, 168px" className="hidden h-auto w-[clamp(102px,34vw,168px)] min-[380px]:block" />
          </Link>
          <div className="flex items-center gap-5 sm:gap-8">
            <a href="#faq" className="hidden text-sm font-medium text-[#526253] transition hover:text-[#203329] sm:inline-flex">FAQ</a>
            <a href="#analyze" className="inline-flex min-h-11 items-center justify-center rounded-full bg-[#26382f] px-4 text-xs font-bold text-white shadow-sm transition hover:bg-[#354b3f] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-3 focus-visible:outline-[#526b36] sm:px-5 sm:text-sm">
              Analyze your route
            </a>
          </div>
        </nav>
      </header>

      <section className="topo-hero relative overflow-hidden border-b border-[#dfe5d8]">
        <div className="relative mx-auto grid max-w-7xl items-center gap-10 px-5 py-12 sm:px-8 sm:py-16 lg:grid-cols-[.92fr_1.08fr] lg:gap-14 lg:px-10 lg:py-20">
          <div className="relative z-10">
            <p className="text-xs font-bold uppercase tracking-[0.2em] text-[#667a58]">GPX route analysis for trail running</p>
            <h1 className="mt-5 max-w-2xl text-[2.75rem] font-semibold leading-[1.02] tracking-[-0.05em] text-[#203329] sm:text-6xl lg:text-[4.25rem]">
              Don&apos;t just analyze the route. Understand it.
            </h1>
            <p className="mt-6 max-w-xl text-lg font-medium leading-7 text-[#203329] sm:text-xl">
              Every trail has a story. Know it before the start line.
            </p>
            <p className="mt-4 max-w-xl text-sm leading-6 text-[#263a30] sm:text-base sm:leading-7">
              Distance and elevation only tell part of the story. See how a course unfolds: where long climbs begin, how descents are distributed, and which sections shape its profile. Turn your GPX into a clearer picture of the route and prepare with more confidence.
            </p>
          </div>
          <div className="relative z-10 min-w-0"><AnalysisPreview /></div>
        </div>
      </section>

      <section className="topo-benefits border-y border-[#e0e5dc]">
        <div className="mx-auto max-w-7xl px-5 py-14 sm:px-8 sm:py-16 lg:px-10">
          <div className="max-w-2xl">
            <p className="text-xs font-bold uppercase tracking-[0.19em] text-[#71835c]">A clearer view before race day</p>
            <h2 className="mt-3 text-3xl font-semibold tracking-[-0.04em] sm:text-4xl">Why analyze your route?</h2>
          </div>
          <div className="mt-8 grid gap-4 md:grid-cols-3">
            {benefits.map((benefit) => (
              <article key={benefit.number} className="rounded-2xl border border-[#e0e5dc] bg-white/95 p-5 shadow-[0_10px_30px_-28px_rgba(31,51,39,.45)] sm:p-6">
                <p className="text-xs font-bold tracking-[0.15em] text-[#819a50]">{benefit.number}</p>
                <h3 className="mt-4 text-lg font-semibold tracking-tight">{benefit.title}</h3>
                <p className="mt-2 text-sm leading-6 text-[#5a685d]">{benefit.body}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <RouteMode embedded />

      <section id="faq" className="topo-benefits scroll-mt-24 mx-auto max-w-4xl px-5 py-14 sm:px-8 sm:py-20">
        <p className="text-xs font-bold uppercase tracking-[0.19em] text-[#71835c]">Frequently asked questions</p>
        <h2 className="mt-3 text-3xl font-semibold tracking-[-0.04em] sm:text-4xl">Before you begin</h2>
        <div className="mt-7 divide-y divide-[#dfe5dc] border-y border-[#dfe5dc]">
          {faqs.map((item) => (
            <details key={item.question} className="group py-5">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-5 text-base font-semibold marker:hidden focus-visible:rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#71835c] sm:text-lg">
                {item.question}
                <span aria-hidden="true" className="text-xl font-normal text-[#71835c] transition group-open:rotate-45">+</span>
              </summary>
              <p className="mt-3 max-w-3xl pr-8 text-sm leading-6 text-[#5a685d]">{item.answer}</p>
            </details>
          ))}
        </div>
      </section>

      <footer className="bg-[#203329] py-8 text-white">
        <div className="mx-auto flex w-full max-w-7xl flex-col gap-4 px-5 sm:flex-row sm:items-center sm:justify-between sm:px-8 lg:px-10">
          <Link href="/" className="w-fit" aria-label="Endurset home">
            <Image src="/brand/endurset-wordmark-dark.png" alt="" width={2015} height={314} className="h-auto w-[145px]" />
          </Link>
          <div className="flex flex-wrap gap-x-5 gap-y-2 text-xs text-white/70">
            <a href="#analyze" className="transition hover:text-white">Analyze your route</a>
            <a href="#faq" className="transition hover:text-white">FAQ</a>
          </div>
          <p className="text-xs leading-5 text-white/55">Understand the route in your GPX.</p>
        </div>
      </footer>
    </main>
  );
}
