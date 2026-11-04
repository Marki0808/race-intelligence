import type { Metadata } from "next";
import Link from "next/link";
import Image from "next/image";
import PrivacySettingsLink from "../PrivacySettingsLink";

export const metadata: Metadata = {
  title: "Privacy Policy | Endurset",
  description: "How Endurset handles GPX route analysis, browser storage, feedback and optional analytics.",
};

export default function PrivacyPage() {
  return (
    <main className="min-h-screen bg-[#f5f5ef] text-[#203329]">
      <header className="border-b border-[#dce2d6] bg-[#f8f8f2]">
        <nav aria-label="Main navigation" className="mx-auto flex h-16 max-w-7xl items-center justify-between px-5 sm:px-8 lg:px-10">
          <Link href="/" className="shrink-0" aria-label="Endurset home">
            <Image src="/brand/endurset-e.png" alt="" width={417} height={314} sizes="36px" className="block h-auto w-9 min-[380px]:hidden" />
            <Image src="/brand/endurset-wordmark.png" alt="" width={2015} height={314} sizes="(max-width: 640px) 34vw, 168px" className="hidden h-auto w-[clamp(102px,34vw,168px)] min-[380px]:block" />
          </Link>
          <Link href="/" className="text-sm font-semibold text-[#526253] hover:text-[#203329]">Back to Endurset</Link>
        </nav>
      </header>
      <article className="mx-auto max-w-4xl px-5 py-10 sm:px-8 sm:py-16">
        <p className="text-xs font-bold uppercase tracking-[.18em] text-[#667a58]">Last updated 4 November 2026</p>
        <h1 className="mt-3 text-4xl font-semibold tracking-tight sm:text-5xl">Privacy Policy</h1>
        <p className="mt-5 text-base leading-7 text-[#526253]">This page explains how Endurset processes information when you use GPX Route Analysis. The service is intended to help you understand route structure from a GPX file.</p>
        <section aria-labelledby="data-controller-heading" className="mt-7 rounded-2xl border border-[#dce2d6] bg-white/80 p-5 text-sm leading-6 text-[#35453b]">
          <h2 id="data-controller-heading" className="font-semibold text-[#203329]">Data Controller &amp; Contact</h2>
          <p className="mt-2">Endurset is an independent personal project operated by Marcel Bračić in Croatia. Marcel Bračić is the data controller for the processing described in this policy.</p>
          <p className="mt-2">Privacy contact: <a className="font-semibold underline" href="mailto:endurset@gmail.com">endurset@gmail.com</a>. Website: <a className="underline" href="https://endurset.com">endurset.com</a>.</p>
        </section>

        <div className="mt-9 space-y-8 text-sm leading-7 text-[#35453b]">
          <section><h2 className="text-xl font-semibold text-[#203329]">Information processed for route analysis</h2>
            <p className="mt-2">Your selected GPX file is read and analyzed in your browser. In the normal V1 flow, the GPX file, filename, raw track coordinates, and derived route fingerprints are not sent to Endurset servers. V1 does not check routes against a shared-route registry or save route geometry or analysis to a shared server database.</p>
            <p className="mt-2">Route geometry and analysis may be kept in this browser’s IndexedDB cache so the app can reuse them locally. The browser cache has no automatic expiry in the current app; you can remove it by clearing Endurset site data in your browser.</p>
            <p className="mt-2">The Course Brief in normal V1 Route Analysis is generated locally from GPX-derived measurements. The normal V1 flow does not send route content to OpenAI.</p>
          </section>
          <section><h2 className="text-xl font-semibold text-[#203329]">Maps and external services</h2>
            <p className="mt-2">When a route analysis is displayed, its map loads automatically and your browser requests map tiles from OpenStreetMap Foundation tile servers. Those requests disclose ordinary connection information, including your IP address, and the geographic tile area requested by the map. OpenStreetMap Foundation says its tiles are served through a global network of cache servers, so the server handling a tile request can vary. See the <a className="underline" href="https://operations.osmfoundation.org/policies/tiles/">tile usage policy</a> and <a className="underline" href="https://osmfoundation.org/wiki/Privacy_Policy">OpenStreetMap Foundation privacy policy</a>.</p>
            <p className="mt-2">Terrain Intelligence, including its optional OpenStreetMap enrichment and Mapillary imagery paths, is disabled in the public V1 interface and is not requested by the normal V1 analysis flow.</p>
          </section>
          <section><h2 className="text-xl font-semibold text-[#203329]">Feedback and abuse prevention</h2>
            <p className="mt-2">If you submit feedback, the service stores the message, a randomly generated submission ID, and a server-generated timestamp. Feedback is not attached to your GPX or route analysis. Please do not include personal or sensitive information in the message.</p>
            <p className="mt-2">To limit spam on feedback and newsletter signups, the server uses transient connection information, including the client address supplied by the hosting platform, to calculate a keyed rate-limit digest. The raw address is not stored in the feedback or newsletter rate-limit tables. Rate-limit digests and counters expire after their configured window and are cleaned during later submissions. Feedback rows older than 12 months are deleted when a subsequent feedback submission triggers cleanup; this does not guarantee deletion exactly at 12 months. You can request deletion by emailing us.</p>
          </section>
          <section><h2 className="text-xl font-semibold text-[#203329]">Browser storage</h2>
            <p className="mt-2">Endurset uses IndexedDB to cache route geometry and analysis in your browser for local reuse. A new analysis can be completed without that cache. The cache is not sent to Endurset servers and has no automatic expiry. There is no in-app control to clear it; remove it by clearing Endurset site data in your browser. Local storage remembers your Metric/US Customary preference and analytics consent choice. Analytics storage is used only after you accept analytics.</p>
          </section>
          <section><h2 className="text-xl font-semibold text-[#203329]">Optional Google Analytics</h2>
            <p className="mt-2">Google Analytics 4 loads only when a valid measurement ID is configured and you actively accept analytics. Rejecting has no effect on route analysis. After consent, Endurset sends limited page views and approved product events. Endurset does not send GPX files, coordinates, route fingerprints or IDs, route metrics, filenames, feedback text, email addresses, an Endurset account user ID, or custom personal identifiers. Google Analytics may use its own pseudonymous client identifier and cookies. Google may process connection information, including an IP address, to derive approximate visitor location such as country. You can reject or withdraw consent at any time through Privacy settings; the app then stops sending events and attempts to remove Google Analytics cookies for this site. See Google’s <a className="underline" href="https://policies.google.com/privacy">privacy information</a>.</p>
          </section>
          <section><h2 className="text-xl font-semibold text-[#203329]">Hosting, database and international processing</h2>
            <p className="mt-2">Endurset uses Vercel for application hosting and Supabase/Postgres for feedback and newsletter signup. Route analysis is not sent to Supabase. The Supabase primary database region is eu-central-1 (Frankfurt, Germany); Vercel Functions are configured for fra1 (Frankfurt, Germany). These locations do not mean that every provider operation or item of service metadata stays in those regions. Providers may process some account, support, security, telemetry, and operational information elsewhere under their service terms and data-protection commitments. Vercel’s current Hobby plan documentation states that runtime logs are retained for one hour; other provider retention, including database backups and analytics reports, depends on account settings and provider terms. For details, see the <a className="underline" href="https://vercel.com/legal/privacy-notice">Vercel privacy notice</a>, <a className="underline" href="https://vercel.com/legal/dpa">Vercel DPA</a>, <a className="underline" href="https://supabase.com/legal/customer-resources/data-processing-addendum">Supabase DPA</a>, and <a className="underline" href="https://supabase.com/legal/privacy-resources/data-residency-and-transfers-faq">Supabase information about data residency and transfers</a>.</p>
          </section>
          <section><h2 className="text-xl font-semibold text-[#203329]">Legal bases for processing</h2>
            <p className="mt-2">For feedback you choose to send, Endurset relies on its legitimate interest under Article 6(1)(f) of the GDPR in understanding what is useful or confusing and improving Route Analysis. For spam and abuse prevention, service availability, and necessary security and operations, Endurset relies on its legitimate interest in protecting and maintaining the website. These activities use limited information: feedback is not linked to your route, and rate-limit records store keyed digests rather than raw network addresses. You may object to processing based on legitimate interests by contacting us.</p>
            <p className="mt-2">We rely on your consent under Article 6(1)(a) of the GDPR for optional analytics and newsletter signup. You may withdraw analytics consent through Privacy settings or newsletter consent by contacting us; withdrawal does not affect processing carried out before withdrawal.</p>
          </section>
          <section><h2 className="text-xl font-semibold text-[#203329]">Newsletter signups</h2>
            <p className="mt-2">If you choose to sign up, Endurset stores your normalized email address, a random record ID, server-recorded signup and consent timestamps, the version of the consent text, and signup status. This records your request to receive occasional Endurset product updates. Signup is optional and separate from analytics consent. The legal basis is your consent under Article 6(1)(a) of the GDPR. You can withdraw it by emailing <a className="underline" href="mailto:endurset@gmail.com">endurset@gmail.com</a>; withdrawal does not affect processing that took place before it.</p>
            <p className="mt-2">Signup records are stored in Endurset&apos;s Supabase/Postgres database. New records remain pending confirmation; no confirmation email is sent and no marketing emails are currently being sent. An address will not be eligible for future mailing unless its ownership and consent have been confirmed. If an email delivery provider is introduced later, Endurset will update this policy and put appropriate safeguards in place before sharing eligible addresses with it.</p>
            <p className="mt-2">Pending signups are due for deletion after six months. The application checks for expired pending records when a later signup is submitted, so deletion may happen later if there is no subsequent signup. The current signup flow does not confirm addresses, create confirmed subscriptions, or send email. Withdrawal requests are handled manually: the record can be marked unsubscribed and excluded from any future export, with signup and confirmation details removed. A minimal suppression record may be retained only when necessary and lawful to prevent accidental re-addition; otherwise, the record is deleted.</p>
          </section>
          <section><h2 className="text-xl font-semibold text-[#203329]">Your rights and complaints</h2>
            <p className="mt-2">Depending on the circumstances, GDPR rights include access, rectification, erasure, restriction, portability, and objection where processing is based on legitimate interests or a public task. You may withdraw analytics consent at any time using <PrivacySettingsLink lightSurface /> and newsletter consent by emailing us; withdrawal does not affect processing carried out before withdrawal. To exercise rights, contact <a className="underline" href="mailto:endurset@gmail.com">endurset@gmail.com</a>.</p>
            <p className="mt-2">You may lodge a complaint with a competent supervisory authority. In Croatia, this includes the <a className="underline" href="https://azop.hr/">Croatian Personal Data Protection Agency (AZOP)</a>; see its <a className="underline" href="https://azop.hr/data-subject-rights/">information about data-subject rights</a> and <a className="underline" href="https://azop.hr/how-to-lodge-a-complaint/">how to lodge a complaint</a>.</p>
          </section>
          <section><h2 className="text-xl font-semibold text-[#203329]">Contact</h2><p className="mt-2">Questions or requests: <a className="font-semibold underline" href="mailto:endurset@gmail.com">endurset@gmail.com</a>.</p></section>
        </div>
      </article>
      <footer className="bg-[#203329] py-8 text-white">
        <div className="mx-auto flex w-full max-w-7xl flex-col gap-4 px-5 sm:flex-row sm:items-center sm:justify-between sm:px-8 lg:px-10">
          <Link href="/" className="w-fit" aria-label="Endurset home">
            <Image src="/brand/endurset-wordmark-dark.png" alt="" width={2015} height={314} className="h-auto w-[145px]" />
          </Link>
          <div className="flex flex-wrap gap-x-5 gap-y-2 text-xs text-white/70"><Link href="/">Home</Link><PrivacySettingsLink /></div>
        </div>
      </footer>
    </main>
  );
}
