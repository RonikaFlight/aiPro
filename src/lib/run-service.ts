/**
 * Run service — ProofPilot
 *
 * Creates, lists, gets, and cancels ScanRuns.
 * All run creation goes through `authorizeScan()` first.
 */
import { db } from './db'
import { env } from './env'
import { logger } from './logger'
import { AppError, ConflictError, ForbiddenError, NotFoundError, ValidationError } from './errors'
import { recordAudit, type AuditContext } from './audit'
import { hasPermission, type WorkspaceRole } from './permissions'
import { enqueue, cancelJob } from './queue'
import { recordUsageEvent } from './usage-service'
import { authorizeScan, type AuthorizeScanInput, type AuthorizedScan, type RunMode, type RunTrigger } from './scan-auth'
import { appendScanEvent } from './scan-events'

export interface CreateRunInput {
  projectId: string
  environmentId?: string
  targetUrl?: string
  runMode: RunMode
  trigger?: RunTrigger
  scanProfileId?: string
  userConfirmedDestructive?: boolean
  /** Optional override of the configured maxPages/maxDepth/timeout/viewports/locales/browsers. */
  config?: Partial<RunConfig>
}

export interface RunConfig {
  maxPages: number
  maxDepth: number
  timeoutMs: number
  viewports: string[]
  locales: string[]
  browsers: string[]
  analyzers: string[] | null // null = all
  journeyIds: string[] | null
}

const DEFAULT_CONFIG: RunConfig = {
  maxPages: env.SCAN_DEFAULT_MAX_PAGES,
  maxDepth: env.SCAN_DEFAULT_MAX_DEPTH,
  timeoutMs: env.SCAN_DEFAULT_TIMEOUT_MS,
  viewports: env.SCAN_DEFAULT_VIEWPORTS.split(','),
  locales: ['en'],
  browsers: ['chromium'],
  analyzers: null,
  journeyIds: null,
}

export interface CreateRunResult {
  runId: string
  status: string
  configSnapshot: Record<string, unknown>
  estimatedSeconds: number
}

/** Create + enqueue a scan run. Throws AppError on any failure. */
export async function createRun(
  input: CreateRunInput,
  userId: string,
  userRole: WorkspaceRole,
  ctx: Pick<AuditContext, 'ip' | 'userAgent' | 'requestId'>,
): Promise<CreateRunResult> {
  const trigger: RunTrigger = input.trigger ?? 'MANUAL'

  // Authorize (throws on failure — includes SSRF, domain verification, subscription, quota)
  const authorized = await authorizeScan(
    {
      projectId: input.projectId,
      environmentId: input.environmentId,
      targetUrl: input.targetUrl ?? '',
      runMode: input.runMode,
      trigger,
      scanProfileId: input.scanProfileId,
      userId,
      userRole,
      userConfirmedDestructive: input.userConfirmedDestructive,
    },
    ctx,
  )

  // Build config (defaults from env, overridable per-run within caps)
  const config: RunConfig = {
    ...DEFAULT_CONFIG,
    ...input.config,
    viewports: input.config?.viewports ?? DEFAULT_CONFIG.viewports,
    locales: input.config?.locales ?? [authorized.project.primaryLocale, ...authorized.project.supportedLocales].filter((v, i, a) => a.indexOf(v) === i).slice(0, 5),
    browsers: input.config?.browsers ?? DEFAULT_CONFIG.browsers,
    analyzers: input.config?.analyzers ?? null,
    journeyIds: input.config?.journeyIds ?? null,
  }

  // Cap to env-defined maximums
  config.maxPages = Math.min(config.maxPages, env.WORKER_MAX_PAGES_PER_RUN)
  config.maxDepth = Math.min(config.maxDepth, 5)
  config.timeoutMs = Math.min(config.timeoutMs, env.WORKER_BROWSER_TIMEOUT_MS)

  // Build the immutable config snapshot
  const configSnapshot = {
    targetUrl: authorized.normalizedTargetUrl,
    normalizedTargetUrl: authorized.normalizedTargetUrl,
    allowedOrigins: authorized.allowedOrigins,
    runMode: authorized.runMode,
    trigger: authorized.trigger,
    environment: {
      id: authorized.environment.id,
      type: authorized.environment.type,
      baseUrl: authorized.environment.baseUrl,
      scanMode: authorized.environment.scanMode,
      allowedHostnames: authorized.environment.allowedHostnames,
      networkRestrictions: authorized.environment.networkRestrictions,
    },
    project: {
      id: authorized.project.id,
      name: authorized.project.name,
      primaryLocale: authorized.project.primaryLocale,
      supportedLocales: authorized.project.supportedLocales,
      defaultTimezone: authorized.project.defaultTimezone,
      retentionDays: authorized.project.retentionDays,
    },
    workspace: {
      id: authorized.workspace.id,
      name: authorized.workspace.name,
      slug: authorized.workspace.slug,
    },
    scan: config,
    createdAt: new Date().toISOString(),
    triggeredBy: userId,
  }

  // Create the run
  const run = await db.scanRun.create({
    data: {
      projectId: authorized.projectId,
      environmentId: authorized.environmentId,
      scanProfileId: authorized.scanProfileId ?? null,
      workspaceId: authorized.workspaceId,
      status: 'QUEUED',
      trigger: authorized.trigger,
      runMode: authorized.runMode,
      triggeredById: userId,
      configSnapshot: JSON.stringify(configSnapshot),
    },
  })

  // Initial event
  await appendScanEvent(run.id, 'run.queued', {
    targetUrl: authorized.normalizedTargetUrl,
    runMode: authorized.runMode,
    trigger: authorized.trigger,
    config,
  })

  // Record usage (idempotent)
  await recordUsageEvent({
    workspaceId: authorized.workspaceId,
    eventType: 'RUN_CREATED',
    quantity: 1,
    projectId: authorized.projectId,
    runId: run.id,
    idempotencyKey: `run:${run.id}:created`,
  })

  // Enqueue for the worker
  await enqueue(
    'scan-orchestration',
    {
      runId: run.id,
      workspaceId: authorized.workspaceId,
      projectId: authorized.projectId,
      environmentId: authorized.environmentId,
      targetUrl: authorized.normalizedTargetUrl,
      allowedOrigins: authorized.allowedOrigins,
      runMode: authorized.runMode,
      trigger: authorized.trigger,
      config,
    },
    {
      workspaceId: authorized.workspaceId,
      correlationId: run.id,
      // PUBLIC runs are lower priority; paid runs are normal priority
      priority: authorized.trigger === 'PUBLIC' ? 1 : 5,
    },
  )

  await recordAudit(
    'RUN_CREATE',
    { type: 'scan_run', id: run.id },
    { ...ctx, actorType: 'USER', actorId: userId, workspaceId: authorized.workspaceId },
    { projectId: authorized.projectId, targetUrl: authorized.normalizedTargetUrl, runMode: authorized.runMode },
  )

  logger.info('Scan run created', {
    runId: run.id,
    projectId: authorized.projectId,
    workspaceId: authorized.workspaceId,
    targetUrl: authorized.normalizedTargetUrl,
    runMode: authorized.runMode,
    trigger: authorized.trigger,
  })

  const estimatedSeconds = Math.max(30, config.maxPages * 8)

  return {
    runId: run.id,
    status: 'QUEUED',
    configSnapshot,
    estimatedSeconds,
  }
}

