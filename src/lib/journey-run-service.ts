/**
 * Journey run service — ProofPilot
 *
 * Creates, lists, gets, and cancels journey runs (executions).
 * Each journey run is enqueued as a `journey-execution` queue job, processed
 * by the worker mini-service.
 *
 * Journey runs can be:
 *   - Triggered manually (POST /api/v1/journeys/[id]/runs) — requires journeys.create
 *   - Triggered by a scan run (POST /api/v1/projects/[id]/runs with journeyIds)
 *   - Triggered by a schedule (Phase 11)
 *
 * See SECURITY_MODEL.md §"Journeys".
 */
import { db } from './db'
import { env } from './env'
import { logger } from './logger'
import {
  AppError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from './errors'
import { recordAudit, type AuditContext } from './audit'
import { hasPermission, type WorkspaceRole } from './permissions'
import { enqueue } from './queue'
import { appendScanEvent } from './scan-events'
import { parseSteps } from './journey-types'
import { validateStepsAgainstPolicy } from './journey-policy'
import type { RunMode } from './scan-auth'

// ---------------- Types ----------------

export interface CreateJourneyRunInput {
  journeyId: string
  /** Optional parent scan run (when triggered as part of a scan). */
  scanRunId?: string
  /** Override the journey's entry URL (must be on a verified domain). */
  targetUrl?: string
  /** Override the project's environment. */
  environmentId?: string
  /** Override the run mode (defaults to the parent scan run's mode, or SAFE_INTERACTION for standalone). */
  runMode?: RunMode
  trigger?: 'MANUAL' | 'SCAN' | 'SCHEDULED'
}

export interface JourneyRunSummary {
  id: string
  journeyId: string
  journeyName: string
  journeyVersion: number
  scanRunId: string | null
  projectId: string
  status: string
  runMode: string
  trigger: string
  targetUrl: string
  viewport: string | null
  locale: string | null
  browser: string
  stepsTotal: number
  stepsPassed: number
  stepsFailed: number
  stepsSkipped: number
  startedAt: string | null
  completedAt: string | null
  failedReason: string | null
  createdAt: string
}

export interface JourneyRunDetail extends JourneyRunSummary {
  workspaceId: string
  environmentId: string | null
  personaId: string | null
  triggeredById: string | null
  stepResults: Array<{
    id: string
    stepIndex: number
    stepType: string
    stepLabel: string | null
    status: string
    durationMs: number
    error: string | null
    beforeScreenshotId: string | null
    afterScreenshotId: string | null
    consoleErrors: number
    networkErrors: number
    metadata: Record<string, unknown> | null
    createdAt: string
  }>
}

// ---------------- Create + enqueue ----------------

export async function createJourneyRun(
  input: CreateJourneyRunInput,
  userId: string,
  userRole: WorkspaceRole,
  ctx: Pick<AuditContext, 'ip' | 'userAgent' | 'requestId'>,
): Promise<{ journeyRunId: string; status: string }> {
  if (!hasPermission(userRole, 'runs.create')) {
    throw new ForbiddenError('Missing permission: runs.create')
  }

  // Load journey + project + workspace + environment
  const journey = await db.journey.findUnique({
    where: { id: input.journeyId },
    include: {
      project: {
        include: {
          workspace: true,
          verifiedDomains: { where: { verificationStatus: 'VERIFIED' }, select: { domainNormalized: true } },
          environments: { where: { enabled: true } },
        },
      },
    },
  })
  if (!journey || journey.status === 'DELETED') {
    throw new NotFoundError('Journey')
  }
  if (journey.status !== 'ACTIVE') {
    throw new ConflictError(`Journey must be ACTIVE to run (current: ${journey.status})`)
  }

  const workspaceId = journey.project.workspaceId

  // Confirm membership (already implied by userRole, but double-check)
  const membership = await db.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } },
  })
  if (!membership || membership.removedAt) {
    throw new ForbiddenError('Not a member of this workspace')
  }

  // Resolve run mode
  let runMode: RunMode = input.runMode ?? 'SAFE_INTERACTION'
  if (input.scanRunId) {
    const parentRun = await db.scanRun.findUnique({
      where: { id: input.scanRunId },
      select: { runMode: true, workspaceId: true, status: true },
    })
    if (!parentRun) throw new NotFoundError('Parent scan run')
    if (parentRun.workspaceId !== workspaceId) {
      throw new ForbiddenError('Parent scan run belongs to a different workspace')
    }
    // Inherit the parent's run mode (escalation only — never down)
    const ranks: Record<RunMode, number> = { PASSIVE: 0, SAFE_INTERACTION: 1, TEST_TRANSACTION: 2, CUSTOM_APPROVED: 3 }
    if (ranks[parentRun.runMode as RunMode] > ranks[runMode]) {
      runMode = parentRun.runMode as RunMode
    }
  }

  // Resolve environment
  let environment = input.environmentId
    ? journey.project.environments.find((e) => e.id === input.environmentId)
    : journey.project.environments.find((e) => e.type === 'PRODUCTION') ?? journey.project.environments[0]
  if (!environment) {
    throw new ConflictError('No enabled environment for this project')
  }
  // Environment's scanMode must permit the runMode
  const envModeRank: Record<string, number> = { PASSIVE: 0, SAFE_INTERACTION: 1, TEST_TRANSACTION: 2, CUSTOM_APPROVED: 3 }
  if ((envModeRank[environment.scanMode] ?? 0) < envModeRank[runMode]) {
    throw new ForbiddenError(
      `Environment scan mode (${environment.scanMode}) does not permit run mode (${runMode})`,
    )
  }

  // Resolve target URL
  let targetUrl = input.targetUrl ?? journey.entryUrl ?? environment.baseUrl
  if (!targetUrl) {
    throw new ValidationError('Target URL is required (journey.entryUrl or environment.baseUrl)')
  }
  if (targetUrl.startsWith('/')) {
    targetUrl = new URL(targetUrl, environment.baseUrl).href
  }
  // Verify target URL origin is a verified domain
  let targetOrigin: string
  try {
    targetOrigin = new URL(targetUrl).origin
  } catch {
    throw new ValidationError('Invalid target URL')
  }
  const allowedOrigins = new Set<string>()
  try {
    allowedOrigins.add(new URL(environment.baseUrl).origin)
  } catch { /* ignore */ }
  for (const vd of journey.project.verifiedDomains) {
    const scheme = vd.domainNormalized === 'localhost' && env.APP_ENV === 'development' ? 'http' : 'https'
    allowedOrigins.add(`${scheme}://${vd.domainNormalized}`)
  }
  if (environment.allowedHostnames) {
    for (const h of environment.allowedHostnames.split(',').map((s) => s.trim()).filter(Boolean)) {
      const scheme = h === 'localhost' && env.APP_ENV === 'development' ? 'http' : 'https'
      allowedOrigins.add(`${scheme}://${h}`)
    }
  }
  if (!allowedOrigins.has(targetOrigin)) {
    throw new ForbiddenError(
      `Target origin ${targetOrigin} is not in this project's verified domains`,
    )
  }

  // Load + validate the journey's current version's steps
  const version = await db.journeyVersion.findUnique({
    where: { journeyId_version: { journeyId: journey.id, version: journey.currentVersion } },
  })
  if (!version) {
    throw new AppError('Journey version missing', 500, 'journey_version_missing')
  }
  const steps = parseSteps(version.stepsJson)

  // Validate against the safe-action policy
  const policy = validateStepsAgainstPolicy(steps, runMode)
  if (!policy.ok) {
    throw new ValidationError('Journey steps violate the safe-action policy', {
      violations: policy.violations,
    })
  }

  // Create the JourneyRun record
  const journeyRun = await db.journeyRun.create({
    data: {
      journeyId: journey.id,
      journeyVersion: journey.currentVersion,
      scanRunId: input.scanRunId ?? null,
      projectId: journey.projectId,
      workspaceId,
      environmentId: environment.id,
      personaId: journey.personaId,
      status: 'QUEUED',
      runMode,
      trigger: input.trigger ?? (input.scanRunId ? 'SCAN' : 'MANUAL'),
      targetUrl,
      viewport: 'desktop:1366x768', // default; persona override applied in worker
      locale: journey.project.primaryLocale,
      browser: 'chromium',
      stepsTotal: steps.length,
      triggeredById: userId,
    },
  })

  // Enqueue the journey-execution job
  const jobId = await enqueue(
    'journey-execution',
    {
      journeyRunId: journeyRun.id,
      journeyId: journey.id,
      journeyVersion: journey.currentVersion,
      scanRunId: input.scanRunId ?? null,
      projectId: journey.projectId,
      workspaceId,
      environmentId: environment.id,
      personaId: journey.personaId,
      runMode,
      trigger: journeyRun.trigger,
      targetUrl,
      allowedOrigins: Array.from(allowedOrigins),
      locale: journey.project.primaryLocale,
      viewport: 'desktop:1366x768',
      timezone: journey.project.defaultTimezone,
    },
    {
      workspaceId,
      correlationId: `journey-run-${journeyRun.id}`,
      idempotencyKey: `journey-run-${journeyRun.id}`,
      maxAttempts: 1, // journeys are non-retryable — they may have side effects
    },
  )

  // Emit scan event (linked to parent scan run if present)
  if (input.scanRunId) {
    await appendScanEvent(input.scanRunId, 'journey.queued', {
      journeyId: journey.id,
      journeyRunId: journeyRun.id,
      jobId,
      stepCount: steps.length,
    })
  }

  await recordAudit(
    'JOURNEY_RUN_CREATE',
    { type: 'journey_run', id: journeyRun.id },
    { ...ctx, actorType: 'USER', actorId: userId, workspaceId },
    { projectId: journey.projectId, journeyId: journey.id, version: journey.currentVersion, runMode, targetUrl, jobId },
  )

  logger.info('Journey run enqueued', {
    journeyRunId: journeyRun.id,
    journeyId: journey.id,
    jobId,
    stepCount: steps.length,
    runMode,
  })

  return { journeyRunId: journeyRun.id, status: 'QUEUED' }
}

