/**
 * Usage ledger service — ProofPilot
 *
 * Immutable, append-only ledger of metered usage events.
 * - Every event is unique by idempotencyKey (when provided), so retries are safe.
 * - Period aggregation rolls up counts into UsagePeriod for fast reads.
 * - Plan limit checks consult the current UsagePeriod against Plan limits.
 *
 * See DATABASE_DESIGN.md §"Usage ledger" and API_DESIGN.md §"Usage".
 */
import { db } from './db'
import { AppError, ConflictError, NotFoundError } from './errors'
import { logger } from './logger'

// Canonical metered event types. Stored as strings in SQLite.
export const USAGE_EVENTS = {
  RUN_CREATED: 'RUN_CREATED',
  PAGE_ANALYZED: 'PAGE_ANALYZED',
  AI_TOKENS: 'AI_TOKENS',
  REPORT_GENERATED: 'REPORT_GENERATED',
  JOURNEY_EXECUTED: 'JOURNEY_EXECUTED',
  ARTIFACT_STORED: 'ARTIFACT_STORED',
} as const

export type UsageEventType = (typeof USAGE_EVENTS)[keyof typeof USAGE_EVENTS]

export interface RecordUsageInput {
  workspaceId: string
  eventType: UsageEventType
  quantity?: number
  projectId?: string
  runId?: string
  idempotencyKey?: string
  metadata?: Record<string, unknown>
}

/**
 * Record a usage event. Idempotent: if `idempotencyKey` is provided and an
 * event with that key already exists, the existing record is returned unchanged
 * (no double-counting).
 *
 * The ledger is immutable — records are never updated or deleted except by
 * retention cleanup (which only deletes rows older than RETENTION_AUDIT_LOG_DAYS).
 */
export async function recordUsageEvent(input: RecordUsageInput) {
  const quantity = Math.max(1, Math.floor(input.quantity ?? 1))
  const metadataJson = input.metadata ? JSON.stringify(input.metadata) : null

  // Idempotency check (unique constraint on idempotencyKey)
  if (input.idempotencyKey) {
    const existing = await db.usageLedger.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
    })
    if (existing) {
      logger.debug('Usage event already recorded (idempotent)', {
        workspaceId: input.workspaceId,
        eventType: input.eventType,
        idempotencyKey: input.idempotencyKey,
      })
      return existing
    }
  }

  // Insert ledger row
  const ledger = await db.usageLedger.create({
    data: {
      workspaceId: input.workspaceId,
      projectId: input.projectId ?? null,
      runId: input.runId ?? null,
      eventType: input.eventType,
      quantity,
      idempotencyKey: input.idempotencyKey ?? null,
      metadataJson,
    },
  })

  // Roll up into current usage period
  await incrementUsagePeriod(input.workspaceId, input.eventType, quantity)

  return ledger
}

/**
 * Find or create the current billing-period UsagePeriod row.
 *
 * Period boundaries come from the workspace's Subscription:
 * - If the subscription has currentPeriodStart/End, use those.
 * - Otherwise default to calendar month (UTC).
 */
export async function getCurrentUsagePeriod(workspaceId: string) {
  const subscription = await db.subscription.findFirst({
    where: { workspaceId },
    orderBy: { createdAt: 'desc' },
    include: { plan: true },
  })

  const now = new Date()
  let periodStart: Date
  let periodEnd: Date

  if (subscription?.currentPeriodStart && subscription?.currentPeriodEnd) {
    // If the stored period has elapsed, roll forward to the next month
    if (subscription.currentPeriodEnd < now) {
      const newEnd = new Date(subscription.currentPeriodEnd)
      while (newEnd < now) {
        newEnd.setMonth(newEnd.getMonth() + 1)
      }
      const newStart = new Date(newEnd)
      newStart.setMonth(newStart.getMonth() - 1)
      periodStart = newStart
      periodEnd = newEnd
    } else {
      periodStart = subscription.currentPeriodStart
      periodEnd = subscription.currentPeriodEnd
    }
  } else {
    // Default: calendar month UTC
    periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
    periodEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
  }

  // Upsert the UsagePeriod row (unique on [workspaceId, periodStart])
  const period = await db.usagePeriod.upsert({
    where: {
      workspaceId_periodStart: { workspaceId, periodStart },
    },
    update: {},
    create: {
      workspaceId,
      periodStart,
      periodEnd,
    },
  })

  return { period, subscription }
}

/** Increment the period totals for a given event type. */
async function incrementUsagePeriod(
  workspaceId: string,
  eventType: UsageEventType,
  quantity: number,
) {
  const { period } = await getCurrentUsagePeriod(workspaceId)
  switch (eventType) {
    case USAGE_EVENTS.RUN_CREATED:
      await db.usagePeriod.update({
        where: { id: period.id },
        data: { runsUsed: { increment: quantity } },
      })
      break
    case USAGE_EVENTS.PAGE_ANALYZED:
      await db.usagePeriod.update({
        where: { id: period.id },
        data: { pagesAnalyzed: { increment: quantity } },
      })
      break
    case USAGE_EVENTS.AI_TOKENS:
      await db.usagePeriod.update({
        where: { id: period.id },
        data: { aiTokensUsed: { increment: quantity } },
      })
      break
    case USAGE_EVENTS.REPORT_GENERATED:
      await db.usagePeriod.update({
        where: { id: period.id },
        data: { reportsGenerated: { increment: quantity } },
      })
      break
    default:
      // Other event types don't roll into a period column
      return
  }
}

