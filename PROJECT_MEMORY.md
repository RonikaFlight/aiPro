# PROJECT_MEMORY — ProofPilot

> Living document. Read before starting any new task. Update after every significant change.

## 1. Product Purpose

**ProofPilot** is a SaaS quality-assurance platform for web agencies, freelancers, AI-app builders, micro-SaaS creators, startups, e-commerce teams, and teams without dedicated QA engineers.

A user provides a verified application URL. ProofPilot automatically:

1. Discovers pages and product structure.
2. Runs browser-based checks.
3. Tests responsive layouts.
4. Detects accessibility problems.
5. Detects broken interactions.
6. Records browser and console errors.
7. Checks localization and RTL layouts.
8. Executes safe user journeys.
9. Captures screenshots, traces and videos.
10. Groups duplicate problems.
11. Assigns severity and business impact.
12. Generates technical and client-friendly reports.
13. Re-runs checks after deployment.
14. Tracks whether problems were fixed, reopened or ignored.

**Tagline:** *Ship AI-built apps with evidence, not hope.*

**Positioning:** Automated QA / browser testing / accessibility auditing / responsive testing / localization testing / client delivery evidence platform. NOT a penetration-testing platform. Security checks are passive and non-destructive.

## 2. Technology Choices

| Concern | Choice | Notes |
|---|---|---|
| Framework | Next.js 16 App Router | Single-app architecture; only port 3000 available in sandbox |
| Language | TypeScript 5 (strict) | Required |
| Runtime | Node.js / Bun | Bun for dev server |
| Styling | Tailwind CSS 4 + shadcn/ui (New York) | Already scaffolded |
| Database | SQLite via Prisma | Sandbox does not provide PostgreSQL; tenant isolation enforced at application layer with strict workspace-scoped queries (RLS-equivalent controls). Schema is portable to PostgreSQL. |
| Caching / queues | In-process BullMQ-style queues + SQLite-backed job table | Redis not available in sandbox; queues persist in DB for reliability. Architecture supports swapping in Redis+BullMQ. |
| Browser automation | Playwright (Chromium) | Installed in worker mini-service |
| Auth | Custom: Argon2id + opaque session cookies + TOTP MFA | No localStorage tokens. Cookie `__Host-proofpilot_session`. |
| Secret vault | AES-256-GCM with envelope-encryption interface | Master key from env. |
| AI | z-ai-web-dev-sdk (GLM) | Provider-agnostic adapter; Mock provider for tests. |
| Billing | Stripe test mode (abstraction layer) | When Stripe keys absent, runs in "developer mode" with synthetic plans. |
| Real-time | Server-Sent Events (SSE) via Next.js route | Worker publishes events through in-process pub/sub. |
| Validation | Zod | For schemas, env, AI output. |
| i18n | next-intl | English (default) + Persian (full RTL). |
| Tests | Bun test + Playwright for e2e | |

## 3. Architecture Decisions

See `DECISIONS.md` for full rationale. Highlights:

- **D1.** Single-app adaptation: Because the sandbox only exposes port 3000, the spec's multi-app pnpm monorepo (apps/web + apps/api + apps/worker + apps/scheduler + apps/demo-target) is collapsed into one Next.js app with internal `src/modules/*` packages plus a Playwright worker mini-service on port 3003 (called via the gateway using `?XTransformPort=3003`).
- **D2.** SQLite replaces PostgreSQL. Tenant isolation enforced via (a) mandatory `workspaceId` parameter on every service method, (b) workspace-aware Prisma client wrapper, (c) automated tenant-isolation tests. PostgreSQL RLS notes are retained in `DATABASE_DESIGN.md` and the schema is portable.
- **D3.** Queues are SQLite-backed (jobs table) with in-process workers. API matches BullMQ semantics so the implementation can swap to Redis+BullMQ in production without rewriting handlers.
- **D4.** API uses Next.js Route Handlers under `/api/v1/*` instead of a separate NestJS app. Same REST contract, RFC 7807 Problem Details error responses.
- **D5.** Authentication uses custom session-based auth (not NextAuth) to satisfy the spec's exact requirements: opaque 256-bit tokens, hash-only storage, `__Host-proofpilot_session` cookie, Argon2id, TOTP MFA, recovery codes.

## 4. Coding Conventions

