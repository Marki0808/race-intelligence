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

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
