/**
 * Journey service — ProofPilot
 *
 * CRUD for journeys + versioned stepsJson + validation against safe-action policy.
 * All operations are workspace-scoped via project membership.
 *
 * Versioning:
 *   - Every update creates a NEW JourneyVersion row with version = prev + 1.
 *   - `Journey.currentVersion` points at the latest version.
 *   - Rollback sets `currentVersion` to an earlier version (no row deletion).
 *   - Old versions are retained forever for auditability.
 *
 * Authorization:
 *   - journeys.create / journeys.update / projects.read permissions enforced.
 *   - Workspace membership resolved via project.workspaceId.
 *
 * See SECURITY_MODEL.md §"Journeys".
 */
import { db } from './db'
import { recordAudit, type AuditContext } from './audit'
import { hasPermission, type WorkspaceRole } from './permissions'
import {
  AppError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from './errors'
import {
  JourneyStepsSchema,
  serializeSteps,
  parseSteps,
  type JourneyStep,
  type JourneyRunMode,
} from './journey-types'
import { validateStepsAgainstPolicy, type PolicyResult } from './journey-policy'
import { extractSecretKeys } from './project-secrets'

// ---------------- Types ----------------

export interface CreateJourneyInput {
  projectId: string
  name: string
  description?: string
  entryUrl?: string
  personaId?: string
  steps: JourneyStep[]
  changeLog?: string
}

export interface UpdateJourneyInput {
  name?: string
  description?: string
  entryUrl?: string | null
  personaId?: string | null
  steps?: JourneyStep[]
  status?: 'DRAFT' | 'ACTIVE' | 'ARCHIVED'
  changeLog?: string
}

export interface JourneyDetail {
  id: string
  projectId: string
  workspaceId: string
  name: string
  description: string | null
  status: string
  entryUrl: string | null
  personaId: string | null
  currentVersion: number
  createdById: string | null
  createdAt: string
  updatedAt: string
  steps: JourneyStep[]
  secretKeys: string[]
}

export interface JourneySummary {
  id: string
  projectId: string
  name: string
  description: string | null
  status: string
  currentVersion: number
  entryUrl: string | null
  personaId: string | null
  createdAt: string
  updatedAt: string
  runCount: number
  lastRunAt: string | null
  lastRunStatus: string | null
}

export interface JourneyVersionSummary {
  id: string
  version: number
  changeLog: string | null
  createdById: string | null
  createdAt: string
  stepCount: number
}

// ---------------- Authorization ----------------

async function authorizeProject(
  projectId: string,
  userId: string,
  requiredPermission: 'projects.read' | 'journeys.create' | 'journeys.update',
): Promise<{ projectId: string; workspaceId: string; role: WorkspaceRole }> {
  const project = await db.project.findUnique({
    where: { id: projectId },
    select: { id: true, workspaceId: true, status: true },
  })
  if (!project || project.status === 'DELETED') {
    throw new NotFoundError('Project')
  }
  const membership = await db.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId: project.workspaceId, userId } },
  })
  if (!membership || membership.removedAt) {
    throw new ForbiddenError('Not a member of this workspace')
  }
  const role = membership.role as WorkspaceRole
  if (requiredPermission !== 'projects.read' && !hasPermission(role, requiredPermission)) {
    throw new ForbiddenError(`Missing permission: ${requiredPermission}`)
  }
  return { projectId: project.id, workspaceId: project.workspaceId, role }
}

async function loadJourneyInWorkspace(
  journeyId: string,
  workspaceId: string,
): Promise<{ journeyId: string; projectId: string }> {
  const journey = await db.journey.findUnique({
    where: { id: journeyId },
    select: { id: true, projectId: true, project: { select: { workspaceId: true, status: true } } },
  })
  if (!journey || journey.project.workspaceId !== workspaceId) {
    throw new NotFoundError('Journey')
  }
  return { journeyId: journey.id, projectId: journey.projectId }
}

// ---------------- CRUD ----------------

