# Architecture — ProofPilot

> ProofPilot is a SaaS quality-assurance platform for web agencies, freelancers,
> AI-app builders, and teams without dedicated QA engineers. It automatically
> discovers pages, runs browser-based checks, detects accessibility problems,
> tests responsive layouts, checks localization/RTL, executes user journeys,
> and generates client-ready reports.

---

## 1. High-Level Architecture

The original specification calls for a pnpm monorepo with five apps
(`apps/web`, `apps/api`, `apps/worker`, `apps/scheduler`, `apps/demo-target`).
Because the development sandbox exposes **only port 3000** externally, the
architecture is collapsed into:

| Component | Location | Port | Purpose |
|-----------|----------|------|----------|
| **Main app** | `/home/z/my-project` (Next.js 16 App Router) | 3000 | UI + API + business logic |
| **Worker mini-service** | `mini-services/worker` | 3003 | Playwright browser scanning |

The Caddy gateway on port 81 routes requests to port 3000 by default.
Requests with `?XTransformPort=3003` are forwarded to the worker
mini-service, matching the sandbox's gateway rules.

```
                          ┌──────────────────────────────────────┐
                          │          Caddy Gateway (:81)          │
                          │  default → localhost:3000            │
                          │  ?XTransformPort=3003 → localhost:3003│
                          └──────┬────────────────────┬───────────┘
                                 │                    │
                    ┌────────────▼────┐      ┌─────────▼──────────┐
                    │   Next.js 16    │      │  Worker Mini-Service│
                    │   Port 3000     │      │  Port 3003         │
                    │                 │      │  (Playwright)       │
                    └────────┬────────┘      └─────────┬──────────┘
                             │                         │
                    ┌────────▼────────┐               │
                    │  Route Handler  │               │
                    │  /api/v1/*      │               │
                    └────────┬────────┘               │
                             │                         │
                    ┌────────▼────────┐      ┌─────────▼──────────┐
                    │ Service Module  │      │  Playwright         │
                    │ src/modules/*   │      │  Browser Contexts   │
                    └────────┬────────┘      └─────────┬──────────┘
                             │                         │
                    ┌────────▼────────┐               │
                    │   Prisma ORM    │               │
                    └────────┬────────┘               │
                             │                         │
                    ┌────────▼────────┐      ┌─────────▼──────────┐
                    │   SQLite DB     │◄─────│  Artifact Storage   │
                    │  db/custom.db   │      │  (screenshots, etc.)│
                    └─────────────────┘      └────────────────────┘

    ─── Scan Request Flow ───

    Browser → Caddy → Next.js :3000
      → /api/v1/runs (POST, create run)
      → Service module writes job to `jobs` table
      → Worker polls / is notified of job
      → Worker launches Playwright (port 3003 via XTransformPort)
      → Playwright navigates target, runs analyzers
      → Artifacts stored, findings written to DB
      → Events published to DB (in-process pub/sub)
      → SSE /api/v1/runs/:runId/events streams to browser
```

---

## 2. Internal Modules (`src/modules/*`)

The spec's separate packages are represented as internal modules within the
single Next.js app. Each module encapsulates a bounded context:

| Module | Purpose |
|--------|--------|
| `src/modules/auth` | Registration, login, logout, password reset, email verification, OAuth adapters (Google, GitHub), session management, TOTP MFA, recovery codes |
| `src/modules/workspaces` | Workspace CRUD, invitations, member management, role assignment |
| `src/modules/projects` | Project CRUD, brand settings, locales, timezone, retention configuration |
| `src/modules/environments` | Environment CRUD (PRODUCTION/STAGING/PREVIEW/DEVELOPMENT), scan modes, network restrictions |
| `src/modules/scans` | Run lifecycle (create, cancel, retry), page discovery, orchestration, crawl engine, URL safety, domain verification |
| `src/modules/findings` | Finding fingerprinting, deduplication, lifecycle state machine, severity, comments, assignments, tags, suppressions, quality scoring |
| `src/modules/journeys` | Journey schema, step types, visual editor backend, runner, safe action policy, secret references, results |
| `src/modules/reports` | Technical and client reports, white-label, secure sharing, PDF export, approval workflow |
| `src/modules/billing` | Stripe integration (with developer-mode fallback), subscription CRUD, plans, usage ledger, checkout, portal |
| `src/modules/integrations` | Deployment hooks, Slack notifications, outgoing webhooks (HMAC-signed), scheduling |
| `src/modules/ai` | Provider abstraction (GLM, OpenAI-compatible, Mock), versioned prompts, Zod-validated output, cost controls, prompt-injection defenses |
| `src/modules/admin` | Platform administration — user management, workspace oversight, job monitoring, system health, feature flags, security events |

### Module Internal Structure

Each module follows a consistent layout:

```
src/modules/<name>/
  ├─ types.ts          # Domain types and interfaces
  ├─ schemas.ts        # Zod validation schemas
  ├─ service.ts        # Business logic (workspace-scoped methods)
  ├─ routes.ts         # API route handler registrations (or inline in app/api/)
  ├─ queries.ts        # Reusable Prisma query helpers
  └─ __tests__/        # Module-specific tests
```

