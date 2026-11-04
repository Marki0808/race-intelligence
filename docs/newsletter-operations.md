# Newsletter operations

This document describes administrator-only handling. Do not add a public read, export, unsubscribe, update, or delete API. Restrict Supabase project access to trusted administrators and never put database credentials in the browser or in this repository.

## Production setup

1. Review `supabase/migrations/202611040001_endurset_newsletter.sql` and apply it through the intended Supabase project's SQL Editor. This repository task does not apply migrations.
2. In Vercel, set server-only `POSTGRES_URL` and `NEWSLETTER_RATE_LIMIT_SECRET` for the environments where signup should work. The rate-limit secret must be generated from at least 32 cryptographically random bytes and kept separate from the feedback secret. Do not expose either with a `NEXT_PUBLIC_` prefix.
3. Deploy only after the migration and environment variables are configured. Without them, the endpoint fails closed with a generic retry message.
4. Verify signup using a controlled test address, then remove the test record in Supabase. Confirm the row is `pending_confirmation`, consent fields are populated, no raw IP or route data is stored, and browser roles cannot select the table. Do not test against a real subscriber address.

The API trusts `x-vercel-forwarded-for` in production, as the existing feedback endpoint does. It validates that the value is a single IP address, immediately HMACs it, and stores only bounded counters and 64-character digests in a separate newsletter limiter table. Do not log the header or raw address. Local development may use `x-forwarded-for`; that fallback is not used in production.

## Consent, confirmation and mailing

Every signup is recorded as `pending_confirmation`; a generic success response does not confirm that the address was new or verified. No marketing email is sent by this application. Do not mail or export pending addresses. A future double-opt-in implementation must verify control of the address, record `confirmed_at`, and transition the row to `subscribed` only after a valid confirmation. Store only a hash of any future one-time confirmation token, with expiry, in a separate restricted table.

The current consent text version is `newsletter-consent-v1`. If consent wording or purpose materially changes, update the version constant and preserve the version with each new consent record.

## Retention and withdrawal requests

- Pending signups are due for deletion after six months. The application deletes expired pending rows during a later signup request; this is opportunistic cleanup, not a scheduled guarantee. An administrator should arrange periodic cleanup in Supabase if a strict deletion schedule is required:

  ```sql
  delete from public.newsletter_subscribers
  where status = 'pending_confirmation'
    and registered_at < now() - interval '6 months';
  ```

- Confirmed rows remain only while consent is active and the project has a newsletter purpose. Review this need periodically; no messages are currently sent.
- Handle withdrawal requests sent to `endurset@gmail.com` promptly. Use restricted administrator access, normalize the exact address, and update by parameterized value. Set `status = 'unsubscribed'` and `unsubscribed_at = now()`, clear `registered_at`, `consent_at`, `consent_text_version`, and `confirmed_at`, and remove the address from any working/export files. This leaves only the random row ID, normalized address, status, and withdrawal timestamp as a potential suppression record.
- Keep that minimal suppression record only while there is a documented, lawful need to prevent accidental re-import or mailing; review the need at least annually. If that need is not justified, delete the row instead. Do not keep exported CSV files as a suppression list.
- Do not promise self-service unsubscribe or confirmation emails; neither exists in this version.

## Future eligible CSV export

There is intentionally no export route. When an approved mailing provider and confirmation flow exist, an administrator may use a restricted Supabase session to export only records matching all of these conditions: `status = 'subscribed'`, `confirmed_at IS NOT NULL`, `consent_at IS NOT NULL`, and `consent_text_version` is an accepted version for the stated product-update purpose. Include only normalized email and the consent timestamp/version needed to establish provenance; do not include IDs, request metadata, route data, or limiter rows. For example, the eligibility filter is:

```sql
select email_normalized, consent_at, consent_text_version
from public.newsletter_subscribers
where status = 'subscribed'
  and confirmed_at is not null
  and consent_at is not null
  and consent_text_version is not null;
```

In the restricted Supabase SQL Editor, export query results to CSV only after checking the eligible row count and recipient scope. Transfer the file through an approved secure channel, import only eligible records, then securely delete temporary copies. Reconcile withdrawals against the source table immediately before a campaign. No real subscriber list has been exported as part of this implementation.

## Rollback

Disable the homepage form or remove `NEWSLETTER_RATE_LIMIT_SECRET` to make new submissions fail closed; this does not delete records. To roll back storage, first disable signup and preserve any records subject to user rights or retention duties. Drop the two newsletter tables only after a separate data-retention review and explicit approval; never drop the feedback tables as part of newsletter rollback.
