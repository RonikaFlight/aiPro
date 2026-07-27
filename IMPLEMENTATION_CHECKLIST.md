# IMPLEMENTATION_CHECKLIST — ProofPilot

> Mark an item complete **only** when: implementation exists, is connected to the real application, is tested, contains no placeholder behavior, and documentation is updated.

## Phase 1 — Foundation

- [x] Monorepo architecture (adapted to single-app + mini-services: `src/modules/*` + `mini-services/worker`)
- [x] Tooling: TypeScript strict, ESLint, Tailwind, shadcn/ui
- [x] Docker infrastructure reference (`docker-compose.yml`)
- [x] Shared configuration (`src/lib/config.ts`, `src/lib/env.ts`)
- [x] Structured JSON logging (`src/lib/logger.ts`)
- [x] Environment validation (Zod, startup refusals for unsafe production)
- [x] Database schema (Prisma + SQLite, all required tables/enums)
- [x] Migrations applied (`bun run db:push`)
- [x] Seed system (`src/lib/seed.ts`, `scripts/seed.ts`)
- [x] `PROJECT_MEMORY.md`, `ARCHITECTURE.md`, `SECURITY_MODEL.md`, `THREAT_MODEL.md`, `DATABASE_DESIGN.md`, `API_DESIGN.md`, `DECISIONS.md`
- [x] `.env.example`

## Phase 2 — Security & Identity

- [x] Email/password registration (min 12 chars, Argon2id)
- [x] Email verification (hashed, single-use, expiring tokens)
- [x] Login (rate-limited, constant-time)
- [x] Logout (revokes session)
- [x] Forgot password (no email existence leak)
- [x] Password reset (hashed, single-use tokens)
- [x] Google OAuth (Authorization Code + PKCE) — `src/lib/oauth/google.ts` (GoogleOAuthProvider: scopes openid/email/profile, code_challenge S256, prompt=select_account, access_type=online; exchangeCode via oauth2.googleapis.com/token; fetchProfile via openidconnect.googleapis.com/v1/userinfo; validates sub+email+email_verified)
- [x] GitHub OAuth — `src/lib/oauth/github.ts` (GitHubOAuthProvider: scopes read:user/user:email, code_challenge S256; exchangeCode via github.com/login/oauth/access_token with Accept:json; fetchProfile via api.github.com/user + api.github.com/user/emails to resolve primary+verified email)
- [x] TOTP MFA setup + confirm + challenge
- [x] Recovery codes (10, hashed)
- [x] Sessions list / revoke one / revoke others
- [x] Session rotation (login, MFA, password change, role elevation)
- [x] CSRF protection (Origin/Referer + token, exempt only webhooks)
- [x] Workspace roles (OWNER/ADMIN/MEMBER/VIEWER/CLIENT)
- [x] Platform roles (USER/SUPPORT/PLATFORM_ADMIN)
- [x] Centralized permission map + guards
- [x] Audit logging (login, logout, MFA, role change, secret access, etc.)
- [ ] Tenant-isolation tests (Phase 12)

## Phase 3 — Core SaaS

- [x] Workspaces CRUD
- [x] Workspace invitations (accept/revoke)
- [x] Members list / role change / remove
- [x] Projects CRUD (with brand, locales, timezone, retention)
- [x] Environments CRUD (PRODUCTION/STAGING/PREVIEW/DEVELOPMENT, scan mode, network restrictions)
- [x] Domain verification (DNS TXT / HTML file / meta tag) + revalidation
- [x] Plans (FREE/STARTER/PRO/AGENCY) stored in DB
- [x] Usage ledger (immutable, idempotency keys) — `src/lib/usage-service.ts` (recordUsageEvent, getUsageSummary, listUsageEvents, assertCanStartRun, assertCanAnalyzePage, aggregateUsageByType)
- [x] Billing foundation (Stripe abstraction, dev mode) — `src/lib/billing-service.ts` (PaymentProvider interface, DeveloperPaymentProvider, StripePaymentProvider, createCheckoutSession, createPortalSession, ensureSubscription, handleStripeWebhook, adminChangePlan)
- [x] Public audit mode (5 pages, no auth, rate-limited) — `src/lib/public-scan-service.ts` (createPublicScan, getPublicRunStatus)

