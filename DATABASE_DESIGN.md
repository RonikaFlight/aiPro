# DATABASE_DESIGN — ProofPilot

## 1. Provider

- **Sandbox**: SQLite via Prisma (`DATABASE_URL=file:./db/custom.db`). Single file, no external services.
- **Production**: PostgreSQL 17+ (schema is portable; switch `DATABASE_PROVIDER=postgresql` and update `DATABASE_URL`).

## 2. Conventions

- Primary keys: `String @id @default(cuid())` (cuid for collision-resistant, sortable IDs).
- Timestamps: `DateTime @default(now())` for `createdAt`, `@updatedAt` for `updatedAt`. All UTC.
- Constraints: unique indexes on natural keys (`email`, `tokenHash`, `fingerprint`); FKs with `onDelete: Cascade` or `Restrict` as appropriate.
- Indexes on every `workspaceId`, `projectId`, `runId`, `findingId`, `status`, `createdAt`, `email`, `tokenHash`, `fingerprint`.
- Soft deletion: only where business recovery requires it (audit logs never deleted; findings can be hard-deleted on workspace deletion). Otherwise hard delete.

## 3. Tenant isolation

Every workspace-owned entity has `workspaceId`. SQLite has no native RLS, so isolation is enforced via:

1. **Mandatory `workspaceId` parameter** on every service method (`src/lib/db.ts` exposes `workspaceScoped`).
2. **Workspace guard** that resolves workspace from route context (never from request body).
3. **Prisma `where` clause** always includes `workspaceId`.
4. **Automated tenant-isolation tests** (Phase 12).

### PostgreSQL RLS plan (production)

When migrating to PostgreSQL:

```sql
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON projects
  USING (workspace_id = current_setting('app.current_workspace', true)::text);
```

Each request runs inside a transaction that sets `SET LOCAL app.current_workspace = '<uuid>'` before any tenant query. For queries the ORM cannot safely support, use parameterized `pg` queries (never string concatenation).

## 4. Tables (from spec §8.1)

All implemented as Prisma models in `prisma/schema.prisma`.

**Identity & auth**: `users`, `oauth_identities`, `sessions`, `mfa_factors`, `mfa_recovery_codes`, `email_verification_tokens`, `password_reset_tokens`.

**Tenancy**: `workspaces`, `workspace_members`, `workspace_invitations`.

**Projects & environments**: `projects`, `project_environments`, `verified_domains`, `domain_verification_challenges`, `scan_profiles`, `scan_schedules`, `personas`.

**Journeys**: `journeys`, `journey_steps`, `journey_versions`.

**Runs & pages**: `scan_runs`, `scan_run_events`, `scan_pages`, `scan_page_metrics`, `network_requests`, `browser_console_events`.

**Findings**: `findings`, `finding_occurrences`, `finding_comments`, `finding_status_history`, `finding_suppressions`.

**Artifacts & visual**: `artifacts`, `visual_baselines`, `visual_comparisons`.

**Reports**: `reports`, `report_sections`, `report_shares`, `report_approvals`.

**Integrations**: `integrations`, `integration_secrets`, `deployment_hooks`, `outgoing_webhooks`, `outgoing_webhook_deliveries`, `incoming_webhook_events`.

**Billing & usage**: `plans`, `subscriptions`, `subscription_events`, `usage_ledger`, `usage_periods`.

**Notifications**: `notifications`, `notification_preferences`.

**Platform**: `api_keys`, `audit_logs`, `security_events`, `llm_usage_records`, `data_export_requests`, `data_deletion_requests`.

