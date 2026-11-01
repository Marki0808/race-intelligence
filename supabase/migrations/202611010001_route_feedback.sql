-- Additive V1 feedback storage. Browser roles receive no direct table policy.
create table if not exists public.route_feedback_submissions (
  id uuid primary key,
  feedback_text text not null check (char_length(btrim(feedback_text)) between 1 and 2000),
  created_at timestamptz not null default now()
);

create index if not exists route_feedback_submissions_created_at_idx
  on public.route_feedback_submissions (created_at);

-- Rate-limit state is separate from feedback and contains only keyed digests, counters, and expiry.
create table if not exists public.route_feedback_rate_limit_buckets (
  bucket_hash text primary key check (bucket_hash ~ '^[0-9a-f]{64}$'),
  request_count integer not null check (request_count > 0),
  expires_at timestamptz not null
);

create index if not exists route_feedback_rate_limit_expiry_idx
  on public.route_feedback_rate_limit_buckets (expires_at);

alter table public.route_feedback_submissions enable row level security;
alter table public.route_feedback_rate_limit_buckets enable row level security;