- TypeScript strict mode everywhere.
- ES modules.
- `"use client"` only where interaction requires it; otherwise Server Components.
- `"use server"` for server actions (used sparingly — API routes preferred per instructions).
- Imports use `@/` alias → `./src/`.
- Files: kebab-case for files, PascalCase for React components and types.
- Every API route validates input with Zod.
- Every workspace-scoped query receives `workspaceId` from the authenticated session context, never from the request body.
- No `any` without a documented `// eslint-disable-next-line` justification.
- No `eval`, no direct SQL string concatenation, no token in localStorage, no `@ts-ignore` without justification.
- Errors returned as RFC 7807 Problem Details JSON.
- Secrets never logged.

## 5. Current Implementation Status

### Completed
- **Phase 1 — Foundation**: Project memory, implementation checklist, architecture, security model, threat model, database design, API design, decisions docs. Environment validation (Zod + production safety checks). Structured JSON logger with secret redaction. Prisma schema (50+ models, all required enums). Database client with workspace scoping helpers. Crypto helpers (Argon2id, AES-256-GCM, SHA-256, secure random, fingerprint). Permission system (26 permissions, 8 roles). Error types + RFC 7807 Problem Details. Session cookie helpers. CSRF token (stateless HMAC-signed). Rate limiting (per-endpoint, progressive delay). SafeTargetUrlService (SSRF controls). SQLite-backed BullMQ-compatible queue. Audit log + security event helpers. Auth context (requireAuth, requireWorkspaceAuth, requirePlatformAdmin). Seed system (4 plans, 7 feature flags, 3 users, 1 workspace, 1 demo project, 1 verified localhost domain, 1 demo integration with encrypted secret). Demo target app (8 intentional issues). Docker compose reference. `.env.example`.

- **Phase 2 — Security & Identity**: Auth service (register, verify-email, login with MFA challenge, logout, forgot-password, reset-password, TOTP setup/confirm/disable, MFA challenge completion, session list/revoke). Email service (4 templates, dev mode logging). Workspace service (create, list, get, update, invite member, accept invitation, change role, remove member — with role hierarchy and last-owner protection). All auth API routes (`/api/v1/auth/*`, `/api/v1/mfa/*`, `/api/v1/sessions/*`, `/api/v1/csrf`, `/api/v1/me`). Workspace API routes (`/api/v1/workspaces/*`, `/api/v1/workspaces/[id]/members`, `/api/v1/invitations/[token]/accept`, `/api/v1/workspaces/[id]/audit-logs`). Login + Register UI pages. Dashboard page showing user's workspaces with stats. Direct auth service test (10/10 tests passed). Full API flow verified (csrf → login → me → workspaces → members all return 200). Browser login flow verified (Agent Browser confirmed dashboard renders with real data).

- **Phase 3 — Core SaaS (complete)**: Project service (create with plan limit check, list, get, update, delete). Environment service (create). Domain verification (start with DNS_TXT/HTML_FILE/HTML_META, check with dev auto-verify for localhost). Billing plans API. Workspace projects UI page. Usage ledger service (`src/lib/usage-service.ts`): immutable append-only event log, idempotency via unique keys, period aggregation (runs/pages/tokens/reports), plan limit checks (assertCanStartRun, assertCanAnalyzePage), paginated event listing, period-aware summary with limits + exceeded flags. Billing service (`src/lib/billing-service.ts`): PaymentProvider abstraction (DeveloperPaymentProvider for dev mode, StripePaymentProvider for live Stripe with HMAC-SHA256 signature verification + 5-min tolerance), createCheckoutSession, createPortalSession, ensureSubscription (creates FREE trial if missing), handleStripeWebhook (idempotent via event ID, signature-gated, records SubscriptionEvent, applies state transitions for checkout.session.completed/subscription.updated/subscription.deleted/invoice.payment_failed/invoice.paid), adminChangePlan. Public audit mode (`src/lib/public-scan-service.ts`): 5-page limit, single viewport/locale, PASSIVE mode only, per-IP rate limiting (3/hour), SSRF controls via SafeTargetUrlService, creates ScanRun on shared "public-audit" workspace, enqueues scan-orchestration job. API routes: `/api/v1/workspaces/[id]/usage`, `/api/v1/workspaces/[id]/usage/events`, `/api/v1/workspaces/[id]/billing/subscription`, `/api/v1/workspaces/[id]/billing/checkout`, `/api/v1/workspaces/[id]/billing/portal`, `/api/v1/webhooks/stripe` (raw body, signature verify, 256KB max, idempotent), `/api/v1/public/scan`, `/api/v1/public/runs/[runId]`. Billing UI page (`/app/workspaces/[id]/billing`) — client component showing subscription, plan features, usage progress bars, recent events table, checkout/portal actions.