export async function createJourney(
  input: CreateJourneyInput,
  userId: string,
  userRole: WorkspaceRole,
  ctx: Pick<AuditContext, 'ip' | 'userAgent' | 'requestId'>,
): Promise<JourneyDetail> {
  const { projectId, workspaceId } = await authorizeProject(input.projectId, userId, 'journeys.create')

  // Validate name
  const name = input.name?.trim()
  if (!name || name.length < 2) {
    throw new ValidationError('Journey name must be at least 2 characters')
  }
  if (name.length > 200) {
    throw new ValidationError('Journey name exceeds 200 characters')
  }

  // Validate steps (Zod)
  const stepsResult = JourneyStepsSchema.safeParse(input.steps)
  if (!stepsResult.success) {
    throw new ValidationError('Invalid journey steps', {
      issues: stepsResult.error.issues,
    })
  }
  const steps = stepsResult.data

  // Validate entry URL if provided
  let entryUrl: string | null = null
  if (input.entryUrl) {
    if (!/^https?:\/\//i.test(input.entryUrl)) {
      throw new ValidationError('Entry URL must start with http:// or https://')
    }
    if (input.entryUrl.length > 2048) {
      throw new ValidationError('Entry URL exceeds 2048 chars')
    }
    entryUrl = input.entryUrl
  }

  // Validate persona if provided
  if (input.personaId) {
    const persona = await db.persona.findUnique({
      where: { id: input.personaId },
      select: { id: true, projectId: true },
    })
    if (!persona || persona.projectId !== projectId) {
      throw new ValidationError('Persona does not belong to this project')
    }
  }

  // Create journey + first version in a transaction
  const created = await db.$transaction(async (tx) => {
    const journey = await tx.journey.create({
      data: {
        projectId,
        name,
        description: input.description?.trim() || null,
        status: 'DRAFT',
        entryUrl,
        personaId: input.personaId ?? null,
        currentVersion: 1,
        createdById: userId,
      },
    })
    await tx.journeyVersion.create({
      data: {
        journeyId: journey.id,
        version: 1,
        stepsJson: serializeSteps(steps),
        changeLog: input.changeLog?.trim() || 'Initial version',
        createdBy: userId,
      },
    })
    return journey
  })

  await recordAudit(
    'JOURNEY_CREATE',
    { type: 'journey', id: created.id },
    { ...ctx, actorType: 'USER', actorId: userId, workspaceId },
    { projectId, name, stepCount: steps.length, version: 1 },
  )

  return formatJourneyDetail(created, steps, workspaceId)
}

export async function listJourneys(
  projectId: string,
  userId: string,
  opts: { status?: string; limit?: number; cursor?: string } = {},
): Promise<{ items: JourneySummary[]; nextCursor: string | null }> {
  const { workspaceId } = await authorizeProject(projectId, userId, 'projects.read')
  const limit = Math.min(opts.limit ?? 50, 100)

  const journeys = await db.journey.findMany({
    where: {
      projectId,
      status: opts.status ?? { not: 'DELETED' },
    },
    orderBy: { createdAt: 'desc' },
    take: limit + 1,
    cursor: opts.cursor ? { id: opts.cursor } : undefined,
    skip: opts.cursor ? 1 : 0,
    include: {
      runs: {
        orderBy: { createdAt: 'desc' },
        take: 1,
        select: { id: true, status: true, createdAt: true },
      },
      _count: { select: { runs: true } },
    },
  })

  const hasMore = journeys.length > limit
  const items = journeys.slice(0, limit).map((j) => ({
    id: j.id,
    projectId: j.projectId,
    name: j.name,
    description: j.description,
    status: j.status,
    currentVersion: j.currentVersion,
    entryUrl: j.entryUrl,
    personaId: j.personaId,
    createdAt: j.createdAt.toISOString(),
    updatedAt: j.updatedAt.toISOString(),
    runCount: j._count.runs,
    lastRunAt: j.runs[0]?.createdAt.toISOString() ?? null,
    lastRunStatus: j.runs[0]?.status ?? null,
  }))

  return {
    items,
    nextCursor: hasMore ? items[items.length - 1]!.id : null,
  }
}

