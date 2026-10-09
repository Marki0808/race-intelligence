# Race Intelligence — Project State

**Last verified against:** `main` at `9102d82b81c8454c14834ccbb8c439e9ea736140`
**Verification date:** 2026-10-09
**Document scope:** Current repository architecture plus separately labeled Production facts supplied from completed operational verification.

Sections 1–9 and 11–16 describe repository-derived implementation and status. Section 10 records operational facts from Production verification; it does not imply that every code path or external-provider persistence behavior was verified in Production.

## 1. Project overview

Race Intelligence helps trail runners understand a route before running or racing it. The current product has two related flows:

- **Race Mode:** a curated race experience resolved from a statically registered `RaceRecordData`. It presents race/edition information, course exploration, Key Moments, Course Character, sources, and course analysis.
- **Route Mode:** a user selects a GPX file for deterministic route analysis. Analysis runs in the browser. OSM and Mapillary evidence can also be requested for local/noncanonical uploads through the application APIs; shared-persistence eligibility is not required to request or use that evidence. For registered physical routes that meet the shared-route rules, the same evidence flow can additionally use server-side shared persistence and reuse.

Current analytical outputs include distance and elevation metrics, Route Dynamics, consolidated runner-facing Route Sections, Key Route Moments, optional surface/imagery evidence, and Course Brief engines. Course Brief V1 is the current API flow; a separate deterministic V2 engine is implemented but is not wired into that API. GPX-derived outputs are distinct from external provider evidence. Race search remains statically registered rather than database-backed.

## 2. End-to-end data flow

### Route Mode

1. The browser reads the selected GPX text. `parseGpxText` preserves each `<trkseg>` as a separate ordered component and assigns its points a `segmentIndex`. Empty and singleton components do not create traversed edges. Multiple `<trk>` elements remain unsupported and are rejected by the parser.
2. The browser computes two separate identities: physical `routeFingerprint` and normalized ordered-input `analysisInputFingerprint`.
3. Route Analysis is looked up through the server persistence API when the route is eligible. Otherwise, compatible local IndexedDB analysis can be reused. On a miss or persistence failure, `analyzeGpxRoute` computes results locally.
4. Deterministic analysis computes distance and elevation changes only along traversed edges within each component. Route Dynamics and Route Sections are segment-aware; no synthetic adjacency is introduced across component boundaries. Route Sections describe the dominant runner-facing phases; Key Route Moments are discrete facts/highlights, not another segmentation.
5. Optional evidence requests run separately from deterministic Route Analysis. Route Mode can request OSM evidence through the application Geo Enrichment API and Mapillary imagery through the application Mapillary API for local/noncanonical uploads as well as registered routes. OSM evidence is classified from returned OSM ways; Mapillary searches are built per Route Section. Requests may fail or return partial/no usable evidence, and neither provider defines Route Section boundaries.
6. For local/noncanonical routes, compatible analysis and enrichment/cache data can be stored in browser IndexedDB. For registered physical routes that meet shared-route eligibility rules, the same evidence flow can additionally reuse or persist compatible data through the server-side shared store. External evidence availability is independent of shared-persistence eligibility: a route may request/use provider evidence without being eligible for shared persistence. The UI presents route-derived analysis and clearly scoped evidence/coverage states.

### Race Mode

Race Mode resolves a route parameter against the static `raceRegistry`, then supplies the resolved race record to data-driven page components. Its selected edition supplies the GPX reference and descriptive race intelligence. It is separate from arbitrary GPX upload in Route Mode.

### Course Phases and Narrative

The deterministic Course Intelligence layers consume final Route Sections and remain race-agnostic.

