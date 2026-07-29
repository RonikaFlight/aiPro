# Task: Deployment Hooks Service & API Routes

**Task ID:** deployment-hooks-service
**Agent:** main (Z.ai Code)

## Work Summary

Created the full Deployment Hooks service and API routes for ProofPilot — 4 files total.

## Files Created

### 1. `src/lib/deployment-hook-service.ts` (~310 lines)
Core service with all business logic:

**CRUD operations:**
- `createDeploymentHook(data, workspaceId, userId, ctx)` — Creates hook with random `publicId` + `dhsec_`-prefixed secret. Secret is AES-256-GCM encrypted (via `encryptToJson`) and stored in the `secretHash` column so it can be decrypted later for HMAC verification. Returns `{ hook, secret }` (secret shown only once).
- `listDeploymentHooks(projectId, workspaceId)` — Lists all hooks for a project, workspace-scoped.
- `getDeploymentHook(publicId)` — Fetches hook by publicId (used by incoming webhook endpoint; no auth required).
- `toggleDeploymentHook(hookId, workspaceId, enabled, userId, ctx)` — Enable/disable toggle with audit.
- `deleteDeploymentHook(hookId, workspaceId, userId, ctx)` — Delete with audit.

**Security operations:**
- `verifyDeploymentHookSignature(rawBody, signature, encryptedSecret)` — Decrypts stored secret, parses timestamp from JSON body, computes `HMAC-SHA256(rawSecret, "timestamp.body")`, compares with constant-time `timingSafeEqual`.
- `processDeploymentHook(hook, payload, auditCtx)` — Full processing pipeline: branch filter matching (glob with `*` wildcard, comma-separated), replay protection (5-minute window), idempotency via `IncomingWebhookEvent` (source+externalId uniqueness), records event, updates `lastTriggeredAt`, triggers scan run if `scanProfileId` is set, records audit log.

**Validation:**
- Branch filter: max 200 chars, alphanumeric + `*/\-_.` only
- Max 10 hooks per project
- scanProfileId verified against project ownership
- Payload timestamp validated (reject if > 5 min old or > 1 min in future)

### 2. `src/app/api/v1/projects/[projectId]/deployment-hooks/route.ts` (GET + POST)
- **GET**: Lists hooks for a project. Requires `projects.write` workspace permission. Returns `{ items: [...] }`.
- **POST**: Creates a hook. Requires `projects.write` permission + CSRF. Zod-validated body (`environmentId`, `branchFilter`, `scanProfileId`). Returns 201 with `{ hook, secret }`.

### 3. `src/app/api/v1/projects/[projectId]/deployment-hooks/[hookId]/route.ts` (PATCH + DELETE)
- **PATCH**: Toggles hook enabled/disabled. Requires `projects.write` + CSRF. Body: `{ enabled: boolean }`.
- **DELETE**: Deletes hook. Requires `projects.write` + CSRF. Returns 204.

### 4. `src/app/api/v1/hooks/[publicId]/route.ts` (POST — PUBLIC endpoint)
The incoming webhook receiver. **No session auth required** — verified via HMAC signature.

**Flow:**
1. Look up hook by publicId (404 if not found)
2. Rate-limit per publicId+IP (10 req/min via `checkRateLimit`)
3. Read raw body for HMAC verification
4. Extract `X-ProofPilot-Signature` header → 401 if missing, `recordSecurityEvent` on failure
5. Verify HMAC-SHA256 signature → 401 if invalid, `recordSecurityEvent` on failure
6. Parse payload with Zod (`branch`, `commit`, `timestamp`, `environment`, `url`)
7. Process hook via `processDeploymentHook`
8. Return 200 `{ accepted: true, scanRunId }` or 202 `{ accepted: false, reason }`

**Note:** The CSRF exemption for `/api/v1/hooks/` was already present in `csrf.ts`.

## Key Design Decisions

1. **Secret storage**: The `secretHash` column stores the AES-256-GCM encrypted raw secret (via `encryptToJson`/`decryptFromJson`), not a SHA-256 hash. This is necessary because HMAC-SHA256 verification requires the raw signing key, which cannot be recovered from a hash. The field name is misleading but the schema was pre-defined.

2. **Scan triggering**: Rather than importing the full `createRun` (which requires `userId`/`userRole`/workspace auth), deployment hooks directly create a `ScanRun` record with `trigger: 'DEPLOYMENT_HOOK'` and `status: 'QUEUED'`. The queue system picks it up.

3. **Replay protection**: Uses the `timestamp` field from the payload. Rejects if > 5 minutes old or > 1 minute in the future (to account for clock skew).

4. **Idempotency**: Uses `sha256(payload)` truncated to 16 chars as part of the `externalId`, with `source='deployment_hook'`. The `IncomingWebhookEvent` model's `@@unique([source, externalId])` constraint prevents duplicate processing.

## Verification
- `bun run lint`: 0 errors, 0 warnings
- Dev server: running, all routes compile without errors