---

## 3. Worker Mini-Service

**Location:** `mini-services/worker`
**Port:** 3003
**Runtime:** Bun (separate process)
**Access:** Via Caddy gateway with `?XTransformPort=3003`

The worker is a lightweight HTTP server responsible for:

- Receiving scan jobs (page URLs, viewport, locale, analyzer config)
- Launching isolated Playwright (Chromium) browser contexts
- Running browser-based analyzers (HTTP, runtime, responsive, a11y, forms, perf, passive security, SEO)
- Capturing screenshots, traces, and video artifacts
- Streaming progress events back to the main app

**Production note:** In production, the worker runs in an isolated Docker
container with full sandbox hardening (non-root, read-only FS, dropped
capabilities, resource limits). In the sandbox, it shares the host for
simplicity.

---

## 4. Persistence Layer

### Database

| Concern | Choice |
|---------|--------|
| ORM | Prisma |
| Engine | SQLite (sandbox) — portable to PostgreSQL |
| File | `db/custom.db` |
| Migrations | `prisma db push` (sandbox) / `prisma migrate` (production) |

### Tenant Isolation

SQLite lacks native Row-Level Security. Isolation is enforced at the
application layer through:

1. **Workspace guard** — API route middleware extracts `workspaceId` from
   the authenticated session, never from the request body.
2. **Mandatory `workspaceId` parameter** — Every service method that
   touches tenant data requires `workspaceId` as an explicit argument.
3. **Workspace-scoped Prisma client wrapper** — `src/lib/db.ts` provides
   helpers that inject `where: { workspaceId }` into all queries.
4. **Automated tenant-isolation tests** — Prove no cross-tenant data
   leakage under adversarial conditions.
5. **FK constraints** — Database foreign keys enforce referential
   integrity across tenant boundaries.

PostgreSQL RLS policies are documented in `DATABASE_DESIGN.md` for
production deployment; the schema is portable without structural changes.

### Queue / Job Storage

A `jobs` table in SQLite provides persistent job storage. The API
exposes BullMQ-compatible semantics (`add`, `process`, `progress`,
`complete`, `fail`) so handlers can be swapped to Redis+BullMQ in
production without rewriting business logic.

---

## 5. Real-Time Communication

### Server-Sent Events (SSE)

Run progress is streamed via SSE at:

```
GET /api/v1/runs/:runId/events
Authorization: Bearer <session-cookie>
Accept: text/event-stream
```

**Protocol:**

- Worker writes events to the database (or in-process event emitter).
- The SSE route subscribes to the event stream and forwards to the client.
- Events include: `page.started`, `page.completed`, `finding.discovered`,
  `run.completed`, `run.failed`, heartbeat (`: keep-alive`).
- Clients reconnect with `Last-Event-ID` to resume after disconnection.

---

## 6. AI Integration

### Provider Adapter

```
src/modules/ai/providers/
  ├─ glm-adapter.ts       # z-ai-web-dev-sdk (GLM) — default
  ├─ openai-adapter.ts    # OpenAI-compatible fallback
  └─ mock-adapter.ts      # Deterministic responses for tests
```

- All adapters implement a common `AIProvider` interface.
- The default provider is `z-ai-web-dev-sdk` (GLM), available in the sandbox.
- An OpenAI-compatible adapter is maintained for production portability.
- A Mock adapter provides deterministic responses for unit/integration tests.
- Prompts are versioned and validated with Zod schemas for structured output.
- Cost controls enforce per-plan, per-run, and daily limits with circuit breakers.

---

## 7. Caching

Caching is in-process memory only (no Redis in sandbox):

- **Session lookups:** In-process `Map` with TTL-based expiry.
- **Workspace/plan cache:** In-process with invalidation on mutation.
- **Rate-limit counters:** In-process sliding window (with DB fallback for
  persistence across restarts).

Production may introduce Redis for distributed caching without architectural
changes.

---

## 8. Internationalization (i18n)

| Concern | Choice |
|---------|--------|
| Library | `next-intl` |
| Default locale | English (`en`) |
| Full RTL locale | Persian/Farsi (`fa`) |
| Direction | `dir="rtl"` for `fa`, logical CSS properties throughout |
| Number/date formatting | Locale-aware via `Intl` APIs |

Messages are stored in `messages/en.json` and `messages/fa.json`.
All user-facing strings, email templates, and error messages are
externalized.

---

## 9. `src/lib/*` Helper Reference

