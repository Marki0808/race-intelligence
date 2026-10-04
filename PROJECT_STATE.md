# Race Intelligence — Project State

**Last verified against:** `main` at `649dfb0c34ee399a092ec39a845b00f1c1d5f8be`
**Verification date:** 2026-10-04
**Document scope:** Current repository architecture plus separately labeled Production facts supplied from completed operational verification.

## 1. Project overview

Race Intelligence helps trail runners understand a route before running or racing it. The current product has two related flows:

- **Race Mode:** a curated race experience resolved from a statically registered `RaceRecordData`. It presents race/edition information, course exploration, Key Moments, Course Character, sources, and course analysis.
- **Route Mode:** a user selects a GPX file for deterministic route analysis. Analysis runs in the browser. OSM and Mapillary evidence can also be requested for local/noncanonical uploads through the application APIs; shared-persistence eligibility is not required to request or use that evidence. For registered physical routes that meet the shared-route rules, the same evidence flow can additionally use server-side shared persistence and reuse.

Current analytical outputs include distance and elevation metrics, Route Dynamics, consolidated runner-facing Route Sections, Key Route Moments, and optional surface/imagery evidence. GPX-derived outputs are distinct from external provider evidence. There is no AI analysis or database-backed race search in the current implementation.

## 2. End-to-end data flow

### Route Mode

1. The browser reads the selected GPX text and `parseGpxText` extracts route points and elevation.
2. The browser computes two separate identities: physical `routeFingerprint` and normalized ordered-input `analysisInputFingerprint`.
3. Route Analysis is looked up through the server persistence API when the route is eligible. Otherwise, compatible local IndexedDB analysis can be reused. On a miss or persistence failure, `analyzeGpxRoute` computes results locally.
4. Deterministic analysis produces route metrics, Route Dynamics, final Route Sections, Key Route Moments, and course character. Route Sections describe the dominant runner-facing phases; Key Route Moments are discrete facts/highlights, not another segmentation.
5. Optional evidence requests run separately from deterministic Route Analysis. Route Mode can request OSM evidence through the application Geo Enrichment API and Mapillary imagery through the application Mapillary API for local/noncanonical uploads as well as registered routes. OSM evidence is classified from returned OSM ways; Mapillary searches are built per Route Section. Requests may fail or return partial/no usable evidence, and neither provider defines Route Section boundaries.
6. For local/noncanonical routes, compatible analysis and enrichment/cache data can be stored in browser IndexedDB. For registered physical routes that meet shared-route eligibility rules, the same evidence flow can additionally reuse or persist compatible data through the server-side shared store. External evidence availability is independent of shared-persistence eligibility: a route may request/use provider evidence without being eligible for shared persistence. The UI presents route-derived analysis and clearly scoped evidence/coverage states.

### Race Mode

Race Mode resolves a route parameter against the static `raceRegistry`, then supplies the resolved race record to data-driven page components. Its selected edition supplies the GPX reference and descriptive race intelligence. It is separate from arbitrary GPX upload in Route Mode.

### Evidence boundary

Distance, elevation, dynamics, Route Sections, and Key Route Moments come from parsed GPX points and deterministic calculations. OSM and Mapillary are optional external evidence layers. Missing provider coverage remains missing/unknown; it is not inferred from route shape or neighboring evidence.

## 3. Identity model — critical

### Physical route identity

`routeFingerprint + routeFingerprintVersion` identifies normalized physical route geometry. The fingerprint implementation uses ordered latitude/longitude geometry and deliberately excludes elevation. Its normalized geometry is also the route geometry stored for the shared route record.

This identity is used for physical route records, shared-route eligibility, race-edition route links, and OSM/Mapillary reuse. Direction is significant in the current fingerprint implementation.

### Analysis input identity

`analysisInputFingerprint` identifies the normalized ordered numerical input supplied to deterministic Route Analysis; it is not a hash of the original GPX text or its raw numeric formatting. It includes ordered latitude, longitude, and elevation values, preserving point order and point count/density. Deterministic normalization includes treating negative zero and zero equivalently. It excludes filename, GPX metadata/name, upload time, and browser-specific state.

### Analysis algorithm identity