- **Course Phase V1** consumes final Route Sections and groups persistent/stable route rhythm into the closed vocabulary `climb-dominant`, `descent-dominant`, `repeated-vertical`, `low-vertical`, and `mixed`. Components are processed independently; phases and transitions do not cross disconnected GPX components. A same-character run across at least two adjacent sections is persistent; a single-section phase uses Route Dynamics stability (currently 0.58) plus route-relative support (currently at least 8% of component distance or 20% of vertical work), with a repeated-vertical pattern also recognized by the phase rules. These are algorithm configuration values, not universal distance cutoffs. `COURSE_PHASE_ALGORITHM_VERSION = 1`.
- **Course Narrative V1** consumes Course Phases, transitions, and structural route evidence to form larger Narrative Units. Patterns include phase characters and `evolving`; units preserve component identity and may be enriched by extrema and selected Key Moments. Event tiers are deterministic. `COURSE_NARRATIVE_ALGORITHM_VERSION = 1`.
- **Course Brief Narrative Facts V2** is a compact deterministic projection in `CourseBriefInputV2`. Its closed fact catalog is `UNIT_CHARACTER`, `STRUCTURAL_TRANSITION`, `VERTICAL_INTENSITY_EVOLUTION`, `PERSISTENT_FINISH_CHARACTER`, `ANCHOR_WITHIN_UNIT`, and `SIGNIFICANT_INTERRUPTION`. Facts are structured data, not prose; direct structural facts are separated from bounded interpretations. Interruptions are retained but are not currently selectable. Decreasing vertical-intensity evolution is implemented; increasing evolution is not. Race Context, geographic anchors, and OSM are not part of this input. `COURSE_BRIEF_INPUT_SCHEMA_VERSION = 2`; `NARRATIVE_FACT_SCHEMA_VERSION = 1`.

For checked-in Istria 110K, the current analysis produces **15 Route Sections → 5 Course Phases → 4 Narrative Units → 25 Narrative Fact records, of which 14 are selectable**. The phase ranges are 0–30.45 km climb-dominant; 30.45–42.75 km descent-dominant; 42.75–86.25 km repeated-vertical; 86.25–100.55 km descent-dominant; and 100.55–110.73 km low-vertical. The four Narrative Units are 0–30.45 km climb-dominant; 30.45–42.75 km descent-dominant; 42.75–86.25 km repeated-vertical; and 86.25–110.73 km evolving. These are observed Istria outputs, not universal thresholds.

### Course Brief V1 API flow

The current `/api/course-brief` flow is an ephemeral, server-generated summary of a caller-submitted `CourseBriefInputV1`. The checked-in deterministic builder projects Route Analysis into a compact input with three provenance groups:

- `directFacts`: route metrics, elevation extrema, and track components.
- `derivedFacts`: smoothed vertical progression, ordered Route Sections, and structured Key Route Moments.
- `evidenceScopedFacts`: optional section-scoped OSM surface evidence.

Raw GPX is not sent to the model. Coordinates, Mapillary data, filenames, user data, and race context are excluded from the Course Brief input. Its `schemaVersion` is 1.

The V1 generation flow is:

```text
validated CourseBriefInputV1
→ deterministic fact index
→ eligible claim enumeration
→ request-specific eligible option catalog
→ model selects option IDs only
→ IDs map to canonical claims
→ semantic and redundancy validation
→ deterministic rendering
```

Application code decides which claims are factually eligible. The model selects and prioritizes from that set; it does not calculate route metrics, determine claim eligibility, author final claim parameters, or write the final prose. The closed catalog contains `vertical_concentration`, `vertical_transition`, `key_moment`, `highest_point`, `lowest_point`, and `osm_surface_category`. It does not support claims about difficulty, technicality, runnability, strategy, hazards, weather, nutrition, or pacing unless a separately designed evidence model supports them.

The server-side API uses the OpenAI Responses API with `gpt-5.4-mini`, `store: false`, `maxRetries: 0`, no reasoning effort, low verbosity, and bounded output and request duration. Prompt version is 2; the internal model-selection schema version is 1. `OPENAI_API_KEY` is configured in Vercel Production and API billing was reported active; secret values do not belong in this document.

`CourseBriefInputV1` is schema version 1; its prompt version is 2, selection schema version is 1, and rendered Course Brief schema version is 1. This is the V1/API path; its OpenAI ID-selection architecture is not the V2 selector. `ROUTE_ANALYSIS_VERSION` remains 2. The Course Brief milestones made no physical fingerprint, analysis-input fingerprint, database migration, or IndexedDB schema-version change.