export interface RunListResult {
  id: string
  status: string
  trigger: string
  runMode: string
  pagesDiscovered: number
  pagesAnalyzed: number
  findingsCount: number
  blockerCount: number
  score: number | null
  previousScore: number | null
  startedAt: string | null
  completedAt: string | null
  failedReason: string | null
  createdAt: string
  triggeredBy: { id: string; name: string | null; email: string } | null
  config: { targetUrl: string; maxPages: number; maxDepth: number; viewports: string[]; locales: string[] } | null
}

/** List runs for a project (workspace-scoped). */
export async function listRuns(
  projectId: string,
  userId: string,
  opts: { status?: string; limit?: number; cursor?: string } = {},
): Promise<{ runs: RunListResult[]; nextCursor: string | null }> {
  const project = await db.project.findUnique({ where: { id: projectId }, select: { workspaceId: true, status: true } })
  if (!project || project.status === 'DELETED') {
    throw new NotFoundError('Project')
  }
  const membership = await db.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId: project.workspaceId, userId } },
  })
  if (!membership || membership.removedAt) {
    throw new NotFoundError('Project')
  }
  if (!hasPermission(membership.role as WorkspaceRole, 'runs.read')) {
    throw new ForbiddenError('Missing permission: runs.read')
  }

  const limit = Math.min(opts.limit ?? 25, 100)
  const runs = await db.scanRun.findMany({
    where: {
      projectId,
      workspaceId: project.workspaceId,
      ...(opts.status ? { status: opts.status } : {}),
      ...(opts.cursor ? { id: { lt: opts.cursor } } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: limit + 1,
    include: { triggeredBy: { select: { id: true, name: true, email: true } } },
  })

  const nextCursor = runs.length > limit ? runs[limit - 1].id : null
  const slice = runs.slice(0, limit)

  return {
    runs: slice.map((r) => {
      let config: RunListResult['config'] = null
      try {
        const parsed = JSON.parse(r.configSnapshot) as { targetUrl?: string; scan?: { maxPages?: number; maxDepth?: number; viewports?: string[]; locales?: string[] } }
        config = {
          targetUrl: parsed.targetUrl ?? '',
          maxPages: parsed.scan?.maxPages ?? 0,
          maxDepth: parsed.scan?.maxDepth ?? 0,
          viewports: parsed.scan?.viewports ?? [],
          locales: parsed.scan?.locales ?? [],
        }
      } catch {
        // ignore parse errors
      }
      return {
        id: r.id,
        status: r.status,
        trigger: r.trigger,
        runMode: r.runMode,
        pagesDiscovered: r.pagesDiscovered,
        pagesAnalyzed: r.pagesAnalyzed,
        findingsCount: r.findingsCount,
        blockerCount: r.blockerCount,
        score: r.score,
        previousScore: r.previousScore,
        startedAt: r.startedAt?.toISOString() ?? null,
        completedAt: r.completedAt?.toISOString() ?? null,
        failedReason: r.failedReason,
        createdAt: r.createdAt.toISOString(),
        triggeredBy: r.triggeredBy
          ? { id: r.triggeredBy.id, name: r.triggeredBy.name, email: r.triggeredBy.email }
          : null,
        config,
      }
    }),
    nextCursor,
  }
}

export interface RunDetail extends RunListResult {
  environmentId: string | null
  scanProfileId: string | null
  configSnapshot: Record<string, unknown>
  events: Array<{ sequence: number; eventType: string; payload: Record<string, unknown>; createdAt: string }>
}

/** Get a single run with events. Workspace-scoped. */
export async function getRun(runId: string, userId: string): Promise<RunDetail> {
  const run = await db.scanRun.findUnique({
    where: { id: runId },
    include: {
      triggeredBy: { select: { id: true, name: true, email: true } },
      events: { orderBy: { sequence: 'asc' }, take: 200 },
    },
  })
  if (!run) throw new NotFoundError('Run')

  const membership = await db.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId: run.workspaceId, userId } },
  })
  if (!membership || membership.removedAt) {
    throw new NotFoundError('Run')
  }
  if (!hasPermission(membership.role as WorkspaceRole, 'runs.read')) {
    throw new ForbiddenError('Missing permission: runs.read')
  }

  let configSnapshot: Record<string, unknown> = {}
  try {
    configSnapshot = JSON.parse(run.configSnapshot) as Record<string, unknown>
  } catch {
    // ignore
  }

  let config: RunListResult['config'] = null
  const scan = (configSnapshot.scan ?? {}) as { maxPages?: number; maxDepth?: number; viewports?: string[]; locales?: string[] }
  config = {
    targetUrl: (configSnapshot.targetUrl as string) ?? '',
    maxPages: scan.maxPages ?? 0,
    maxDepth: scan.maxDepth ?? 0,
    viewports: scan.viewports ?? [],
    locales: scan.locales ?? [],
  }

  return {
    id: run.id,
    status: run.status,
    trigger: run.trigger,
    runMode: run.runMode,
    pagesDiscovered: run.pagesDiscovered,
    pagesAnalyzed: run.pagesAnalyzed,
    findingsCount: run.findingsCount,
    blockerCount: run.blockerCount,
    score: run.score,
    previousScore: run.previousScore,
    startedAt: run.startedAt?.toISOString() ?? null,
    completedAt: run.completedAt?.toISOString() ?? null,
    failedReason: run.failedReason,
    createdAt: run.createdAt.toISOString(),
    triggeredBy: run.triggeredBy
      ? { id: run.triggeredBy.id, name: run.triggeredBy.name, email: run.triggeredBy.email }
      : null,
    config,
    environmentId: run.environmentId,
    scanProfileId: run.scanProfileId,
    configSnapshot,
    events: run.events.map((e) => ({
      sequence: e.sequence,
      eventType: e.eventType,
      payload: JSON.parse(e.payloadJson) as Record<string, unknown>,
      createdAt: e.createdAt.toISOString(),
    })),
  }
}