**Queues (sandbox-only)**: `queue_jobs` (replaces BullMQ's Redis storage).

## 5. Enums (spec §8.2)

| Enum | Values |
|---|---|
| `UserStatus` | `PENDING_VERIFICATION`, `ACTIVE`, `SUSPENDED`, `DELETED` |
| `PlatformRole` | `USER`, `SUPPORT`, `PLATFORM_ADMIN` |
| `WorkspaceRole` | `OWNER`, `ADMIN`, `MEMBER`, `VIEWER`, `CLIENT` |
| `ProjectStatus` | `ACTIVE`, `ARCHIVED`, `DELETED` |
| `EnvironmentType` | `PRODUCTION`, `STAGING`, `PREVIEW`, `DEVELOPMENT` |
| `VerificationMethod` | `DNS_TXT`, `HTML_FILE`, `HTML_META` |
| `VerificationStatus` | `PENDING`, `VERIFIED`, `FAILED`, `EXPIRED` |
| `RunStatus` | `QUEUED`, `VALIDATING_TARGET`, `STARTING_WORKER`, `CRAWLING`, `ANALYZING`, `RUNNING_JOURNEYS`, `PROCESSING_ARTIFACTS`, `AI_ENRICHMENT`, `GENERATING_REPORT`, `COMPLETED`, `COMPLETED_WITH_WARNINGS`, `FAILED`, `CANCELLED`, `TIMED_OUT` |
| `RunTrigger` | `MANUAL`, `SCHEDULED`, `DEPLOYMENT_HOOK`, `API`, `RETRY` |
| `RunMode` | `PASSIVE`, `SAFE_INTERACTION`, `TEST_TRANSACTION`, `CUSTOM_APPROVED` |
| `FindingSeverity` | `BLOCKER`, `CRITICAL`, `MAJOR`, `MINOR`, `INFO` |
| `FindingStatus` | `OPEN`, `ACKNOWLEDGED`, `IN_PROGRESS`, `RESOLVED`, `REOPENED`, `IGNORED`, `ACCEPTED_RISK`, `FALSE_POSITIVE` |
| `FindingCategory` | `HTTP_NAVIGATION`, `RUNTIME`, `RESPONSIVE`, `ACCESSIBILITY`, `FORMS`, `PERFORMANCE`, `PASSIVE_SECURITY`, `SEO_METADATA`, `LOCALIZATION`, `RTL`, `JOURNEY` |
| `FindingConfidence` | `HIGH`, `MEDIUM`, `LOW` |
| `ArtifactType` | `SCREENSHOT`, `FULL_PAGE_SCREENSHOT`, `VIDEO`, `TRACE`, `DIFF_IMAGE`, `PDF_REPORT`, `EXPORT_ARCHIVE` |
| `JourneyStatus` | `DRAFT`, `ACTIVE`, `ARCHIVED` |
| `JourneyStepType` | `NAVIGATE`, `CLICK`, `TYPE`, `SELECT`, `CHECK`, `UNCHECK`, `UPLOAD_TEST_FILE`, `WAIT_FOR_ELEMENT`, `WAIT_FOR_URL`, `ASSERT_VISIBLE`, `ASSERT_HIDDEN`, `ASSERT_TEXT`, `ASSERT_URL`, `ASSERT_STATUS`, `SCREENSHOT`, `CUSTOM_SAFE_SCRIPT` |
| `ReportStatus` | `DRAFT`, `READY`, `PUBLISHED`, `ARCHIVED` |
| `SubscriptionStatus` | `TRIALING`, `ACTIVE`, `PAST_DUE`, `CANCELED`, `UNPAID`, `INCOMPLETE` |
| `NotificationType` | `RUN_COMPLETED`, `RUN_FAILED`, `BLOCKER_FOUND`, `FINDING_REOPENED`, `SCHEDULED_RUN_SKIPPED`, `DOMAIN_VERIFICATION_EXPIRING`, `SUBSCRIPTION_PAYMENT_FAILED`, `WORKSPACE_INVITATION`, `REPORT_APPROVED`, `USAGE_LIMIT_NEAR`, `USAGE_LIMIT_REACHED` |
| `IntegrationType` | `SLACK`, `GITHUB`, `GITLAB`, `VERCEL`, `NETLIFY`, `GENERIC_WEBHOOK` |
| `AuditAction` | `LOGIN`, `LOGIN_FAILED`, `LOGOUT`, `PASSWORD_CHANGE`, `MFA_ENABLE`, `MFA_DISABLE`, `SESSION_REVOKE`, `WORKSPACE_CREATE`, `MEMBER_INVITE`, `ROLE_CHANGE`, `MEMBER_REMOVE`, `DOMAIN_VERIFY`, `SECRET_CREATE`, `SECRET_ACCESS`, `SECRET_DELETE`, `SCAN_CREATE`, `SCAN_CANCEL`, `FINDING_STATUS_CHANGE`, `REPORT_PUBLISH`, `REPORT_SHARE_CREATE`, `BILLING_CHANGE`, `API_KEY_CREATE`, `API_KEY_REVOKE`, `INTEGRATION_CHANGE`, `DATA_EXPORT`, `DATA_DELETION` |
| `SecurityEventType` | `RATE_LIMIT_EXCEEDED`, `CSRF_REJECTED`, `INVALID_OAUTH_STATE`, `SSRF_BLOCKED`, `REDIRECT_BLOCKED`, `STRIPE_SIGNATURE_INVALID`, `STRIPE_EVENT_DUPLICATE`, `PROMPT_INJECTION_DETECTED`, `ARTIFACT_ACCESS_DENIED`, `PATH_TRAVERSAL_ATTEMPT`, `OVERSIZED_REQUEST_BODY` |

## 6. Run status state machine (spec §8.3)

```
QUEUED
  └─> VALIDATING_TARGET
        └─> STARTING_WORKER
              └─> CRAWLING
                    └─> ANALYZING
                          └─> RUNNING_JOURNEYS
                                └─> PROCESSING_ARTIFACTS
                                      └─> AI_ENRICHMENT
                                            └─> GENERATING_REPORT
                                                  └─> COMPLETED | COMPLETED_WITH_WARNINGS
```

Any state can transition to `FAILED`, `CANCELLED`, or `TIMED_OUT`. The `transitionRunStatus` helper in `src/modules/scans/run-state-machine.ts` enforces allowed transitions and rejects invalid ones.

## 7. Finding lifecycle (spec §8.4)

```
OPEN ──> ACKNOWLEDGED ──> IN_PROGRESS ──> RESOLVED
  │                                          │
  ├──> IGNORED                               │
  ├──> ACCEPTED_RISK                         │
  ├──> FALSE_POSITIVE                        │
  │                                          ▼
  └──────────────────────────────────────> REOPENED
```

**Auto-reopen rule**: when a finding with status `RESOLVED` has its fingerprint re-detected in a subsequent run, status transitions automatically to `REOPENED` and a `finding_status_history` entry is created with `reason: 'auto_reopen'`.

## 8. Finding fingerprint (spec §8.5)

```
fingerprint = sha256(
  projectId,
  checkId,
  normalizedUrl,
  normalizedSelector,
  viewport,
  locale,
  stableMessageKey
)
```

- `normalizedUrl`: strip fragment, sort query params, drop ignored query params, lowercase host, remove default ports.
- `normalizedSelector`: stable CSS selector or `role:Name` locator.
- `viewport`: `${width}x${height}`.
- `locale`: BCP-47 lowercased.
- `stableMessageKey`: rule ID + key params (not volatile text).

Volatile text (e.g. exact timing values) is excluded to prevent duplicate findings on every run.

## 9. Index strategy

Every workspace-owned table has:

```prisma
@@index([workspaceId])
@@index([workspaceId, createdAt])
@@index([workspaceId, status])
```

Run-scoped tables add `@@index([runId])`. Finding tables add `@@index([fingerprint])`, `@@index([findingId])`. Auth tables add `@@index([tokenHash])`, `@@unique([email])`.
