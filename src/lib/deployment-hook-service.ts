/**
 * Deployment hook service — ProofPilot
 *
 * CRUD for deployment hooks that receive signed webhook payloads from
 * CI/CD pipelines. Each hook has a publicId + encrypted signing secret;
 * the raw secret is returned once on creation.
 *
 * Security:
 *   - HMAC-SHA256 signature verification (timestamp.body)
 *   - Rate-limited per publicId (10 req/min)
 *   - Replay-protected (reject payloads older than 5 minutes)
 *   - Idempotent (IncomingWebhookEvent uniqueness on source+externalId)
 *   - Audited (recordAudit on every mutation)
 *
 * See SECURITY_MODEL.md §"Incoming deployment hooks".
 */
import { createHmac } from 'crypto'
import { db } from './db'
import { logger } from './logger'
import {
  AppError,
  NotFoundError,
  ValidationError,
} from './errors'
import { recordAudit, recordSecurityEvent, type AuditContext } from './audit'
import { randomHex, sha256, timingSafeEqual, encryptToJson, decryptFromJson } from './crypto'
import { checkRateLimit } from './rate-limit'

// ===========================================================
// Types
// ===========================================================

export interface CreateDeploymentHookInput {
  projectId: string
  environmentId?: string
  branchFilter?: string
  scanProfileId?: string
}

export interface DeploymentHookItem {
  id: string
  projectId: string
  environmentId: string | null
  publicId: string
  branchFilter: string | null
  scanProfileId: string | null
  enabled: boolean
  lastTriggeredAt: string | null
  createdAt: string
  updatedAt: string
}

export interface CreateDeploymentHookResult {
  hook: DeploymentHookItem
  /** Raw signing secret — only returned on creation. */
  secret: string
}

export interface DeploymentHookPayload {
  branch?: string
  commit?: string
  timestamp?: string | number
  environment?: string
  url?: string
}

export interface ProcessHookResult {
  accepted: boolean
  reason?: string
  scanRunId?: string
}

/** Audit context subset. */
type CtxLike = Pick<AuditContext, 'ip' | 'userAgent' | 'requestId'>

// ===========================================================
// Constants
// ===========================================================

const REPLAY_TOLERANCE_MS = 5 * 60 * 1000 // 5 minutes
const DEPLOYMENT_HOOK_RATE_LIMIT = { max: 10, windowSeconds: 60, keyPrefix: 'deployhook' }
const MAX_HOOKS_PER_PROJECT = 10

// ===========================================================
// CRUD
// ===========================================================

/**
 * Create a new deployment hook.
 *
 * Generates a random publicId and signing secret. The raw secret is
 * returned once; the secret is AES-256-GCM encrypted before storage
 * so we can decrypt it later for signature verification.
 */
