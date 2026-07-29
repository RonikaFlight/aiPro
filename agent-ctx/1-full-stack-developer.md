# Task 1 — Phase 10: Run Details + Findings Table pages

## Files created/modified

- `src/app/app/runs/[runId]/page.tsx` (rewritten) — Run Details page
- `src/app/app/projects/[projectId]/findings/page.tsx` (new) — Findings Table page

## Work Log

- Read `/home/z/my-project/worklog.md` (991 lines) and prior work records for context on existing app routes and conventions.
- Inspected existing project dashboard (`src/app/app/projects/[projectId]/page.tsx`) and app home (`src/app/app/page.tsx`) for UI/style conventions (emerald primary, sticky header with `ShieldCheck` logo, breadcrumb pattern, `mt-auto` footer).
- Inspected API routes:
  - `GET /api/v1/runs/[runId]` (returns `RunDetail` with `events[]` + `configSnapshot`)
  - `GET /api/v1/runs/[runId]/events` (SSE — not consumed client-side here; we use the events array returned by the GET run endpoint instead, since the page already has all events inline)
  - `GET /api/v1/runs/[runId]/summary` (optional AI summary fetch for completed runs)
  - `DELETE /api/v1/runs/[runId]` (cancel — protected by CSRF)
  - `GET /api/v1/projects/[projectId]/findings` (cursor pagination + filters)
  - `GET /api/v1/projects/[projectId]` (for breadcrumb/project name)
- Inspected service helpers: `getRun` (returns events array inline), `listFindings` (returns `{ items, nextCursor, totalApprox }`).
- Inspected `finding-severity.ts` for valid `FindingSeverity` and `FindingStatus` values.
- Built Run Details page:
  - Client component, fetches run via `fetch('/api/v1/runs/[runId]')`.
  - On COMPLETED runs, additionally fetches AI summary from `/api/v1/runs/[runId]/summary` (best-effort, doesn't block render).
  - Stat cards: score (with trend icon + previous-score delta), pages analyzed/discovered, findings (with blocker count), duration.
  - Stage timeline rendered from `run.events[]` — matches stages `run.queued → run.validating → run.authorized → run.crawling → run.analyzing → run.generating_report → run.scored → run.summarized → run.completed`, with red/gray styling for failed/cancelled terminal events.
  - Cancel button only shows for QUEUED/RUNNING/ANALYZING/SCORING runs, wrapped in `AlertDialog` for confirmation, calls `DELETE /api/v1/runs/[runId]`, then reloads data.
  - Run metadata card (trigger, mode, created/started/completed relative times, failure reason, triggered-by).
  - Config snapshot card — pretty-printed JSON in a scrollable `<pre>` plus human-friendly rows for targetUrl, maxPages, maxDepth, viewports, locales.
  - AI Summary card — delivery readiness badge, executive summary, top issues list (with severity color), recommendation.
  - Loading skeleton + error retry state. Back link to `/app`.
- Built Findings Table page:
  - Client component, fetches `GET /api/v1/projects/[projectId]/findings` with query params (limit=25, sort, order, cursor, severity, status, category, search).
  - Filters bar: search input (with clear button + Enter-to-search), severity multi-select (dropdown menu with colored dots + count badge), status multi-select dropdown (with count badge), category single-select (populated from loaded findings), sort field select + asc/desc toggle button.
  - Active filter badges row — click any badge to remove that filter.
  - Clear-all button when filters active.
  - Table columns: Severity (color-coded badge), Title (+ mobile inline severity/category), Category (hidden on mobile), Status (color-coded), URL (truncated, hidden on small screens), First Seen, Last Seen.
  - Cursor pagination: Previous/Next buttons with cursor stack for back-navigation; respects `nextCursor` from API.
  - Empty state with FileX icon — different copy for "no findings yet" vs "no matches".
  - Loading skeleton + error retry state. Back link to project dashboard.
- Verified both files lint cleanly with `npx eslint` (no new errors or warnings).
- Dev server log shows clean startup, no compilation errors.

## Stage Summary

- Two Phase 10 UI pages delivered following the existing emerald-on-background design system.
- Both pages use client-side `fetch('/api/v1/...')` calls only (no absolute URLs, no port numbers).
- Sticky header (ShieldCheck logo + breadcrumb nav), `min-h-screen flex flex-col bg-background` root, `mt-auto` footer with copyright — consistent with the dashboard.
- All timestamps use a local `relativeTime()` helper (mirrors the dashboard's implementation).
- Severity color scheme matches spec: BLOCKER=red, CRITICAL=orange, MAJOR=amber, MINOR=lime, INFO=gray.
- Status color scheme matches spec: OPEN/ACKNOWLEDGED/IN_PROGRESS/REOPENED=warm (red/orange/amber), RESOLVED/IGNORED/ACCEPTED_RISK/FALSE_POSITIVE=emerald.
- No new API routes created — both pages use existing endpoints only.
- No new lint errors introduced (the 4 pre-existing `no-require-imports` errors in `auth-service.ts`, `db.ts`, `route-helpers.ts` are unrelated).