| File | Purpose |
|------|---------|
| `src/lib/config.ts` | Centralized application configuration constants and defaults |
| `src/lib/env.ts` | Zod-validated environment variables; startup refusal for unsafe production configs |
| `src/lib/logger.ts` | Structured JSON logger with standard fields (timestamp, level, requestId, component) |
| `src/lib/db.ts` | Prisma client singleton with workspace-scoped query helpers |
| `src/lib/crypto.ts` | Argon2id hashing, secure random generation, AES-256-GCM envelope encryption |
| `src/lib/permissions.ts` | Centralized permission map and guard functions for workspace/platform roles |
| `src/lib/session.ts` | Cookie/session creation, verification, rotation, and revocation helpers |
| `src/lib/audit.ts` | Structured audit log writer with immutable entries and sensitive-field exclusion |
| `src/lib/seed.ts` | Database seeder for development environments (plans, default workspace) |
| `src/lib/utils.ts` | General-purpose utilities (`cn` for Tailwind class merging, etc.) |
| `src/lib/queue.ts` | SQLite-backed job queue with BullMQ-compatible handler API |
| `src/lib/safe-url.ts` | `SafeTargetUrlService` — URL parsing, validation, SSRF prevention |
| `src/lib/rate-limit.ts` | Rate limiting (in-memory + DB-backed), sliding window, per-key quotas |
| `src/lib/vault.ts` | Secrets vault — AES-256-GCM envelope encryption with key versioning |
| `src/lib/errors.ts` | RFC 7807 Problem Details error construction and formatting |
| `src/lib/api-key.ts` | API key generation, validation, hashing, and scope enforcement |

---

## 10. `src/modules/*` Reference

| Module | Purpose |
|--------|--------|
| `src/modules/auth` | User authentication, registration, login, password management, email verification, OAuth, MFA, sessions |
| `src/modules/workspaces` | Workspace CRUD, member invitations, role management, team operations |
| `src/modules/projects` | Project CRUD with brand settings, locale configuration, timezone, retention policies |
| `src/modules/environments` | Environment management (PRODUCTION/STAGING/PREVIEW/DEVELOPMENT) with scan modes and network restrictions |
| `src/modules/scans` | Scan run lifecycle, page crawling, URL safety, domain verification, orchestration |
| `src/modules/findings` | Finding fingerprinting, deduplication, lifecycle management, severity, scoring |
| `src/modules/journeys` | User journey definition, execution, safe action policies, secret references, results |
| `src/modules/reports` | Technical/client report generation, white-labeling, sharing, PDF export, approvals |
| `src/modules/billing` | Stripe integration, subscription management, plans, usage ledger, developer-mode fallback |
| `src/modules/integrations` | Deployment hooks, Slack notifications, outgoing webhooks, scheduling |
| `src/modules/ai` | AI provider abstraction, prompt management, output validation, cost controls |
| `src/modules/admin` | Platform administration, system monitoring, feature flags, security event review |

---

## 11. Request Flow — Complete

### Standard API Request

```
Browser
  │
  ▼
Caddy Gateway (:81)
  │  X-Forwarded-For, X-Forwarded-Proto, X-Real-IP
  ▼
Next.js (:3000)
  │
  ├─ Middleware (session auth, CSRF, request ID, security headers)
  ▼
API Route Handler (/api/v1/*)
  │  Input validation (Zod)
  │  Workspace guard (extract workspaceId from session)
  ▼
Service Module (src/modules/*)
  │  Business logic
  │  Permission checks
  ▼
Prisma ORM
  │  Workspace-scoped queries
  ▼
SQLite (db/custom.db)
  │
  ▼
Response (RFC 7807 errors or JSON payload)
```

### Scan Execution Request

```
Browser (POST /api/v1/runs)
  │
  ▼
Caddy → Next.js :3000
  │
  ├─ Auth + workspace guard + domain verification + quota check
  ▼
Scan Service Module
  │  Creates Run record
  │  Enqueues job (scan-orchestration) in jobs table
  │  Returns run ID
  ▼
Worker Mini-Service (:3003, via ?XTransformPort=3003)
  │  Polls / receives job notification
  │  Launches Playwright browser context (isolated per run)
  │  Navigates target URL
  │  Runs analyzers (HTTP, runtime, responsive, a11y, forms, perf, sec, SEO)
  │  Stores artifacts (screenshots, traces)
  │  Writes findings to DB via internal API
  │  Publishes progress events
  ▼
SQLite (findings, artifacts, events)
  │
  ▼
SSE Route (/api/v1/runs/:runId/events)
  │  Streams events to browser (heartbeat, page progress, findings)
  ▼
Browser receives real-time updates
```

---

## 12. Technology Stack Summary

| Layer | Technology |
|-------|-----------|
| Framework | Next.js 16 App Router |
| Language | TypeScript 5 (strict) |
| Runtime | Node.js / Bun |
| Styling | Tailwind CSS 4 + shadcn/ui (New York) |
| Database | SQLite via Prisma (sandbox); PostgreSQL (production) |
| Browser Automation | Playwright (Chromium) |
| Auth | Custom: Argon2id + opaque session cookies + TOTP MFA |
| Secret Encryption | AES-256-GCM envelope encryption |
| AI | z-ai-web-dev-sdk (GLM) with provider-agnostic adapter |
| Billing | Stripe (developer-mode fallback when keys absent) |
| Real-time | Server-Sent Events (SSE) |
| Validation | Zod |
| i18n | next-intl (EN + FA/RTL) |
| State Management | Zustand + TanStack Query |
| Testing | Bun test + Playwright e2e |

---

_This document describes the intended architecture. Implementation status
is tracked in `IMPLEMENTATION_CHECKLIST.md`._
