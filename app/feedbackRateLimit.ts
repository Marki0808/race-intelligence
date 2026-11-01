export const FEEDBACK_RATE_LIMITS = {
  perClientHourly: 3,
  globalHourly: 30,
  globalDaily: 100,
} as const;

export function feedbackRateLimitExceeded(counts: { perClientHourly: number; globalHourly: number; globalDaily: number }) {
  return counts.perClientHourly > FEEDBACK_RATE_LIMITS.perClientHourly
    || counts.globalHourly > FEEDBACK_RATE_LIMITS.globalHourly
    || counts.globalDaily > FEEDBACK_RATE_LIMITS.globalDaily;
}
