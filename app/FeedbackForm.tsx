"use client";

import { useRef, useState, type FormEvent } from "react";
import { MAX_FEEDBACK_CHARACTERS } from "./feedbackContract";
import { FeedbackSubmissionGate } from "./feedbackSubmissionGate";

export default function FeedbackForm() {
  const [message, setMessage] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState("");
  const submissionGate = useRef(new FeedbackSubmissionGate());

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const feedback = message.trim();
    if (!feedback || !submissionGate.current.begin()) return;
    setIsSubmitting(true);
    setError("");
    try {
      const response = await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ feedback }),
      });
      if (response.status === 429) throw new Error("feedback-rate-limited");
      if (!response.ok) throw new Error("feedback-unavailable");
      setSubmitted(true);
      setMessage("");
    } catch (caught) {
      setError(caught instanceof Error && caught.message === "feedback-rate-limited"
        ? "You've sent feedback recently. Please try again later. Your message is still here."
        : "Feedback could not be sent right now. Your message is still here; please try again later.");
    } finally {
      submissionGate.current.finish();
      setIsSubmitting(false);
    }
  }

  return (
    <section className="border-t border-black/10 bg-[#f4f2ed]" aria-labelledby="route-feedback-title">
      <div className="mx-auto max-w-3xl px-6 py-12 sm:py-16">
        <h2 id="route-feedback-title" className="text-2xl font-semibold tracking-[-0.025em]">Help us improve Route Analysis</h2>
        <p className="mt-3 max-w-2xl text-sm leading-6 text-black/60">
          Did this analysis help you understand the route? Tell us what worked, what was confusing, or what you&apos;d like to see improved.
        </p>
        <p className="mt-3 text-xs leading-5 text-[var(--analysis-muted)]">
          Your message is stored for product improvement and is not attached to your GPX route. Please do not include personal or sensitive information.
        </p>
        <p className="mt-2 text-xs leading-5 text-[var(--analysis-muted)]">A temporary privacy-protected request token is used separately to limit spam; raw IP addresses are not stored with feedback.</p>
        {submitted ? (
          <p className="mt-5 rounded-xl bg-white px-4 py-3 text-sm font-medium text-[#334523]" role="status" aria-live="polite">
            Thank you. Your feedback has been received.
          </p>
        ) : (
          <form className="mt-5" onSubmit={handleSubmit}>
            <label htmlFor="route-feedback-message" className="block text-sm font-semibold">Your feedback</label>
            <textarea
              id="route-feedback-message"
              name="feedback"
              required
              maxLength={MAX_FEEDBACK_CHARACTERS}
              rows={5}
              value={message}
              onChange={(event) => setMessage(event.currentTarget.value)}
              disabled={isSubmitting}
              className="mt-2 block w-full rounded-xl border border-black/15 bg-white p-3 text-sm leading-6 outline-none focus-visible:ring-2 focus-visible:ring-[#71805d] disabled:opacity-70"
            />
            <p className="mt-2 text-xs text-[var(--analysis-muted)]">{message.length}/{MAX_FEEDBACK_CHARACTERS} characters</p>
            <button type="submit" disabled={isSubmitting || message.trim().length === 0} className="mt-4 inline-flex min-h-11 items-center justify-center rounded-full bg-[#17211c] px-6 py-3 text-sm font-semibold text-white transition hover:bg-[#293a31] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#71805d] disabled:cursor-wait disabled:opacity-60">
              {isSubmitting ? "Sending feedback…" : "Send feedback"}
            </button>
            {isSubmitting && <p className="sr-only" role="status" aria-live="polite">Sending your feedback.</p>}
            {error && <p className="mt-4 text-sm text-red-800" role="alert">{error}</p>}
          </form>
        )}
      </div>
    </section>
  );
}