Input validation is strict and the request body is limited to 64 KiB. Eligible-option enumeration and final semantic validation share the same evaluator; the request-specific Structured Output schema limits selections to eligible IDs. Final semantic and redundancy checks remain defense in depth, and prose is rendered deterministically. Public errors are sanitized. Telemetry excludes prompts, provider output, route values, coordinates, GPX, raw OSM/Mapillary evidence, credentials, and user data.

The API accepts caller-submitted `CourseBriefInputV1` and validates it internally; it does not independently derive the facts from trusted GPX/OSM sources. This is suitable only for the current ephemeral caller-visible flow. Submitted Course Brief input must not become authoritative shared persistent/cache data without trusted server-side derivation and identity. The endpoint also lacks durable authentication/rate-limit protection suitable for unrestricted public exposure; abuse and cost controls are required before broad public exposure.

### Course Brief V2 deterministic engine — Phase 3C2A

The separate V2 engine in `app/courseBriefCandidates.ts` implements:

```text
CourseBriefInputV2
→ validation
→ deterministic candidate construction
→ deterministic coverage/redundancy selection
→ deterministic chronological ordering
→ deterministic rendering
```

It does **not** call a provider and is not wired into `/api/course-brief`; the V1 API remains separate. Candidate patterns are `UNIT`, `UNIT_WITH_ANCHOR`, `TRANSITION_TO_UNIT`, `EVOLVING_FINISH`, `EVOLUTION`, and `STANDALONE_TRANSITION`. Transitions normally attach to the destination unit; a candidate has at most one structural anchor; broad evolution cannot suppress a distinctive unit story; components remain separate. Selection is deterministic. Five rendered observations is a safety ceiling, not a limit on route complexity. V2 has no separate headline; zero candidates return a typed `insufficient_route_facts` result. Rendering uses validated canonical facts only, contains no AI prose, and adds no runner advice.

`COURSE_BRIEF_CANDIDATE_ALGORITHM_VERSION = 1` and `COURSE_BRIEF_OUTPUT_V2_SCHEMA_VERSION = 2`. Checked-in Istria currently yields four candidates, selects all four, omits none, and represents its traversable component. The engine's data structure is under review; its current deterministic wording is not approved final product copy. Natural-language quality and race-specific enrichment remain future work.

**AI decision:** Phase 2's AI selection architecture remains implemented for Course Brief V1/proof work. Initial Course Brief V2 does not use AI for factual correctness, grouping, coverage, ordering, selection, or rendering. An optional AI stylistic/prose layer may be evaluated separately, but no decision has been made to add it. Deterministic fallback remains a product principle.

### Evidence boundary

Distance, elevation, dynamics, Route Sections, and Key Route Moments come from parsed GPX points and deterministic calculations. OSM and Mapillary are optional external evidence layers. Missing provider coverage remains missing/unknown; it is not inferred from route shape or neighboring evidence.

## 3. Identity model — critical

### Physical route identity

`routeFingerprint + routeFingerprintVersion` identifies normalized physical route geometry. The current global fingerprint algorithm is version 2. Its ordered, path-topology-aware geometry preserves component boundaries, so one continuous path differs from disconnected paths even when they contain the same coordinates. Elevation is excluded. Its normalized geometry is also the route geometry stored for the shared route record.

This identity is used for physical route records, shared-route eligibility, race-edition route links, and OSM/Mapillary reuse. Direction and path topology are significant. Legacy v1 physical identities remain legacy data and are not silently reused as v2 identities. Physical identity is independent of Route Analysis version.

### Analysis input identity

`analysisInputFingerprint` identifies the normalized ordered numerical input supplied to deterministic Route Analysis; it is not a hash of the original GPX text or its raw numeric formatting. Its current algorithm version is 2. It includes component topology and, within each component, ordered latitude, longitude, and elevation values, preserving point order and point count/density. Deterministic normalization includes treating negative zero and zero equivalently. It excludes filename, GPX metadata/name, upload time, and browser-specific state. Legacy analyses without the current input identity are not accepted as current cache hits.

### Analysis algorithm identity

`analysisVersion` identifies Route Analysis algorithm/data semantics. The current `ROUTE_ANALYSIS_VERSION` is 2; older analysis versions are not treated as current. A valid analysis cache hit requires all three:

```text
physical route identity
+ analysisVersion
+ analysisInputFingerprint
```

