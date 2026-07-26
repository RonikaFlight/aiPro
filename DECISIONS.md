# Architecture Decision Records — ProofPilot

> Each ADR follows the format: Context, Decision, Rationale, Consequences.
> ADRs are immutable once recorded; new information leads to new ADRs, not edits.

---

## D1. Single-App Adaptation (vs Spec's pnpm Monorepo)

### Context

The specification defines a pnpm monorepo with five apps:

- `apps/web` — Next.js frontend
- `apps/api` — NestJS REST API
- `apps/worker` — Playwright browser scanning
- `apps/scheduler` — Cron-based scan scheduling
- `apps/demo-target` — Intentionally vulnerable site for scanner testing

The development sandbox exposes **only port 3000** externally. Other ports are
reachable only via the Caddy gateway using `?XTransformPort=<port>`.

### Decision

Collapse the monorepo into a **single Next.js 16 App Router application** with
internal `src/modules/*` packages plus a **Playwright worker mini-service** on
port 3003 (reached via the gateway).

- The Next.js app serves both the UI and the REST API (`/api/v1/*`).
- Internal modules replace the spec's separate packages.
- The scheduler runs as an in-process cron within the Next.js app.
- The demo-target is omitted from the sandbox (used only in CI/e2e tests).
- The worker is a separate Bun process on port 3003.

### Rationale

Only port 3000 is externally reachable. Running a separate NestJS API server
on a different port would be inaccessible. Collapsing into one app preserves
the same REST contract and module boundaries while working within the sandbox
constraint.

The worker must be a separate process because Playwright browser instances
require process isolation from the Next.js app. Port 3003 is reachable via
the gateway's `XTransformPort` mechanism.

### Consequences

- **Positive:** Simpler development setup (one `bun run dev`); no inter-service
  networking complexity; shared types and utilities without package publishing.
- **Positive:** Same REST API contract (`/api/v1/*`), RFC 7807 errors, and
  OpenAPI spec as the spec's NestJS API.
- **Negative:** Internal modules instead of npm packages — no tree-shaking
  across package boundaries, no independent versioning.
- **Negative:** Worker is a mini-service rather than a fully containerized
  deployment — production must switch to the documented Docker container approach.
- **Negative:** Scheduler is in-process rather than a dedicated process —
  acceptable for the scale of this application.

---

## D2. SQLite via Prisma (vs PostgreSQL)

### Context

The specification calls for PostgreSQL with Row-Level Security (RLS) for
tenant isolation. The sandbox environment does not provide a PostgreSQL
instance.

### Decision

Use **SQLite** as the database with **Prisma** as the ORM. Enforce tenant
isolation at the **application layer** through mandatory workspace-scoped
queries. Retain RLS policy definitions in `DATABASE_DESIGN.md` for
production migration.

### Rationale

SQLite is file-based and requires no external service, making it ideal for
the sandbox. Prisma supports SQLite with the same query API as PostgreSQL,
so the application code is database-agnostic.

Tenant isolation without RLS requires stricter application-layer controls.
These controls are implemented as a defense-in-depth strategy (workspace guard,
mandatory workspaceId parameter, Prisma wrapper, FK constraints, automated
tests).

### Consequences

- **Positive:** Zero-infrastructure database; fast setup; easy local development.
- **Positive:** Schema is portable to PostgreSQL — Prisma handles dialect
  differences; migration requires changing `provider = "sqlite"` to
  `provider = "postgresql"` and updating `DATABASE_URL`.
- **Negative:** No native RLS — isolation relies entirely on application code;
  a single missed `workspaceId` check could leak data.
- **Negative:** No concurrent write performance — SQLite uses file-level
  locking; acceptable for development and low-scale deployment.
- **Negative:** No full-text search, JSON operators, or advanced PostgreSQL
  features — workarounds exist or features are deferred to production.
- **Mitigation:** Automated tenant-isolation test suite proves no
  cross-tenant data access; tests run on every commit.

---

## D3. SQLite-Backed Queues (vs Redis + BullMQ)

### Context

The specification calls for Redis-backed BullMQ queues for scan orchestration,
page analysis, journey execution, artifact processing, AI enrichment, report
generation, email, webhooks, and maintenance. The sandbox does not provide
Redis.

