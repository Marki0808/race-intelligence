# Endurset V1 — Project State

**Snapshot date:** 2026-11-17
**Repository:** `main` at `410bfae` (`Fix section overview heading contrast`)
**Release state:** This document describes the current working tree. The map/fullscreen and universal section-summary changes in this snapshot are still uncommitted and have not been deployed. Production facts below are owner-reported unless explicitly marked as verified from source.

## Product scope

Endurset is a browser-based GPX route-analysis product for trail runners. Public V1 is centered on user-selected GPX files and deterministic Route Analysis. Race discovery and mapped-terrain evidence are deferred. The app uses Next.js App Router, React, TypeScript, Leaflet for 2D maps, MapLibre GL JS for 3D terrain maps, and server route handlers for feedback and newsletter submissions. The package manager is npm; Node 22 is declared. The installed project uses Next.js 16.3.6 and React 19.2.8.

## V1 user experience

- **GPX analysis:** The browser parses and analyzes the uploaded GPX. Route distance, elevation profile, route statistics, Course Brief, Key Moments, sections, grades, and narratives are derived from GPX data. GPX files and route geometry are not uploaded to Endurset's analysis API. Local IndexedDB may cache route-analysis records.
- **Automatic Sections:** Elevation-based Route Sections are the default. Selecting a section in the full-route elevation profile selects and highlights the corresponding section and synchronizes the analysis view.
- **Custom Sections:** Users can enter cumulative-distance boundaries or add them by selecting positions on the elevation profile. Start and Finish remain fixed; boundaries are ordered, validated, editable/removable, and can be undone. Distance entry and profile selection produce the same section intervals and use the existing section-analysis path. Custom plans remain available when switching to Automatic Sections. Finishing profile selection with no interior boundaries returns to Automatic Sections.
- **Universal Live Section Summary:** A shared compact summary displays the selected Automatic or Custom section under the main profile. It uses the same `RouteSection` interval and grade calculations as section details, supports unit preference, and links to the corresponding full analysis. Numeric boundary changes and section/profile selections update the highlighted section and summary.
- **Section detail:** Selected sections show a full-route overview with the section highlighted at its proportional location, then a zoomed section detail using cumulative full-route distance. Section cards include elevation grades, steepest sustained grade windows when supported, and direction-specific Gradient Distribution. Incomplete profiles and insufficient directional distance remain explicitly unavailable.
- **Gradient distribution:** Five mutually exclusive bands are shown separately for uphill and downhill: 0–<5%, 5–<10%, 10–<15%, 15–<20%, and 20%+. Percentages represent classified directional distance; category distances are cumulative within the route or selected section. Classification uses the smoothed GPX profile, excludes flat/opposite-direction intervals, and reports unavailable when profile coverage or directional distance is insufficient.
- **Maps:** 3D MapLibre terrain is the default map mode; Leaflet 2D is the alternative where supported. The 3D view uses OpenFreeMap for its basemap and Mapterhorn DEM for terrain. The 2D view uses OpenStreetMap tiles. Maps show route geometry and selected-section or Key Moment context without joining disconnected GPX components. The shared fullscreen shell supports native fullscreen and a viewport fallback, places a text control with the map controls, prevents background scrolling in fallback mode, and resizes the existing map instance. Wheel zoom is opt-in by activating the map; outside click or Escape exits that mode. Provider attribution remains visible.
- **Key Moments:** Existing GPX-derived point and interval moments remain separate from section segmentation. Cards, full-route elevation profile, numbered 3D map markers, selected-range highlighting, and map/card selection share the existing moment identity and selection state. The map is loaded when near the viewport and does not include Flyover controls.
- **Flyover:** The integrated 3D map supports full-route and eligible selected-section playback, time-based distance progression, pause/resume/restart/seek, and 1× through 32× visualization speeds (25 m/s virtual baseline). Its compact circular marker shows cumulative route distance and GPX elevation; playback controls sit below the map. Camera follow adapts to speed. The feature guards incomplete or disconnected paths where a continuous flyover cannot be supported.
- **Other V1 features:** Anonymous written feedback and explicit-consent newsletter signup use server APIs and server-only Postgres access. Optional GA4 and Vercel Web Analytics are both gated behind affirmative analytics consent. Analytics events use an allowlist and exclude GPX content, route identifiers, feedback text, and subscriber addresses. Newsletter records start as `pending_confirmation`; the current flow sends no confirmation or marketing email.
- **Course Brief API:** `POST /api/course-brief` returns a fixed 404 in V1. Normal Course Brief generation is deterministic and local to the browser analysis experience.