These identities are separate because the same physical trail can be represented with different elevation inputs, point samples, or component topology. Geometry-based evidence and eligibility can remain reusable, while a cached deterministic analysis must match the exact analysis input and algorithm version.

## 4. Local and shared persistence

### Browser-local IndexedDB

`app/routePersistence.ts` provides optional local persistence for route metadata, analysis variants, OSM enrichment, Mapillary enrichment, and race-edition references. The current analysis store is `analysis-variants`, keyed by physical fingerprint/version, analysis version, and analysis-input fingerprint. The v2 physical identity and segment-aware JSON data required no IndexedDB schema-version bump.

The legacy local `analyses` object store is not used as a fallback for current lookups. Legacy analyses without `analysisInputFingerprint` fail closed. Local persistence is an optimization: when IndexedDB is unavailable or an operation fails, Route Mode can recompute the analysis locally. An IndexedDB open blocked by another tab may therefore mean no cache for that attempt; the route can still be analyzed.

### Server-shared persistence

Shared persistence uses the server-only `POSTGRES_URL` connection in `app/server/sharedRouteStore.ts`. The browser calls the application API; it does not connect directly to Postgres. Raw GPX files and original filenames are not stored by the shared route store.

Shared eligibility is determined on the server by comparing the physical fingerprint against GPX data loaded from the race registry. A client-provided `analysisInputFingerprint` is a lookup request value; it does not establish eligibility or authorize a shared write. The server derives the canonical input fingerprint from its registry GPX.

When the physical route matches but its submitted analysis input differs from the server-derived canonical input, the analysis lookup returns no shared analysis and skips analysis read/create/persist in that lookup path. Route Mode uses its local analysis path instead. Matching canonical input may reuse or create the canonical shared analysis. OSM and Mapillary reuse remain governed by their own route/evidence identities and versions.

## 5. Shared database model

The current migrations define eight shared tables:

| Table | Role and identity |
| --- | --- |
| `routes` | Physical route record, unique by fingerprint and fingerprint version; includes normalized topology-aware geometry and distance metadata. Persistence scope is constrained to `shared`. |
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

OSM requests, matching, and evidence ranges preserve `segmentIndex`. Equal cumulative kilometer positions on different components do not share evidence.

Current Surface Evidence presentation semantics:

- Exact mapped coverage of **0%** is `missing`, even if inconsistent category data is present.
- Positive exact coverage below **1%** remains mapped and is displayed as **`<1%`**.
- At **1% or greater**, the normal mapped coverage presentation is used.
- Terrain distribution percentages describe only mapped/classifiable evidence; they do not claim the same distribution over the entire route.

## 7. Mapillary

Mapillary supplies optional route imagery as a separate evidence layer. Requests are built from Route Sections and their GPX points, then sent server-side to Mapillary when configured. Its token is read server-side; absence or provider failure yields an unavailable/unknown imagery result rather than blocking GPX analysis or OSM evidence.

Mapillary persistence/reuse is keyed by physical route fingerprint/version, Mapillary schema version, and provider. It is not keyed by `analysisVersion` or `analysisInputFingerprint`; changing Route Analysis semantics alone does not invalidate compatible imagery.

Mapillary request validation and image matching preserve component identity and do not bridge disconnected paths.

Current implementation builds section requests from the server-derived analysis and drops request groups with fewer than two sampled points. Consequently it does not guarantee imagery coverage for every very short Route Section or continuous image coverage along every route point. Provider search and matching limits also mean “available” is evidence of matched imagery, not complete visual coverage.

## 8. Race registry and shared eligibility

`app/raceRegistry.ts` exports the current static collection of `RaceRecordData`; it presently contains the Istria 110K record. Race identity, edition data, descriptive intelligence, and sources live in the race data model, while each edition supplies edition-specific facts including its GPX path.

The server loads a registered edition's public GPX and computes the authorized v2 physical and analysis-input identities, including component topology. A physical-route match establishes that the route is eligible for shared physical-route evidence. The server-derived registry `analysisInputFingerprint` separately decides whether canonical Route Analysis can be reused or persisted.

If physical geometry matches but elevation or ordered point input differs, the request must not receive canonical shared analysis or persist arbitrary uploaded analysis. It falls back to local analysis/reuse. Future registered races/editions can extend the registry, but the registry and currently available race data remain statically defined in this version.