## Phase 4 — Scanner Infrastructure

- [x] `SafeTargetUrlService` (WHATWG parse, IDNA, protocol blocklist, port allowlist, length cap)
- [x] IP validation (loopback/private/link-local/multicast/CGNAT/reserved/doc/metadata)
- [x] DNS rebinding protection (resolve → record → re-resolve → abort on change)
- [x] Redirect policy (max 10, revalidate, record blocked)
- [x] Scan authorization guard (workspace + domain verified + subscription + user confirm + env enabled + SSRF) — `src/lib/scan-auth.ts` (7 gates: membership/permission, project ACTIVE, environment enabled + scanMode compat, subscription ACTIVE/TRIALING, usage quota, verified-domain origin allowlist, SSRF + DNS rebinding; plus `revalidateTargetBeforeFetch` for fetch-time rebinding defense)
- [x] Queues (`scan-orchestration`, `page-analysis`, `journey-execution`, `artifact-processing`, `ai-enrichment`, `report-generation`, `email`, `webhooks`, `maintenance`)
- [x] Worker mini-service (`mini-services/worker`, port 3003) — `mini-services/worker/src/index.ts` (Bun.serve HTTP API + queue poller, health/status endpoints, graceful shutdown, --hot reload)
- [x] Playwright launch policy (no `--no-sandbox` by default, block SW persistence, block clipboard/camera/mic/geolocation/notifications) — `mini-services/worker/src/browser.ts` (21 hardened args, serviceWorkers:'block', acceptDownloads:false, permissions:[], clearPermissions, webrtc IP handling disable, --webrtc-ip-handling-policy=disable_non_proxied_udp)
- [x] Network interception (allowed origins, blocked IPs, max response size, timeout, blocked protocols, redirect revalidation, header stripping) — `mini-services/worker/src/browser.ts` createContext (7 checks: protocol, origin allowlist, DNS resolve + blocked IP, cross-origin cookie/auth stripping, non-safe method block, sanitized headers, context-level timeout)
- [x] Crawl engine (depth, max pages, normalize, fragment drop, query dedup, logout/destructive avoidance, per-page/total timeout, redirect chain, title, lang, dir) — `mini-services/worker/src/crawl.ts` (BFS queue, 38 destructive URL patterns multilingual, same-origin link discovery, canonical capture, console+page error capture, screenshot+HTML artifact capture)
- [x] Artifact storage (private, signed URLs, MIME, size limit, retention) — `src/lib/artifact-service.ts` (HMAC-SHA256 signed URLs, magic-byte MIME sniffing, allowlist per type, SHA-256 hash, path-traversal guard, retention expiry, cleanup helper)
- [x] SSE `/api/v1/runs/:runId/events` (auth, authorize workspace, heartbeat, reconnect with event ID) — `src/app/api/v1/runs/[runId]/events/route.ts` (Last-Event-ID replay, 15s heartbeat, in-process pub/sub + 1s DB polling fallback, 30min max lifetime, stream.end on terminal events)

## Phase 5 — Analyzers