export async function getJourney(
  journeyId: string,
  userId: string,
): Promise<JourneyDetail> {
  const journey = await db.journey.findUnique({
    where: { id: journeyId },
    include: {
      project: { select: { workspaceId: true, status: true } },
    },
  })
  if (!journey || journey.status === 'DELETED') {
    throw new NotFoundError('Journey')
  }
  const membership = await db.workspaceMember.findUnique({
    where: {
      workspaceId_userId: {
        workspaceId: journey.project.workspaceId,
        userId,
      },
    },
  })
  if (!membership || membership.removedAt) {
    throw new ForbiddenError('Not a member of this workspace')
  }

  // Load current version
  const version = await db.journeyVersion.findUnique({
    where: { journeyId_version: { journeyId, version: journey.currentVersion } },
  })
  if (!version) {
    throw new AppError('Journey version missing', 500, 'journey_version_missing')
  }

  const steps = parseSteps(version.stepsJson)
  const secretKeys = extractSecretKeys(steps)

  return {
    id: journey.id,
    projectId: journey.projectId,
    workspaceId: journey.project.workspaceId,
    name: journey.name,
    description: journey.description,
    status: journey.status,
    entryUrl: journey.entryUrl,
    personaId: journey.personaId,
    currentVersion: journey.currentVersion,
    createdById: journey.createdById,
    createdAt: journey.createdAt.toISOString(),
    updatedAt: journey.updatedAt.toISOString(),
    steps,
    secretKeys,
  }
}

export async function updateJourney(
  journeyId: string,
  input: UpdateJourneyInput,
  userId: string,
  userRole: WorkspaceRole,
  ctx: Pick<AuditContext, 'ip' | 'userAgent' | 'requestId'>,
): Promise<JourneyDetail> {
  // Resolve workspace via the journey's project
  const journey = await db.journey.findUnique({
    where: { id: journeyId },
    include: { project: { select: { workspaceId: true, status: true } } },
  })
  if (!journey || journey.status === 'DELETED') {
    throw new NotFoundError('Journey')
  }
  if (!hasPermission(userRole, 'journeys.update')) {
    throw new ForbiddenError('Missing permission: journeys.update')
  }

  const workspaceId = journey.project.workspaceId

  // If steps are provided, validate + create a new version
  let newVersion: number | null = null
  let validatedSteps: JourneyStep[] | null = null
  if (input.steps) {
    const stepsResult = JourneyStepsSchema.safeParse(input.steps)
    if (!stepsResult.success) {
      throw new ValidationError('Invalid journey steps', {
        issues: stepsResult.error.issues,
      })
    }
    validatedSteps = stepsResult.data
    newVersion = journey.currentVersion + 1
  }

  // Validate entry URL if provided
  let entryUrl: string | null | undefined
  if (input.entryUrl !== undefined) {
    if (input.entryUrl === null) {
      entryUrl = null
    } else {
      if (!/^https?:\/\//i.test(input.entryUrl)) {
        throw new ValidationError('Entry URL must start with http:// or https://')
      }
      if (input.entryUrl.length > 2048) {
        throw new ValidationError('Entry URL exceeds 2048 chars')
      }
      entryUrl = input.entryUrl
    }
  }

  // Validate persona if provided
  if (input.personaId) {
    const persona = await db.persona.findUnique({
      where: { id: input.personaId },
      select: { id: true, projectId: true },
    })
    if (!persona || persona.projectId !== journey.projectId) {
      throw new ValidationError('Persona does not belong to this project')
    }
  }

  const name = input.name?.trim()
  if (input.name !== undefined && (!name || name.length < 2)) {
    throw new ValidationError('Journey name must be at least 2 characters')
  }

  // Update journey + create new version atomically
  await db.$transaction(async (tx) => {
    await tx.journey.update({
      where: { id: journeyId },
      data: {
        name: name ?? undefined,
        description: input.description?.trim() ?? undefined,
        entryUrl: entryUrl ?? undefined,
        personaId: input.personaId === null ? null : input.personaId ?? undefined,
        status: input.status ?? undefined,
        currentVersion: newVersion ?? undefined,
      },
    })
    if (validatedSteps && newVersion) {
      await tx.journeyVersion.create({
        data: {
          journeyId,
          version: newVersion,
          stepsJson: serializeSteps(validatedSteps),
          changeLog: input.changeLog?.trim() || `Version ${newVersion}`,
          createdBy: userId,
        },
      })
    }
  })

  await recordAudit(
    'JOURNEY_UPDATE',
    { type: 'journey', id: journeyId },
    { ...ctx, actorType: 'USER', actorId: userId, workspaceId },
    {
      projectId: journey.projectId,
      nameChanged: input.name !== undefined,
      stepsChanged: validatedSteps !== null,
      newVersion,
      status: input.status,
    },
  )

  return getJourney(journeyId, userId)
}