### Phase 3D — Race Context and Verified Route Anchors

**Status: 3D1 and 3D2 IMPLEMENTED AND COMMITTED; 3D3 DESIGN AUDIT ACCEPTED, IMPLEMENTATION NOT STARTED.** Phase 3D1 was committed as `6ee9330adefb834ff40fff521cbf92d11cc3d93a` (`feat: add verified route anchor foundation`). Phase 3D2 was committed as `9102d82b81c8454c14834ccbb8c439e9ea736140` (`feat: add deterministic route anchor matching`). These are repository implementation facts; no Production verification of these anchor capabilities is claimed.

**Phase 3D1 — Route Anchor foundation.** `app/routeAnchors.ts` defines edition-aware `RaceContextV1`, `RouteAnchorV1`, evidence, route bounds, ordering constraints, validation, and a deterministic index. Race Context describes race/edition locations; a Route Anchor associates a context location/place with a route visit and a position when supported. Place identity (`placeId`) and visit identity (`visitId`) are distinct; repeated visits require distinct visit IDs. Anchor types are START, FINISH, NAMED_LOCATION, and AID_STATION. Provenance and positional confidence are separate fields. Provenance includes official, GPX-derived, previous-edition, estimated, and unknown; confidence is exact-direct, verified-match, approximate, context-only, or conflicting.

Positions are component-scoped POINT, RANGE, ORDERED_ONLY, or UNPOSITIONED values. Coordinate evidence states whether a coordinate represents an event point, route point, place reference, or feature point. The validator checks edition/source references, evidence support, component/range bounds, endpoint consistency, unique anchor and visit IDs, and ordering consistency. Ordering constraints retain evidence-backed visit order as relational metadata; they do not create coordinates, kilometer positions, route distance, geometric continuity, or cross-component ownership. The pure index scopes queries to a component, uses half-open point ranges `[startKm, endKm)`, includes a terminal FINISH at the component endpoint, and uses strict interval overlap for ranges. Its position-safety helper distinguishes exact positions from qualified approximate positions; callers must still apply their own confidence policy.

**Phase 3D2 — evidence and deterministic matching.** Evidence Schema V2 adds explicit coordinate semantics and route-kilometer facts. Matching algorithm version is 1 and match-policy version is 1. `app/routeAnchorMatching.ts` validates its input, projects coordinates independently onto traversed great-circle route segments, and retains component/visit identity. It does not construct connectors across disconnected components. Direct route-kilometer evidence is accepted only when in bounds and unambiguous; coordinate projections retain candidate visits so loops, out-and-back routes, and repeated passes can be reported ambiguous. Evidence-backed ordering can disambiguate plausible visits when spatial candidates already exist; ordering alone produces no position. Contradictions and endpoint mismatches fail closed and are returned as diagnostics rather than positioned anchors.

START and FINISH positions are checked against the first and last traversed component endpoints. Coordinate semantics and generic offset policies constrain matching: route-point 30 m, event-point 100 m, feature-point 75 m, and place-reference-point 250 m; route-kilometer/coordinate agreement uses 0.1 km. A place-reference point can produce only an approximate named-location match; it cannot establish a START, FINISH, or AID_STATION. These are implementation policy thresholds, not guarantees of real-world accuracy or universal evidence standards. Approximate results are not position-safe for display. The exact-direct and verified-match results require trusted current-edition evidence and corresponding supported positions; previous-edition, estimated, unknown, or unsupported evidence cannot establish them by itself.

The checked-in Istria 110K 2027 fixture currently produces **four context-only entries and zero position-safe anchors**: Buzet START, Umag FINISH, Buzet AID_STATION, and Livade AID_STATION. The matcher test confirms all four remain unpositioned and that there are zero position-safe named anchors. The checked-in GPX has no `<wpt>` or `<rtept>` elements. GPX waypoint ingestion/support as an evidence-discovery path is deferred; there is no live source discovery, geocoding, or provider integration. This evidence status does not imply that those places are absent from the race or route.

