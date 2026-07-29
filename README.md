# ProofPilot

**Ship AI-built apps with evidence, not hope.**

<p align="center">
  <img src="public/logo.svg" alt="ProofPilot Logo" width="280" />
</p>

<p align="center">
  <strong>Automated QA platform for web agencies, freelancers, and AI-app builders.</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white" alt="TypeScript 5" />
  <img src="https://img.shields.io/badge/Next.js-16-000000?logo=next.js&logoColor=white" alt="Next.js 16" />
  <img src="https://img.shields.io/badge/npm-11-CB3837?logo=npm&logoColor=white" alt="npm" />
  <img src="https://img.shields.io/badge/Prisma-6-2D3748?logo=prisma&logoColor=white" alt="Prisma 6" />
  <img src="https://img.shields.io/badge/License-MIT-green" alt="MIT License" />
</p>

---

## Overview

ProofPilot is a SaaS quality-assurance platform that automatically scans web applications, detects issues across browser rendering, accessibility, responsiveness, localization, and performance, then generates both technical and client-facing reports with AI-powered analysis.

Provide a verified application URL. ProofPilot automatically:

- Discovers pages and product structure
- Runs browser-based checks with Playwright
- Tests responsive layouts across breakpoints
- Detects accessibility problems (WCAG)
- Identifies broken interactions and console errors
- Checks localization and RTL layout rendering
- Executes safe user journeys with destructive-action policies
- Captures screenshots, traces, and videos as evidence
- Groups duplicate problems and assigns severity and business impact
- Generates technical reports and client-friendly deliverables
- Re-runs checks after deployment and tracks fix/reopen/ignore status

---

## How to Run the Project

### Prerequisites

