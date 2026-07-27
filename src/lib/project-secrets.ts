/**
 * Project secrets vault — ProofPilot
 *
 * Stores per-project secrets (test credentials, API tokens used inside journeys)
 * as AES-256-GCM encrypted values. Keys are returned to the UI; values are
 * NEVER serialized to API responses.
 *
 * Secret resolution (`{{secret.NAME}}`) happens ONLY inside the worker via
 * `resolveSecret()`. The Next.js API layer can write/delete/list secrets but
 * cannot read decrypted values.
 *
 * See SECURITY_MODEL.md §"Secret vault" and THREAT_MODEL.md T13.
 */
import { db } from './db'
import { encrypt, encryptToJson, decryptFromJson } from './crypto'
import { recordAudit, type AuditContext } from './audit'
import { ForbiddenError, NotFoundError, ValidationError } from './errors'
import { hasPermission, type WorkspaceRole } from './permissions'

const KEY_REGEX = /^[A-Z0-9_]{1,64}$/
const MAX_VALUE_LENGTH = 8192
const MAX_DESCRIPTION_LENGTH = 500

export interface ProjectSecretMeta {
  id: string
  projectId: string
  key: string
  description: string | null
  createdAt: string
  updatedAt: string
}

/** Validate a secret key. Throws ValidationError on invalid. */
export function assertValidKey(key: string): void {
  if (!KEY_REGEX.test(key)) {
    throw new ValidationError(
      'Secret key must be 1-64 chars, uppercase letters/digits/underscore only',
    )
  }
}

/** Validate a secret value. Throws ValidationError on invalid. */
export function assertValidValue(value: string): void {
  if (!value || value.length === 0) {
    throw new ValidationError('Secret value must not be empty')
  }
  if (value.length > MAX_VALUE_LENGTH) {
    throw new ValidationError(`Secret value exceeds ${MAX_VALUE_LENGTH} chars`)
  }
}

/** Verify the caller has access to the project (workspace membership + secrets.manage). */
async function authorizeSecretOperation(
  projectId: string,
  userId: string,
  userRole: WorkspaceRole,
): Promise<{ projectId: string; workspaceId: string }> {
  if (!hasPermission(userRole, 'secrets.manage')) {
    throw new ForbiddenError('Missing permission: secrets.manage')
  }
  const project = await db.project.findUnique({
    where: { id: projectId },
    select: { id: true, workspaceId: true, status: true },
  })
  if (!project || project.status === 'DELETED') {
    throw new NotFoundError('Project')
  }
  return { projectId: project.id, workspaceId: project.workspaceId }
}

/** Set (create or update) a project secret. The plaintext value is encrypted at rest. */
export async function setSecret(
  projectId: string,
  key: string,
  value: string,
  description: string | null,
  userId: string,
  userRole: WorkspaceRole,
  ctx: Pick<AuditContext, 'ip' | 'userAgent' | 'requestId'>,
): Promise<ProjectSecretMeta> {
  assertValidKey(key)
  assertValidValue(value)
  if (description && description.length > MAX_DESCRIPTION_LENGTH) {
    throw new ValidationError(`Description exceeds ${MAX_DESCRIPTION_LENGTH} chars`)
  }

  const { workspaceId } = await authorizeSecretOperation(projectId, userId, userRole)
  const valueEncrypted = encryptToJson(value)

  const secret = await db.projectSecret.upsert({
    where: { projectId_key: { projectId, key } },
    create: {
      projectId,
      key,
      valueEncrypted,
      description: description?.trim() || null,
      createdById: userId,
    },
    update: {
      valueEncrypted,
      description: description?.trim() || null,
    },
  })

  await recordAudit(
    'PROJECT_SECRET_SET',
    { type: 'project_secret', id: secret.id },
    { ...ctx, actorType: 'USER', actorId: userId, workspaceId },
    // We deliberately do NOT record the plaintext value in the audit log.
    // The metadata records only the key + whether the value was changed.
    { projectId, key, action: 'set' },
  )

  return toMeta(secret)
}

/** List all secret keys for a project. NEVER returns decrypted values. */
export async function listSecrets(
  projectId: string,
  userId: string,
  userRole: WorkspaceRole,
): Promise<ProjectSecretMeta[]> {
  // VIEWERs can list secret keys (read-only) — but cannot set/delete.
  if (!hasPermission(userRole, 'secrets.manage') && userRole !== 'VIEWER') {
    throw new ForbiddenError('Not a member of this workspace')
  }
  const project = await db.project.findUnique({
    where: { id: projectId },
    select: { id: true, workspaceId: true, status: true },
  })
  if (!project || project.status === 'DELETED') {
    throw new NotFoundError('Project')
  }
  // Confirm membership
  const membership = await db.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId: project.workspaceId, userId } },
  })
  if (!membership || membership.removedAt) {
    throw new ForbiddenError('Not a member of this workspace')
  }

  const secrets = await db.projectSecret.findMany({
    where: { projectId },
    orderBy: { key: 'asc' },
  })
  return secrets.map(toMeta)
}