`analysisVersion` identifies Route Analysis algorithm/data semantics. A valid analysis cache hit requires all three:

```text
physical route identity
+ analysisVersion
+ analysisInputFingerprint
```

These identities are separate because the same physical trail can be represented with different elevation inputs or point samples. Geometry-based evidence and eligibility can remain reusable, while a cached deterministic analysis must match the exact analysis input and algorithm version.

## 4. Local and shared persistence

### Browser-local IndexedDB

`app/routePersistence.ts` provides optional local persistence for route metadata, analysis variants, OSM enrichment, Mapillary enrichment, and race-edition references. The current analysis store is `analysis-variants`, keyed by physical fingerprint/version, analysis version, and analysis-input fingerprint.

The legacy local `analyses` object store is not used as a fallback for current lookups. Legacy analyses without `analysisInputFingerprint` fail closed. Local persistence is an optimization: when IndexedDB is unavailable or an operation fails, Route Mode can recompute the analysis locally. An IndexedDB open blocked by another tab may therefore mean no cache for that attempt; the route can still be analyzed.

### Server-shared persistence

Shared persistence uses the server-only `POSTGRES_URL` connection in `app/server/sharedRouteStore.ts`. The browser calls the application API; it does not connect directly to Postgres. Raw GPX files and original filenames are not stored by the shared route store.

Shared eligibility is determined on the server by comparing the physical fingerprint against GPX data loaded from the race registry. A client-provided `analysisInputFingerprint` is a lookup request value; it does not establish eligibility or authorize a shared write. The server derives the canonical input fingerprint from its registry GPX.

When the physical route matches but its submitted analysis input differs from the server-derived canonical input, the analysis lookup returns no shared analysis and skips analysis read/create/persist in that lookup path. Route Mode uses its local analysis path instead. Matching canonical input may reuse or create the canonical shared analysis. OSM and Mapillary reuse remain governed by their own route/evidence identities and versions.

## 5. Shared database model

The current migrations define eight shared tables:

| Table | Role and identity |
| --- | --- |
| `routes` | Physical route record, unique by fingerprint and fingerprint version; includes normalized geometry and distance metadata. Persistence scope is constrained to `shared`. |
| `route_analyses` | Deterministic analysis JSON attached to a route. Current identity is `route_id + analysis_version + analysis_input_fingerprint`. |
| `route_osm_enrichments` | Current merged OSM evidence for a route, keyed by route, OSM schema version, and provider. |
| `route_osm_snapshots` | OSM retrieval snapshots associated with an enrichment; content hash prevents duplicate snapshots. |
| `route_mapillary_enrichments` | Mapillary evidence keyed by route, Mapillary schema version, and provider. It has no Route Analysis version. |
| `races` | Race identity records. |
| `race_editions` | Edition/year records belonging to a race. |
| `race_edition_routes` | Links a race edition to a physical `route_id`; it does not duplicate fingerprint identity. |

Foreign keys use `ON DELETE RESTRICT` in the current migration. RLS is enabled on all eight tables; application database access is server-side, with no browser database client or browser table policies created by these migrations.

Legacy `route_analyses` rows with a NULL `analysis_input_fingerprint` may remain after the additive identity migration. Application analysis lookup requires a non-null exact input fingerprint, so those legacy rows are intentionally ignored rather than treated as cache hits.

## 6. OSM and Surface Evidence

OSM adds optional physical-route surface evidence. The current retrieval service uses the public Overpass endpoint `overpass-api.de`, with bounded corridor queries, request limits, and adaptive subdivisions for retryable partial failures. Returned ways are parsed and spatially matched against the route; terrain classification is based on available OSM tags.

Retrieval coverage, matched/classifiable coverage, unavailable ranges, and classifiable ranges represent different stages. A successful corridor query does not imply every part of that range has classifiable surface tags. Failed or unavailable ranges remain insufficient evidence. Terrain Aggregation V3 keeps supported terrain sections separate from `insufficientEvidenceRanges`; it does not let query chunk boundaries become terrain-section boundaries.

OSM evidence and snapshots are persisted independently from Route Analysis and are physical-route based, not elevation-dependent. Partial results can be merged and reused by route/schema/provider identity.

Current Surface Evidence presentation semantics:

- Exact mapped coverage of **0%** is `missing`, even if inconsistent category data is present.
- Positive exact coverage below **1%** remains mapped and is displayed as **`<1%`**.
- At **1% or greater**, the normal mapped coverage presentation is used.
- Terrain distribution percentages describe only mapped/classifiable evidence; they do not claim the same distribution over the entire route.

## 7. Mapillary

Mapillary supplies optional route imagery as a separate evidence layer. Requests are built from Route Sections and their GPX points, then sent server-side to Mapillary when configured. Its token is read server-side; absence or provider failure yields an unavailable/unknown imagery result rather than blocking GPX analysis or OSM evidence.

Mapillary persistence/reuse is keyed by physical route fingerprint/version, Mapillary schema version, and provider. It is not keyed by `analysisVersion` or `analysisInputFingerprint`; changing Route Analysis semantics alone does not invalidate compatible imagery.

Current implementation builds section requests from the server-derived analysis and drops request groups with fewer than two sampled points. Consequently it does not guarantee imagery coverage for every very short Route Section or continuous image coverage along every route point. Provider search and matching limits also mean “available” is evidence of matched imagery, not complete visual coverage.

## 8. Race registry and shared eligibility

`app/raceRegistry.ts` exports the current static collection of `RaceRecordData`; it presently contains the Istria 110K record. Race identity, edition data, descriptive intelligence, and sources live in the race data model, while each edition supplies edition-specific facts including its GPX path.

The server loads a registered edition's public GPX and computes the authorized physical and analysis-input identities. A physical-route match establishes that the route is eligible for shared physical-route evidence. The server-derived registry `analysisInputFingerprint` separately decides whether canonical Route Analysis can be reused or persisted.

If physical geometry matches but elevation or ordered point input differs, the request must not receive canonical shared analysis or persist arbitrary uploaded analysis. It falls back to local analysis/reuse. Future registered races/editions can extend the registry, but the registry and currently available race data remain statically defined in this version.

## 9. Production architecture

- Next.js application with server and client components/API routes.
- Vercel Production hosts the application.
- Browser Route Mode performs GPX parsing and deterministic analysis and can use IndexedDB locally.
- Server API routes use a server-only PostgreSQL connection to Supabase/Postgres for shared persistence.
- OSM evidence may use the public Overpass service; Mapillary imagery may use the Mapillary API when a server-side token is configured.

No credentials, connection strings, tokens, or environment values belong in this document. The database URL is not a `NEXT_PUBLIC_*` variable and must remain server-only.

## 10. Production-verified facts

> The following are operational facts supplied from completed Production verification. They are not inferred solely from repository code and were not re-queried while creating this document.

- Vercel Production was reported **Ready and Current** after commit `649dfb0c34ee399a092ec39a845b00f1c1d5f8be` (`fix: key route analysis cache by input identity`).
- Vercel Production to server-side PostgreSQL/Supabase connectivity was previously verified.
- All eight shared persistence tables were reachable from Production.
- Shared persistence write, read-back, idempotency, and cleanup were smoke-tested.
- The analysis-input identity migration was manually applied and verified: `analysis_input_fingerprint` is nullable text; the old route/version uniqueness rule was removed; a variant-aware partial unique index exists; RLS remained enabled; and the route foreign key retains `ON DELETE RESTRICT`.
- Controlled live persistence tests verified identical full-identity idempotency, coexistence and specific read-back of two input variants for one physical route/analysis version, cache misses for unknown fingerprints and legacy NULL fingerprints, and cleanup restoring all eight table counts to baseline.
- The Surface Evidence zero-versus-low-coverage presentation change was reported deployed to Production.

## 11. Testing and quality gates

Before important changes, the project workflow uses:

- Full Node test suite (`node --test`; there is no dedicated `test` script in `package.json`).
- `npx tsc --noEmit`.
- `npm run lint`.
- `npm run build`.
- `git diff --check` and review of the complete Git diff.
- Controlled live database smoke tests with synthetic data and cleanup when persistence semantics change.

At commit `649dfb0c34ee399a092ec39a845b00f1c1d5f8be`, the reported full suite result was **175 passed, 0 failed**. This is a point-in-time result, not a permanent suite count.