**Phase 3D3 — next task.** The accepted design is a pure deterministic attachment layer that runs after Course Brief V2 structural candidate selection. It consumes already-selected observations/candidates plus validated position-safe matching output and emits separate structured attachment/render-token data. Geographic evidence must not alter structural candidate construction, selection, ordering, coverage, or count. `CourseBriefOutputV2` and its renderer remain unchanged in 3D3; no prose generation, string replacement, UI, API, or provider call belongs in this phase.

A trust boundary remains: Course Brief V2 input has no route identity, while the matcher receives a caller-supplied `routeId` and route geometry. A future 3D3 caller must bind both outputs to the same current Route Analysis result and compare route/component bounds. The existing contracts cannot independently prove that a caller-supplied identity is authentic or that two same-bounds inputs represent identical geometry. No shared or persistent use may treat submitted identities or evidence as authoritative without a trusted derivation path.

Planned sequence after the committed work:

1. **3D3:** deterministic post-selection anchor attachment and synthetic tests; keep attachment output separately versioned and fail closed on ambiguous ownership or identity/bounds mismatch.
2. **3D4:** structured geographic tokens and deterministic wording, using 3D3 output without changing structural selection.
3. Later: source discovery, GPX waypoint ingestion, extraction, geocoding, or provider integrations only after separate design and evidence-trust review.

## 9. Production architecture

- Next.js application with server and client components/API routes.
- Vercel Production hosts the application.
- Browser Route Mode performs GPX parsing and deterministic analysis and can use IndexedDB locally.
- GPX track components remain separate through metrics, Route Dynamics, Route Sections, evidence matching, and map/profile rendering.
- Server API routes use a server-only PostgreSQL connection to Supabase/Postgres for shared persistence.
- OSM evidence may use the public Overpass service; Mapillary imagery may use the Mapillary API when a server-side token is configured.

No credentials, connection strings, tokens, or environment values belong in this document. The database URL is not a `NEXT_PUBLIC_*` variable and must remain server-only.

## 10. Production-verified facts

> The following are operational facts supplied from completed Production verification. They are not inferred solely from repository code and were not re-queried while creating this document.