### Decision

Implement a **jobs table in SQLite** with an in-process worker that exposes a
**BullMQ-compatible handler API** (`add`, `process`, `progress`, `complete`,
`fail`).

### Rationale

A SQLite-backed job table provides persistent job storage without requiring
Redis. Jobs survive application restarts (unlike pure in-memory queues).

By matching BullMQ's handler API, all job handler code is written once and
works identically whether backed by SQLite or Redis+BullMQ. Production
deployment swaps the queue backend without rewriting handlers.

### Consequences

- **Positive:** No Redis dependency for development.
- **Positive:** Persistent jobs (survive restarts).
- **Positive:** Handler code is backend-agnostic.
- **Negative:** Lower throughput than Redis — SQLite write contention limits
  concurrent job processing.
- **Negative:** No distributed locking across multiple app instances.
- **Negative:** No built-in job priority, delay, or repeat semantics (must be
  implemented in the SQLite adapter).
- **Mitigation:** Single-instance deployment is sufficient for development;
  production uses Redis+BullMQ.

---

## D4. Next.js Route Handlers (vs NestJS)

### Context

The specification defines a separate NestJS application for the REST API,
with OpenAPI spec generation, request validation, and error handling.
The single-app adaptation (D1) means the API must live within the Next.js app.

### Decision

Implement the REST API as **Next.js Route Handlers** under `/api/v1/*`.
Use the same REST contract, RFC 7807 Problem Details error format, and
Zod-based validation as the spec's NestJS API.

### Rationale

Next.js Route Handlers provide a standard way to serve API endpoints within
the App Router. They support the same HTTP methods, middleware integration,
and TypeScript types as a standalone API server.

The REST contract (paths, methods, request/response schemas) is defined
independently of the framework. OpenAPI specs can be generated from Zod
schemas.

### Consequences

- **Positive:** Single process for UI and API — no CORS issues, shared
  middleware, simplified deployment.
- **Positive:** Same error format (RFC 7807), same validation (Zod), same
  authentication model as the spec.
- **Positive:** Route handlers have access to Next.js middleware for auth,
  CSRF, and security headers.
- **Negative:** No NestJS-specific features (decorators, guards, interceptors,
  pipes) — equivalents implemented as plain TypeScript middleware and functions.
- **Negative:** Route handlers are slightly more verbose than NestJS
  decorators for complex routing.
- **Neutral:** Performance is comparable for the expected request volume.

---

## D5. Custom Session Auth (vs NextAuth)

### Context

The specification requires:

- Opaque 256-bit session tokens (not JWTs)
- Hash-only storage (never store raw tokens)
- Exact cookie name: `__Host-proofpilot_session`
- Argon2id password hashing with specific parameters (m≥64MiB, t≥3, p≥1)
- TOTP MFA (RFC 6238) with encrypted secret storage
- 10 single-use recovery codes, hashed
- Session rotation on specific events
- Constant-time credential comparisons
- No periodic forced password changes

NextAuth (Auth.js) provides a flexible auth framework but has opinions about
token format, session strategy, cookie names, and MFA that don't match the
spec's exact requirements.

### Decision

Implement **custom authentication** from scratch, using:

- `argon2` npm package for Argon2id password hashing
- `crypto.randomBytes(32)` for session token generation
- `crypto.createHash('sha256')` for token hashing before storage
- Custom cookie handling matching the spec's exact configuration
- Custom TOTP implementation using `otplib`
- Custom recovery code generation and verification

### Rationale

The spec's requirements are specific and non-negotiable. NextAuth's session
strategy (typically JWT), cookie management, and MFA flow don't align without
significant customization that would be more complex than a custom implementation.

A custom implementation gives full control over:

- Token format and storage
- Cookie attributes (exact `__Host-` prefix, flags, name)
- Session lifecycle (rotation events, expiration policy)
- MFA flow (confirm-before-enable, recovery codes)
- Audit logging integration

### Consequences

- **Positive:** Full control over every aspect of authentication.
- **Positive:** Exact match to specification requirements.
- **Positive:** No dependency on NextAuth's release cycle or breaking changes.
- **Negative:** More code to write and maintain (~500-800 lines vs NextAuth's
  ~50-line setup).