- [x] HTTP/nav: broken links, 4xx/5xx, redirect loops, mixed content, failed resources, CORS-visible failures, invalid content types, missing/duplicate titles, missing lang, invalid canonical, broken favicon/manifest — `mini-services/worker/src/analyzers/http-nav.ts` (server errors, client errors, redirect loops, excessive redirects, failed requests, broken links via active HEAD/GET checking, mixed content, invalid content types, missing title, cross-origin canonical, broken favicon, broken manifest)
- [x] Runtime: uncaught errors, unhandled rejections, console errors/warnings, failed network, page crashes, nav timeouts, CSP violations (redacted) — `mini-services/worker/src/analyzers/runtime.ts` (page errors with secret redaction, console errors deduped, console warnings grouped, CSP violations via SecurityPolicyViolationEvent, page crash detection)
- [x] Responsive: horizontal overflow, out-of-viewport, fixed covering, clipped text, overlapping interactives, modal overflow, mobile nav, tap targets, input sizes, font sizes, tables, images, sticky headers — `mini-services/worker/src/analyzers/responsive.ts` (document overflow, out-of-viewport elements, fixed/sticky covering interactives, clipped text, tap target sizes <44×44, input font <16px, root font <16px, table overflow, image overflow)
- [x] Accessibility: axe-core integration, WCAG 2.2 AA where supported, missing names/labels, invalid ARIA, duplicate IDs, heading hierarchy, focus, contrast, alt, landmarks, dialog/button semantics, link names, tab order, frame titles, lang, touch targets — `mini-services/worker/src/analyzers/accessibility.ts` (axe-core WCAG 2.2 AA + best-practice tags, manual checks for missing html lang, heading hierarchy, h1 count, frame titles, bypass mechanism, unnamed interactives)
- [x] Forms: missing label, autocomplete, password handling, submit unavailable, inaccessible errors, required communication, unexpected navigation, missing feedback, mobile keyboard obscuring — `mini-services/worker/src/analyzers/forms.ts` (missing labels, missing/wrong autocomplete, suboptimal input types, password fields without autocomplete, missing submit button, disabled submit, required fields without aria-required, missing error region)
- [x] Performance: TTFB, DCL, load, LCP, CLS, INP, transferred bytes, request count, largest resources, long tasks, render-blocking — `mini-services/worker/src/analyzers/performance.ts` (TTFB, DCL, load, LCP, CLS, INP, FCP via Performance Timeline + PerformanceObserver, total bytes, request count, largest resources, long tasks, render-blocking resources, large individual resources)
- [x] Passive security: missing headers, mixed content, cookie Secure/HttpOnly/SameSite, sensitive URL params, insecure credential POST, source map exposure, secret-like strings, SRI, iframe policies, public stack traces — `mini-services/worker/src/analyzers/security.ts` (6 required security headers, cookie Secure/HttpOnly/SameSite, sensitive URL params, insecure credential POST, source map exposure, secret-like strings in DOM [AWS keys, JWTs, GitHub tokens, Stripe keys, Google API keys, Slack tokens], missing SRI on third-party resources, iframe sandbox, public stack traces on error pages)
- [x] SEO/metadata: title/description/canonical/OG/viewport/indexability/robots/sitemap — `mini-services/worker/src/analyzers/seo.ts` (missing/short/long title, missing/short/long description, missing canonical, missing/bad viewport, noindex detection, missing OG tags, missing Twitter Card, missing JSON-LD, missing favicon, missing manifest, missing html lang, thin content)

## Phase 6 — Findings