export async function createDeploymentHook(
  data: CreateDeploymentHookInput,
  workspaceId: string,
  userId: string,
  ctx: CtxLike,
): Promise<CreateDeploymentHookResult> {
  // Validate branch filter pattern if provided
  if (data.branchFilter) {
    if (data.branchFilter.length > 200) {
      throw new ValidationError('Branch filter must be at most 200 characters')
    }
    // Basic glob validation — only allow *, letters, digits, /, -, _
    if (!/^[a-zA-Z0-9/*\-_.]+$/.test(data.branchFilter)) {
      throw new ValidationError(
        'Branch filter contains invalid characters. Use *, letters, digits, /, -, _',
      )
    }
  }

  // Check limit per project
  const existingCount = await db.deploymentHook.count({
    where: { projectId: data.projectId },
  })
  if (existingCount >= MAX_HOOKS_PER_PROJECT) {
    throw new ValidationError(
      `Maximum deployment hooks (${MAX_HOOKS_PER_PROJECT}) reached for this project`,
    )
  }

  // Verify scanProfileId belongs to the project if provided
  if (data.scanProfileId) {
    const profile = await db.scanProfile.findUnique({
      where: { id: data.scanProfileId },
      select: { projectId: true },
    })
    if (!profile || profile.projectId !== data.projectId) {
      throw new ValidationError('Scan profile not found for this project')
    }
  }

  const publicId = `dh_${randomHex(16)}`
  const secret = `dhsec_${randomHex(24)}`

  // Encrypt the raw secret for storage so we can decrypt for HMAC verification
  const encryptedSecret = encryptToJson(secret)

  const hook = await db.deploymentHook.create({
    data: {
      projectId: data.projectId,
      environmentId: data.environmentId ?? null,
      workspaceId,
      publicId,
      secretHash: encryptedSecret,
      branchFilter: data.branchFilter ?? null,
      scanProfileId: data.scanProfileId ?? null,
    },
  })

  await recordAudit(
    'DEPLOYMENT_HOOK_CREATE',
    { type: 'deployment_hook', id: hook.id },
    {
      actorType: 'USER',
      actorId: userId,
      workspaceId,
      ...ctx,
    },
    { publicId, projectId: data.projectId },
  )

  logger.info('Deployment hook created', {
    hookId: hook.id,
    publicId,
    projectId: data.projectId,
    workspaceId,
  })

  return {
    hook: mapHook(hook),
    secret,
  }
}

/**
 * List all deployment hooks for a project.
 */
export async function listDeploymentHooks(
  projectId: string,
  workspaceId: string,
): Promise<DeploymentHookItem[]> {
  const hooks = await db.deploymentHook.findMany({
    where: { projectId, workspaceId },
    orderBy: { createdAt: 'desc' },
  })
  return hooks.map(mapHook)
}

/**
 * Get a single deployment hook by publicId.
 * Used for incoming webhook processing — does not require workspace auth.
 */
export async function getDeploymentHook(
  publicId: string,
): Promise<{
  id: string
  projectId: string
  environmentId: string | null
  workspaceId: string
  publicId: string
  secretHash: string
  branchFilter: string | null
  scanProfileId: string | null
  enabled: boolean
} | null> {
  const hook = await db.deploymentHook.findUnique({
    where: { publicId },
  })
  if (!hook) return null
  return {
    id: hook.id,
    projectId: hook.projectId,
    environmentId: hook.environmentId,
    workspaceId: hook.workspaceId,
    publicId: hook.publicId,
    secretHash: hook.secretHash,
    branchFilter: hook.branchFilter,
    scanProfileId: hook.scanProfileId,
    enabled: hook.enabled,
  }
}

/**
 * Toggle a deployment hook enabled/disabled.
 */
export async function toggleDeploymentHook(
  hookId: string,
  workspaceId: string,
  enabled: boolean,
  userId: string,
  ctx: CtxLike,
): Promise<DeploymentHookItem> {
  const hook = await db.deploymentHook.findUnique({ where: { id: hookId } })
  if (!hook || hook.workspaceId !== workspaceId) {
    throw new NotFoundError('Deployment hook')
  }

  const updated = await db.deploymentHook.update({
    where: { id: hookId },
    data: { enabled },
  })

  await recordAudit(
    enabled ? 'DEPLOYMENT_HOOK_ENABLE' : 'DEPLOYMENT_HOOK_DISABLE',
    { type: 'deployment_hook', id: hookId },
    { actorType: 'USER', actorId: userId, workspaceId, ...ctx },
  )

  logger.info('Deployment hook toggled', { hookId, enabled, workspaceId })

  return mapHook(updated)
}

/**
 * Delete a deployment hook.
 */
export async function deleteDeploymentHook(
  hookId: string,
  workspaceId: string,
  userId: string,
  ctx: CtxLike,
): Promise<void> {
  const hook = await db.deploymentHook.findUnique({ where: { id: hookId } })
  if (!hook || hook.workspaceId !== workspaceId) {
    throw new NotFoundError('Deployment hook')
  }

  await db.deploymentHook.delete({ where: { id: hookId } })

  await recordAudit(
    'DEPLOYMENT_HOOK_DELETE',
    { type: 'deployment_hook', id: hookId },
    { actorType: 'USER', actorId: userId, workspaceId, ...ctx },
    { publicId: hook.publicId, projectId: hook.projectId },
  )

  logger.info('Deployment hook deleted', { hookId, workspaceId })
}

// ===========================================================
// Signature verification
// ===========================================================

/**
 * Verify HMAC-SHA256 signature from incoming webhook.
 *
 * The secretHash field stores the AES-256-GCM encrypted raw secret.
 * We decrypt it to recover the raw signing key, then compute
 * HMAC-SHA256 over `timestamp.body` and compare with the provided
 * signature using constant-time comparison.
 */
export function verifyDeploymentHookSignature(
  rawBody: string,
  signature: string,
  encryptedSecret: string,
): boolean {
  if (!signature || !rawBody || !encryptedSecret) return false

  // Decrypt the raw secret
  let rawSecret: string
  try {
    rawSecret = decryptFromJson(encryptedSecret)
  } catch {
    return false
  }

  // Parse the raw body to extract the timestamp
  let parsed: { timestamp?: number | string }
  try {
    parsed = JSON.parse(rawBody) as { timestamp?: number | string }
  } catch {
    return false
  }

  const ts = parsed.timestamp
  if (!ts) return false

  const tsNum = typeof ts === 'number' ? ts : parseInt(ts, 10)
  if (isNaN(tsNum)) return false

  // Signature covers `timestamp.body`
  const signedPayload = `${tsNum}.${rawBody}`
  const expected = createHmac('sha256', rawSecret)
    .update(signedPayload)
    .digest('hex')

  return timingSafeEqual(signature, expected)
}

// ===========================================================
// Incoming webhook processing
// ===========================================================

/**
 * Process an incoming deployment hook payload.
 *
 * Validates branch filter, checks idempotency, records the event,
 * and triggers a scan if scanProfileId is configured.
 */
export async function processDeploymentHook(
  hook: NonNullable<Awaited<ReturnType<typeof getDeploymentHook>>>,
  payload: DeploymentHookPayload,
  auditCtx: CtxLike,
): Promise<ProcessHookResult> {
  if (!hook.enabled) {
    return { accepted: false, reason: 'Hook is disabled' }
  }

  // 1. Validate branch filter
  if (hook.branchFilter && payload.branch) {
    if (!matchesBranchFilter(payload.branch, hook.branchFilter)) {
      return { accepted: false, reason: 'Branch does not match filter' }
    }
  }

  // 2. Replay protection — check timestamp
  const payloadTs = payload.timestamp
  if (payloadTs) {
    const tsNum = typeof payloadTs === 'string'
      ? parseInt(payloadTs, 10)
      : typeof payloadTs === 'number'
        ? payloadTs
        : 0
    if (isNaN(tsNum)) {
      return { accepted: false, reason: 'Invalid timestamp in payload' }
    }
    const ageMs = Date.now() - tsNum * 1000
    if (ageMs > REPLAY_TOLERANCE_MS || ageMs < -60_000) {
      return { accepted: false, reason: 'Payload timestamp too old or in the future' }
    }
  }

  // 3. Idempotency — compute a hash of the payload
  const payloadHash = sha256(JSON.stringify(payload))
  const externalId = `dh_${hook.publicId}_${payloadHash.slice(0, 16)}`

  const existing = await db.incomingWebhookEvent.findUnique({
    where: { source_externalId: { source: 'deployment_hook', externalId } },
  })
  if (existing) {
    return { accepted: false, reason: 'Duplicate payload already processed' }
  }

  // 4. Record incoming event
  await db.incomingWebhookEvent.create({
    data: {
      source: 'deployment_hook',
      externalId,
      payloadJson: JSON.stringify(payload),
      processedAt: new Date(),
    },
  })

  // 5. Update lastTriggeredAt on the hook
  await db.deploymentHook.update({
    where: { id: hook.id },
    data: { lastTriggeredAt: new Date() },
  })

  // 6. Trigger scan if scanProfileId is set
  let scanRunId: string | undefined
  if (hook.scanProfileId) {
    try {
      scanRunId = await triggerScanFromHook(hook, payload, auditCtx)
    } catch (err) {
      logger.error('Failed to trigger scan from deployment hook', {
        hookId: hook.id,
        scanProfileId: hook.scanProfileId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  // 7. Audit
  await recordAudit(
    'DEPLOYMENT_HOOK_TRIGGERED',
    { type: 'deployment_hook', id: hook.id },
    {
      actorType: 'SYSTEM',
      workspaceId: hook.workspaceId,
      ...auditCtx,
    },
    { branch: payload.branch, commit: payload.commit?.slice(0, 12), scanRunId },
  )

  logger.info('Deployment hook processed', {
    hookId: hook.id,
    publicId: hook.publicId,
    branch: payload.branch,
    scanRunId,
  })

  return { accepted: true, scanRunId }
}

// ===========================================================
// Internal helpers
// ===========================================================

/**
 * Trigger a scan run from a deployment hook.
 */
async function triggerScanFromHook(
  hook: NonNullable<Awaited<ReturnType<typeof getDeploymentHook>>>,
  payload: DeploymentHookPayload,
  _ctx: CtxLike,
): Promise<string> {
  const environmentId = payload.environment
    ? await resolveEnvironmentId(hook.projectId, payload.environment)
    : hook.environmentId

  const run = await db.scanRun.create({
    data: {
      projectId: hook.projectId,
      environmentId,
      scanProfileId: hook.scanProfileId,
      workspaceId: hook.workspaceId,
      status: 'QUEUED',
      trigger: 'DEPLOYMENT_HOOK',
      runMode: 'PASSIVE',
      configSnapshot: JSON.stringify({
        trigger: 'deployment_hook',
        branch: payload.branch,
        commit: payload.commit?.slice(0, 12),
        url: payload.url,
      }),
    },
  })

  logger.info('Scan triggered from deployment hook', {
    runId: run.id,
    hookId: hook.id,
  })

  return run.id
}

/**
 * Resolve an environment name to its ID for the given project.
 * Matches against the ProjectEnvironment.type field (case-insensitive).
 */
async function resolveEnvironmentId(
  projectId: string,
  environmentName: string,
): Promise<string | undefined> {
  const envRecord = await db.projectEnvironment.findFirst({
    where: {
      projectId,
      type: environmentName.toUpperCase(),
    },
    select: { id: true },
  })
  return envRecord?.id
}

/**
 * Simple glob-style branch filter matching.
 * Supports * as wildcard, comma-separated for multiple patterns.
 */
function matchesBranchFilter(branch: string, filter: string): boolean {
  if (filter === '*' || filter === '**') return true

  const filterParts = filter.split(',')
  for (const part of filterParts) {
    const trimmed = part.trim()
    if (!trimmed) continue
    if (globMatch(branch, trimmed)) return true
  }
  return false
}

/**
 * Simple glob match: converts glob pattern to regex.
 * Only * is supported as a wildcard character.
 */
function globMatch(str: string, pattern: string): boolean {
  const regexStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&') // escape regex special chars except *
    .replace(/\*/g, '.*')
  const regex = new RegExp(`^${regexStr}$`)
  return regex.test(str)
}

/** Map a DB row to the API response type. */
function mapHook(w: {
  id: string
  projectId: string
  environmentId: string | null
  publicId: string
  branchFilter: string | null
  scanProfileId: string | null
  enabled: boolean
  lastTriggeredAt: Date | null
  createdAt: Date
  updatedAt: Date
}): DeploymentHookItem {
  return {
    id: w.id,
    projectId: w.projectId,
    environmentId: w.environmentId,
    publicId: w.publicId,
    branchFilter: w.branchFilter,
    scanProfileId: w.scanProfileId,
    enabled: w.enabled,
    lastTriggeredAt: w.lastTriggeredAt?.toISOString() ?? null,
    createdAt: w.createdAt.toISOString(),
    updatedAt: w.updatedAt.toISOString(),
  }
}
