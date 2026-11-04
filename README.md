This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Optional Mapillary terrain imagery

Mapillary imagery is optional, additional visual evidence for the terrain sections shown in Route Mode. To enable it locally, copy `.env.example` to `.env.local` and set `MAPILLARY_ACCESS_TOKEN` to a token created in the [Mapillary developer dashboard](https://www.mapillary.com/dashboard/developers). This variable is read only by the server-side `/api/mapillary` route; do not prefix it with `NEXT_PUBLIC_` or commit a real token.

When the token is missing, imagery availability is reported as unknown and the GPX and OpenStreetMap terrain evidence continue to work. Imagery evidence may be cached locally, and is shared server-side only for explicitly allowlisted public race routes.

## Shared route persistence

The server can use `POSTGRES_URL` for shared persistence of routes explicitly listed in the source-controlled race registry. The current shared eligibility list consists of official race GPX files referenced by race editions. Arbitrary uploaded routes remain local to the browser and are never promoted to shared storage based only on an uploaded fingerprint. The original uploaded GPX file is not stored.

For local database integration, set `POSTGRES_URL` in `.env.local`. On Vercel, configure the server-side `POSTGRES_URL` variable through the connected Supabase integration. Do not expose it with a `NEXT_PUBLIC_` prefix or use it in client code. Shared database reads and writes happen only through the Node.js `/api/route-persistence` route; IndexedDB remains an optional local cache. If the database is unavailable, GPX analysis and existing local evidence flows continue.

The initial additive schema is in `supabase/migrations/202610020001_route_persistence.sql`. It has not been applied automatically. Before applying it, verify that the selected Supabase project is the intended Race Intelligence database and review the migration in the Supabase SQL Editor. Future authenticated private-route persistence should add ownership and access controls; it must not broaden this public-route allowlist by default. RLS is enabled without browser policies because this application accesses the database server-side.

## Route Analysis feedback

The completed Route Analysis page includes an optional free-text feedback form. `POST /api/feedback` stores only a server-generated UUID, trimmed feedback text (up to 2,000 characters), and a server timestamp in `public.route_feedback_submissions`. It does not receive route or GPX context. The endpoint fails closed unless both `POSTGRES_URL` and `FEEDBACK_RATE_LIMIT_SECRET` are configured. Keep both values server-side; never use a `NEXT_PUBLIC_` prefix.

Before enabling feedback in a deployment, review and apply `supabase/migrations/202611010001_route_feedback.sql` to the intended Supabase project. Configure `FEEDBACK_RATE_LIMIT_SECRET` with at least 32 random bytes. The database-backed limiter allows up to 3 submissions per client IP per hour, 30 submissions globally per hour, and 100 globally per day. It reads Vercel's edge-provided `x-vercel-forwarded-for` header, immediately HMACs the address with the server secret, and stores only a short-lived digest and counter in the separate rate-limit table; raw addresses are not logged or persisted. Expired limiter rows are removed during submissions.

Feedback has a 12-month retention period; the API prunes older rows on feedback requests. For guaranteed scheduled deletion even during long periods without new submissions, configure a monthly database cleanup with `delete from public.route_feedback_submissions where created_at < now() - interval '12 months';`. Operators can remove a single message with `delete from public.route_feedback_submissions where id = '<submission-uuid>';` or remove all messages with `delete from public.route_feedback_submissions;`. No scheduled cleanup is configured automatically by the application.

## Newsletter signup

The homepage newsletter form records voluntary product-update requests in `public.newsletter_subscribers`. It stores a random UUID, normalized email, signup and consent timestamps, consent text version, status, and nullable future confirmation/withdrawal timestamps. New signups are always `pending_confirmation`; the application has no email sender and does not mark addresses as subscribed. Duplicate active or pending addresses receive the same generic success response as new addresses. The subscriber table has RLS enabled, no browser policies, and explicit revocation of `public`, `anon`, and `authenticated` access. Writes use server-only `POSTGRES_URL`.

Apply `supabase/migrations/202611040001_endurset_newsletter.sql` to the intended Supabase project before enabling signup. Configure `NEWSLETTER_RATE_LIMIT_SECRET` server-side with at least 32 random bytes; it is separate from `FEEDBACK_RATE_LIMIT_SECRET`. Newsletter requests use Vercel's edge-provided `x-vercel-forwarded-for` only to calculate a keyed HMAC limiter digest; raw addresses are not stored in the limiter. The durable database limiter permits 3 requests per client per hour, 30 globally per hour, and 100 globally per day. Never add either secret to a `NEXT_PUBLIC_` variable.

Operational, retention, withdrawal and future export procedures are documented in [`docs/newsletter-operations.md`](docs/newsletter-operations.md). There is no public subscriber list or export endpoint. Because there is no confirmation flow yet, the current public application produces no `subscribed` or export-eligible records.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