// ---------------- List + get ----------------

export async function listJourneyRuns(
  journeyId: string,
  userId: string,
  opts: { status?: string; limit?: number; cursor?: string } = {},
): Promise<{ items: JourneyRunSummary[]; nextCursor: string | null }> {
  const journey = await db.journey.findUnique({
    where: { id: journeyId },
    select: { id: true, project: { select: { workspaceId: true } } },
  })
  if (!journey) throw new NotFoundError('Journey')
  const membership = await db.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId: journey.project.workspaceId, userId } },
  })
  if (!membership || membership.removedAt) {
    throw new ForbiddenError('Not a member of this workspace')
  }

  const limit = Math.min(opts.limit ?? 30, 100)
  const runs = await db.journeyRun.findMany({
    where: {
      journeyId,
      status: opts.status,
    },
    orderBy: { createdAt: 'desc' },
    take: limit + 1,
    cursor: opts.cursor ? { id: opts.cursor } : undefined,
    skip: opts.cursor ? 1 : 0,
    include: { journey: { select: { name: true } } },
  })

  const hasMore = runs.length > limit
  const items = runs.slice(0, limit).map((r) => formatSummary(r, r.journey.name))

  return {
    items,
    nextCursor: hasMore ? items[items.length - 1]!.id : null,
  }
}