export interface UsageSummary {
  period: {
    id: string
    periodStart: string
    periodEnd: string
    runsUsed: number
    pagesAnalyzed: number
    aiTokensUsed: number
    reportsGenerated: number
  }
  limits: {
    maxRunsPerMonth: number | null
    maxPagesPerRun: number | null
    aiEnrichment: boolean
    planCode: string | null
    planName: string | null
  }
  /** True if any limit is exceeded. */
  exceeded: {
    runs: boolean
    pagesThisRun: boolean
  }
}

/** Get the current period totals + plan limits for a workspace. */
export async function getUsageSummary(workspaceId: string): Promise<UsageSummary> {
  const { period, subscription } = await getCurrentUsagePeriod(workspaceId)

  const plan = subscription?.plan
  const maxRunsPerMonth = plan?.maxRunsPerMonth ?? null
  const maxPagesPerRun = plan?.maxPagesPerRun ?? null

  return {
    period: {
      id: period.id,
      periodStart: period.periodStart.toISOString(),
      periodEnd: period.periodEnd.toISOString(),
      runsUsed: period.runsUsed,
      pagesAnalyzed: period.pagesAnalyzed,
      aiTokensUsed: period.aiTokensUsed,
      reportsGenerated: period.reportsGenerated,
    },
    limits: {
      maxRunsPerMonth,
      maxPagesPerRun,
      aiEnrichment: plan?.aiEnrichment ?? false,
      planCode: plan?.code ?? null,
      planName: plan?.name ?? null,
    },
    exceeded: {
      runs: maxRunsPerMonth != null && period.runsUsed >= maxRunsPerMonth,
      pagesThisRun: false,
    },
  }
}

/** Check whether a workspace can start a new run. Throws AppError(402) if exceeded. */
export async function assertCanStartRun(workspaceId: string): Promise<void> {
  const summary = await getUsageSummary(workspaceId)
  if (summary.exceeded.runs) {
    throw new AppError(
      `Plan limit reached: ${summary.limits.maxRunsPerMonth} runs per month on ${summary.limits.planCode} plan`,
      402,
      'plan_limit_runs',
      'https://proofpilot.app/problems/plan-limit-runs',
      { runsUsed: summary.period.runsUsed, maxRuns: summary.limits.maxRunsPerMonth },
    )
  }
}

/** Check whether a run can analyze another page. Throws AppError(402) if exceeded. */
export async function assertCanAnalyzePage(
  workspaceId: string,
  pagesAlreadyInRun: number,
): Promise<void> {
  const summary = await getUsageSummary(workspaceId)
  if (summary.limits.maxPagesPerRun != null && pagesAlreadyInRun >= summary.limits.maxPagesPerRun) {
    throw new AppError(
      `Plan limit reached: ${summary.limits.maxPagesPerRun} pages per run on ${summary.limits.planCode} plan`,
      402,
      'plan_limit_pages',
      'https://proofpilot.app/problems/plan-limit-pages',
      { pagesAlreadyInRun, maxPagesPerRun: summary.limits.maxPagesPerRun },
    )
  }
}

export interface ListUsageEventsOptions {
  eventType?: UsageEventType
  projectId?: string
  runId?: string
  startDate?: Date
  endDate?: Date
  limit?: number
  cursor?: string // id of the last item on the previous page
}

export interface ListUsageEventsResult {
  items: Array<{
    id: string
    eventType: string
    quantity: number
    projectId: string | null
    runId: string | null
    idempotencyKey: string | null
    metadata: Record<string, unknown> | null
    createdAt: string
  }>
  nextCursor: string | null
}

/** Paginated list of usage events for a workspace (newest first). */
export async function listUsageEvents(
  workspaceId: string,
  opts: ListUsageEventsOptions = {},
): Promise<ListUsageEventsResult> {
  const limit = Math.min(100, Math.max(1, opts.limit ?? 50))
  const where: Record<string, unknown> = { workspaceId }
  if (opts.eventType) where.eventType = opts.eventType
  if (opts.projectId) where.projectId = opts.projectId
  if (opts.runId) where.runId = opts.runId
  if (opts.startDate || opts.endDate) {
    where.createdAt = {}
    if (opts.startDate) (where.createdAt as Record<string, unknown>).gte = opts.startDate
    if (opts.endDate) (where.createdAt as Record<string, unknown>).lte = opts.endDate
  }
  if (opts.cursor) {
    where.id = { lt: opts.cursor }
  }

  const rows = await db.usageLedger.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: limit + 1,
  })

  const items = rows.slice(0, limit).map((r) => ({
    id: r.id,
    eventType: r.eventType,
    quantity: r.quantity,
    projectId: r.projectId,
    runId: r.runId,
    idempotencyKey: r.idempotencyKey,
    metadata: r.metadataJson ? (JSON.parse(r.metadataJson) as Record<string, unknown>) : null,
    createdAt: r.createdAt.toISOString(),
  }))

  return {
    items,
    nextCursor: rows.length > limit ? rows[limit - 1].id : null,
  }
}

/**
 * Aggregate usage by event type for a period. Used by reports and dashboards.
 */
export async function aggregateUsageByType(
  workspaceId: string,
  startDate: Date,
  endDate: Date,
): Promise<Array<{ eventType: string; totalQuantity: number; eventCount: number }>> {
  const rows = await db.usageLedger.groupBy({
    by: ['eventType'],
    where: {
      workspaceId,
      createdAt: { gte: startDate, lte: endDate },
    },
    _sum: { quantity: true },
    _count: { id: true },
  })
  return rows.map((r) => ({
    eventType: r.eventType,
    totalQuantity: r._sum.quantity ?? 0,
    eventCount: r._count.id,
  }))
}