- The GPX segment-boundary implementation was deployed after commit `c75cd9faf988703a0a498c08a825924ccba396ce` (`fix: preserve GPX track segment boundaries`); global user-facing Route Section numbering was deployed after commit `f6ec794ebe3914e06f7a1037dcc768d38816b4c2` (`fix: number route sections globally`).
- Vercel Production to server-side PostgreSQL/Supabase connectivity was previously verified.
- After the v2 transition, Production verification reported Istria 110K 2027 metrics of approximately 110.73 km distance, 4,168 m gain, 4,240 m loss, 1,017 m highest, and 3 m lowest.
- All eight shared persistence tables were reachable from Production.
- Shared persistence write, read-back, idempotency, and cleanup were smoke-tested.
- The analysis-input identity migration was manually applied and verified: `analysis_input_fingerprint` is nullable text; the old route/version uniqueness rule was removed; a variant-aware partial unique index exists; RLS remained enabled; and the route foreign key retains `ON DELETE RESTRICT`.
- Controlled live persistence tests verified identical full-identity idempotency, coexistence and specific read-back of two input variants for one physical route/analysis version, cache misses for unknown fingerprints and legacy NULL fingerprints, and cleanup restoring all eight table counts to baseline.
- The Surface Evidence zero-versus-low-coverage presentation change was reported deployed to Production.
- Production persistence verification after the v2 transition found one route with `fingerprint_version = 2`, one linked analysis with `analysis_version = 2` and non-null `analysis_input_fingerprint`, and a matching race-edition link. The computed canonical Istria registry identities matched the persisted route and analysis, supporting shared analysis reuse.
- At that read-only verification point, there were no OSM or Mapillary enrichment rows associated with a v2 route. Their shared persistence was not Production-verified by that check.
- A deterministic fixture with one track, two disconnected track segments, ten points, an expected traversed distance of about 4.024 km, a 22.330 km component gap, and a 680 m boundary elevation jump was verified in Production. Observed metrics were 4.02 km distance, +40 m gain, 0 m loss, 840 m highest, and 120 m lowest; the gap and boundary elevation jump were excluded.
- No database migration or IndexedDB schema-version bump was required for the GPX segment-boundary implementation.
- Production rendering of that fixture showed separate route paths, elevation-profile paths, and component-specific section maps. Route Sections did not span the boundary. After the globally sequential numbering fix was deployed, the two component sections displayed as Route Section 1 and Route Section 2.
- A deterministic short-route fixture with one track, one segment, and 11 points was manually verified in Production. It traversed approximately 300.0 m with monotonically increasing elevation; Route Mode showed 0.30 km, +25 m gain, 0 m loss, 125 m high, and 100 m low. The route rendered as one continuous path with correct start/finish markers and elevation profile, analysis completed without error, and a Route Section stayed within 0–0.30 km. OSM and Mapillary were not refreshed during this check.
- An earlier failure had been observed on a synthetic route of roughly 300 m, but its exact fixture was unavailable and the failure was not reproduced. Current representative automated tests and the Production verification above pass; no generic short-route bug is currently known.
- Course Brief Phase 2 was implemented in commit `9d968c1a2176425a402e76f39b6cecdca6b2e8fa` (`feat: add deterministic course brief selection`), reported Ready in Vercel Production, and passed one controlled Production smoke test using the checked-in Istria 110K input, `analysisVersion = 2`, and OSM `not-requested`. The local repository `HEAD` matched that commit at verification time.
- Earlier Production Course Brief attempts failed closed when the model-facing schema allowed invalid claim parameters, including `vertical_concentration` with `phase = early` and `direction = null`. The deterministic eligible-option design replaced model-authored claim parameters with selection of eligible option IDs.
- The final smoke-test precheck validated the input and found 7 eligible options: 0 vertical concentrations, 1 vertical transition, 4 Key Moment role options, 1 highest point, 1 lowest point, and 0 OSM surface categories. Exactly one `POST /api/course-brief` was made; it returned HTTP 200 in 3,495 ms with no retry, OSM, Mapillary, or database request.
- The successful response selected a climb-to-descent vertical transition, the longest climb, and the longest descent. Deterministic rendering described the early-to-late smoothed-profile transition, a climb from 2.1–9.1 km with 526 m ascent, and a descent from 31.4–36.1 km with 482 m descent. Provider telemetry reported `gpt-5.4-mini`, 2,768 input tokens, 42 output tokens, 2,810 total tokens, 0 cached input tokens, 0 reasoning tokens, 2,552 ms provider duration, success, no error category, and `retryable = false`. The provider request ID is intentionally omitted.
- Production verification confirms the deterministic eligible-option selection, canonical claim mapping, semantic/redundancy validation, and renderer completed successfully for this request. It does not establish broader content quality or justify unrestricted public exposure. Editorial usefulness was assessed as concise and grounded, with the headline transition considered somewhat subtle.
- No Production verification is claimed for the Phase 3C2A deterministic Course Brief V2 engine or the Phase 3D1/3D2 anchor implementation. The V2 engine is not wired to the production API; Phase 3D3 remains design-only.

## 11. Testing and quality gates

Before important changes, the project workflow uses:

- Full Node test suite (`node --test`; there is no dedicated `test` script in `package.json`).
- `npx tsc --noEmit`.
- `npm run lint`.
- `npm run build`.
- `git diff --check` and review of the complete Git diff.
- Controlled live database smoke tests with synthetic data and cleanup when persistence semantics change.

At commit `6bb91c63c5c83c72b4ba1f8b12fb280985918f54`, the reported full suite result was **218 passed, 0 failed**, including short-route regression cases. This is a point-in-time result, not a permanent suite count.

For Course Brief Phase 2 commit `9d968c1a2176425a402e76f39b6cecdca6b2e8fa`, reported verification was **279 passed, 0 failed** in the full Node suite and **38 passed** focused Course Brief tests; TypeScript, ESLint, production build, and `git diff --check` passed. Direct eligible-option tests cover concentration thresholds/ties, transition dominance/ties, Key Moment direction/roles, extrema, OSM evidence eligibility/unavailable states, and request-specific selection behavior. These are point-in-time results.

