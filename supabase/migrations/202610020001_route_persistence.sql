-- Initial shared-route schema. This migration is additive and contains no destructive statements.
create table if not exists public.routes (
  id uuid primary key default gen_random_uuid(),
  fingerprint text not null,
  fingerprint_version integer not null check (fingerprint_version > 0),
  persistence_scope text not null check (persistence_scope = 'shared'),
  normalized_distance_km double precision not null check (normalized_distance_km >= 0),
  total_distance_km double precision not null check (total_distance_km >= 0),
  representative_point_count integer not null check (representative_point_count >= 0),
  normalized_geometry jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint routes_fingerprint_version_unique unique (fingerprint, fingerprint_version)
);

create table if not exists public.route_analyses (
  id uuid primary key default gen_random_uuid(),
  route_id uuid not null references public.routes(id) on delete restrict,
  analysis_version integer not null check (analysis_version > 0),
  analysis_data jsonb not null,
  generated_at timestamptz not null,
  constraint route_analyses_route_version_unique unique (route_id, analysis_version)
);

create table if not exists public.route_osm_enrichments (
  id uuid primary key default gen_random_uuid(),
  route_id uuid not null references public.routes(id) on delete restrict,
  schema_version integer not null check (schema_version > 0),
  provider text not null,
  route_length_km double precision not null check (route_length_km >= 0),
  retrieval_coverage_percent double precision not null default 0 check (retrieval_coverage_percent between 0 and 100),
  classifiable_coverage_percent double precision not null default 0 check (classifiable_coverage_percent between 0 and 100),
  retrieved_ranges jsonb not null default '[]'::jsonb,
  unavailable_ranges jsonb not null default '[]'::jsonb,
  classifiable_ranges jsonb not null default '[]'::jsonb,
  conflicts jsonb not null default '[]'::jsonb,
  current_merged_data jsonb not null,
  current_snapshots jsonb not null default '[]'::jsonb,
  retrieved_at timestamptz not null,
  updated_at timestamptz not null default now(),
  constraint route_osm_enrichments_route_version_provider_unique unique (route_id, schema_version, provider)
);

create table if not exists public.route_osm_snapshots (
  id uuid primary key default gen_random_uuid(),
  enrichment_id uuid not null references public.route_osm_enrichments(id) on delete restrict,
  provider text not null,
  content_hash text not null,
  successful_ranges jsonb not null default '[]'::jsonb,
  unavailable_ranges jsonb not null default '[]'::jsonb,
  classifiable_ranges jsonb not null default '[]'::jsonb,
  diagnostics jsonb not null default '{}'::jsonb,
  provenance jsonb not null default '{}'::jsonb,
  snapshot_data jsonb not null,
  retrieved_at timestamptz not null,
  constraint route_osm_snapshots_content_unique unique (enrichment_id, content_hash)
);

create table if not exists public.route_mapillary_enrichments (
  id uuid primary key default gen_random_uuid(),
  route_id uuid not null references public.routes(id) on delete restrict,
  schema_version integer not null check (schema_version > 0),
  provider text not null default 'mapillary',
  enrichment_data jsonb not null,
  retrieved_at timestamptz not null,
  updated_at timestamptz not null default now(),
  constraint route_mapillary_route_version_provider_unique unique (route_id, schema_version, provider)
);

create table if not exists public.races (
  id text primary key,
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.race_editions (
  id uuid primary key default gen_random_uuid(),
  race_id text not null references public.races(id) on delete restrict,
  year integer not null check (year between 1900 and 2200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint race_editions_race_year_unique unique (race_id, year)
);

create table if not exists public.race_edition_routes (
  race_edition_id uuid not null references public.race_editions(id) on delete restrict,
  route_id uuid not null references public.routes(id) on delete restrict,
  created_at timestamptz not null default now(),
  primary key (race_edition_id, route_id)
);

create index if not exists route_analyses_route_lookup_idx on public.route_analyses (route_id, analysis_version);
create index if not exists route_osm_enrichments_route_lookup_idx on public.route_osm_enrichments (route_id, schema_version);
create index if not exists route_osm_snapshots_enrichment_time_idx on public.route_osm_snapshots (enrichment_id, retrieved_at desc);
create index if not exists route_mapillary_route_lookup_idx on public.route_mapillary_enrichments (route_id, schema_version);
create index if not exists race_edition_routes_route_lookup_idx on public.race_edition_routes (route_id);

-- The application connects with a server-only Postgres URL. No browser roles get direct table access.
alter table public.routes enable row level security;
alter table public.route_analyses enable row level security;
alter table public.route_osm_enrichments enable row level security;
alter table public.route_osm_snapshots enable row level security;
alter table public.route_mapillary_enrichments enable row level security;
alter table public.races enable row level security;
alter table public.race_editions enable row level security;
alter table public.race_edition_routes enable row level security;