- [x] Finding fingerprint (projectId, checkId, normalizedUrl, normalizedSelector, viewport, locale, stableMessageKey, SHA-256) — `src/lib/crypto.ts` fingerprint() + `mini-services/worker/src/analyzers/finding-writer.ts` (fingerprint = SHA-256 of projectId+checkId+normalizedUrl+selector+viewport+locale+messageKey, upsert on fingerprint for cross-run dedup)
- [x] Deduplication across runs/pages/viewports/locales — `mini-services/worker/src/analyzers/finding-writer.ts` (upsert on fingerprint; FindingOccurrence records per-run appearances; isFindingSuppressed skips occurrence emission for suppressed findings)
- [x] Lifecycle state machine (OPEN/ACKNOWLEDGED/IN_PROGRESS/RESOLVED/REOPENED/IGNORED/ACCEPTED_RISK/FALSE_POSITIVE) with invalid-transition rejection — `src/lib/finding-severity.ts` (TRANSITION_MATRIX, canTransition, assertCanTransition) + `src/lib/findings-service.ts` (transitionFinding, patchFinding validate transitions, records FindingStatusHistory)
- [x] Auto-reopen on resolved fingerprint re-appearance — `src/lib/findings-service.ts` maybeAutoReopenFinding (only from RESOLVED; IGNORED/ACCEPTED_RISK/FALSE_POSITIVE are intentional decisions, not auto-reopened) + wired into `mini-services/worker/src/analyzers/finding-writer.ts`
- [x] Comments, assignments, tags — `src/lib/findings-service.ts` (addComment, listComments, patchFinding for assignedToId/tags; FindingComment model, Finding.tags comma-separated with parseTags validation/dedup, max 12 tags)
- [x] Suppressions (reason, creator, optional expiry, audit, narrowly scoped) — `src/lib/findings-service.ts` (createSuppression with 4 scopes: finding/fingerprint/checkId/project_check; project-wide requires OWNER/ADMIN; revokeSuppression idempotent; isFindingSuppressed for worker; expiry capped at 1 year; FindingSuppression.createdBy relation added)
- [x] Severity (BLOCKER/CRITICAL/MAJOR/MINOR/INFO) — deterministic first, AI may explain but not silently override — `src/lib/finding-severity.ts` (DETERMINISTIC_SEVERITY table for 60+ (category, checkId) pairs, resolveSeverity returns {severity, overridden}; AI cannot silently override — overrides recorded via patchFinding audit)
- [x] Business impact categories — `src/lib/finding-severity.ts` (12 BUSINESS_IMPACTS: REVENUE_LOSS, CONVERSION_LOSS, BRAND_DAMAGE, ACCESSIBILITY_BARRIER, LEGAL_COMPLIANCE, SEO_TRAFFIC_LOSS, USER_EXPERIENCE, SECURITY_EXPOSURE, PERFORMANCE_DEGRADATION, LOCALIZATION_BARRIER, TECHNICAL_DEBT, OTHER; parseBusinessImpacts/serializeBusinessImpacts)
- [x] Quality score (0–100, weights, blocker caps readiness) — `src/lib/quality-score.ts` (computeBreakdown pure function, SEVERITY_WEIGHTS [BLOCKER=25/CRITICAL=12/MAJOR=5/MINOR=2/INFO=0], SEVERITY_MAX_PENALTY caps per bucket, open BLOCKER caps score at 49 [NOT_READY], open CRITICAL caps at 74 [NEEDS_WORK], READY requires ≥80 + no blockers/criticals; computeProjectScore live from findings table, computeAndPersistRunScore writes to ScanRun.score + previousScore + blockerCount; wired into page-analysis handler)

## Phase 7 — Journeys

- [x] Journey schema + step types (NAVIGATE/CLICK/TYPE/SELECT/CHECK/UNCHECK/UPLOAD_TEST_FILE/WAIT_*/ASSERT_*/SCREENSHOT/CUSTOM_SAFE_SCRIPT) — `src/lib/journey-types.ts` (Zod discriminated union with 17 step types, selector charset whitelist + 200-char cap, secret-ref `{{secret.NAME}}` regex, URL validation (http(s) or relative), safe-script ID whitelist, parseSteps/serializeSteps/safeParseSteps helpers)
- [x] Visual journey editor (add/reorder/locator/test-data/assertions/secret-mark/versions/rollback) — backend foundation in `src/lib/journey-service.ts` (createJourney, getJourney, updateJourney with new version, listJourneyVersions, getJourneyVersion, rollbackJourney, deleteJourney soft-delete, validateJourney dry-run); API routes for full CRUD + versions + rollback + validate; UI editor itself is Phase 10
- [x] Runner (isolated browser context) — `mini-services/worker/src/journey-runner.ts` (launches hardened browser via launchBrowser + createContext, executes each step against an isolated page, captures before/after screenshots on failure, records JourneyStepResult with duration/console/network error counts, aborts on first failure unless continueOnError, emit journey.started/step.passed/step.failed/step.skipped/completed/failed scan events)
- [x] Safe action policy (PASSIVE/SAFE_INTERACTION/TEST_TRANSACTION/CUSTOM_APPROVED) with dangerous-action blocklist (multilingual) — `src/lib/journey-policy.ts` (DESTRUCTIVE_PATTERNS covering EN/FR/DE/ES/NL/FA; DESTRUCTIVE_TEXT_PATTERNS for element text; validateStepsAgainstPolicy design-time check + isDestructiveSelector/Url/Text runtime check; STEP_PERMISSIONS table per run mode; minimumModeForStep helper)
- [x] Secret references `{{secret.NAME}}` resolved only inside worker — `src/lib/project-secrets.ts` (ProjectSecret model with AES-256-GCM encryption, setSecret/listSecrets/deleteSecret API surface never returns decrypted values, resolveSecret + resolveSecretsForSteps worker-only functions decrypt on demand, extractSecretKeys helper for batch resolution, audit logs record only the key name not the value)
- [x] Journey results + step outcomes — `src/lib/journey-run-service.ts` + JourneyRun + JourneyStepResult models (createJourneyRun enqueues journey-execution job, listJourneyRuns cursor pagination, getJourneyRun with full step results, cancelJourneyRun idempotent; JourneyStepResult records stepIndex/stepType/status/durationMs/error/before+afterScreenshotIds/consoleErrors/networkErrors/metadataJson)
- [ ] AI-proposed journeys (validated JSON, never raw code, user approval required) — Phase 8

