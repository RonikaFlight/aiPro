# API_DESIGN — ProofPilot

## 1. Base path & versioning

All REST endpoints live under `/api/v1`. The version is part of the URL so future breaking changes can introduce `/api/v2` without breaking clients.

## 2. Standard error format — RFC 7807 Problem Details

Every error response uses `Content-Type: application/problem+json`:

```json
{
  "type": "https://proofpilot.app/problems/validation-error",
  "title": "Validation failed",
  "status": 422,
  "detail": "One or more fields are invalid.",
  "instance": "/api/v1/projects",
  "requestId": "req_01HN4...",
  "errors": {
    "name": ["Name is required."]
  }
}
```

| HTTP status | When |
|---|---|
| 400 | Malformed request body or query |
| 401 | No session / invalid session |
| 403 | Authenticated but not authorized |
| 404 | Resource not found (or hidden via tenant isolation) |
| 409 | Conflict (e.g. duplicate email) |
| 422 | Validation failure |
| 429 | Rate limited |
| 500 | Internal error (sanitized) |

## 3. Standard headers

| Header | Purpose |
|---|---|
| `X-Request-Id` | Returned on every response. Client may send; otherwise generated. |
| `X-Frame-Options: DENY` | Prevent clickjacking. |
| `Content-Security-Policy` | Strict, nonce-based. |
| `X-CSRF-Token` | Required on all state-changing browser requests. |
| `Idempotency-Key` | Optional on POST/PUT for safe retries. |
| `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`, `Retry-After` | Rate limit info. |

## 4. Authentication

Two mechanisms:

1. **Session cookie** — `__Host-proofpilot_session` (HttpOnly, Secure in prod, Path=/, SameSite=Lax, no Domain). Set after login/MFA. Used by the dashboard UI.
2. **API key** — `Authorization: Bearer pp_live_<public-id>_<secret>`. Used by integrations, deployment hooks, CLI.

API keys have scopes and rate limits; the dashboard cookie does not.

## 5. Pagination

```
GET /api/v1/projects/:projectId/findings?page=1&pageSize=20&sort=-createdAt&severity=CRITICAL,MAJOR
```

Response:

```json
{
  "items": [ /* ... */ ],
  "total": 137,
  "page": 1,
  "pageSize": 20
}
```

- `page` ≥ 1, default 1.
- `pageSize` 1–100, default 20.
- `sort` is an allowlisted comma list; `-` prefix = descending.

## 6. Idempotency

`Idempotency-Key` header (any UUID-like string) supported on:

- `POST /api/v1/projects/:projectId/runs`
- `POST /api/v1/billing/checkout`
- `POST /api/v1/projects/:projectId/reports`
- `POST /api/v1/deployment-hooks/:publicId`

Server stores `(key, requestFingerprint, response)` for 24h. Reuse with a different body returns `409 Conflict`.

## 7. Rate limits

Redis-backed in production; in-memory + DB in sandbox. Per-endpoint policies:

| Policy | Limit | Window |
|---|---|---|
| Login | 10 | 60s per IP+email |
| Register | 5 | 300s per IP |
| Password reset | 5 | 300s per IP+email |
| Email verification | 5 | 300s per IP+email |
| MFA challenge | 10 | 60s per session |
| Public scan | 3 | 3600s per IP |
| Authenticated scan creation | 30 | 60s per workspace |
| Report sharing | 20 | 60s per workspace |
| API key use | 60 | 60s per key |
| Stripe webhooks | unlimited (signature-gated) | — |
| General API | 300 | 60s per IP |

Progressive delay applied to repeated auth failures; no permanent lock (attacker-controlled).

## 8. Route groups

```
/auth
/users
/sessions
/mfa
/workspaces
/workspace-invitations
/projects
/environments
/domains
/scan-profiles
/personas
/journeys
/runs
/findings
/artifacts
/baselines
/reports
/report-shares
/integrations
/deployment-hooks
/webhooks
/billing
/subscriptions
/usage
/notifications
/api-keys
/audit-logs
/admin
```