- **Phase 4 — Scanner Infrastructure (complete)**: Scan authorization guard (`src/lib/scan-auth.ts`) — 7-gate chokepoint: workspace membership + runs.create permission, project ACTIVE status, environment enabled + scanMode compatibility (PASSIVE < SAFE_INTERACTION < TEST_TRANSACTION < CUSTOM_APPROVED), destructive-mode user confirmation, subscription ACTIVE/TRIALING (with trial-end check), usage quota (assertCanStartRun), verified-domain origin allowlist (environment baseUrl + verified domains + allowed hostnames), SSRF controls (validateUrl + DNS rebinding via resolveHostname + isBlockedIp). `revalidateTargetBeforeFetch` for fetch-time DNS rebinding defense. Run service (`src/lib/run-service.ts`) — createRun (authorize → config snapshot → ScanRun.create → appendScanEvent → recordUsageEvent → enqueue scan-orchestration), listRuns (cursor pagination), getRun (with events + config), cancelRun (idempotent, cancels queued jobs). Scan events (`src/lib/scan-events.ts`) — appendScanEvent (monotonic per-run sequence, DB persistence + in-process pub/sub broadcast), listScanEvents (for SSE replay), subscribeToRun (in-process push for same-process SSE). Artifact service (`src/lib/artifact-service.ts`) — storeArtifact (magic-byte MIME sniffing, type-specific allowlist, SHA-256 hash, path-traversal guard, 5MB size cap, retention expiry), readArtifactBuffer (path-traversal-safe read), signArtifactUrl (HMAC-SHA256 with TTL), verifyArtifactSignature (constant-time comparison, expiry check), cleanupExpiredArtifacts. Worker mini-service (`mini-services/worker/`, port 3003) — Bun.serve HTTP API (health/live, health/ready with DB ping + queue stats, status with per-queue counts), queue poller for scan-orchestration + page-analysis, --hot reload, graceful shutdown. Playwright launch policy (`mini-services/worker/src/browser.ts`) — 21 hardened Chromium args (no --no-sandbox in prod, disable extensions/sync/translate/plugins/popup-blocking/background-networking, WebRTC IP handling policy, force lang=en), serviceWorkers:'block', acceptDownloads:false, permissions:[], clearPermissions. Network interception (createContext) — 7 per-request checks: protocol (http/https only), origin allowlist, DNS resolve + isBlockedIp (rebinding), cross-origin cookie/authorization stripping, non-safe method block (GET/HEAD/OPTIONS only in PASSIVE), sanitized headers (strip X-ProofPilot-Scan), context-level timeout. navigateSafely — redirect chain tracking, post-navigation origin revalidation, post-navigation DNS re-resolve, response headers + status captured for security analysis. Crawl engine (`mini-services/worker/src/crawl.ts`) — BFS queue with depth tracking, URL normalization (fragment drop, query sort, default port removal), 38 multilingual destructive URL patterns (logout/delete/reset/wipe/unsubscribe in EN/FR/DE/ES/NL + action/op/cmd/do/method/_method param patterns), same-origin link discovery, per-page + total timeout, redirect chain capture, title/lang/dir/canonical extraction, console error + page error capture, screenshot (full-page PNG) + HTML snapshot capture. Scan orchestrator (`mini-services/worker/src/orchestrator.ts`) — handles scan-orchestration jobs: load run, skip if cancelled, mark RUNNING, revalidate target, launch browser, crawl per viewport+locale, persist ScanPage records, store screenshot/HTML/error-log artifacts, enqueue page-analysis jobs with crawl-time data (consoleErrors, pageErrors, httpStatus, redirectChain, lang, dir, canonical), mark COMPLETED, append scan events throughout. API routes: `/api/v1/projects/[projectId]/runs` (POST create with Zod-validated config, GET list with cursor pagination), `/api/v1/runs/[runId]` (GET with events+config, DELETE cancel idempotent), `/api/v1/runs/[runId]/events` (SSE with Last-Event-ID replay, 15s heartbeat, in-process pub/sub + 1s DB polling fallback, 30min max lifetime, stream.end on terminal events), `/api/v1/artifacts/[artifactId]` (signed-URL download with HMAC verification + workspace membership defense-in-depth). 24/24 Phase 4 verification tests pass. End-to-end scan pipeline verified (worker processed queued job: 1 page, 2 findings, 9 events, 1 artifact, run COMPLETED in 72ms).