For Phase 3C2A commit `3a46657ab591633817466712a9b1e209797d4131` (`feat: add deterministic course brief v2 engine`), the reported focused tests were **23/23** and the full Node suite was **363/363**. TypeScript, ESLint, production build, and `git diff --check` passed. The Istria checked-in GPX evaluation is an automated/local deterministic result, not Production verification. These are point-in-time results.

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
- `<trkseg>` components remain disconnected throughout analysis and evidence processing; no distance, elevation change, dynamics, section, or matching edge is synthesized across a component boundary.
- User-facing Route Section ordinals are globally sequential in course order. They are presentation ordinals and do not replace internal section IDs or `segmentIndex`.
- Overall route ascent is computed from raw GPX traversal. Individual Route Section ascent is computed from its resampled and smoothed profile, so section ascent values need not sum exactly to raw route ascent.
- Course Brief claims are restricted to deterministic eligible options and are validated before rendering; the model cannot establish new facts or author final prose.
- Course Brief input is caller-submitted and is not independently derived server-side. It must not be trusted as shared persistent/cache data without a trusted derivation and identity path.
- Course Brief generation is ephemeral and is not persisted or cached.
- The Course Brief API has no durable authentication/rate-limit protection suitable for unrestricted public exposure; do not broadly expose generation before abuse and cost controls are designed.
- Course Brief V2 is a separate deterministic engine and is not integrated into the V1 API or Production. Its current deterministic wording is not final product copy.
- Phase 3D1/3D2 provide implemented anchor schemas, validation, indexing, evidence matching, and diagnostics; they are not Production-verified. Current Istria data yields four context-only entries and zero position-safe anchors. No geographic wording should be inferred from race labels or GPX extrema.
- `CourseBriefInputV2` validation checks schema and internal consistency, not source authenticity. A caller-submitted V2 input can be fabricated; future caller-submitted Race Context or anchors have the same trust limitation. Persistent/shared canonical use requires trusted server derivation or trusted stored evidence. This is not solved by the current Phase 3D implementation or the accepted 3D3 design; 3D3's caller-supplied route binding remains unverified until a trusted composition path exists.

## 13. Known limitations and open correctness work

| Issue | Status and confidence |
| --- | --- |
| Mapillary section coverage | **Confirmed code limitation.** Requests are made per Route Section; generated requests with fewer than two sampled points are discarded. Imagery is not guaranteed for every section or continuously along the route. |
| Race Mode versus Route Mode | **Current product distinction.** Race Mode is a curated registered-race experience; Route Mode analyzes a user-selected GPX. Arbitrary uploads do not become registered races or shared canonical analyses. |
| Race registry scalability | **Current architectural limit.** Available race records are statically imported and listed in `raceRegistry.ts`; no database-backed registry or dynamic race ingestion exists. |
| IndexedDB fallback | **Confirmed behavior.** Persistence is optional; failed/unavailable local storage falls back to computing analysis in memory. A blocked database upgrade may prevent caching during that attempt. |
| Public OSM availability | **Provider-dependent limitation.** Overpass can time out, rate-limit, or return partial coverage. The UI and data model preserve unavailable/unknown ranges; successful classification depends on actual returned OSM ways and tags. |
| Course Brief trust boundary | **Confirmed code limitation.** The endpoint strictly validates caller-submitted `CourseBriefInputV1` but does not independently derive its facts from trusted source data. It is ephemeral only; do not use submitted facts as authoritative shared persistent/cache data. |
| Course Brief public access | **Confirmed code limitation.** The generation endpoint lacks durable authentication/rate-limit protection suitable for unrestricted public exposure. Abuse and cost controls are needed before broad exposure. |
| Course Brief editorial scope | **Current product limitation.** The six-claim catalog is intentionally narrow and does not cover difficulty, technicality, runnability, strategy, hazards, weather, nutrition, or pacing. The first Production output was grounded and concise, but its usefulness needs product review before expanding the catalog or exposing the feature widely. |

## 14. Current priorities

1. Implement Phase 3D3: deterministic post-selection Course Brief anchor attachment, separately versioned enrichment output, fail-closed identity/bounds validation, and synthetic tests. Keep structural candidate generation and selection independent of geographic evidence.
2. Keep external evidence coverage and provenance explicit as route and provider behavior evolves; do not infer terrain, imagery, or geographic position where evidence is absent.

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