- **Negative:** Must implement and test all security measures manually
  (timing-safe comparisons, hash-only storage, etc.).
- **Negative:** No ecosystem of pre-built providers — OAuth adapters written
  from scratch (though this is straightforward).
- **Mitigation:** Security tests cover all critical paths; code is well-documented
  and reviewed.

---

## D6. z-ai-web-dev-sdk as Primary AI Provider

### Context

The specification calls for AI-powered features: finding explanations, run
summaries, business-impact categorization, remediation suggestions, journey
proposals, client-friendly report language, and semantic finding grouping.

The sandbox provides the `z-ai-web-dev-sdk` package, which offers GLM-based
LLM capabilities.

### Decision

Create a **provider-agnostic AI adapter interface** with three implementations:

1. **GLM adapter** — uses `z-ai-web-dev-sdk` (default in sandbox/development)
2. **OpenAI-compatible adapter** — for production deployment with OpenAI or
   compatible providers (Anthropic via proxy, local models via Ollama, etc.)
3. **Mock adapter** — deterministic responses for unit and integration tests

The adapter is selected via the `AI_PROVIDER` environment variable.

### Rationale

The `z-ai-web-dev-sdk` is the only AI runtime available in the sandbox.
A provider-agnostic interface allows swapping to any OpenAI-compatible API
in production without changing business logic.

The Mock adapter is essential for testing — AI responses are non-deterministic
and slow, making tests flaky without mocking.

### Consequences

- **Positive:** Development works immediately with the sandbox's SDK.
- **Positive:** Production can use any OpenAI-compatible provider.
- **Positive:** Tests are fast and deterministic with the Mock adapter.
- **Positive:** Versioned prompts + Zod validation ensure output consistency
  across providers.
- **Negative:** GLM and OpenAI may produce different quality/style outputs —
  prompts may need provider-specific tuning.
- **Negative:** Maintaining multiple adapters adds surface area.
- **Mitigation:** Prompts are versioned and tested; output validation via Zod
  ensures structural consistency regardless of provider.

---

## D7. SSE over WebSocket for Run Progress

### Context

The specification requires real-time progress updates during scan runs.
Both Server-Sent Events (SSE) and WebSocket are viable technologies.

### Decision

Use **Server-Sent Events (SSE)** via `GET /api/v1/runs/:runId/events`.

### Rationale

- **One-way communication:** Scan progress is server-to-client only; the
  client doesn't send data through the progress channel (control operations
  use standard REST endpoints: POST to cancel, POST to retry).
- **Simplicity:** SSE is simpler to implement and debug than WebSocket.
  No framing protocol, no ping/pong, no connection-state management.
- **Compatibility:** SSE works through proxies and CDNs more reliably than
  WebSocket.
- **Spec allowance:** The specification allows "equivalent secure mechanism"
  — SSE satisfies this.

### Consequences

- **Positive:** Simpler implementation (native browser `EventSource` API).
- **Positive:** Automatic reconnection built into the `EventSource` API.
- **Positive:** Works with standard HTTP infrastructure (no upgrade needed).
- **Negative:** One-way only — client cannot send data through the SSE channel
  (acceptable; control operations use REST).
- **Negative:** Limited to ~6 concurrent SSE connections per domain in some
  browsers (mitigated by: only one SSE connection per run view).
- **Implementation details:**
  - Heartbeat: server sends `: keep-alive` comments every 15 seconds.
  - Reconnect: client sends `Last-Event-ID` header to resume from last
    received event.
  - Auth: SSE endpoint requires valid session cookie (first request).

---

## D8. In-Process + DB Pub/Sub for Worker Events (vs Redis Pub/Sub)

### Context

The specification calls for the worker to publish events (page progress,
findings, completion) that are streamed to the client via SSE. In a full
deployment, this would use Redis Pub/Sub to decouple the worker from the
API server.

The sandbox has no Redis.

### Decision

Use a **two-part mechanism**:

1. Worker writes events to the **database** (an `events` table).
2. The SSE route **polls or subscribes** to new events using an in-process
   event emitter (for same-process scenarios) or database polling (for
   cross-process scenarios).