export async function getJourneyRun(
  journeyRunId: string,
  userId: string,
): Promise<JourneyRunDetail> {
  const run = await db.journeyRun.findUnique({
    where: { id: journeyRunId },
    include: {
      journey: { select: { name: true, project: { select: { workspaceId: true } } } },
      stepResults: { orderBy: { stepIndex: 'asc' } },
    },
  })
  if (!run) throw new NotFoundError('Journey run')

  const membership = await db.workspaceMember.findUnique({
    where: {
      workspaceId_userId: {
        workspaceId: run.journey.project.workspaceId,
        userId,
      },
    },
  })
  if (!membership || membership.removedAt) {
    throw new ForbiddenError('Not a member of this workspace')
  }

  return {
    id: run.id,
    journeyId: run.journeyId,
    journeyName: run.journey.name,
    journeyVersion: run.journeyVersion,
    scanRunId: run.scanRunId,
    projectId: run.projectId,
    workspaceId: run.workspaceId,
    environmentId: run.environmentId,
    personaId: run.personaId,
    status: run.status,
    runMode: run.runMode,
    trigger: run.trigger,
    targetUrl: run.targetUrl,
    viewport: run.viewport,
    locale: run.locale,
    browser: run.browser,
    stepsTotal: run.stepsTotal,
    stepsPassed: run.stepsPassed,
    stepsFailed: run.stepsFailed,
    stepsSkipped: run.stepsSkipped,
    startedAt: run.startedAt?.toISOString() ?? null,
    completedAt: run.completedAt?.toISOString() ?? null,
    failedReason: run.failedReason,
    triggeredById: run.triggeredById,
    createdAt: run.createdAt.toISOString(),
    stepResults: run.stepResults.map((s) => ({
      id: s.id,
      stepIndex: s.stepIndex,
      stepType: s.stepType,
      stepLabel: s.stepLabel,
      status: s.status,
      durationMs: s.durationMs,
      error: s.error,
      beforeScreenshotId: s.beforeScreenshotId,
      afterScreenshotId: s.afterScreenshotId,
      consoleErrors: s.consoleErrors,
      networkErrors: s.networkErrors,
      metadata: s.metadataJson ? (JSON.parse(s.metadataJson) as Record<string, unknown>) : null,
      createdAt: s.createdAt.toISOString(),
    })),
  }
}