## 12. Architectural invariants

- Physical route identity is different from exact analysis-input identity.
- Elevation changes must not change physical route identity.
- Analysis cache reuse requires matching physical route, `analysisVersion`, and `analysisInputFingerprint`.
- `analysisVersion` and `analysisInputFingerprint` describe different things: algorithm semantics versus input data.
- OSM identity remains physical-route based.
- Mapillary identity remains physical-route based and independent of Route Analysis versions.
- Race eligibility remains physical-route based; it does not authorize arbitrary client analysis data.
- Client-provided hashes do not establish server authority.
- Legacy analysis records without input identity fail closed.
- Missing or insufficient evidence must not be presented as confident terrain evidence.
- Shared database persistence and provider credentials remain server-side.
- GPX-derived analysis, OSM evidence, and Mapillary evidence retain distinct provenance and failure behavior.
- Route Sections are the primary runner-facing segmentation; Key Route Moments are highlights/facts rather than a second segmentation.

## 13. Known limitations and open correctness work

| Issue | Status and confidence |
| --- | --- |
| GPX track-segment boundaries | **Confirmed code limitation.** `parseGpxText` extracts all `trkpt` elements into one point list and does not preserve `<trkseg>` boundaries. `analyzeGpxRoute` calculates distance and elevation change between every adjacent point. Disconnected segments can therefore create synthetic straight-line distance/elevation relationships. |
| Mapillary section coverage | **Confirmed code limitation.** Requests are made per Route Section; generated requests with fewer than two sampled points are discarded. Imagery is not guaranteed for every section or continuously along the route. |
| Race Mode versus Route Mode | **Current product distinction.** Race Mode is a curated registered-race experience; Route Mode analyzes a user-selected GPX. Arbitrary uploads do not become registered races or shared canonical analyses. |
| Race registry scalability | **Current architectural limit.** Available race records are statically imported and listed in `raceRegistry.ts`; no database-backed registry or dynamic race ingestion exists. |
| IndexedDB fallback | **Confirmed behavior.** Persistence is optional; failed/unavailable local storage falls back to computing analysis in memory. A blocked database upgrade may prevent caching during that attempt. |
| Extremely short routes | **Previously observed, not independently reproduced in this review.** A synthetic route of roughly 300 m was reported to fail in Route Analysis around `routeSectionEngine.ts`. Treat as an open regression candidate, not a general claim that all short routes fail. |
| Public OSM availability | **Provider-dependent limitation.** Overpass can time out, rate-limit, or return partial coverage. The UI and data model preserve unavailable/unknown ranges; successful classification depends on actual returned OSM ways and tags. |

## 14. Current priorities

1. Correct GPX `<trkseg>` boundary handling so disconnected track segments do not create synthetic joins; define appropriate parsing and analysis behavior and cover it with deterministic tests.
2. Add regression coverage for very short valid GPX routes, based on the reported synthetic failure, before deciding whether a generic engine fix is required.
3. Keep external evidence coverage and provenance explicit as route and provider behavior evolves; do not infer terrain or imagery where evidence is absent.

## 15. Safe development workflow

For correctness-sensitive, architectural, persistence, or production-impacting changes:

1. Audit the current implementation and agree on the design.
2. Implement locally with a narrow scope.
3. Run tests, TypeScript, ESLint, production build, and diff checks.
4. Review the complete diff, including staged and unstaged changes.
5. Review/apply database migrations separately when required; do not couple an unreviewed migration to application deployment.
6. Verify the live schema read-only.
7. Run controlled database smoke tests only with synthetic data and mandatory dependency-ordered cleanup.
8. Stage only the intended files/hunks and review the staged diff.
9. Commit and push the reviewed snapshot.
10. Confirm the corresponding Vercel Production deployment is Ready/Current and perform the required production verification.
11. Update this document when architecture or verified operational state materially changes.

Temporary Production diagnostics must be removed after they have served their purpose and a cleanup deployment is verified.

## 16. Document maintenance

Update `PROJECT_STATE.md` whenever a change materially affects architecture, identity/version semantics, persistence, external providers, Production infrastructure, known correctness limitations, or major product flows. Keep repository-derived facts separate from operational facts verified outside the repository.