## Phase 8 — AI

- [x] Provider abstraction (Z.ai GLM adapter, OpenAI-compatible adapter, Mock for tests) — `src/lib/ai/` (AiProvider interface with complete/completeStructured; GlmAiProvider via z-ai-web-dev-sdk with env→.z-ai-config bridge; OpenAiCompatibleProvider via fetch to AI_BASE_URL; MockAiProvider deterministic/offline; registry with fallback-to-mock when configured provider not ready; AiError taxonomy; cost-per-1K-token table + estimateCostUsd)
- [x] Versioned prompts + Zod-validated structured output — `src/lib/ai/prompts.ts` (8 versioned PromptDefinitions keyed `${taskType}@${version}`, getPrompt/getPromptVersion/promptVersionOf/listPrompts; co-located Zod schemas FindingExplanationSchema/RunSummarySchema/BusinessImpactSchema/RemediationSchema/JourneyProposalSchema/ClientReportSchema/SemanticGroupingSchema; shared SAFETY_PREAMBLE in every system message declaring the <<<UNTRUSTED_*>>> fence convention) + `src/lib/ai/prompt-safety.ts` (delimitUntrusted with randomized unforgeable fence, truncateForPrompt with marker, prepareUntrusted, redactPii for email/phone/cc/ssn/jwt/AWS/GitHub/Stripe/Google/Slack keys with per-rule counts, assertNoSecretRefs/containsSecretRef/assertMessageSafe guard) + `src/lib/ai/run-task.ts` (runStructuredTask/runTextTask/runTask wrapper: loads versioned prompt → asserts user message safe → provider.completeStructured/complete → records LlmUsageRow best-effort → returns validated data + promptVersion + repaired flag)
- [x] Finding explanations — `src/lib/ai/finding-explanations.ts` (generateFindingExplanation: loads finding + project context, feature-flag guard, idempotent unless force=true, builds safe user message with prepareUntrusted + redactPii on all page-derived content, calls runStructuredTask<FindingExplanation>, persists aiExplanation as JSON {explanation,userImpact,rootCause} + aiSummary as plain text, records audit FINDING_AI_EXPLANATION + LlmUsageRecord; enqueueFindingExplanation: deduped ai-enrichment queue job via correlationId) + `mini-services/worker/src/ai-enrichment.ts` (handleAiEnrichment: dispatches on payload.task, calls generateFindingExplanation for finding_explanation, emits finding.explained scan event) + worker finding-writer.ts auto-enqueues on first occurrence (when !aiExplanation) + `POST /api/v1/findings/[findingId]/explanation` (findings.update permission, force flag, synchronous) + finding.explained ScanEventType added. 60/60 standalone tests pass.
- [x] Run summaries — `src/lib/ai/run-summaries.ts` (generateRunSummary: loads run + aggregates findings by category/severity — trusted scanner metadata unfenced; page-derived finding titles fenced via prepareUntrusted + redactPii; runs runStructuredTask<RunSummary>; persists ScanRun.aiSummaryJson + ScanRun.aiSummary; readiness guard rejects QUEUED/RUNNING; idempotent unless force; audit RUN_AI_SUMMARY; enqueueRunSummary via ai-enrichment queue with correlationId dedup) + `POST /api/v1/runs/[runId]/summary` (GET cached summary / POST generate with force flag, permission runs.read) + worker ai-enrichment handler dispatches run_summary → emit run.summarized scan event + page-analysis.ts auto-enqueues when all pages analyzed (after run.scored) + Prisma: ScanRun.aiSummary + ScanRun.aiSummaryJson columns + scan-events.ts: run.summarized ScanEventType added + AI barrel exports updated. 68/68 standalone tests pass.
- [x] Business-impact categorization — `src/lib/ai/business-impacts.ts` (generateBusinessImpacts: loads finding + project context; feature-flag guard; idempotent unless force=true; buildUserMessage applies redactPii + prepareUntrusted to all page-derived content — trusted scanner metadata unfenced; calls runStructuredTask<BusinessImpactResult>; validates impacts against canonical BUSINESS_IMPACTS list; persists Finding.businessImpact as comma-separated; records audit FINDING_AI_BUSINESS_IMPACT with promptVersion + provider + model + impacts + confidence + tokens; enqueueBusinessImpacts via ai-enrichment queue with correlationId dedup) + `POST /api/v1/findings/[findingId]/business-impacts` (force flag, permission findings.update) + worker ai-enrichment handler dispatches business_impact → emit finding.categorized scan event + finding-writer.ts auto-enqueues on first occurrence (when !businessImpact) + scan-events.ts: finding.categorized ScanEventType added + AI barrel exports updated. 54/54 standalone tests pass.
- [x] Remediation suggestions — `src/lib/ai/remediation-suggestions.ts` (generateRemediationSuggestion: loads finding + project context; feature-flag guard; idempotent unless force=true; buildUserMessage applies redactPii + prepareUntrusted to all page-derived content — trusted scanner metadata unfenced; includes existing deterministic remediation as additional context; calls runStructuredTask<Remediation>; persists Finding.aiRemediation as JSON {summary, steps[], estimatedEffort}; records audit FINDING_AI_REMEDIATION with promptVersion + provider + model + stepCount + estimatedEffort + tokens; enqueueRemediationSuggestion via ai-enrichment queue with correlationId dedup) + `POST /api/v1/findings/[findingId]/remediation` (force flag, permission findings.update) + worker ai-enrichment handler dispatches remediation → emit finding.remediated scan event + finding-writer.ts auto-enqueues on first occurrence (when !aiRemediation) + scan-events.ts: finding.remediated ScanEventType added + AI barrel exports updated + Prisma: Finding.aiRemediation column added. 0 lint errors from new code.
- [ ] Journey proposals
- [ ] Client-friendly report language
- [ ] Semantic finding grouping
- [x] Prompt-injection controls (delimit untrusted, no system-instruction injection, no secrets to model, content size cap, PII redaction, no tool selection by page, no code execution, log prompt version only) — `src/lib/ai/prompt-safety.ts` (delimitUntrusted with randomized unforgeable fence, truncateForPrompt + prepareUntrusted with 50k-char cap, redactPii across 10 secret/PII pattern types with per-rule counts, assertNoSecretRefs/containsSecretRef/assertMessageSafe guard; every system message in prompts.ts declares the <<<UNTRUSTED_*>>> fence convention; run-task.ts asserts message safety before every provider call; finding-explanations.ts applies prepareUntrusted + redactPii to all page-derived content before building the user message)
- [ ] Cost controls (per-plan/per-run/daily limits, circuit breaker, retry budget, timeout)

