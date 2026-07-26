# Security Model — ProofPilot

> This document describes the security controls, policies, and mechanisms
> implemented (or planned) in ProofPilot. It serves as the authoritative
> reference for security review and implementation verification.

---

## Table of Contents

1. [Authentication](#1-authentication)
2. [Sessions](#2-sessions)
3. [Multi-Factor Authentication (MFA)](#3-multi-factor-authentication-mfa)
4. [CSRF Protection](#4-csrf-protection)
5. [Multi-Tenancy Isolation](#5-multi-tenancy-isolation)
6. [SSRF Prevention](#6-ssrf-prevention)
7. [Browser Sandbox](#7-browser-sandbox)
8. [Secrets Vault](#8-secrets-vault)
9. [API Security](#9-api-security)
10. [API Keys](#10-api-keys)
11. [Artifact Storage](#11-artifact-storage)
12. [Audit Logging](#12-audit-logging)
13. [Observability](#13-observability)
14. [Security Headers](#14-security-headers)
15. [Production Safety](#15-production-safety)

---

## 1. Authentication

### Password Hashing

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| Algorithm | Argon2id | Resistant to GPU/ASIC attacks; winner of PHC |
| Memory cost (m) | ≥ 64 MiB | Forces significant memory per hash attempt |
| Time cost (t) | ≥ 3 iterations | Balances security and latency |
| Parallelism (p) | ≥ 1 | No benefit to parallelism against single-hash target |
| Salt | 16 bytes, cryptographically random, unique per hash | Prevents rainbow table and cross-user attacks |
| Output length | 32 bytes (256 bits) | Sufficient for password verification |

### Password Policy

| Rule | Value |
|------|-------|
| Minimum length | 12 characters |
| Maximum length | 128 characters (prevents DoS from extreme-length hashes) |
| Periodic forced changes | **Not required** — NIST SP 800-63B §5.1.1.2 discourages forced rotation |
| Composition rules | No mandatory character classes (NIST guidance: length over complexity) |
| Breach check | Passwords checked against known breached password lists at creation |

### Credential Handling

- **No logging:** Passwords, password hashes, and verification tokens are never written to logs.
- **Constant-time comparison:** All secret comparisons (passwords, tokens, nonces) use `crypto.timingSafeEqual` to prevent timing attacks.
- **No credential in URL:** Password reset tokens are delivered via email only, never in URL query parameters.
- **Error messages:** Login failures return generic "invalid credentials" — no differentiation between "user not found" and "wrong password."

---

## 2. Sessions

### Token Format

- **Opaque 256-bit tokens** generated with `crypto.randomBytes(32)`.
- The raw token is **never stored**. Only the SHA-256 hash is persisted.
- Tokens are URL-safe base64url-encoded for cookie transport.

### Cookie Configuration

```
Set-Cookie: __Host-proofpilot_session=<token>;
  HttpOnly;
  Secure;            (production only)
  Path=/;
  SameSite=Lax;
  (no Domain attribute)
```

| Attribute | Value | Rationale |
|-----------|-------|-----------|
| Name | `__Host-proofpilot_session` | `__Host-` prefix requires `Path=/`, no `Domain`, and `Secure` — browser-enforced |
| HttpOnly | Yes | Prevents JavaScript access (`document.cookie`) |
| Secure | Yes (prod) / No (dev) | Prevents transmission over HTTP |
| Path | `/` | Available to all app paths |
| SameSite | `Lax` | Prevents CSRF from cross-site POST while allowing top-level navigations |
| Domain | Not set | Prevents subdomain cookie leakage |

### Session Lifecycle

| Event | Action |
|-------|--------|
| Login | New session created, token returned in cookie |
| MFA completion | Session rotated (old token invalidated, new token issued) |
| Password change | All sessions for user revoked and re-issued |
| Role elevation | Current session rotated |
| Sensitive security change (email, MFA disable) | Current session rotated |
| Logout | Specific session revoked (token hash deleted) |
| "Revoke other sessions" | All sessions except current are deleted |
| Idle timeout | Rolling expiration; activity resets the clock |
| Absolute lifetime cap | Maximum session age enforced regardless of activity |

### Session Storage

- Hash-only: Only `SHA-256(token)` is stored in the database.
- Fields: `id`, `userId`, `tokenHash`, `ipHash`, `userAgentSummary`, `createdAt`, `lastActiveAt`, `expiresAt`, `revokedAt`.
- Lookup: Hash the incoming cookie value, query by `tokenHash`.

---

## 3. Multi-Factor Authentication (MFA)

### TOTP (RFC 6238)

- **Algorithm:** HMAC-SHA1 (RFC 6238 standard)
- **Time step:** 30 seconds
- **Code length:** 6 digits
- **Clock skew tolerance:** ±1 time step (90-second window)

### Secret Storage

- The TOTP secret is encrypted with **AES-256-GCM** using the master encryption key before storage.
- A unique nonce is generated per encryption operation.
- The plaintext secret is never logged or exposed via API responses.

### Setup Flow

```
1. User requests MFA enablement
2. Server generates TOTP secret
3. Server encrypts and stores secret (provisional, not active)
4. Server returns QR code (otpauth:// URI) for user to scan
5. User enters two consecutive TOTP codes to confirm
6. On valid confirmation: secret marked active, 10 recovery codes generated
```

### Recovery Codes

| Property | Value |
|----------|-------|
| Count | 10 codes |
| Format | 8-character alphanumeric, single-use |
| Storage | Argon2id hashed (same as passwords) |
| Display | Shown once during setup; user must store securely |
| Consumption | Marked used immediately after successful verification |

### MFA Disable Flow

Disabling MFA requires **both**:
1. Current valid password verification
2. Current valid TOTP code (or recovery code)

All MFA state changes are audit-logged.

---

## 4. CSRF Protection

### Mechanism

CSRF protection uses a **dual approach**:

1. **Origin/Referer validation** for all state-changing requests (POST, PUT, PATCH, DELETE).
   - The `Origin` or `Referer` header is compared against the configured allowed origins.
   - Requests with mismatched or absent origin are rejected with 403.

2. **CSRF token** for additional defense-in-depth:
   - A cryptographically random token is generated per session.
   - The token is embedded in a hidden form field or custom header (`X-CSRF-Token`).
   - The server validates the token against the session's stored value on state-changing requests.

### Exemptions

- **Verified external webhooks only:** Incoming webhook endpoints (Stripe, deployment hooks) are exempt from CSRF token checks but still validate the request signature (HMAC-SHA256 for outgoing; Stripe webhook signature for incoming).
- All other state-changing endpoints require valid CSRF protection.

---

## 5. Multi-Tenancy Isolation

### Defense in Depth

Tenant (workspace) data isolation is enforced through multiple independent layers:

| Layer | Mechanism |
|-------|-----------|
| **API guard** | Middleware extracts `workspaceId` from the authenticated session, never from the request body. Requests without valid workspace context are rejected. |
| **Service methods** | Every service method that accesses tenant data requires `workspaceId` as an explicit, non-optional parameter. |
| **Prisma queries** | The workspace-scoped DB client wrapper injects `where: { workspaceId }` into all queries. |
| **Foreign keys** | Database FK constraints prevent cross-tenant references. |
| **Application tests** | Automated test suite proves no cross-tenant data access under adversarial conditions (IDs from other workspaces, direct query manipulation). |
| **Audit logs** | Every data access is audit-logged with `workspaceId`, enabling post-hoc leakage detection. |

### PostgreSQL Migration Note

When migrating to PostgreSQL, native **Row-Level Security (RLS)** policies will be added as an additional database-level enforcement layer. The application-level controls remain as defense in depth. RLS policy definitions are documented in `DATABASE_DESIGN.md`.

---

## 6. SSRF Prevention

### SafeTargetUrlService

All URLs targeted by the scanner pass through `src/lib/safe-url.ts` (`SafeTargetUrlService`) before any network request is made.

```
Input URL
  │
  ├─ WHATWG URL parse (reject invalid URLs)
  ├─ IDNA normalization (punycode)
  ├─ Protocol blocklist (allow only http: and https:)
  ├─ Port allowlist (80, 443, 8080, 8443 — configurable)
  ├─ URL length cap (2048 characters)
  ├─ IP classification:
  │    ├─ Loopback (127.0.0.0/8, ::1)
  │    ├─ Private (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, fc00::/7)
  │    ├─ Link-local (169.254.0.0/16, fe80::/10)
  │    ├─ Multicast (224.0.0.0/4, ff00::/8)
  │    ├─ CGNAT (100.64.0.0/10)
  │    ├─ Reserved (0.0.0.0/8, 240.0.0.0/4)
  │    ├─ Documentation (192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24)
  │    ├─ Metadata (169.254.169.254 and derivatives)
  │    └─ All classified IPs are BLOCKED
  ├─ DNS resolution:
  │    ├─ Resolve hostname → record IP
  │    ├─ Re-resolve hostname → compare
  │    └─ Abort if IP changed (DNS rebinding protection)
  ├─ Redirect policy:
  │    ├─ Maximum 10 redirects
  │    ├─ Re-validate each redirect through full SafeTargetUrlService
  │    └─ Record and report blocked redirects
  └─ Output: validated, safe URL or rejection reason
```

### Network Interception (Playwright)

The worker applies additional network-level controls:

- Allowed origins list per scan configuration.
- Blocked IPs enforced at the socket level.
- Maximum response size limit per request.
- Per-page and total timeout enforcement.
- Blocked protocols (e.g., `file://`, `data:` in navigation contexts).
- Header stripping for outgoing requests (remove internal headers).
- Redirect revalidation through `SafeTargetUrlService` on every hop.

---

## 7. Browser Sandbox

### Process Isolation

| Control | Sandbox | Production |
|---------|---------|------------|
| Run as | Non-root user | Non-root user (dedicated) |
| Root filesystem | Read-only where possible | Read-only with tmpfs overlay |
| Temp directory | tmpfs mount | tmpfs mount |
| Capabilities | Dropped (all except minimal) | Dropped (all except minimal) |
| Privilege escalation | `no-new-privileges` | `no-new-privileges` |
| Docker socket | Not mounted | Not mounted |
| Host credentials | Not accessible | Not accessible (separate secret store) |
| Host networking | Not used | Not used |

### Resource Limits

| Resource | Limit |
|----------|-------|
| CPU | Capped (configurable per plan) |
| Memory | Capped (configurable per plan) |
| PID count | Limited (prevents fork bombs) |
| Timeout | Per-page timeout + total run timeout |

### Per-Run Isolation

- **Separate browser context** for every scan run.
- No cookie, localStorage, or state reuse between runs.
- Browser contexts are closed and cleaned up after each run.
- No access to the main app's session, cookies, or storage.

### Playwright Launch Policy

- `--no-sandbox` is **not** used by default.
- Service Worker persistence is blocked.
- Clipboard, camera, microphone, geolocation, and notifications are blocked.
- Downloads are intercepted and discarded (or routed to artifact storage).

---

## 8. Secrets Vault

### Encryption Scheme

| Property | Value |
|----------|-------|
| Algorithm | AES-256-GCM |
| Key size | 256 bits (32 bytes) |
| Nonce | 96 bits (12 bytes), unique per encryption operation, generated with `crypto.randomBytes` |
| Key versioning | Each encrypted value is tagged with a key version ID, enabling key rotation |
| Envelope encryption | Data encrypted with a DEK (Data Encryption Key); DEK encrypted with the KEK (Key Encryption Key, from env) |

### Key Management

- **Master key:** `PROOFPILOT_ENCRYPTION_KEY` environment variable, 32 bytes base64-encoded.
- **KMS adapter interface:** Defined for production integration with cloud KMS (AWS KMS, GCP KMS, Azure Key Vault).
- **Sandbox:** Fixed dev key used; production must set a strong unique key.

### Access Policy

| Rule | Implementation |
|------|---------------|
| Never return decrypted via API | Vault operations return references or encrypted payloads; decryption occurs only in service layer |
| Audit all operations | `create`, `update`, `access`, `delete` events are audit-logged |
| Key rotation support | Version-tagged ciphertext; old versions can be re-encrypted on access |
| No secrets in logs | Vault module redacts all secret values from structured log output |

---

## 9. API Security

### Request Processing Pipeline

```
Incoming request
  │
  ├─ Security headers ( Helmet-style )
  ├─ CORS validation (strict allowlist)
  ├─ Request ID generation (UUID v4, propagated in response)
  ├─ Rate limiting (per-key, per-route)
  ├─ Content-Type validation (reject unexpected types for POST/PUT/PATCH)
  ├─ Body size limits (JSON: 1MB, file: per-endpoint configured)
  ├─ Cookie session extraction / API key extraction
  ├─ CSRF validation (Origin/Referer + token)
  ├─ Input validation (Zod schemas)
  ├─ Authentication check
  ├─ Workspace guard + permission check
  ├─ Business logic (service module)
  ├─ Output serialization (Zod, strip internal fields)
  ├─ Error sanitization (no stack traces, no internal details)
  ├─ Audit logging (sensitive actions)
  └─ Response (JSON + security headers)
```

### Security Headers

Applied via middleware (see [Section 14](#14-security-headers) for full details):

- `Strict-Transport-Security`
- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Permissions-Policy`
- `Cross-Origin-Opener-Policy`
- `Cross-Origin-Resource-Policy`
- `Content-Security-Policy` (nonces/hashes, no broad `unsafe-inline`)

### Rate Limiting

| Environment | Backend | Notes |
|-------------|---------|-------|
| Sandbox | In-process memory + DB persistence | Sliding window, per-route quotas |
| Production | Redis-backed | Distributed, consistent across instances |

Rate limits are applied per: IP, user ID, workspace ID, API key (as applicable).

### Error Responses

All errors follow **RFC 7807 Problem Details** format:

```json
{
  "type": "https://proofpilot.dev/errors/auth/invalid-credentials",
  "title": "Authentication failed",
  "status": 401,
  "detail": "Invalid credentials",
  "requestId": "a1b2c3d4-..."
}
```

- No stack traces in production.
- No internal path or query details.
- No database error messages.
- `requestId` enables correlation with logs.

### Idempotency

- All state-changing endpoints accept an optional `Idempotency-Key` header.
- Duplicate keys within the key's TTL return the original response.
- Prevents accidental duplicate operations from network retries.

---

## 10. API Keys

### Format

```
pp_live_<public-id>_<secret>
```

| Component | Description |
|-----------|-------------|
| Prefix | `pp_live_` (identifies the key type) |
| Public ID | CUID, used as the key's identifier in API responses and database |
| Secret | 32 bytes, cryptographically random, base64url-encoded |

### Lifecycle

| Property | Implementation |
|----------|---------------|
| Display | **Shown once** at creation time; cannot be retrieved afterward |
| Storage | Secret is hashed (SHA-256) before storage; only the hash is persisted |
| Scopes | Granular permissions (e.g., `runs:read`, `findings:write`, `reports:read`) |
| Expiration | Optional; configured at creation |
| Last used | Timestamp updated on each authenticated request |
| Revocation | Immediate; hashed secret deleted, audit logged |
| Rate limiting | Separate rate limit bucket per API key |
| Audit | Creation, use, scope change, and revocation are audit-logged |

### Authentication

- API key is passed via `Authorization: Bearer pp_live_<id>_<secret>`.
- The server extracts the public ID, looks up the stored hash, and verifies via constant-time comparison.
- If valid, the request proceeds with the key's associated workspace, user, and scopes.

---

## 11. Artifact Storage

### Access Control

| Property | Value |
|----------|-------|
| Bucket visibility | **Private** — no public access |
| Access method | Signed URLs with short-lived expiration |
| Authorization | Signed only after verifying the requester has workspace-level access to the artifact's parent run/project |
| Content-Disposition | `attachment` for downloads (prevents inline execution) |
| MIME validation | Uploaded artifacts are validated against expected MIME types |
| Size limits | Per-artifact and per-workspace quotas enforced |
| Encryption at rest | AES-256 (S3 SSE) or equivalent |
| Lifecycle | Configurable retention; expired artifacts are automatically deleted |

### Signed URL Generation

```
1. Client requests artifact access (GET /api/v1/artifacts/:id)
2. Server verifies: auth + workspace membership + artifact ownership
3. Server generates signed URL (e.g., S3 presigned, 15-minute expiry)
4. Server returns redirect or JSON with the signed URL
5. Client fetches directly from storage (or server proxies in sandbox)
```

---

## 12. Audit Logging

### Immutability

- Audit log entries are **append-only**. No update or delete operations are exposed.
- Database-level: audit table uses `INSERT` only; no `UPDATE`/`DELETE` grants for the application role (in PostgreSQL; SQLite equivalent enforced at application level).

### Sensitive Actions

The following actions (and their sub-actions) are always audit-logged:

- Authentication events: login, logout, failed login, MFA enable/disable, recovery code use, session revocation
- Authorization events: role change, permission escalation, API key creation/revocation
- Data access: secret vault access, report sharing token creation, PII export
- Configuration: workspace settings changes, billing changes, integration changes
- Security events: CSRF failure, rate limit exceeded, suspicious activity, blocked SSRF attempt

### Entry Schema

| Field | Type | Description |
|-------|------|-------------|
| `id` | string (CUID) | Unique entry identifier |
| `actorType` | enum | `USER`, `API_KEY`, `SYSTEM`, `WEBHOOK` |
| `actorId` | string | Reference to the acting entity |
| `workspaceId` | string? | Workspace context (null for platform-level actions) |
| `action` | string | Specific action performed (e.g., `auth.login`, `mfa.enable`) |
| `targetType` | string? | Type of affected resource (e.g., `user`, `session`, `api_key`) |
| `targetId` | string? | ID of the affected resource |
| `timestamp` | datetime (UTC) | When the action occurred |
| `ipHash` | string | SHA-256 hash of the client IP (never store raw IP) |
| `userAgentSummary` | string | Truncated, sanitized user agent (no unique fingerprinting) |
| `requestId` | string | Correlates with the request's `X-Request-ID` |
| `safeMetadata` | JSON | Additional context; must not contain secrets or PII |
| `outcome` | enum | `SUCCESS`, `FAILURE`, `BLOCKED` |

### Secrets Exclusion

- Vault decrypted values, passwords, TOTP secrets, API key secrets, and recovery codes are **never** included in `safeMetadata` or any other audit field.
- Only references (IDs, key names, action descriptions) are logged.

---

## 13. Observability

### Structured Logging

All log output is structured JSON:

```json
{
  "timestamp": "2025-01-15T10:30:00.000Z",
  "level": "info",
  "message": "Scan run completed",
  "component": "scans",
  "requestId": "a1b2c3d4-...",
  "workspaceId": "ws_...",
  "runId": "run_...",
  "pagesScanned": 15,
  "findingsCount": 23,
  "durationMs": 12400
}
```

Standard fields: `timestamp`, `level`, `message`, `component`, `requestId`.
Secrets are never included in log output.

### OpenTelemetry Readiness

- The logger and middleware are designed for easy integration with OpenTelemetry.
- Request IDs, trace IDs, and span IDs are propagated through the request lifecycle.
- Production deployment adds OTLP exporters for distributed tracing.

### Health Endpoints

| Endpoint | Purpose | Checks |
|----------|---------|--------|
| `GET /health/live` | Liveness | Process is running; returns 200 |
| `GET /health/ready` | Readiness | Database connection, encryption key available, critical services reachable; returns 200 or 503 with details |

---

## 14. Security Headers

Applied by Next.js middleware on every response:

```
Strict-Transport-Security: max-age=63072000; includeSubDomains; preload
X-Content-Type-Options: nosniff
Referrer-Policy: strict-origin-when-cross-origin
Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=()
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Resource-Policy: same-origin
Content-Security-Policy:
  default-src 'self';
  script-src 'self' 'nonce-{nonce}';
  style-src 'self' 'nonce-{nonce}';
  img-src 'self' data: https:;
  font-src 'self';
  connect-src 'self';
  frame-ancestors 'none';
  base-uri 'self';
  form-action 'self';
```

**CSP Notes:**

- Nonces are generated per-request and injected into `<script>` and `<style>` tags.
- No broad `unsafe-inline` for scripts or styles.
- `frame-ancestors: 'none'` prevents embedding in iframes (clickjacking defense).
- `connect-src 'self'` restricts fetch/XHR to same-origin (SSE endpoint is same-origin).

---

## 15. Production Safety

The application **refuses to start** if any of the following unsafe conditions are detected when `NODE_ENV=production`:

| Check | Condition | Refusal Message |
|-------|-----------|-----------------|
| Debug mode | `NODE_ENV !== 'production'` | N/A (check only runs in production) |
| HTTP cookies | Session cookie configured without `Secure` flag | "Secure cookie required in production" |
| Default admin password | Default admin account has not changed its password | "Default admin password must be changed" |
| Missing encryption key | `PROOFPILOT_ENCRYPTION_KEY` is absent or invalid | "Encryption key is required" |
| Public artifact bucket | Artifact storage is configured as publicly accessible | "Artifact bucket must be private" |
| Wildcard CORS | CORS allowlist contains `*` | "Wildcard CORS is not allowed in production" |
| Disabled CSRF | CSRF protection is disabled | "CSRF protection cannot be disabled in production" |
| Private-network scanner override | Scanner is configured to allow private network targets | "Private network scanning is disabled in production" |
| Test Stripe keys | `STRIPE_SECRET_KEY` starts with `sk_test_` | "Test Stripe keys cannot be used in production" |
| Weak session secret | Session signing secret is too short or predictable | "Session secret does not meet strength requirements" |
| Unrestricted scan targets | SSRF blocklist is empty or disabled | "SSRF protection cannot be disabled in production" |

These checks are implemented in `src/lib/env.ts` and run at application startup before the HTTP server begins listening.
