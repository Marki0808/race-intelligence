-- Distinguish deterministic analysis inputs while preserving physical route identity.
-- Legacy rows remain present with NULL and are intentionally ignored by application lookups.
alter table public.route_analyses
  add column if not exists analysis_input_fingerprint text;

-- Replace the former one-analysis-per-route/version rule with variant-aware uniqueness.
alter table public.route_analyses
  drop constraint if exists route_analyses_route_version_unique;

-- PostgreSQL permits multiple NULL values in a unique index. The partial index makes that
-- legacy behavior explicit while preventing duplicate non-NULL analysis variants.
create unique index if not exists route_analyses_input_identity_unique_idx
  on public.route_analyses (route_id, analysis_version, analysis_input_fingerprint)
  where analysis_input_fingerprint is not null;