## Calculation and persistence notes

- **Disconnected tracks:** Component identity is retained through analysis, profiles, section generation, map geometry, and relevant metrics. No artificial edge is added between components. Section intervals are projected and clipped to valid component geometry.
- **Distance and elevation:** GPX cumulative distance is calculated from traversed track edges. Reported ascent/descent uses GPX elevations resampled on a 50 m distance grid and a 50 m-radius median filter. Whole-route extrema and section elevation ranges use source GPX elevations, with section boundaries interpolated between source samples.
- **Profile-derived grade and narrative inputs:** Route Dynamics resamples each component at 100 m, applies a 150 m-radius median filter and a 250 m-radius moving average. Section grade metrics use the existing smoothed section profile, check coverage/gaps, calculate directional average grades, and search exact 100 m and 500 m windows. Gradient Distribution classifies cumulative interval distance by the five grade bands above. These models do not replace canonical ascent/descent values.
- **Local cache:** IndexedDB database `race-intelligence-route-cache`, database version **2**. Canonical route-analysis cache version `ROUTE_ANALYSIS_VERSION` is **7**. OSM enrichment schema is 2 and Mapillary enrichment schema is 1; those caches and providers are not active in public V1 while Terrain Intelligence is disabled. The browser cache is local to the user's browser and is not an Endurset server backup.
- **Remote route persistence:** Physical route fingerprinting code remains in the repository, but `SHARED_ROUTE_PERSISTENCE_V1_ENABLED` is `false`. The V1 upload path does not send route fingerprints or GPX-derived route content to Endurset's shared-route endpoint; the public endpoint is disabled. Remote shared-route retrieval and writes are deferred.

## Feature flags and deferred scope

The following source flags are currently false in `app/featureFlags.ts`:

- `RACE_MODE_V1_ENABLED` — registered-race discovery and Race Mode public entry points are deferred.
- `TERRAIN_INTELLIGENCE_V1_ENABLED` — OSM/Mapillary terrain-evidence requests and presentation are deferred.
- `SHARED_ROUTE_PERSISTENCE_V1_ENABLED` — remote fingerprint lookup and shared-route storage are deferred.
- Flyover performance diagnostics are gated to development by `NODE_ENV` and the optional `NEXT_PUBLIC_FLYOVER_DIAGNOSTICS` switch; the diagnostic panel is not part of the normal UI.

Deferred work includes Race Mode and race/aid-station discovery, terrain evidence enrichment, shared-route reuse/persistence, and future newsletter confirmation/delivery. No route-derived analysis is sent to an AI service in the current browser flow. The separate Course Brief endpoint remains disabled.

## Production configuration — owner-reported, not independently checked for this audit

- Public domain: `endurset.com`; no DNS, deployment, or live-site verification was performed as part of this snapshot.
- Hosting: Vercel Hobby. The owner reported Vercel Functions region `fra1` configured for a deployment; the region of the currently active deployment has not been verified here.
- Database: Supabase/Postgres; the owner reported region `eu-central-1` and successful application of the feedback and newsletter migrations. The live schema was not queried for this audit.
- Expected server-only environment variable names: `POSTGRES_URL`, `FEEDBACK_RATE_LIMIT_SECRET`, and `NEWSLETTER_RATE_LIMIT_SECRET`. The public analytics ID is supplied as `NEXT_PUBLIC_GA_MEASUREMENT_ID`. No secret values are recorded in this document.
- The owner previously reported `NEXT_PUBLIC_GA_MEASUREMENT_ID` configured in Production and GA4 Enhanced Measurement disabled. Current Vercel values and live GA4 dispatch were not checked.
- The local production-build command detected `.env.local`; its values were not inspected, recorded, or staged. A local build therefore does not verify the Production environment configuration.
- Feedback and newsletter write endpoints require server credentials and rate-limit secrets. Rate-limit tables retain keyed digests/counters/expiry rather than raw client IPs; cleanup is request-triggered, not a guaranteed exact-time deletion schedule.

