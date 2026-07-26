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

### In Progress
- Phase 4: Scanner infrastructure (worker mini-service, Playwright, crawl engine, artifacts, SSE).

### Pending
- Phase 4: Scanner infrastructure (URL safety service done; queues done; worker mini-service, Playwright, crawl engine, artifacts, SSE remaining).
- Phase 5: Analyzers (runtime, HTTP, responsive, a11y, l10n, RTL, perf, passive sec, SEO).
- Phase 6: Findings (fingerprinting done in crypto.ts; dedup, lifecycle, comments, suppressions, score remaining).
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

_Last updated: Phase 3 complete (usage ledger, billing, public audit mode)._