## Phase 9 — Reports

- [ ] Technical report (metadata, env, profile, pages, journeys, browsers, viewports, locales, findings by severity, evidence, perf summary, a11y summary, runtime errors, blocked checks, limitations)
- [ ] Client report (branding, customer, project, exec summary, quality score, tests completed, critical/resolved/remaining, delivery readiness, approval area, limitations)
- [ ] White-label (logo, name, accent color, contact, intro, footer, custom-domain-ready)
- [ ] Secure sharing (high-entropy token hashed, optional password/expiration/email restriction, revoke, view audit, noindex, no workspace nav, signed artifact access)
- [ ] PDF export (headers/footers, page numbers, screenshots, severity labels, branding, page breaks, EN + FA, RTL)
- [ ] Approval workflow

## Phase 10 — Product UI

- [ ] Public pages: `/`, `/features`, `/agencies`, `/ai-builders`, `/accessibility-testing`, `/rtl-testing`, `/pricing`, `/security`, `/docs`, `/changelog`, `/contact`, `/terms`, `/privacy`, `/login`, `/register`, `/verify-email`, `/forgot-password`, `/reset-password`
- [ ] Authenticated pages: `/app`, onboarding, workspaces, projects, runs, findings, journeys, personas, baselines, reports, settings, team, integrations, billing, usage, notifications, security, sessions, audit-log
- [ ] Admin pages: `/admin`, users, workspaces, runs, jobs, subscriptions, security-events, system-health, feature-flags
- [ ] Design system (light/dark, responsive nav, keyboard nav, focus states, skeletons, empty/error states, confirm dialogs, toasts, accessible forms, status badges, data tables, filters, pagination, saved views)
- [ ] Main dashboard (score, trend, blockers, criticals, last/next run, attention projects, recent activity, usage, quick scan)
- [ ] Project dashboard (score, category cards, trend, latest run, blockers, findings by severity/category, browser/viewport/locale coverage, journey success rate, delivery readiness, recent reports)
- [ ] Run details (stage timeline, live progress, pages processed, current URL, findings discovered, journey progress, safe logs, cancel/retry, config snapshot, artifacts)
- [ ] Findings table (search, severity/status/category/locale/viewport/browser/assignee/first-seen filters, bulk actions, CSV export)
- [ ] Persian/RTL UI (full translations, `dir=rtl`, logical CSS properties, number/date formatting)