export async function cancelJourneyRun(
  journeyRunId: string,
  userId: string,
  userRole: WorkspaceRole,
  ctx: Pick<AuditContext, 'ip' | 'userAgent' | 'requestId'>,
): Promise<void> {
  if (!hasPermission(userRole, 'runs.cancel')) {
    throw new ForbiddenError('Missing permission: runs.cancel')
  }
  const run = await db.journeyRun.findUnique({
    where: { id: journeyRunId },
    select: { id: true, status: true, workspaceId: true, projectId: true },
  })
  if (!run) throw new NotFoundError('Journey run')
  const membership = await db.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId: run.workspaceId, userId } },
  })
  if (!membership || membership.removedAt) {
    throw new ForbiddenError('Not a member of this workspace')
  }
  if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(run.status)) {
    return // idempotent
  }
  await db.journeyRun.update({
    where: { id: journeyRunId },
    data: { status: 'CANCELLED', completedAt: new Date() },
  })
  await recordAudit(
    'JOURNEY_RUN_CANCEL',
    { type: 'journey_run', id: journeyRunId },
    { ...ctx, actorType: 'USER', actorId: userId, workspaceId: run.workspaceId },
    { projectId: run.projectId },
  )
}

// ---------------- Helpers ----------------

function formatSummary(
  r: {
    id: string
    journeyId: string
    journeyVersion: number
    scanRunId: string | null
    projectId: string
    status: string
    runMode: string
    trigger: string
    targetUrl: string
    viewport: string | null
    locale: string | null
    browser: string
    stepsTotal: number
    stepsPassed: number
    stepsFailed: number
    stepsSkipped: number
    startedAt: Date | null
    completedAt: Date | null
    failedReason: string | null
    createdAt: Date
  },
  journeyName: string,
): JourneyRunSummary {
  return {
    id: r.id,
    journeyId: r.journeyId,
    journeyName,
    journeyVersion: r.journeyVersion,
    scanRunId: r.scanRunId,
    projectId: r.projectId,
    status: r.status,
    runMode: r.runMode,
    trigger: r.trigger,
    targetUrl: r.targetUrl,
    viewport: r.viewport,
    locale: r.locale,
    browser: r.browser,
    stepsTotal: r.stepsTotal,
    stepsPassed: r.stepsPassed,
    stepsFailed: r.stepsFailed,
    stepsSkipped: r.stepsSkipped,
    startedAt: r.startedAt?.toISOString() ?? null,
    completedAt: r.completedAt?.toISOString() ?? null,
    failedReason: r.failedReason,
    createdAt: r.createdAt.toISOString(),
  }
}
