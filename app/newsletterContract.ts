export const NEWSLETTER_MAX_EMAIL_CHARACTERS = 254;
export const NEWSLETTER_MAX_REQUEST_BYTES = 2 * 1024;
export const NEWSLETTER_CONSENT_TEXT_VERSION = "newsletter-consent-v1";

export const NEWSLETTER_RATE_LIMITS = {
  perClientHourly: 3,
  globalHourly: 30,
  globalDaily: 100,
} as const;

export type NewsletterRateCounts = {
  perClientHourly: number;
  globalHourly: number;
  globalDaily: number;
};

export function newsletterRateLimitExceeded(counts: NewsletterRateCounts) {
  return counts.perClientHourly > NEWSLETTER_RATE_LIMITS.perClientHourly
    || counts.globalHourly > NEWSLETTER_RATE_LIMITS.globalHourly
    || counts.globalDaily > NEWSLETTER_RATE_LIMITS.globalDaily;
}

export function normalizeNewsletterEmail(value: string): string | null {
  const email = value.trim().toLowerCase();
  if (email.length < 3 || email.length > NEWSLETTER_MAX_EMAIL_CHARACTERS) return null;
  const [local, ...domainParts] = email.split("@");
  if (!local || local.length > 64 || domainParts.length !== 1) return null;
  const domain = domainParts[0];
  if (local.startsWith(".") || local.endsWith(".") || local.includes("..")) return null;
  if (!/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local)) return null;
  if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)) return null;
  return email;
}