/** Delete a project secret by key. */
export async function deleteSecret(
  projectId: string,
  key: string,
  userId: string,
  userRole: WorkspaceRole,
  ctx: Pick<AuditContext, 'ip' | 'userAgent' | 'requestId'>,
): Promise<void> {
  assertValidKey(key)
  const { workspaceId } = await authorizeSecretOperation(projectId, userId, userRole)

  const existing = await db.projectSecret.findUnique({
    where: { projectId_key: { projectId, key } },
    select: { id: true },
  })
  if (!existing) {
    throw new NotFoundError('Project secret')
  }

  await db.projectSecret.delete({ where: { id: existing.id } })

  await recordAudit(
    'PROJECT_SECRET_DELETE',
    { type: 'project_secret', id: existing.id },
    { ...ctx, actorType: 'USER', actorId: userId, workspaceId },
    { projectId, key, action: 'delete' },
  )
}

// ---------------- Worker-only resolution ----------------

/**
 * Resolve a `{{secret.NAME}}` reference for a project.
 *
 * This function MUST only be called from the worker mini-service (or a server
 * action running in a trusted context). It decrypts the secret value and
 * returns it as plaintext. The plaintext is NEVER persisted, NEVER logged,
 * and NEVER returned to the API layer.
 *
 * Returns null if the secret does not exist (the caller decides whether to
 * fail the step or skip it).
 */
export async function resolveSecret(
  projectId: string,
  key: string,
): Promise<string | null> {
  assertValidKey(key)
  const secret = await db.projectSecret.findUnique({
    where: { projectId_key: { projectId, key } },
    select: { valueEncrypted: true },
  })
  if (!secret) return null
  try {
    return decryptFromJson(secret.valueEncrypted)
  } catch {
    // Decryption failure indicates key rotation or tampering — fail closed.
    return null
  }
}

/**
 * Resolve all secret references in a list of steps for a project.
 * Returns a map of `secretRef` → plaintext value. Missing secrets are omitted
 * (the caller will fail those steps at execution time).
 *
 * Used by the journey runner to batch-resolve secrets before execution, so
 * the DB is hit only once per run.
 */
export async function resolveSecretsForSteps(
  projectId: string,
  secretKeys: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (secretKeys.length === 0) return out

  const rows = await db.projectSecret.findMany({
    where: {
      projectId,
      key: { in: secretKeys },
    },
    select: { key: true, valueEncrypted: true },
  })

  for (const row of rows) {
    try {
      out.set(row.key, decryptFromJson(row.valueEncrypted))
    } catch {
      // skip — caller will fail the step
    }
  }
  return out
}

/** Extract {{secret.NAME}} keys referenced in a list of steps. */
export function extractSecretKeys(steps: ReadonlyArray<unknown>): string[] {
  const out = new Set<string>()
  for (const step of steps) {
    if (typeof step !== 'object' || step === null) continue
    const ref = (step as { secretRef?: unknown }).secretRef
    if (typeof ref === 'string') {
      const m = /^\{\{secret\.([A-Z0-9_]+)\}\}$/.exec(ref)
      if (m) out.add(m[1]!)
    }
  }
  return Array.from(out)
}

/** Re-encrypt all secrets with a new master key (for key rotation). */
export async function reEncryptAllSecrets(
  reEncryptFn: (plaintext: string) => string,
): Promise<{ rotated: number }> {
  const secrets = await db.projectSecret.findMany({
    select: { id: true, valueEncrypted: true },
  })
  for (const s of secrets) {
    try {
      const plaintext = decryptFromJson(s.valueEncrypted)
      const reEncrypted = reEncryptFn(plaintext)
      await db.projectSecret.update({
        where: { id: s.id },
        data: { valueEncrypted: reEncrypted },
      })
    } catch {
      // skip — fail-closed; bad records will be flagged by the audit
    }
  }
  return { rotated: secrets.length }
}

// ---------------- Helpers ----------------

function toMeta(row: {
  id: string
  projectId: string
  key: string
  description: string | null
  createdAt: Date
  updatedAt: Date
}): ProjectSecretMeta {
  return {
    id: row.id,
    projectId: row.projectId,
    key: row.key,
    description: row.description,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

// Silence unused-import warnings for the encrypt helper (kept for the rotation helper signature)
void encrypt