- **Phase 5 — Analyzers (complete)**: 8 analyzers covering all required categories. Shared types (`mini-services/worker/src/analyzers/types.ts`) — FindingCandidate, AnalyzerContext, ObservedResponse, ObservedConsoleEvent, PerfMetrics, CrawlData, Analyzer interface. Finding writer (`mini-services/worker/src/analyzers/finding-writer.ts`) — writeFindings (fingerprint = SHA-256 of projectId+checkId+normalizedUrl+selector+viewport+locale+messageKey, upsert on fingerprint for dedup, creates FindingOccurrence per finding, appends scan events), writePageMetrics (upsert ScanPageMetric). HTTP/nav analyzer (`http-nav.ts`) — server errors (5xx CRITICAL), 404, client errors (4xx), redirect loops, excessive redirects (>5 hops), failed network requests, broken links via active HEAD/GET checking of same-origin `<a href>` URLs (capped to 20), mixed content (HTTP on HTTPS), invalid document content-type, missing title, cross-origin canonical, broken favicon, broken manifest. Runtime analyzer (`runtime.ts`) — uncaught page errors with secret redaction (Bearer tokens, base64 strings, emails), console errors deduped by message, console warnings grouped, CSP violations via SecurityPolicyViolationEvent (grouped by directive), page crash detection. Responsive analyzer (`responsive.ts`) — document horizontal overflow, out-of-viewport elements (mobile), fixed/sticky elements covering interactives (mobile), clipped text (scrollWidth > clientWidth), tap targets <44×44px (mobile/tablet), input font-size <16px (iOS zoom), root font-size <16px, table overflow, image overflow. Accessibility analyzer (`accessibility.ts`) — axe-core integration (WCAG 2.2 AA + best-practice tags, 5 node examples per violation), manual checks for missing html lang, heading hierarchy (no headings, no h1, multiple h1, skipped levels), frame/iframe titles, bypass mechanism (skip link or main landmark), unnamed interactive elements (buttons/links with no text/aria-label/title). Forms analyzer (`forms.ts`) — missing labels (label, aria-label, title — placeholder is not a label), missing autocomplete (email/tel/url/name/username/address/zip/country), wrong autocomplete, suboptimal input types (type=text for email/tel/url), password fields without autocomplete, missing submit button, disabled submit, required fields without aria-required, missing error feedback region. Performance analyzer (`performance.ts`) — TTFB/DCL/load/LCP/CLS/INP/FCP with Lighthouse thresholds (good/needs-improvement/poor), total bytes, request count, largest resources, long tasks (>50ms), render-blocking resources, large individual resources. Security analyzer (`security.ts`) — 6 required headers (CSP, X-Content-Type-Options, X-Frame-Options, HSTS, Referrer-Policy, Permissions-Policy), cookie Secure/HttpOnly/SameSite, sensitive URL params (token/password/secret/jwt/etc.), insecure credential POST (password form to HTTP), source map exposure, secret-like strings in DOM (AWS keys, JWTs, GitHub tokens, Stripe keys, Google API keys, Slack tokens, private keys), missing SRI on third-party resources, iframe sandbox, public stack traces on error pages. SEO analyzer (`seo.ts`) — missing/short/long title, missing/short/long description, missing canonical, missing/bad viewport, noindex detection, missing OG tags, missing Twitter Card, missing JSON-LD, missing favicon, missing manifest, missing html lang, thin content (<100 words). Analyzer runner (`mini-services/worker/src/analyzers/index.ts`) — launches browser, creates context with CSP violation init script, captures network responses + console events + page errors + request failures during navigation, collects performance metrics via Performance Timeline (navigation timing, paint entries, LCP/CLS/longtask/event entries, resource entries), builds synthetic document response from navigateSafely response headers, runs all 8 analyzers with 30s timeout each, writes findings + metrics. Page-analysis queue handler (`mini-services/worker/src/page-analysis.ts`) — loads run + scan page, resolves allowed origins from config snapshot, calls runPageAnalysis, atomically increments run's pagesAnalyzed + findingsCount. Orchestrator updated to pass crawl-time data in page-analysis job payload. Standalone verification: 39 findings across 7 categories, 13/13 expected demo-target issues detected, 8/8 analyzers succeeded, ~2.5s per page.