### Rationale

Without Redis, events must be persisted to survive the gap between the
worker process and the Next.js SSE route. A database table provides
persistence and ordering.

For same-process scenarios (e.g., when the SSE client reconnects and the
app polls), an in-process `EventEmitter` bridges between DB writes and
SSE streams with lower latency.

### Consequences

- **Positive:** Works without Redis.
- **Positive:** Events are persisted — can be replayed or audited.
- **Positive:** Same API surface as Redis Pub/Sub (publish/subscribe).
- **Negative:** Higher latency than Redis Pub/Sub (database round-trip).
- **Negative:** Database polling introduces load (mitigated by efficient
  cursor-based queries).
- **Mitigation:** Production swaps to Redis Pub/Sub for lower latency;
  the handler API is identical.

---

## D9. Stripe Developer Mode

### Context

The specification calls for Stripe integration (checkout, customer portal,
subscription management, webhook handling). The sandbox does not have live
Stripe API keys, and using test keys would still require a Stripe account
and network access.

### Decision

Implement a **billing abstraction layer** that:

- Uses the **real Stripe SDK** when `STRIPE_SECRET_KEY` is set and starts
  with `sk_live_`.
- Enters **developer mode** when `STRIPE_SECRET_KEY` is absent or starts
  with `sk_test_`, returning synthetic responses (e.g., fake plans, mocked
  checkout sessions, simulated subscription state).

Developer mode responses are clearly marked (e.g., `source: "developer-mode"`
in response metadata). The UI shows a banner indicating developer mode is
active.

### Rationale

Developer mode unblocks UI development, testing, and demo flows without
requiring a Stripe account or API keys. The abstraction layer ensures that
switching to live Stripe requires only setting the environment variable —
no code changes.

### Consequences

- **Positive:** Full UI development possible without Stripe.
- **Positive:** Synthetic responses allow testing edge cases (payment failure,
  subscription cancellation, etc.).
- **Positive:** Clear visual indicator prevents confusion about billing state.
- **Negative:** Developer mode behavior may not perfectly match Stripe's
  actual API responses.
- **Negative:** Production deployment MUST set real Stripe keys — the
  production safety check (SECURITY_MODEL.md §15) refuses to start with
  test keys.
- **Mitigation:** Integration tests use the Mock adapter; E2E tests use
  Stripe's test mode when available.

---

## D10. Playwright in Worker Mini-Service

### Context

The specification calls for browser-based scanning using Playwright (Chromium)
running in an isolated Docker container with full sandbox hardening. The
sandbox environment doesn't support Docker-in-Docker or complex container
orchestration.

### Decision

Run Playwright in a **worker mini-service** (`mini-services/worker`) as a
separate Bun process on **port 3003**, reached via the Caddy gateway using
`?XTransformPort=3003`.

In the sandbox:

- The worker runs as a plain process (not containerized).
- Playwright launches with default sandbox (no `--no-sandbox`).
- Resource limits are applied at the process level where possible.

In production:

- The worker runs in an isolated Docker container per the spec's
  `infrastructure/docker/worker.Dockerfile`.
- Full sandbox hardening (non-root, read-only FS, dropped capabilities,
  seccomp, resource limits).

### Rationale

Playwright requires a separate process to avoid blocking the Next.js event
loop. The worker mini-service provides this isolation while working within
the sandbox's gateway routing rules.

The `XTransformPort` mechanism is the only way to reach non-3000 services
from outside the sandbox, making port 3003 the natural choice.

### Consequences

- **Positive:** Browser scanning works in the sandbox for development and
  testing.
- **Positive:** Same worker code runs in both sandbox and production.
- **Positive:** Port 3003 is reachable via the gateway for both API calls
  from the main app and external access.
- **Negative:** No OS-level sandboxing in the sandbox environment — a
  browser exploit could affect the host process (mitigated by Chromium's
  built-in sandbox and resource limits).
- **Negative:** Worker process shares the host's network namespace in the
  sandbox (mitigated by Playwright network interception and SSRF controls).
- **Mitigation:** Production uses the fully containerized approach with all
  hardening measures documented in SECURITY_MODEL.md §7.
