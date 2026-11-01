import { createHmac, randomUUID } from "node:crypto";
import { isIP } from "node:net";
import postgres from "postgres";
import type { FeedbackSaveResult } from "../feedbackApi.ts";
import { MAX_FEEDBACK_CHARACTERS } from "../feedbackContract.ts";
import { FEEDBACK_RATE_LIMITS, feedbackRateLimitExceeded } from "../feedbackRateLimit.ts";

type PostgresClient = ReturnType<typeof postgres>;
let client: PostgresClient | null = null;

function getClient(): PostgresClient {
  const connectionString = process.env.POSTGRES_URL;
  if (!connectionString) throw new Error("Feedback database is not configured.");
  if (!client) client = postgres(connectionString, { max: 1, idle_timeout: 20, connect_timeout: 10, prepare: false, ssl: "require" });
  return client;
}

function getRateLimitSecret(): string {
  const secret = process.env.FEEDBACK_RATE_LIMIT_SECRET;
  if (!secret || Buffer.byteLength(secret, "utf8") < 32) throw new Error("Feedback rate limit is not configured.");
  return secret;
}

export async function saveFeedbackSubmission(feedback: string, clientAddress: string): Promise<FeedbackSaveResult> {
  const text = feedback.trim();
  if (!text || Array.from(text).length > MAX_FEEDBACK_CHARACTERS || !isIP(clientAddress)) throw new Error("Invalid feedback submission.");
  const secret = getRateLimitSecret();
  const database = getClient();
  const now = Date.now();
  const hourBucket = Math.floor(now / 3_600_000);
  const dayBucket = Math.floor(now / 86_400_000);
  const buckets = [
    { name: "perClientHourly" as const, key: digest(secret, `client:${clientAddress}:hour:${hourBucket}`), limit: FEEDBACK_RATE_LIMITS.perClientHourly, expiryHours: 25 },
    { name: "globalHourly" as const, key: digest(secret, `global:hour:${hourBucket}`), limit: FEEDBACK_RATE_LIMITS.globalHourly, expiryHours: 25 },
    { name: "globalDaily" as const, key: digest(secret, `global:day:${dayBucket}`), limit: FEEDBACK_RATE_LIMITS.globalDaily, expiryHours: 48 },
  ];
  const id = randomUUID();

  return database.begin(async (transaction) => {
    await transaction`delete from public.route_feedback_rate_limit_buckets where expires_at <= now()`;
    // Rolling retention cleanup runs on submissions; the operations guide also documents manual deletion.
    await transaction`delete from public.route_feedback_submissions where created_at < now() - interval '12 months'`;
    const counts = { perClientHourly: 0, globalHourly: 0, globalDaily: 0 };
    for (const bucket of buckets) {
      const [row] = await transaction`
        insert into public.route_feedback_rate_limit_buckets (bucket_hash, request_count, expires_at)
        values (${bucket.key}, 1, now() + (${bucket.expiryHours} * interval '1 hour'))
        on conflict (bucket_hash) do update set
          request_count = least(public.route_feedback_rate_limit_buckets.request_count + 1, ${bucket.limit + 1}),
          expires_at = excluded.expires_at
        returning request_count`;
      counts[bucket.name] = Number(row?.request_count ?? bucket.limit + 1);
    }
    if (feedbackRateLimitExceeded(counts)) return "rate_limited";
    await transaction`
      insert into public.route_feedback_submissions (id, feedback_text)
      values (${id}, ${text})`;
    return "stored";
  });
}

function digest(secret: string, value: string) {
  return createHmac("sha256", secret).update(value, "utf8").digest("hex");
}