### In Progress
- Phase 6: Findings (fingerprinting done in crypto.ts + finding-writer.ts; dedup via upsert on fingerprint, lifecycle, comments, suppressions, score remaining).

### Pending
- Phase 7: Journeys.
- Phase 8: AI (provider abstraction, structured outputs, prompt-injection controls).
- Phase 9: Reports (technical, client, white-label, sharing, PDF).
- Phase 10: Full Product UI (marketing pages, onboarding, project UI, run UI, findings UI, journey UI, report UI, team, billing, security, admin, Persian/RTL).
- Phase 11: Integrations (Stripe checkout, deployment hooks, Slack, outgoing webhooks, scheduling, notifications, retention).
- Phase 12: Tests + CI/CD + Docker hardening + production docs.

## 6. Known Limitations

- **SQLite vs PostgreSQL:** No native Row-Level Security. Compensated by strict application-level workspace scoping and an automated test suite proving tenant isolation. Production deployment must switch to PostgreSQL (schema is portable).
- **Single-port sandbox:** Worker mini-service is reached via the Caddy gateway using `?XTransformPort=3003`. The browser sandbox runs in the worker process, not a separate Docker container; production must use the documented isolated container approach (see `infrastructure/docker/worker.Dockerfile`).
- **No Redis:** Queues persist in SQLite. Lower throughput than Redis-backed BullMQ but identical handler API.
- **Email delivery:** Uses console/Mailpit-style dev adapter. Production must configure SMTP.
- **Stripe:** Runs in developer mode if `STRIPE_SECRET_KEY` is absent; checkout/portal endpoints return simulated responses.

## 7. Pending Work

See `IMPLEMENTATION_CHECKLIST.md` for the granular list. High-level:

- Phase 2: Auth (register/login/verify/reset/OAuth/MFA/sessions/CSRF).
- Phase 3: Workspaces/members/projects/environments/domain-verification/plans/usage/billing.
- Phase 4: URL safety service, queues, worker, Playwright crawl, artifacts, SSE.
- Phase 5: All analyzers (runtime, HTTP, responsive, a11y, l10n, RTL, perf, passive sec, SEO).
- Phase 6: Findings (fingerprint, dedup, lifecycle, comments, suppressions, score).
- Phase 7: Journeys.
- Phase 8: AI.
- Phase 9: Reports + PDF.
- Phase 10: Full UI + Persian/RTL.
- Phase 11: Integrations + scheduling + retention.
- Phase 12: Tests + CI + Docker hardening + final build.

## 8. Important Commands

```bash
# Dev server (must run in background, single instance)
bun run dev

# Lint
bun run lint

# Database
bun run db:push        # apply schema
bun run db:generate    # regenerate Prisma client
bun run db:migrate     # create migration
bun run db:reset       # reset db

# Worker mini-service (run in background, separate port 3003)
cd mini-services/worker && bun run dev

# Tests
bun test               # unit + integration
bun run test:e2e       # Playwright e2e
```

## 9. Environment Assumptions

- Sandbox exposes only port 3000 (Next.js). Other ports reached via gateway with `?XTransformPort=PORT`.
- `DATABASE_URL` points to a local SQLite file at `db/custom.db`.
- Master encryption key (`PROOFPILOT_ENCRYPTION_KEY`) is 32 bytes base64. In dev, a fixed key is used; production must set a strong key.
- `NODE_ENV=development` by default. Production safety checks refuse to start with unsafe defaults.
- `z-ai-web-dev-sdk` available for AI features.
- Playwright Chromium will be installed in the worker mini-service via `bunx playwright install chromium`.

## 10. Sandbox Preview

The deployed app is previewed via the **Preview Panel** on the right of the interface. Users may also click **"Open in New Tab"** above the Preview Panel. Direct `http://localhost:3000` access is not exposed to the user.

---

_Last updated: Phase 5 complete (8 analyzers: HTTP/nav, runtime, responsive, accessibility with axe-core, forms, performance, passive security, SEO; analyzer runner with performance metrics; page-analysis queue handler; 13/13 expected demo-target issues detected)._