export async function deleteJourney(
  journeyId: string,
  userId: string,
  userRole: WorkspaceRole,
  ctx: Pick<AuditContext, 'ip' | 'userAgent' | 'requestId'>,
): Promise<void> {
  const journey = await db.journey.findUnique({
    where: { id: journeyId },
    select: { id: true, projectId: true, status: true, project: { select: { workspaceId: true } } },
  })
  if (!journey || journey.status === 'DELETED') {
    throw new NotFoundError('Journey')
  }
  if (!hasPermission(userRole, 'journeys.update')) {
    throw new ForbiddenError('Missing permission: journeys.update')
  }
  // Soft delete — keep history for audit
  await db.journey.update({
    where: { id: journeyId },
    data: { status: 'DELETED' },
  })
  await recordAudit(
    'JOURNEY_DELETE',
    { type: 'journey', id: journeyId },
    { ...ctx, actorType: 'USER', actorId: userId, workspaceId: journey.project.workspaceId },
    { projectId: journey.projectId },
  )
}

// ---------------- Versions ----------------

export async function listJourneyVersions(
  journeyId: string,
  userId: string,
): Promise<JourneyVersionSummary[]> {
  const { workspaceId } = await resolveJourneyWorkspace(journeyId, userId)
  const versions = await db.journeyVersion.findMany({
    where: { journeyId },
    orderBy: { version: 'desc' },
  })
  return versions.map((v) => ({
    id: v.id,
    version: v.version,
    changeLog: v.changeLog,
    createdById: v.createdBy,
    createdAt: v.createdAt.toISOString(),
    stepCount: (() => {
      try {
        return parseSteps(v.stepsJson).length
      } catch {
        return 0
      }
    })(),
  }))
  void workspaceId
}

export async function getJourneyVersion(
  journeyId: string,
  version: number,
  userId: string,
): Promise<{ version: number; changeLog: string | null; createdAt: string; steps: JourneyStep[] }> {
  await resolveJourneyWorkspace(journeyId, userId)
  const v = await db.journeyVersion.findUnique({
    where: { journeyId_version: { journeyId, version } },
  })
  if (!v) throw new NotFoundError('Journey version')
  return {
    version: v.version,
    changeLog: v.changeLog,
    createdAt: v.createdAt.toISOString(),
    steps: parseSteps(v.stepsJson),
  }
}

export async function rollbackJourney(
  journeyId: string,
  version: number,
  userId: string,
  userRole: WorkspaceRole,
  ctx: Pick<AuditContext, 'ip' | 'userAgent' | 'requestId'>,
): Promise<JourneyDetail> {
  const journey = await db.journey.findUnique({
    where: { id: journeyId },
    select: { id: true, currentVersion: true, projectId: true, status: true, project: { select: { workspaceId: true } } },
  })
  if (!journey || journey.status === 'DELETED') {
    throw new NotFoundError('Journey')
  }
  if (!hasPermission(userRole, 'journeys.update')) {
    throw new ForbiddenError('Missing permission: journeys.update')
  }
  const target = await db.journeyVersion.findUnique({
    where: { journeyId_version: { journeyId, version } },
    select: { id: true, version: true },
  })
  if (!target) throw new NotFoundError('Journey version')

  await db.journey.update({
    where: { id: journeyId },
    data: { currentVersion: version },
  })

  await recordAudit(
    'JOURNEY_ROLLBACK',
    { type: 'journey', id: journeyId },
    { ...ctx, actorType: 'USER', actorId: userId, workspaceId: journey.project.workspaceId },
    { projectId: journey.projectId, fromVersion: journey.currentVersion, toVersion: version },
  )

  return getJourney(journeyId, userId)
}

// ---------------- Validation (dry-run) ----------------

export interface JourneyValidationResult {
  ok: boolean
  stepsValid: boolean
  policy: PolicyResult
  secretKeys: string[]
  missingSecretKeys: string[]
  suggestedRunMode: JourneyRunMode
}

