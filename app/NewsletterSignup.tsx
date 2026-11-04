"use client";

import Link from "next/link";
import { useRef, useState, type FormEvent } from "react";

export default function NewsletterSignup() {
  const [email, setEmail] = useState("");
  const [consent, setConsent] = useState(false);
  const [status, setStatus] = useState<"idle" | "submitting" | "success" | "error">("idle");
  const submitted = useRef(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitted.current || !consent) return;
    submitted.current = true;
    setStatus("submitting");
    try {
      const response = await fetch("/api/newsletter", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, consent }),
      });
      if (!response.ok) throw new Error("newsletter_unavailable");
      setStatus("success");
      setEmail("");
      setConsent(false);
    } catch {
      setStatus("error");
      submitted.current = false;
    }
  }

  return (
    <section id="newsletter" className="topo-benefits border-t border-[#e0e5dc] px-5 py-12 sm:px-8 sm:py-16" aria-labelledby="newsletter-title">
      <div className="mx-auto max-w-3xl rounded-3xl border border-[#dce2d6] bg-white/90 p-6 shadow-[0_10px_30px_-28px_rgba(31,51,39,.45)] sm:p-9">
        <p className="text-xs font-bold uppercase tracking-[.18em] text-[#71835c]">Endurset updates</p>
        <h2 id="newsletter-title" className="mt-2 text-2xl font-semibold tracking-[-.025em] text-[#203329] sm:text-3xl">Stay in the loop.</h2>
        <p className="mt-3 max-w-2xl text-sm leading-6 text-[#526253]">Get occasional updates about new Endurset features and future releases. No spam.</p>
        {status === "success" ? (
          <p className="mt-5 rounded-xl border border-[#dce2d6] bg-[#f6f7f2] p-4 text-sm leading-6 text-[#35453b]" role="status" aria-live="polite">
            Thanks for your interest! Your email has been recorded. Email verification will be required before updates are sent.
          </p>
        ) : (
          <form className="mt-5" onSubmit={handleSubmit}>
            <label htmlFor="newsletter-email" className="sr-only">Your email address</label>
            <div className="flex flex-col gap-3 sm:flex-row">
              <input
                id="newsletter-email"
                name="email"
                type="email"
                autoComplete="email"
                required
                maxLength={254}
                placeholder="Your email address"
                value={email}
                onChange={(event) => setEmail(event.currentTarget.value)}
                disabled={status === "submitting"}
                className="min-h-12 min-w-0 flex-1 rounded-xl border border-[#cfd8ca] bg-white px-4 text-sm text-[#203329] outline-none placeholder:text-[#778276] focus-visible:ring-2 focus-visible:ring-[#71805d] disabled:opacity-70"
              />
              <button type="submit" disabled={status === "submitting" || !consent} className="min-h-12 rounded-full bg-[#a0bf4c] px-6 text-sm font-bold text-[#17211c] transition hover:bg-[#b2ce67] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#526b36] disabled:cursor-wait disabled:opacity-60">
                {status === "submitting" ? "Submitting…" : "Subscribe"}
              </button>
            </div>
            <label className="mt-4 flex cursor-pointer items-start gap-3 text-sm leading-6 text-[#35453b]">
              <input type="checkbox" required checked={consent} onChange={(event) => setConsent(event.currentTarget.checked)} disabled={status === "submitting"} className="mt-1 size-4 shrink-0 accent-[#718b38] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#526b36]" />
              <span>I agree to receive occasional Endurset product updates by email and understand that I can withdraw my consent at any time. See our <Link href="/privacy" className="font-semibold underline underline-offset-2">Privacy Policy</Link>.</span>
            </label>
            <p className="mt-3 text-xs leading-5 text-[#667568]">Your signup is stored securely for future updates. We are not sending marketing emails yet. You can withdraw consent by emailing <a href="mailto:endurset@gmail.com" className="underline underline-offset-2">endurset@gmail.com</a>.</p>
            {status === "submitting" && <p className="sr-only" role="status" aria-live="polite">Submitting your signup.</p>}
            {status === "error" && <p className="mt-4 text-sm text-red-800" role="alert">We couldn&apos;t save your signup right now. Please try again later.</p>}
          </form>
        )}
      </div>
    </section>
  );
}