/** Cancel a queued/running scan. Idempotent. */
export async function cancelRun(
  runId: string,
  userId: string,
  ctx: Pick<AuditContext, 'ip' | 'userAgent' | 'requestId'>,
): Promise<{ runId: string; status: string }> {
  const run = await db.scanRun.findUnique({ where: { id: runId } })
  if (!run) throw new NotFoundError('Run')

  const membership = await db.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId: run.workspaceId, userId } },
  })
  if (!membership || membership.removedAt) {
    throw new NotFoundError('Run')
  }
  if (!hasPermission(membership.role as WorkspaceRole, 'runs.cancel')) {
    throw new ForbiddenError('Missing permission: runs.cancel')
  }

  if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(run.status)) {
    return { runId: run.id, status: run.status }
  }

  // Mark cancelled + cancel any queued job
  await db.scanRun.update({
    where: { id: runId },
    data: {
      status: 'CANCELLED',
      cancelledAt: new Date(),
    },
  })
  // Cancel any waiting/active job for this run
  const jobs = await db.queueJob.findMany({
    where: { correlationId: runId, status: { in: ['WAITING', 'DELAYED', 'ACTIVE'] } },
    select: { id: true },
  })
  for (const j of jobs) {
    await cancelJob(j.id, 'run_cancelled_by_user')
  }

  await appendScanEvent(runId, 'run.cancelled', { by: userId })
  await recordAudit(
    'RUN_CANCEL',
    { type: 'scan_run', id: runId },
    { ...ctx, actorType: 'USER', actorId: userId, workspaceId: run.workspaceId },
    { runId },
  )

  return { runId, status: 'CANCELLED' }
}
