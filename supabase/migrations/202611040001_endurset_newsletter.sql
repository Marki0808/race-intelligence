-- Newsletter signup records are isolated from feedback and never directly accessible to browser roles.
create table if not exists public.newsletter_subscribers (
  id uuid primary key,
  email_normalized text not null unique
    check (char_length(email_normalized) between 3 and 254)
    check (email_normalized = lower(btrim(email_normalized)))
    check (email_normalized ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'),
  registered_at timestamptz,
  consent_at timestamptz,
  consent_text_version text,
  status text not null check (status in ('pending_confirmation', 'subscribed', 'unsubscribed')),
  confirmed_at timestamptz,
  unsubscribed_at timestamptz,
  check (
    (status = 'pending_confirmation' and registered_at is not null and consent_at is not null and consent_text_version is not null and confirmed_at is null and unsubscribed_at is null)
    or (status = 'subscribed' and registered_at is not null and consent_at is not null and consent_text_version is not null and confirmed_at is not null and unsubscribed_at is null)
    or (status = 'unsubscribed' and unsubscribed_at is not null)
  )
);

create index if not exists newsletter_subscribers_status_confirmed_idx
  on public.newsletter_subscribers (status, confirmed_at)
  where status = 'subscribed';
create index if not exists newsletter_subscribers_pending_retention_idx
  on public.newsletter_subscribers (registered_at)
  where status = 'pending_confirmation';

create table if not exists public.newsletter_rate_limit_buckets (
  bucket_hash text primary key check (bucket_hash ~ '^[0-9a-f]{64}$'),
  request_count integer not null check (request_count > 0),
  expires_at timestamptz not null
);
create index if not exists newsletter_rate_limit_expiry_idx
  on public.newsletter_rate_limit_buckets (expires_at);

alter table public.newsletter_subscribers enable row level security;
alter table public.newsletter_rate_limit_buckets enable row level security;
revoke all on public.newsletter_subscribers from public, anon, authenticated;
revoke all on public.newsletter_rate_limit_buckets from public, anon, authenticated;
grant all on public.newsletter_subscribers to service_role;
grant all on public.newsletter_rate_limit_buckets to service_role;
