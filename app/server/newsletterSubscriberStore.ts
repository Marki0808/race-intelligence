import { createHmac, randomUUID } from "node:crypto";
import { isIP } from "node:net";
import postgres from "postgres";
import { NEWSLETTER_CONSENT_TEXT_VERSION, NEWSLETTER_RATE_LIMITS, newsletterRateLimitExceeded } from "../newsletterContract.ts";
import type { NewsletterSaveResult } from "../newsletterApi.ts";

type PostgresClient = ReturnType<typeof postgres>;
let client: PostgresClient | null = null;

function getClient(): PostgresClient {
  const connectionString = process.env.POSTGRES_URL;
  if (!connectionString) throw new Error("Newsletter database is not configured.");
  if (!client) client = postgres(connectionString, { max: 1, idle_timeout: 20, connect_timeout: 10, prepare: false, ssl: "require" });
  return client;
}

function getRateLimitSecret(): string {
  const secret = process.env.NEWSLETTER_RATE_LIMIT_SECRET;
  if (!secret || Buffer.byteLength(secret, "utf8") < 32) throw new Error("Newsletter rate limit is not configured.");
  return secret;
}

export async function recordNewsletterSignup(email: string, clientAddress: string): Promise<NewsletterSaveResult> {
  if (!isIP(clientAddress)) throw new Error("Invalid request address.");
  const secret = getRateLimitSecret();
  const database = getClient();
  const now = Date.now();
  const hourBucket = Math.floor(now / 3_600_000);
  const dayBucket = Math.floor(now / 86_400_000);
  const buckets = [
    { name: "perClientHourly" as const, key: digest(secret, `client:${clientAddress}:hour:${hourBucket}`), limit: NEWSLETTER_RATE_LIMITS.perClientHourly, expiryHours: 25 },
    { name: "globalHourly" as const, key: digest(secret, `global:hour:${hourBucket}`), limit: NEWSLETTER_RATE_LIMITS.globalHourly, expiryHours: 25 },
    { name: "globalDaily" as const, key: digest(secret, `global:day:${dayBucket}`), limit: NEWSLETTER_RATE_LIMITS.globalDaily, expiryHours: 48 },
  ];

  return database.begin(async (transaction) => {
    await transaction`delete from public.newsletter_rate_limit_buckets where expires_at <= now()`;
    await transaction`delete from public.newsletter_subscribers where status = 'pending_confirmation' and registered_at < now() - interval '6 months'`;
    const counts = { perClientHourly: 0, globalHourly: 0, globalDaily: 0 };
    for (const bucket of buckets) {
      const [row] = await transaction`
        insert into public.newsletter_rate_limit_buckets (bucket_hash, request_count, expires_at)
        values (${bucket.key}, 1, now() + (${bucket.expiryHours} * interval '1 hour'))
        on conflict (bucket_hash) do update set
          request_count = least(public.newsletter_rate_limit_buckets.request_count + 1, ${bucket.limit + 1}),
          expires_at = excluded.expires_at
        returning request_count`;
      counts[bucket.name] = Number(row?.request_count ?? bucket.limit + 1);
    }
    if (newsletterRateLimitExceeded(counts)) return "rate_limited";

    await transaction`
      insert into public.newsletter_subscribers
        (id, email_normalized, registered_at, consent_at, consent_text_version, status)
      values (${randomUUID()}, ${email}, now(), now(), ${NEWSLETTER_CONSENT_TEXT_VERSION}, 'pending_confirmation')
      on conflict (email_normalized) do update set
        registered_at = now(),
        consent_at = now(),
        consent_text_version = excluded.consent_text_version,
        status = 'pending_confirmation',
        confirmed_at = null,
        unsubscribed_at = null
      where newsletter_subscribers.status = 'unsubscribed'`;
    return "recorded";
  });
}

function digest(secret: string, value: string) {
  return createHmac("sha256", secret).update(value, "utf8").digest("hex");
}