- [Node.js](https://nodejs.org/) 18+ (recommended: 20+)
- npm 9+ (comes with Node.js)

### 1. Install Dependencies

```bash
npm install
```

This reads `package.json` and generates `package-lock.json`. All 858+ packages are installed into `node_modules/`.

> If you see postinstall script warnings for `sharp`, `argon2`, or `prisma`, run:
> ```bash
> npm approve-scripts @prisma/client @prisma/engines prisma argon2 sharp unrs-resolver @parcel/watcher @swc/core es5-ext
> ```

### 2. Configure Environment Variables

Copy the `.env` file (or create one from scratch) at the project root:

```bash
cp .env.example .env
```

Minimum required variables for development:

```env
DATABASE_URL=file:./db/custom.db
SESSION_SECRET=dev-session-secret-minimum-16-characters
CSRF_SECRET=dev-csrf-secret-minimum-16-characters
PROOFPILOT_ENCRYPTION_KEY=dev-encryption-key-minimum-20-characters
APP_URL=http://localhost:3000
SESSION_COOKIE_NAME=proofpilot_session
```

> The app uses [Zod](https://zod.dev/) to validate all environment variables at startup. If any are missing or invalid, the server will refuse to start with a clear error message.

### 3. Database Setup

```bash
# Push the Prisma schema to the database (creates tables)
npm run db:push

# Generate the Prisma client ( TypeScript types for database queries)
npm run db:generate

# (Optional) Seed with demo data
npm run seed
```

- `db:push` uses `prisma db push --accept-data-loss` which applies schema changes directly without creating migration files. This is the recommended approach during development.
- `db:generate` regenerates the `@prisma/client` TypeScript types so your IDE has full autocomplete.
- `seed` populates the database with sample workspaces, projects, and scan runs for testing.

### 4. Start the Development Server

```bash
npm run dev
```

This runs `next dev -p 3000` with hot-reload (Turbopack). The server starts in ~300ms.

You'll see output like:

```
▲ Next.js 16.1.3 (Turbopack)
- Local:    http://localhost:3000
- Network:  http://0.0.0.0:3000
✓ Ready in 329ms
```

The application is now available at **http://localhost:3000**.

### 5. (Optional) Start the Worker Mini-Service

The Playwright worker runs on a separate port for browser automation (scanning, accessibility checks, etc.):

```bash
npm run worker
```

This starts on port 3003 (configurable via `WORKER_PORT` env var). In the sandbox environment, it's reached via the Caddy gateway using the query parameter `?XTransformPort=3003`.

> For most UI development and testing, you don't need the worker running. It's only required when triggering actual scans.

### 6. Using the Application

1. **Register** — Go to `http://localhost:3000/register`, create an account
2. **Verify Email** — In development mode, the verification link is logged to the server console. Check the dev log or run:
   ```bash
   tail -f dev.log | rg "verify-email"
   ```
   Then visit the `verify-email?token=...` URL (or POST to `/api/v1/auth/verify-email` with the token).
3. **Login** — Go to `http://localhost:3000/login` with your credentials
4. **Create a Workspace** — After login, click "New workspace" on the dashboard
5. **Create a Project** — Inside a workspace, click "Create project" and provide a target URL
6. **Run a Scan** — Inside a project, trigger a scan (requires the worker mini-service running)

### Quick Reference: All npm Scripts

| Command | What It Does |
|---|---|
| `npm run dev` | Start Next.js dev server on port **3000** |
| `npm run build` | Build production standalone output |
| `npm run start` | Run production server from standalone build |
| `npm run worker` | Start Playwright worker on port **3003** |
| `npm run lint` | Run ESLint |
| `npm run typecheck` | TypeScript type checking (`tsc --noEmit`) |
| `npm run db:push` | Push Prisma schema to database |
| `npm run db:generate` | Regenerate Prisma client types |
| `npm run db:migrate` | Create a new database migration |
| `npm run db:reset` | Reset the database |
| `npm run seed` | Seed database with demo data |

### Development Workflow

A typical development session looks like this:

```bash
# Terminal 1: Main application
npm run dev

# Terminal 2: Worker (only if working on scan features)
npm run worker

# Terminal 3: Watch logs
tail -f dev.log
```

The dev server uses **Turbopack** for near-instant hot module replacement. Changes to any file in `src/` are reflected in the browser within milliseconds — no full-page reload needed.

### Gateway / Reverse Proxy

In production-like environments (including this sandbox), a [Caddy](https://caddy.com/) reverse proxy sits in front of the application:

```
Caddy (port 81)
  ├── / → Next.js (localhost:3000)
  └── /?XTransformPort=3003 → Worker (localhost:3003)
```

All browser requests go through Caddy. The `X-Forwarded-Proto` and `Host` headers are forwarded so the app's CSRF protection accepts the proxy's origin.

---

## Tech Stack

| Concern | Technology | Notes |
|---|---|---|
| Framework | Next.js 16 (App Router) | Single-app architecture with Route Handlers |
| Language | TypeScript 5 (strict) | End-to-end type safety |
| Runtime | Node.js | Development and production |
| Package Manager | npm | Lock file: `package-lock.json` |
| Styling | Tailwind CSS 4 + shadcn/ui | New York style variant |
| Database | SQLite (dev) / PostgreSQL (prod) | Prisma ORM, tenant-isolation at application layer |
| ORM | Prisma 6 | Schema portable between SQLite and PostgreSQL |
| Auth | Argon2id + opaque session cookies | Custom implementation, TOTP MFA, recovery codes |
| Encryption | AES-256-GCM | Envelope encryption for stored secrets |
| AI | z-ai-web-dev-sdk (GLM) | Provider-agnostic adapter with OpenAI-compatible fallback |
| Browser Automation | Playwright (Chromium) | Runs in isolated worker mini-service |
| Validation | Zod 4 | Schemas, env validation, AI output parsing |
| State Management | Zustand + TanStack Query | Client state + server state |
| Internationalization | next-intl | English (default) + Persian (full RTL) |
| PDF Generation | PDFKit | Report export |

---

## Features

### Automated Scanning

- **Page Discovery** -- Automatic crawling and site-structure mapping
- **Browser Checks** -- Playwright-powered runtime error detection, console capture, and interaction testing
- **Responsive Testing** -- Layout validation at mobile, tablet, and desktop breakpoints
- **Accessibility Auditing** -- WCAG compliance checks with categorized violations
- **Localization / RTL** -- Bidirectional layout verification, missing-translation detection, and RTL rendering validation

### AI-Powered Analysis

- **Finding Explanations** -- Plain-language descriptions of detected issues
- **Business Impact Assessment** -- Severity scoring mapped to revenue, reputation, and compliance risk
- **Remediation Suggestions** -- Actionable fix recommendations with code snippets
- **Semantic Grouping** -- Automatic deduplication and clustering of related findings
- **Client-Friendly Reports** -- Non-technical summaries suitable for stakeholder delivery

### Journey Testing

- Safe user-journey execution with configurable **destructive-action policies**
- Journey proposals generated by AI from discovered page structures
- Versioned journey definitions with rollback support

### Security

| Feature | Implementation |
|---|---|
| SSRF Protection | DNS resolution guard, private-network blocklist, URL validation |
| CSRF Defense | Origin/Referer validation + HMAC-signed CSRF tokens |
| Rate Limiting | Per-route and per-user rate limiting |
| Password Hashing | Argon2id (m=64 MiB, t=3, p=1) |
| Encryption at Rest | AES-256-GCM envelope encryption for secrets |
| Prompt Injection Defense | Input sanitization and prompt-safety filters for AI features |

See [SECURITY_MODEL.md](./SECURITY_MODEL.md) and [THREAT_MODEL.md](./THREAT_MODEL.md) for details.

### Collaboration

- **Secure Report Sharing** -- Token-based, password-protected, and time-limited sharing links
- **Approval Workflows** -- Submit reports for review, approve or reject with audit trail
- **White-Labeling** -- Custom branding, colors, and logos per workspace

### Integrations

- **Slack Notifications** -- Alerts for scan completion, critical findings, and deployment hooks
- **Outgoing Webhooks** -- Custom HTTP payloads for finding events
- **Deployment Hooks** -- Automatic scan triggers on deployment events
- **Scheduled Scans** -- Cron-based recurring scan execution

---

## Project Structure

```
proofpilot/
├── src/
│   ├── app/                  # Next.js App Router pages and layouts
│   │   ├── api/v1/           # REST API route handlers
│   │   ├── admin/            # Platform admin dashboard pages
│   │   ├── app/              # Authenticated user dashboard pages
│   │   ├── login/            # Login page
│   │   ├── register/         # Registration page
│   │   └── page.tsx          # Landing page (public)
│   ├── components/           # React components
│   │   ├── ui/               # shadcn/ui primitives
│   │   ├── landing/          # Landing page sections (Navbar, Footer, etc.)
│   │   └── auth/             # Authentication UI components
│   ├── lib/                  # Core business logic and utilities
│   │   ├── ai/               # AI providers, prompts, safety, circuit breaker
│   │   ├── reports/          # Report generation, PDF export, sharing, approvals
│   │   ├── auth-service.ts   # Registration, login, MFA, session management
│   │   ├── crypto.ts         # Argon2id, AES-256-GCM, secure random tokens
│   │   ├── db.ts             # Prisma client singleton
│   │   ├── env.ts            # Zod-validated environment configuration
│   │   ├── csrf.ts           # CSRF token generation and validation
│   │   ├── logger.ts         # Structured JSON logger with secret redaction
│   │   ├── permissions.ts    # Role-based access control (26 permissions)
│   │   ├── rate-limit.ts     # Rate limiting middleware
│   │   ├── ssrf-guard.ts     # SSRF protection (DNS, private networks)
│   │   └── ...               # 50+ service modules
│   ├── hooks/                # Custom React hooks
│   ├── middleware.ts          # Next.js middleware (locale)
│   └── i18n/                 # Internationalization routing and config
├── mini-services/
│   └── worker/               # Playwright worker (port 3003)
│       └── src/
│           ├── analyzers/    # Runtime, HTTP, responsive, a11y, security, SEO, perf
│           ├── crawl.ts      # Page discovery and crawling
│           ├── orchestrator.ts # Scan job orchestration
│           ├── journey-runner.ts # Safe user-journey execution
│           └── ai-enrichment.ts  # Post-scan AI analysis
├── prisma/
│   └── schema.prisma         # Database schema (40+ models)
├── scripts/
│   └── seed.ts               # Database seeding script
├── db/
│   └── custom.db             # SQLite database file (generated)
├── package.json              # npm project manifest
├── package-lock.json         # npm lock file
├── Caddyfile                 # Reverse proxy configuration
├── docker-compose.yml        # Full production service reference
├── Dockerfile                # Hardened multi-stage production image
└── docs/
    ├── ARCHITECTURE.md       # System architecture and design decisions
    ├── API_DESIGN.md         # REST API contract
    ├── DATABASE_DESIGN.md    # Schema design and migration strategy
    ├── SECURITY_MODEL.md     # Security architecture
    └── THREAT_MODEL.md       # Threat analysis and mitigations
```

---

## Architecture

ProofPilot follows a modular architecture with clear separation of concerns. For detailed documentation, see:

| Document | Description |
|---|---|
| [ARCHITECTURE.md](./ARCHITECTURE.md) | System overview, module structure, and design decisions |
| [API_DESIGN.md](./API_DESIGN.md) | REST API contract, RFC 7807 error format, authentication flow |
| [DATABASE_DESIGN.md](./DATABASE_DESIGN.md) | Schema design, tenant isolation, and PostgreSQL migration notes |
| [SECURITY_MODEL.md](./SECURITY_MODEL.md) | Authentication, encryption, CSRF, SSRF protection, production safety |
| [THREAT_MODEL.md](./THREAT_MODEL.md) | Threat analysis, attack surface, and mitigation strategies |
| [DECISIONS.md](./DECISIONS.md) | Architecture decision records (D1--D10) |

Key architectural highlights:

- **Single-app model** with Next.js 16 App Router serving both pages and API routes
- **Worker mini-service** handles Playwright-based browser automation on a separate port
- **Application-layer tenant isolation** with mandatory `workspaceId` scoping on every database query
- **SQLite-backed queues** with BullMQ-compatible API for future Redis migration
- **Provider-agnostic AI layer** with circuit breakers, cost controls, and prompt injection defense

---

## Docker

### Quick Start

Build and run with Docker:

```bash
# Build the image
docker build -t proofpilot .

# Run with read-only filesystem (recommended)
docker run --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=100m \
  -e DATABASE_URL=file:/data/proofpilot.db \
  -e SESSION_SECRET="$(openssl rand -base64 32)" \
  -e CSRF_SECRET="$(openssl rand -base64 32)" \
  -e PROOFPILOT_ENCRYPTION_KEY="$(openssl rand -base64 32)" \
  -v proofpilot-db:/data \
  -p 3000:3000 \
  proofpilot:latest
```

### Full Stack with Docker Compose

For local development with all services (PostgreSQL, Redis, MinIO, Mailpit):

```bash
docker compose up -d postgres redis minio mailpit
```

See `docker-compose.yml` for the complete service reference.

---

## CI/CD

GitHub Actions workflows are located in `.github/workflows/`. See the workflow files for:

- Lint and typecheck on pull requests
- Unit test execution
- Build verification
- Docker image build and push

---

## Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/my-feature`
3. Commit your changes: `git commit -am 'Add new feature'`
4. Push to the branch: `git push origin feature/my-feature`
5. Submit a pull request

---

## License

This project is licensed under the **MIT License**. See [LICENSE](./LICENSE) for details.