## 9. Example endpoints

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/v1/auth/register` | Email + password registration |
| POST | `/api/v1/auth/login` | Login (starts session, may require MFA challenge) |
| POST | `/api/v1/auth/logout` | Revoke current session |
| POST | `/api/v1/auth/verify-email` | Submit email verification token |
| POST | `/api/v1/auth/forgot-password` | Request password reset (no email leak) |
| POST | `/api/v1/auth/reset-password` | Submit new password with reset token |
| GET | `/api/v1/sessions` | List active sessions |
| DELETE | `/api/v1/sessions/:sessionId` | Revoke one session |
| POST | `/api/v1/sessions/revoke-others` | Revoke all other sessions |
| POST | `/api/v1/mfa/totp/setup` | Begin TOTP setup, returns QR + secret (encrypted) |
| POST | `/api/v1/mfa/totp/confirm` | Confirm TOTP with code, enable MFA, return recovery codes |
| POST | `/api/v1/mfa/challenge` | Submit TOTP / recovery code during login |
| DELETE | `/api/v1/mfa/totp` | Disable MFA (requires password + current code) |
| POST | `/api/v1/workspaces` | Create workspace |
| GET | `/api/v1/workspaces` | List workspaces for current user |
| GET | `/api/v1/workspaces/:workspaceId` | Get workspace |
| PATCH | `/api/v1/workspaces/:workspaceId` | Update workspace |
| POST | `/api/v1/workspaces/:workspaceId/invitations` | Invite member |
| POST | `/api/v1/invitations/:token/accept` | Accept invitation |
| POST | `/api/v1/workspaces/:workspaceId/projects` | Create project |
| GET | `/api/v1/workspaces/:workspaceId/projects` | List projects |
| GET | `/api/v1/projects/:projectId` | Get project |
| PATCH | `/api/v1/projects/:projectId` | Update project |
| DELETE | `/api/v1/projects/:projectId` | Delete project |
| POST | `/api/v1/projects/:projectId/environments` | Add environment |
| POST | `/api/v1/environments/:environmentId/domain-verification` | Start domain verification |
| POST | `/api/v1/domain-verifications/:verificationId/check` | Check verification status |
| POST | `/api/v1/projects/:projectId/runs` | Create scan run |
| GET | `/api/v1/projects/:projectId/runs` | List runs |
| GET | `/api/v1/runs/:runId` | Get run |
| POST | `/api/v1/runs/:runId/cancel` | Cancel run |
| GET | `/api/v1/runs/:runId/events` | SSE stream of run events |
| GET | `/api/v1/projects/:projectId/findings` | List findings (filters) |
| GET | `/api/v1/findings/:findingId` | Get finding |
| PATCH | `/api/v1/findings/:findingId` | Update finding (assign, status, tags) |
| POST | `/api/v1/findings/:findingId/comments` | Add comment |
| POST | `/api/v1/findings/:findingId/resolve` | Mark resolved |
| POST | `/api/v1/findings/:findingId/ignore` | Mark ignored |
| POST | `/api/v1/projects/:projectId/journeys` | Create journey |
| GET | `/api/v1/projects/:projectId/journeys` | List journeys |
| PATCH | `/api/v1/journeys/:journeyId` | Update journey (creates new version) |
| POST | `/api/v1/journeys/:journeyId/test` | Test journey |
| POST | `/api/v1/projects/:projectId/reports` | Create report |
| GET | `/api/v1/reports/:reportId` | Get report |
| POST | `/api/v1/reports/:reportId/publish` | Publish report |
| POST | `/api/v1/reports/:reportId/share` | Create share link |
| DELETE | `/api/v1/report-shares/:shareId` | Revoke share |
| GET | `/api/v1/billing/plans` | List plans |
| POST | `/api/v1/billing/checkout` | Create Stripe checkout session |
| POST | `/api/v1/billing/customer-portal` | Create portal session |
| POST | `/api/v1/webhooks/stripe` | Incoming Stripe webhook (signature-gated) |
| POST | `/api/v1/deployment-hooks/:publicId` | Trigger deployment hook (signed) |
| GET | `/api/v1/workspaces/:workspaceId/audit-logs` | List audit logs |

## 10. SSE — `/api/v1/runs/:runId/events`

- Authenticated via session cookie (or API key with `runs:read` scope).
- Workspace authorization checked before streaming.
- Heartbeat comment `: ping` every 15s.
- Reconnect with `Last-Event-ID` header; server replays missed events.
- Event types: `run.queued`, `run.validating`, `run.worker_started`, `run.page_discovered`, `run.page_analyzed`, `run.journey_started`, `run.journey_step`, `run.finding_created`, `run.artifact_uploaded`, `run.report_generating`, `run.completed`, `run.failed`, `run.cancelled`.

## 11. Webhooks

### Incoming Stripe

`POST /api/v1/webhooks/stripe`
- Verify signature with raw body.
- Store event ID; idempotent processing.
- Exempt from CSRF (signature-gated).

### Deployment hooks

`POST /api/v1/deployment-hooks/:publicId`
- Verify HMAC signature or bearer token.
- Rate-limited.
- Idempotent (key = hook id + delivery ID header).
- Replay-protected (timestamp window).
- Creates a new scan run.

## 12. Validation strategy

- **Params**: Zod schema per route (UUID/cuid format, etc.).
- **Query**: allowlisted sort/filter fields; pagination bounded.
- **Body**: Zod schema; reject unknown fields with `.strict()` where appropriate.
- **Headers**: CSRF token on state-changing browser requests; Origin/Referer check.
- **Uploads**: content-type allowlist, max size from env, magic-byte verification where applicable.
- **Body size**: 1 MB default for JSON; higher for uploads via dedicated routes.

## 13. OpenAPI

OpenAPI document generated from the route definitions and exposed at `/api/v1/openapi.json` (and a Swagger UI at `/docs/api` in non-production). In production, exposure is gated by `FEATURE_PUBLIC_API_DOCS` flag (default off).