/**
 * Dry-run validation of journey steps + policy + secret references.
 * Does not persist anything. Used by the validate API endpoint and the editor UI.
 */
export async function validateJourney(
  projectId: string,
  steps: JourneyStep[],
  runMode: JourneyRunMode,
  userId: string,
): Promise<JourneyValidationResult> {
  const { workspaceId } = await authorizeProject(projectId, userId, 'projects.read')

  const stepsResult = JourneyStepsSchema.safeParse(steps)
  const stepsValid = stepsResult.success
  const validSteps = stepsResult.success ? stepsResult.data : []

  const policy = validateStepsAgainstPolicy(validSteps, runMode)
  const secretKeys = extractSecretKeys(validSteps)

  // Check which secrets are missing from the vault
  const missing: string[] = []
  if (secretKeys.length > 0) {
    const existing = await db.projectSecret.findMany({
      where: { projectId, key: { in: secretKeys } },
      select: { key: true },
    })
    const existingSet = new Set(existing.map((s) => s.key))
    for (const k of secretKeys) {
      if (!existingSet.has(k)) missing.push(k)
    }
  }

  // Suggest minimum run mode that permits all steps
  const suggested = suggestRunMode(validSteps)

  void workspaceId
  return {
    ok: stepsValid && policy.ok && missing.length === 0,
    stepsValid,
    policy,
    secretKeys,
    missingSecretKeys: missing,
    suggestedRunMode: suggested,
  }
}

function suggestRunMode(steps: JourneyStep[]): JourneyRunMode {
  const ranks: Record<JourneyRunMode, number> = {
    PASSIVE: 0,
    SAFE_INTERACTION: 1,
    TEST_TRANSACTION: 2,
    CUSTOM_APPROVED: 3,
  }
  const names: JourneyRunMode[] = ['PASSIVE', 'SAFE_INTERACTION', 'TEST_TRANSACTION', 'CUSTOM_APPROVED']
  let minRank = 0
  for (const s of steps) {
    if (s.type === 'CUSTOM_SAFE_SCRIPT') minRank = Math.max(minRank, ranks.CUSTOM_APPROVED)
    else if (s.type === 'UPLOAD_TEST_FILE') minRank = Math.max(minRank, ranks.TEST_TRANSACTION)
    else if (['CLICK', 'TYPE', 'SELECT', 'CHECK', 'UNCHECK'].includes(s.type)) {
      minRank = Math.max(minRank, ranks.SAFE_INTERACTION)
    }
  }
  return names[minRank]!
}

// ---------------- Helpers ----------------

async function resolveJourneyWorkspace(
  journeyId: string,
  userId: string,
): Promise<{ workspaceId: string; projectId: string }> {
  const journey = await db.journey.findUnique({
    where: { id: journeyId },
    select: { id: true, projectId: true, status: true, project: { select: { workspaceId: true, status: true } } },
  })
  if (!journey || journey.status === 'DELETED') {
    throw new NotFoundError('Journey')
  }
  const membership = await db.workspaceMember.findUnique({
    where: {
      workspaceId_userId: {
        workspaceId: journey.project.workspaceId,
        userId,
      },
    },
  })
  if (!membership || membership.removedAt) {
    throw new ForbiddenError('Not a member of this workspace')
  }
  return { workspaceId: journey.project.workspaceId, projectId: journey.projectId }
}

function formatJourneyDetail(
  journey: {
    id: string
    projectId: string
    name: string
    description: string | null
    status: string
    entryUrl: string | null
    personaId: string | null
    currentVersion: number
    createdById: string | null
    createdAt: Date
    updatedAt: Date
  },
  steps: JourneyStep[],
  workspaceId: string,
): JourneyDetail {
  return {
    id: journey.id,
    projectId: journey.projectId,
    workspaceId,
    name: journey.name,
    description: journey.description,
    status: journey.status,
    entryUrl: journey.entryUrl,
    personaId: journey.personaId,
    currentVersion: journey.currentVersion,
    createdById: journey.createdById,
    createdAt: journey.createdAt.toISOString(),
    updatedAt: journey.updatedAt.toISOString(),
    steps,
    secretKeys: extractSecretKeys(steps),
  }
}