## Privacy, legal review, and limitations

- The Privacy Policy identifies Marcel Bračić in Croatia and `endurset@gmail.com` as the privacy contact. It describes browser analysis and IndexedDB, map providers, feedback, newsletter, analytics, hosting, and operational processing.
- **Open legal review:** The appropriate legal basis and ePrivacy treatment for automatic third-party map/terrain resource requests (OpenFreeMap, Mapterhorn, and OpenStreetMap in 2D) have not been established as a completed legal conclusion. The internal assessment is preliminary; owner/qualified legal review remains open. The applicability of ePrivacy rules or a strictly-necessary exception to browser-local GPX analysis and IndexedDB also remains a legal question; do not infer an exemption from the technical design. Confirm whether Croatian law requires additional controller identification/contact details beyond the owner-confirmed name, country, and email; no postal or business-registration details are asserted here. Do not describe these reviews as approved or closed.
- Provider processing, international transfers, and retention outside the explicitly disclosed/configured facts depend on provider terms and operational settings. EU database/function regions do not by themselves establish that all processing stays in the EU.
- Browser-local analysis does not mean the operator or providers process no personal data: hosting/security metadata, map tile requests, consent-gated analytics, feedback, and newsletter data may involve personal or pseudonymous information.
- Elevation quality and sampling vary by GPX. Smoothing suppresses isolated noise but can attenuate short elevation changes. Incomplete coverage, short sections, or insufficient uphill/downhill distance can make grade outputs unavailable; the interface should preserve that state rather than imply zero.
- Automatic section boundaries and narrative descriptions are deterministic interpretations of GPX-derived profiles, not predictions of surface, technical difficulty, weather, safety, or runner effort.
- Current local fullscreen and universal summary changes have automated coverage but require browser acceptance across desktop and narrow mobile layouts, Leaflet/MapLibre, section modes, and Flyover before release. This audit does not claim that the present working tree is deployed or production-ready.

## Current Git/release inventory

At this snapshot, branch `main` is at `410bfae`. Application/test changes and this document are local and uncommitted. No files were staged, committed, pushed, or deployed during this audit.

### Explicit candidate staging list

Stage only these application, test, and state-document paths after review:

- `PROJECT_STATE.md`
- `app/CourseExplorer.tsx`
- `app/CustomSectionControls.tsx`
- `app/LiveSectionSummary.tsx`
- `app/MapFullscreenRegion.tsx`
- `app/MapLibreRouteMap.tsx`
- `app/RouteAnalysisView.tsx`
- `app/RouteFlyover.tsx`
- `app/RouteSectionBrowser.tsx`
- `app/TerrainSectionMap.tsx`
- `app/globals.css`
- `app/liveCustomSectionSummary.test.mjs`
- `app/liveCustomSectionSummaryModel.ts`
- `app/mapFullscreen.test.mjs`
- `app/routeMapIntegration.test.mjs`
- `app/sectionGradeMetrics.ts`

Do not stage `app/dev/` (local terrain prototype), `scripts/` (aid-station research prototype), `test-routes/` (private GPX fixtures), `istria-110k-response.html` (local research output), or `docs/internal-privacy-legal-bases-assessment-2026-11-04.md` (internal legal assessment). The local Webpack build discovers `app/dev/terrain/page.tsx` and lists `/dev/terrain`; excluding that untracked route directory from release inputs is essential to keep this local prototype out of the public app. No package or migration changes are part of the current diff. Recheck Git status and review the staged diff before any later release action.

## Validation record

For this 2026-11-17 working-tree snapshot, validation passed: serial Node suite **1,079/1,079**, TypeScript (`npx tsc --noEmit`), ESLint (`npm run lint`), Next.js Webpack production build (`npx next build --webpack`), and `git diff --check`. Each is point-in-time evidence for this local tree; it does not verify browser rendering, provider availability, production environment values, live database state, or deployment status.
