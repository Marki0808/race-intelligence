import type { RouteAnalysisData } from "./gpxAnalysis";
import { buildRouteTakeaways } from "./routeTakeawayFacts";

export default function RouteTakeaways({ analysis }: { analysis: RouteAnalysisData }) {
  const takeaways = buildRouteTakeaways(analysis);
  if (!takeaways.length) return null;
  return <section aria-labelledby="route-takeaways-title" className="mt-10 rounded-3xl bg-[#17211c] p-6 text-white sm:p-8">
    <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[#a7c957]">Course Takeaways</p>
    <h2 id="route-takeaways-title" className="sr-only">Course takeaways</h2>
    <ul className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {takeaways.map((takeaway) => <li key={takeaway.id} className="rounded-2xl border border-white/10 bg-white/5 p-4 text-sm leading-6 text-white/80">{takeaway.text}</li>)}
    </ul>
    <p className="mt-6 text-sm font-semibold tracking-wide text-white/80">Don’t just analyze the route. Understand it.</p>
  </section>;
}