## Phase 11 — Integrations & Operations

- [ ] Stripe (checkout, portal, subscription CRUD, trial, failed payment, grace period, status sync, webhook signature verify, raw body, event ID, idempotent)
- [ ] Deployment hooks (signed, rate-limited, idempotent, replay-protected, audited)
- [ ] Slack notifications
- [ ] Outgoing webhooks (HMAC-SHA256, timestamp, delivery ID, exponential backoff, SSRF-protected destination, HTTPS-only, manual retry, auto-disable)
- [ ] Scheduling (manual/daily/weekly/cron/deployment-triggered, plan enforcement, distributed-lock dedup, skip logging)
- [ ] Notifications (in-app, email, webhook; per-user preferences; EN+FA templates; safe subjects)
- [ ] Retention cleanup (artifacts, sessions, invitations, exports)
- [ ] Scheduler mini-service or in-process cron

## Phase 12 — Validation

- [ ] Unit tests (permissions, URL normalization, IP rejection, redirect validation, fingerprint, severity, score, quota, token hashing, secret encryption, report token, Stripe idempotency, journey policy, AI output validation)
- [ ] API integration tests (registration, email verify, login, session rotation, password reset, MFA, workspace, invitation, project, domain verify, run create, finding access, report sharing, billing webhook, API key auth, tenant isolation)
- [ ] E2E (Playwright): register → workspace → project → verify local demo → scan → progress → finding → resolve → rescan → reports → share → PDF → invite → role → MFA → billing
- [ ] Scanner test against `apps/demo-target` (detects intentional issues)
- [ ] Security tests (IDOR, cross-workspace, CSRF, SSRF IPv4/IPv6/encoded, redirect-to-private, DNS rebinding sim, malicious webhook URL, brute-force rate limit, session fixation/revocation, invalid Stripe sig, duplicate Stripe event, prompt injection, malicious artifact ID, path traversal, oversized body)
- [ ] Accessibility tests on ProofPilot's own pages
- [ ] CI/CD (GitHub Actions: install, format, lint, typecheck, unit, integration, build, migration validate, dep audit, secret scan, container scan; main branch: full suite, build images, SBOM, sign, push, staging migrate, deploy, smoke)
- [ ] Docker hardening (multi-stage, non-root, health checks, pinned, no dev deps in runtime, signal handling, graceful shutdown, read-only FS)
- [ ] Production documentation (README, docs/*)
- [ ] Final clean build (`bun run lint`, `bun run typecheck`-equivalent, `bun test`, `bun run build` if possible)

## Continuous

- [ ] No unresolved imports
- [ ] No TS errors
- [ ] No ESLint errors
- [ ] No failing migrations
- [ ] No failing tests
- [ ] No exposed credentials
- [ ] No placeholder secret keys
- [ ] No hard-coded production URLs
- [ ] No `eval`
- [ ] No `any` without justification
- [ ] No `@ts-ignore` without justification
- [ ] No auth token in localStorage
- [ ] No direct SQL string concatenation
- [ ] No unvalidated AI output controlling execution
- [ ] No unrestricted arbitrary URL fetching
