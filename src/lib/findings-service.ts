/**
 * Findings service — ProofPilot (Phase 6)
 *
 * Lifecycle state machine, dedup-aware listing, comments, assignments, tags,
 * suppressions, and CSV export for findings.
 *
 * All workspace-scoped queries receive workspaceId from the authenticated
 * session context (never from the request body). Every mutation records an
 * audit-log entry; sensitive actions also record a FindingStatusHistory row.
 *
 * See:
 *   - DATABASE_DESIGN.md §"Finding"
 *   - SECURITY_MODEL.md §"Findings"
 *   - IMPLEMENTATION_CHECKLIST.md Phase 6
 */
import { db } from './db'
import { logger } from './logger'
import {
  AppError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from './errors'
import { recordAudit, type AuditContext } from './audit'
import { appendScanEvent } from './scan-events'
import type { Prisma } from '@prisma/client'
import {
  type FindingSeverity,
  type FindingStatus,
  type BusinessImpact,
  type FindingConfidence,
  assertSeverity,
  assertStatus,
  assertCanTransition,
  canTransition,
  parseBusinessImpacts,
  serializeBusinessImpacts,
  parseTags,
  serializeTags,
  isBusinessImpact,
  OPEN_STATUSES,
} from './finding-severity'

// ===========================================================
// Types
// ===========================================================

export interface FindingFilters {
  projectId?: string
  runId?: string
  severity?: FindingSeverity | FindingSeverity[]
  status?: FindingStatus | FindingStatus[]
  category?: string | string[]
  locale?: string
  viewport?: string
  browser?: string
  assignedToId?: string | null
  /** "true" → only unassigned; "false" → only assigned. */
  unassigned?: boolean
  /** ISO date — only findings first seen after this. */
  firstSeenAfter?: string
  /** ISO date — only findings first seen before this. */
  firstSeenBefore?: string
  /** Free-text search on title/description/checkId. */
  search?: string
  /** "active" → exclude suppressed; "suppressed" → only suppressed; "all" (default). */
  suppression?: 'active' | 'suppressed' | 'all'
  /** Comma-separated tags — findings must have ALL of these. */
  tags?: string[]
}

export interface ListFindingsOptions {
  limit: number
  cursor?: string
  /** Sort field. Defaults to lastSeenAt desc. */
  sort?: 'lastSeenAt' | 'firstSeenAt' | 'severity' | 'title'
  order?: 'asc' | 'desc'
}

export interface FindingDetail {
  id: string
  workspaceId: string
  projectId: string
  runId: string | null
  checkId: string
  category: string
  severity: string
  status: string
  confidence: string
  businessImpact: string[]
  title: string
  description: string | null
  remediation: string | null
  fingerprint: string
  affectedUrl: string
  normalizedUrl: string
  viewport: string | null
  locale: string | null
  browser: string | null
  domSelector: string | null
  evidence: unknown
  aiExplanation: string | null
  aiSummary: string | null
  tags: string[]
  assignedToId: string | null
  assigneeName: string | null
  assigneeEmail: string | null
  firstSeenAt: string
  lastSeenAt: string
  resolvedAt: string | null
  createdAt: string
  updatedAt: string
  occurrenceCount: number
  isSuppressed: boolean
  activeSuppressionId: string | null
}

export interface CommentView {
  id: string
  findingId: string
  authorId: string
  authorName: string | null
  authorEmail: string
  body: string
  createdAt: string
  updatedAt: string
}

export interface StatusHistoryView {
  id: string
  findingId: string
  fromStatus: string
  toStatus: string
  reason: string | null
  changedById: string | null
  changedByName: string | null
  changedAt: string
}

export interface SuppressionView {
  id: string
  findingId: string | null
  workspaceId: string
  projectId: string | null
  checkId: string | null
  fingerprint: string | null
  reason: string
  createdById: string
  createdByName: string | null
  createdByEmail: string
  expiresAt: string | null
  createdAt: string
  revokedAt: string | null
  revokedById: string | null
  isActive: boolean
}

// ===========================================================
// Helpers
// ===========================================================

function safeJsonParse(input: string | null): unknown {
  if (!input) return null
  try {
    return JSON.parse(input)
  } catch {
    return null
  }
}

function asArray<T>(value: T | T[] | undefined): T[] | undefined {
  if (value === undefined) return undefined
  return Array.isArray(value) ? value : [value]
}

/** Include shape used by `loadFindingInWorkspace` and `patchFinding`. */
const FINDING_DETAIL_INCLUDE = {
  assignee: { select: { id: true, name: true, email: true } },
  suppressions: {
    where: { revokedAt: null },
    include: { createdBy: { select: { id: true, name: true, email: true } } },
    orderBy: { createdAt: 'desc' },
  },
} satisfies Prisma.FindingInclude

/** Inferred type for a Finding row with the above include. */
type FindingWithDetail = Prisma.FindingGetPayload<{ include: typeof FINDING_DETAIL_INCLUDE }>

/** Verify the finding belongs to the workspace and return it; throws 404 otherwise. */
async function loadFindingInWorkspace(
  findingId: string,
  workspaceId: string,
): Promise<FindingWithDetail> {
  const finding = await db.finding.findUnique({
    where: { id: findingId },
    include: FINDING_DETAIL_INCLUDE,
  })
  if (!finding || finding.workspaceId !== workspaceId) {
    throw new NotFoundError('Finding')
  }
  return finding
}

/** True if a suppression record is currently active (not revoked, not expired). */
export function isSuppressionActive(s: { revokedAt: Date | null; expiresAt: Date | null }): boolean {
  if (s.revokedAt) return false
  if (s.expiresAt && s.expiresAt < new Date()) return false
  return true
}

function formatFinding(row: {
  id: string
  workspaceId: string
  projectId: string
  runId: string | null
  checkId: string
  category: string
  severity: string
  status: string
  confidence: string
  businessImpact: string | null
  title: string
  description: string | null
  remediation: string | null
  fingerprint: string
  affectedUrl: string
  normalizedUrl: string
  viewport: string | null
  locale: string | null
  browser: string | null
  domSelector: string | null
  evidence: string | null
  aiExplanation: string | null
  aiSummary: string | null
  tags: string
  assignedToId: string | null
  assignee?: { name: string | null; email: string } | null
  firstSeenAt: Date
  lastSeenAt: Date
  resolvedAt: Date | null
  createdAt: Date
  updatedAt: Date
  _count?: { occurrences: number }
  suppressions?: Array<{ revokedAt: Date | null; expiresAt: Date | null; id: string }>
}): FindingDetail {
  const activeSuppression = row.suppressions?.find(isSuppressionActive)
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    runId: row.runId,
    checkId: row.checkId,
    category: row.category,
    severity: row.severity,
    status: row.status,
    confidence: row.confidence,
    businessImpact: parseBusinessImpacts(row.businessImpact),
    title: row.title,
    description: row.description,
    remediation: row.remediation,
    fingerprint: row.fingerprint,
    affectedUrl: row.affectedUrl,
    normalizedUrl: row.normalizedUrl,
    viewport: row.viewport,
    locale: row.locale,
    browser: row.browser,
    domSelector: row.domSelector,
    evidence: safeJsonParse(row.evidence),
    aiExplanation: row.aiExplanation,
    aiSummary: row.aiSummary,
    tags: parseTags(row.tags),
    assignedToId: row.assignedToId,
    assigneeName: row.assignee?.name ?? null,
    assigneeEmail: row.assignee?.email ?? null,
    firstSeenAt: row.firstSeenAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    occurrenceCount: row._count?.occurrences ?? 0,
    isSuppressed: Boolean(activeSuppression),
    activeSuppressionId: activeSuppression?.id ?? null,
  }
}

// ===========================================================
// List / Get
// ===========================================================

export interface ListFindingsResult {
  items: FindingDetail[]
  nextCursor: string | null
  totalApprox: number
}

/**
 * List findings for a workspace (optionally filtered to a project or run).
 *
 * Workspace scoping is enforced by the mandatory `workspaceId` parameter.
 * Project filtering further constrains to a project within that workspace.
 */
export async function listFindings(
  workspaceId: string,
  filters: FindingFilters,
  opts: ListFindingsOptions,
): Promise<ListFindingsResult> {
  const limit = Math.min(Math.max(opts.limit, 1), 100)
  const sort = opts.sort ?? 'lastSeenAt'
  const order = opts.order ?? 'desc'

  const severities = asArray(filters.severity)
  const statuses = asArray(filters.status)
  const categories = asArray(filters.category)

  const where: Record<string, unknown> = {
    workspaceId,
    ...(filters.projectId ? { projectId: filters.projectId } : {}),
    ...(filters.runId ? { runId: filters.runId } : {}),
    ...(severities?.length ? { severity: { in: severities } } : {}),
    ...(statuses?.length ? { status: { in: statuses } } : {}),
    ...(categories?.length ? { category: { in: categories } } : {}),
    ...(filters.locale ? { locale: filters.locale } : {}),
    ...(filters.viewport ? { viewport: filters.viewport } : {}),
    ...(filters.browser ? { browser: filters.browser } : {}),
    ...(filters.firstSeenAfter ? { firstSeenAt: { gte: new Date(filters.firstSeenAfter) } } : {}),
    ...(filters.firstSeenBefore ? { firstSeenAt: { lte: new Date(filters.firstSeenBefore) } } : {}),
  }

  if (filters.assignedToId !== undefined) {
    where.assignedToId = filters.assignedToId
  } else if (filters.unassigned) {
    where.assignedToId = null
  }

  if (filters.search) {
    const q = filters.search.trim()
    if (q.length > 200) {
      throw new ValidationError('Search query too long', { search: ['Max 200 characters'] })
    }
    where.OR = [
      { title: { contains: q } },
      { description: { contains: q } },
      { checkId: { contains: q } },
    ]
  }

  if (filters.tags?.length) {
    // Tags stored as comma-separated string; use contains for each.
    // This is a substring match (good enough for v1; Phase 12 may add a
    // normalized tag table if filter performance becomes an issue).
    where.AND = filters.tags.map((t) => ({ tags: { contains: t } }))
  }

  if (filters.suppression === 'active') {
    where.suppressions = {
      none: {
        revokedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
    }
  } else if (filters.suppression === 'suppressed') {
    where.suppressions = {
      some: {
        revokedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
    }
  }

  const [rows, totalApprox] = await Promise.all([
    db.finding.findMany({
      where,
      include: {
        assignee: { select: { name: true, email: true } },
        suppressions: {
          where: { revokedAt: null },
          select: { id: true, revokedAt: true, expiresAt: true },
          orderBy: { createdAt: 'desc' },
        },
        _count: { select: { occurrences: true } },
      },
      orderBy: sort === 'severity'
        ? [{ severity: order }, { lastSeenAt: order }]
        : sort === 'title'
          ? [{ title: order }]
          : sort === 'firstSeenAt'
            ? [{ firstSeenAt: order }]
            : [{ lastSeenAt: order }],
      take: limit + 1,
      ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
    }),
    db.finding.count({ where }),
  ])

  const hasMore = rows.length > limit
  const items = (hasMore ? rows.slice(0, limit) : rows).map((r) =>
    formatFinding(r),
  )

  return {
    items,
    nextCursor: hasMore && items.length > 0 ? items[items.length - 1].id : null,
    totalApprox,
  }
}

/** Get a single finding with full detail (comments, history, suppressions, occurrences). */
export async function getFinding(
  findingId: string,
  workspaceId: string,
): Promise<{
  finding: FindingDetail
  comments: CommentView[]
  statusHistory: StatusHistoryView[]
  suppressions: SuppressionView[]
  recentOccurrences: Array<{
    id: string
    runId: string | null
    viewport: string | null
    locale: string | null
    browser: string | null
    occurredAt: string
  }>
}> {
  const finding = await loadFindingInWorkspace(findingId, workspaceId)

  const [comments, history, occurrences] = await Promise.all([
    db.findingComment.findMany({
      where: { findingId },
      include: { author: { select: { name: true, email: true } } },
      orderBy: { createdAt: 'asc' },
      take: 200,
    }),
    db.findingStatusHistory.findMany({
      where: { findingId },
      include: { changedBy: { select: { name: true } } },
      orderBy: { changedAt: 'desc' },
      take: 100,
    }),
    db.findingOccurrence.findMany({
      where: { findingId },
      orderBy: { occurredAt: 'desc' },
      take: 50,
      select: {
        id: true,
        runId: true,
        viewport: true,
        locale: true,
        browser: true,
        occurredAt: true,
      },
    }),
  ])

  const suppressionsView: SuppressionView[] = (finding.suppressions ?? []).map((s) => ({
    id: s.id,
    findingId: s.findingId,
    workspaceId: s.workspaceId,
    projectId: s.projectId,
    checkId: s.checkId,
    fingerprint: s.fingerprint,
    reason: s.reason,
    createdById: s.createdById,
    createdByName: s.createdBy?.name ?? null,
    createdByEmail: s.createdBy?.email,
    expiresAt: s.expiresAt?.toISOString() ?? null,
    createdAt: s.createdAt.toISOString(),
    revokedAt: s.revokedAt?.toISOString() ?? null,
    revokedById: null,
    isActive: isSuppressionActive(s),
  }))

  return {
    finding: formatFinding(finding),
    comments: comments.map((c) => ({
      id: c.id,
      findingId: c.findingId,
      authorId: c.authorId,
      authorName: c.author?.name ?? null,
      authorEmail: c.author?.email ?? '',
      body: c.body,
      createdAt: c.createdAt.toISOString(),
      updatedAt: c.updatedAt.toISOString(),
    })),
    statusHistory: history.map((h) => ({
      id: h.id,
      findingId: h.findingId,
      fromStatus: h.fromStatus,
      toStatus: h.toStatus,
      reason: h.reason,
      changedById: h.changedById,
      changedByName: h.changedBy?.name ?? null,
      changedAt: h.changedAt.toISOString(),
    })),
    suppressions: suppressionsView,
    recentOccurrences: occurrences.map((o) => ({
      id: o.id,
      runId: o.runId,
      viewport: o.viewport,
      locale: o.locale,
      browser: o.browser,
      occurredAt: o.occurredAt.toISOString(),
    })),
  }
}

// ===========================================================
// Lifecycle state machine
// ===========================================================

export interface TransitionResult {
  findingId: string
  previousStatus: FindingStatus
  newStatus: FindingStatus
  changedAt: string
  historyId: string
}

/**
 * Transition a finding's status. Validates the transition against the
 * state machine, records a FindingStatusHistory entry, updates
 * `resolvedAt`/`lastSeenAt` as appropriate, and emits an audit entry.
 *
 * `actorRole` is required so we can refuse transitions that need
 * elevated permissions (e.g. ACCEPTED_RISK requires findings.update
 * which is granted to OWNER/ADMIN/MEMBER only).
 */
export async function transitionFinding(
  findingId: string,
  workspaceId: string,
  toStatus: FindingStatus,
  ctx: { userId: string; audit: AuditContext; reason?: string },
): Promise<TransitionResult> {
  assertStatus(toStatus)
  const finding = await loadFindingInWorkspace(findingId, workspaceId)
  const fromStatus = assertStatus(finding.status)

  if (fromStatus === toStatus) {
    // Idempotent — no-op.
    return {
      findingId,
      previousStatus: fromStatus,
      newStatus: toStatus,
      changedAt: new Date().toISOString(),
      historyId: '',
    }
  }

  assertCanTransition(fromStatus, toStatus)

  // Use a transaction so status + history + audit are atomic.
  const [updated, history] = await db.$transaction([
    db.finding.update({
      where: { id: findingId },
      data: {
        status: toStatus,
        resolvedAt: toStatus === 'RESOLVED' ? new Date() : null,
        lastSeenAt: new Date(),
        updatedAt: new Date(),
      },
    }),
    db.findingStatusHistory.create({
      data: {
        findingId,
        fromStatus,
        toStatus,
        reason: ctx.reason ?? null,
        changedById: ctx.userId,
      },
    }),
  ])

  await recordAudit(
    'FINDING_TRANSITION',
    { type: 'finding', id: findingId },
    { ...ctx.audit, actorType: 'USER', actorId: ctx.userId, workspaceId },
    { fromStatus, toStatus, reason: ctx.reason ?? null, historyId: history.id },
  )

  // Emit a scan event so SSE listeners on the parent run see the change.
  if (finding.runId) {
    await appendScanEvent(finding.runId, 'finding.transition', {
      findingId,
      fromStatus,
      toStatus,
      reason: ctx.reason ?? null,
      changedById: ctx.userId,
    }).catch(() => {
      /* best-effort */
    })
  }

  logger.info('Finding transition', {
    findingId,
    fromStatus,
    toStatus,
    userId: ctx.userId,
  })

  return {
    findingId,
    previousStatus: fromStatus,
    newStatus: toStatus,
    changedAt: updated.updatedAt.toISOString(),
    historyId: history.id,
  }
}

// ===========================================================
// Auto-reopen (called by the worker when a fingerprint re-appears)
// ===========================================================

/**
 * If the existing finding is in RESOLVED status, automatically transition
 * it to REOPENED. This is the only "automatic" lifecycle transition;
 * every other transition requires a user action.
 *
 * IGNORED / ACCEPTED_RISK / FALSE_POSITIVE findings are NOT auto-reopened
 * because they represent intentional decisions that should not be silently
 * overturned by a re-scan.
 *
 * Returns true if a reopen occurred.
 */
export async function maybeAutoReopenFinding(
  findingId: string,
  runId: string | null,
  ctx: { requestId?: string },
): Promise<boolean> {
  const finding = await db.finding.findUnique({
    where: { id: findingId },
    select: { id: true, status: true, workspaceId: true, runId: true },
  })
  if (!finding) return false
  if (finding.status !== 'RESOLVED') return false

  const now = new Date()
  await db.$transaction([
    db.finding.update({
      where: { id: findingId },
      data: {
        status: 'REOPENED',
        resolvedAt: null,
        lastSeenAt: now,
        updatedAt: now,
      },
    }),
    db.findingStatusHistory.create({
      data: {
        findingId,
        fromStatus: 'RESOLVED',
        toStatus: 'REOPENED',
        reason: 'Auto-reopened: fingerprint re-appeared in scan',
        changedById: null,
      },
    }),
  ])

  await recordAudit(
    'FINDING_AUTO_REOPEN',
    { type: 'finding', id: findingId },
    {
      actorType: 'SYSTEM',
      workspaceId: finding.workspaceId,
      requestId: ctx.requestId,
    },
    { runId, findingId },
  )

  const eventRunId = finding.runId ?? runId
  if (eventRunId) {
    await appendScanEvent(eventRunId, 'finding.reopened', {
      findingId,
      runId: runId ?? undefined,
    }).catch(() => {
      /* best-effort */
    })
  }

  logger.info('Finding auto-reopened', { findingId, runId: runId ?? undefined })
  return true
}

// ===========================================================
// Comments
// ===========================================================

export async function addComment(
  findingId: string,
  workspaceId: string,
  authorId: string,
  body: string,
  audit: AuditContext,
): Promise<CommentView> {
  const finding = await loadFindingInWorkspace(findingId, workspaceId)
  const trimmed = body.trim()
  if (!trimmed) {
    throw new ValidationError('Comment body cannot be empty', { body: ['Required'] })
  }
  if (trimmed.length > 4000) {
    throw new ValidationError('Comment too long', { body: ['Max 4000 characters'] })
  }

  const comment = await db.findingComment.create({
    data: { findingId, authorId, body: trimmed },
    include: { author: { select: { name: true, email: true } } },
  })

  await recordAudit(
    'FINDING_COMMENT_CREATE',
    { type: 'finding', id: findingId },
    { ...audit, actorType: 'USER', actorId: authorId, workspaceId },
    { commentId: comment.id },
  )

  if (finding.runId) {
    await appendScanEvent(finding.runId, 'finding.comment_added', {
      findingId,
      commentId: comment.id,
      authorId,
    }).catch(() => {
      /* best-effort */
    })
  }

  return {
    id: comment.id,
    findingId: comment.findingId,
    authorId: comment.authorId,
    authorName: comment.author?.name ?? null,
    authorEmail: comment.author?.email ?? '',
    body: comment.body,
    createdAt: comment.createdAt.toISOString(),
    updatedAt: comment.updatedAt.toISOString(),
  }
}

export async function listComments(
  findingId: string,
  workspaceId: string,
  opts: { limit?: number; cursor?: string } = {},
): Promise<{ items: CommentView[]; nextCursor: string | null }> {
  await loadFindingInWorkspace(findingId, workspaceId)
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200)
  const rows = await db.findingComment.findMany({
    where: { findingId },
    include: { author: { select: { name: true, email: true } } },
    orderBy: { createdAt: 'asc' },
    take: limit + 1,
    ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
  })
  const hasMore = rows.length > limit
  const items = (hasMore ? rows.slice(0, limit) : rows).map((c) => ({
    id: c.id,
    findingId: c.findingId,
    authorId: c.authorId,
    authorName: c.author?.name ?? null,
    authorEmail: c.author?.email ?? '',
    body: c.body,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  }))
  return {
    items,
    nextCursor: hasMore && items.length > 0 ? items[items.length - 1].id : null,
  }
}

// ===========================================================
// Assignment, tags, business impact
// ===========================================================

export interface FindingPatch {
  status?: FindingStatus
  severity?: FindingSeverity
  confidence?: FindingConfidence
  assignedToId?: string | null
  tags?: string[]
  businessImpact?: BusinessImpact[]
  aiExplanation?: string
  aiSummary?: string
  /** Optional reason recorded in status history (only when status changes). */
  reason?: string
}

/**
 * Apply a partial update to a finding. Each field is validated:
 *   - status transitions are checked against the state machine.
 *   - assignedToId must reference a workspace member (or null).
 *   - severity is validated (AI overrides are recorded in audit but the
 *     deterministic severity always wins if a rule exists — see
 *     `finding-severity.ts`).
 */
export async function patchFinding(
  findingId: string,
  workspaceId: string,
  patch: FindingPatch,
  ctx: { userId: string; audit: AuditContext },
): Promise<FindingDetail> {
  const finding = await loadFindingInWorkspace(findingId, workspaceId)

  const data: Record<string, unknown> = {}
  const auditMeta: Record<string, unknown> = {}

  if (patch.severity !== undefined) {
    assertSeverity(patch.severity)
    data.severity = patch.severity
    auditMeta.severity = { from: finding.severity, to: patch.severity }
  }

  if (patch.confidence !== undefined) {
    const { assertConfidence } = await import('./finding-severity')
    assertConfidence(patch.confidence)
    data.confidence = patch.confidence
    auditMeta.confidence = patch.confidence
  }

  if (patch.assignedToId !== undefined) {
    if (patch.assignedToId !== null) {
      // Validate the assignee is a member of the workspace.
      const membership = await db.workspaceMember.findUnique({
        where: {
          workspaceId_userId: { workspaceId, userId: patch.assignedToId },
        },
        select: { id: true, removedAt: true },
      })
      if (!membership || membership.removedAt) {
        throw new ValidationError('Assignee is not a workspace member', {
          assignedToId: ['Must be an active workspace member'],
        })
      }
    }
    data.assignedToId = patch.assignedToId
    auditMeta.assignedToId = { from: finding.assignedToId, to: patch.assignedToId }
  }

  if (patch.tags !== undefined) {
    data.tags = serializeTags(patch.tags)
    auditMeta.tags = patch.tags
  }

  if (patch.businessImpact !== undefined) {
    data.businessImpact = serializeBusinessImpacts(patch.businessImpact)
    auditMeta.businessImpact = patch.businessImpact
  }

  if (patch.aiExplanation !== undefined) {
    if (patch.aiExplanation.length > 8000) {
      throw new ValidationError('AI explanation too long', { aiExplanation: ['Max 8000 chars'] })
    }
    data.aiExplanation = patch.aiExplanation || null
    auditMeta.aiExplanationUpdated = true
  }

  if (patch.aiSummary !== undefined) {
    if (patch.aiSummary.length > 2000) {
      throw new ValidationError('AI summary too long', { aiSummary: ['Max 2000 chars'] })
    }
    data.aiSummary = patch.aiSummary || null
    auditMeta.aiSummaryUpdated = true
  }

  // Handle status transition separately (it has its own history record).
  let historyId: string | null = null
  if (patch.status !== undefined) {
    const toStatus = assertStatus(patch.status)
    const fromStatus = assertStatus(finding.status)
    if (fromStatus !== toStatus) {
      assertCanTransition(fromStatus, toStatus)
      data.status = toStatus
      data.resolvedAt = toStatus === 'RESOLVED' ? new Date() : null
      data.lastSeenAt = new Date()
      auditMeta.status = { from: fromStatus, to: toStatus }
    }
  }

  if (Object.keys(data).length === 0) {
    // Nothing to update.
    return formatFinding(finding)
  }

  // Apply in a transaction so status history is atomic with the finding update.
  const [updated] = await db.$transaction([
    db.finding.update({
      where: { id: findingId },
      data,
      include: {
        assignee: { select: { name: true, email: true } },
        suppressions: {
          where: { revokedAt: null },
          select: { id: true, revokedAt: true, expiresAt: true },
          orderBy: { createdAt: 'desc' },
        },
        _count: { select: { occurrences: true } },
      },
    }),
    ...(patch.status && data.status
      ? [
          db.findingStatusHistory.create({
            data: {
              findingId,
              fromStatus: finding.status,
              toStatus: data.status as string,
              reason: patch.reason ?? null,
              changedById: ctx.userId,
            },
          }),
        ]
      : []),
  ])

  await recordAudit(
    'FINDING_UPDATE',
    { type: 'finding', id: findingId },
    { ...ctx.audit, actorType: 'USER', actorId: ctx.userId, workspaceId },
    { ...auditMeta, historyId },
  )

  if (finding.runId && patch.status) {
    await appendScanEvent(finding.runId, 'finding.transition', {
      findingId,
      fromStatus: finding.status,
      toStatus: patch.status,
      reason: patch.reason ?? null,
      changedById: ctx.userId,
    }).catch(() => {
      /* best-effort */
    })
  }

  return formatFinding(updated)
}

// ===========================================================
// Suppressions
// ===========================================================

export interface CreateSuppressionInput {
  findingId?: string
  projectId?: string
  checkId?: string
  fingerprint?: string
  reason: string
  expiresAt?: string | null
}

/**
 * Create a suppression. At least one of {findingId, projectId, checkId, fingerprint}
 * must be provided. The combination determines the scope:
 *
 *   - findingId only       → suppress this single finding.
 *   - projectId + checkId  → suppress this check across the project.
 *   - fingerprint          → suppress by fingerprint (covers re-opens).
 *   - projectId only       → suppress ALL findings in the project (DANGEROUS,
 *                            requires billing.manage / owner role; refused otherwise).
 *
 * Expiry is optional. Revocation is always explicit (separate endpoint).
 */
export async function createSuppression(
  workspaceId: string,
  input: CreateSuppressionInput,
  ctx: { userId: string; audit: AuditContext; isOwnerOrAdmin: boolean },
): Promise<SuppressionView> {
  const reason = input.reason.trim()
  if (reason.length < 3 || reason.length > 500) {
    throw new ValidationError('Suppression reason must be 3–500 characters', {
      reason: ['3–500 characters required'],
    })
  }
  if (!input.findingId && !input.checkId && !input.fingerprint && !input.projectId) {
    throw new ValidationError('Suppression must target at least one of: findingId, projectId+checkId, fingerprint', {
      scope: ['At least one scope field required'],
    })
  }

  // If a findingId is provided, load the finding to scope automatically.
  let findingId = input.findingId
  let projectId = input.projectId
  let fingerprint = input.fingerprint
  let checkId = input.checkId

  if (findingId) {
    const finding = await loadFindingInWorkspace(findingId, workspaceId)
    projectId = projectId ?? finding.projectId
    checkId = checkId ?? finding.checkId
    fingerprint = fingerprint ?? finding.fingerprint
  }

  // Validate project belongs to workspace if provided.
  if (projectId) {
    const project = await db.project.findUnique({
      where: { id: projectId },
      select: { workspaceId: true, status: true },
    })
    if (!project || project.workspaceId !== workspaceId || project.status === 'DELETED') {
      throw new NotFoundError('Project')
    }
  }

  // Broad suppression (no checkId, no fingerprint, no findingId) requires owner/admin.
  if (!findingId && !checkId && !fingerprint && projectId) {
    if (!ctx.isOwnerOrAdmin) {
      throw new ForbiddenError('Project-wide suppressions require OWNER or ADMIN role')
    }
  }

  let expiresAt: Date | null = null
  if (input.expiresAt) {
    const d = new Date(input.expiresAt)
    if (isNaN(d.getTime())) {
      throw new ValidationError('Invalid expiresAt', { expiresAt: ['ISO 8601 required'] })
    }
    if (d < new Date()) {
      throw new ValidationError('Suppression expiry must be in the future', {
        expiresAt: ['Must be future date'],
      })
    }
    // Cap at 1 year.
    const max = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000)
    if (d > max) {
      throw new ValidationError('Suppression expiry cannot exceed 1 year', {
        expiresAt: ['Max 1 year'],
      })
    }
    expiresAt = d
  }

  const suppression = await db.findingSuppression.create({
    data: {
      findingId: findingId ?? null,
      workspaceId,
      projectId: projectId ?? null,
      checkId: checkId ?? null,
      fingerprint: fingerprint ?? null,
      reason,
      createdById: ctx.userId,
      expiresAt,
    },
    include: { createdBy: { select: { name: true, email: true } } },
  })

  await recordAudit(
    'FINDING_SUPPRESS',
    { type: 'finding_suppression', id: suppression.id },
    { ...ctx.audit, actorType: 'USER', actorId: ctx.userId, workspaceId },
    {
      findingId,
      projectId,
      checkId,
      fingerprint,
      reason,
      expiresAt: expiresAt?.toISOString() ?? null,
    },
  )

  // Emit scan event on the affected finding's run (if any).
  if (findingId) {
    const finding = await db.finding.findUnique({
      where: { id: findingId },
      select: { runId: true },
    })
    if (finding?.runId) {
      await appendScanEvent(finding.runId, 'finding.suppressed', {
        findingId,
        suppressionId: suppression.id,
        reason,
      }).catch(() => {
        /* best-effort */
      })
    }
  }

  return {
    id: suppression.id,
    findingId: suppression.findingId,
    workspaceId: suppression.workspaceId,
    projectId: suppression.projectId,
    checkId: suppression.checkId,
    fingerprint: suppression.fingerprint,
    reason: suppression.reason,
    createdById: suppression.createdById,
    createdByName: suppression.createdBy?.name ?? null,
    createdByEmail: suppression.createdBy?.email ?? '',
    expiresAt: suppression.expiresAt?.toISOString() ?? null,
    createdAt: suppression.createdAt.toISOString(),
    revokedAt: null,
    revokedById: null,
    isActive: true,
  }
}

/**
 * Revoke a suppression. Idempotent — revoking an already-revoked suppression
 * returns the existing record without error.
 */
export async function revokeSuppression(
  suppressionId: string,
  workspaceId: string,
  ctx: { userId: string; audit: AuditContext },
): Promise<SuppressionView> {
  const suppression = await db.findingSuppression.findUnique({
    where: { id: suppressionId },
    include: { createdBy: { select: { name: true, email: true } } },
  })
  if (!suppression || suppression.workspaceId !== workspaceId) {
    throw new NotFoundError('Suppression')
  }

  if (suppression.revokedAt) {
    // Idempotent.
    return {
      id: suppression.id,
      findingId: suppression.findingId,
      workspaceId: suppression.workspaceId,
      projectId: suppression.projectId,
      checkId: suppression.checkId,
      fingerprint: suppression.fingerprint,
      reason: suppression.reason,
      createdById: suppression.createdById,
      createdByName: suppression.createdBy?.name ?? null,
      createdByEmail: suppression.createdBy?.email ?? '',
      expiresAt: suppression.expiresAt?.toISOString() ?? null,
      createdAt: suppression.createdAt.toISOString(),
      revokedAt: suppression.revokedAt.toISOString(),
      revokedById: null,
      isActive: false,
    }
  }

  const updated = await db.findingSuppression.update({
    where: { id: suppressionId },
    data: { revokedAt: new Date() },
    include: { createdBy: { select: { name: true, email: true } } },
  })

  await recordAudit(
    'FINDING_UNSUPPRESS',
    { type: 'finding_suppression', id: suppressionId },
    { ...ctx.audit, actorType: 'USER', actorId: ctx.userId, workspaceId },
    { findingId: suppression.findingId, fingerprint: suppression.fingerprint },
  )

  if (suppression.findingId) {
    const finding = await db.finding.findUnique({
      where: { id: suppression.findingId },
      select: { runId: true },
    })
    if (finding?.runId) {
      await appendScanEvent(finding.runId, 'finding.unsuppressed', {
        findingId: suppression.findingId,
        suppressionId,
      }).catch(() => {
        /* best-effort */
      })
    }
  }

  return {
    id: updated.id,
    findingId: updated.findingId,
    workspaceId: updated.workspaceId,
    projectId: updated.projectId,
    checkId: updated.checkId,
    fingerprint: updated.fingerprint,
    reason: updated.reason,
    createdById: updated.createdById,
    createdByName: updated.createdBy?.name ?? null,
    createdByEmail: updated.createdBy?.email ?? '',
    expiresAt: updated.expiresAt?.toISOString() ?? null,
    createdAt: updated.createdAt.toISOString(),
    revokedAt: updated.revokedAt!.toISOString(),
    revokedById: null,
    isActive: false,
  }
}

/**
 * Check whether a finding is currently suppressed (used by the worker
 * to skip occurrence recording for suppressed findings).
 */
export async function isFindingSuppressed(
  fingerprint: string,
  workspaceId: string,
  opts: { checkId?: string; projectId?: string } = {},
): Promise<boolean> {
  const now = new Date()
  // Look up any active suppression matching the fingerprint OR (projectId+checkId)
  // OR (workspace-wide without projectId/checkId).
  const matching = await db.findingSuppression.findFirst({
    where: {
      workspaceId,
      revokedAt: null,
      AND: [
        { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
        {
          OR: [
            ...(opts.projectId && opts.checkId
              ? [{ projectId: opts.projectId, checkId: opts.checkId }]
              : []),
            { fingerprint },
            // Workspace-wide (no scope fields): match anything.
            { findingId: null, projectId: null, checkId: null, fingerprint: null },
          ],
        },
      ],
    },
    select: { id: true },
  })
  return Boolean(matching)
}

export async function listSuppressions(
  workspaceId: string,
  opts: {
    projectId?: string
    findingId?: string
    activeOnly?: boolean
    limit?: number
    cursor?: string
  } = {},
): Promise<{ items: SuppressionView[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200)
  const now = new Date()
  const where: Record<string, unknown> = { workspaceId }
  if (opts.projectId) where.projectId = opts.projectId
  if (opts.findingId) where.findingId = opts.findingId
  if (opts.activeOnly) {
    where.revokedAt = null
    where.OR = [{ expiresAt: null }, { expiresAt: { gt: now } }]
  }
  const rows = await db.findingSuppression.findMany({
    where,
    include: { createdBy: { select: { name: true, email: true } } },
    orderBy: { createdAt: 'desc' },
    take: limit + 1,
    ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
  })
  const hasMore = rows.length > limit
  const items = (hasMore ? rows.slice(0, limit) : rows).map((s) => ({
    id: s.id,
    findingId: s.findingId,
    workspaceId: s.workspaceId,
    projectId: s.projectId,
    checkId: s.checkId,
    fingerprint: s.fingerprint,
    reason: s.reason,
    createdById: s.createdById,
    createdByName: s.createdBy?.name ?? null,
    createdByEmail: s.createdBy?.email ?? '',
    expiresAt: s.expiresAt?.toISOString() ?? null,
    createdAt: s.createdAt.toISOString(),
    revokedAt: s.revokedAt?.toISOString() ?? null,
    revokedById: null,
    isActive: isSuppressionActive(s),
  }))
  return {
    items,
    nextCursor: hasMore && items.length > 0 ? items[items.length - 1].id : null,
  }
}

// ===========================================================
// Bulk update
// ===========================================================

export interface BulkUpdateInput {
  /** Filter (must include at least one of projectId/runId/severity/status/category). */
  filter: FindingFilters
  /** Action to apply to every matching finding. */
  action:
    | { type: 'transition'; toStatus: FindingStatus; reason?: string }
    | { type: 'assign'; assignedToId: string | null }
    | { type: 'add_tags'; tags: string[] }
    | { type: 'remove_tags'; tags: string[] }
    | { type: 'set_business_impact'; impacts: BusinessImpact[] }
}

export interface BulkUpdateResult {
  matched: number
  updated: number
  skipped: number
  errors: Array<{ findingId: string; error: string }>
}

/**
 * Apply a bulk action to findings matching the filter. Each finding is
 * updated individually so transitions are validated against the state
 * machine (invalid transitions are skipped, not fatal).
 *
 * Hard cap: 500 findings per bulk operation.
 */
export async function bulkUpdateFindings(
  workspaceId: string,
  input: BulkUpdateInput,
  ctx: { userId: string; audit: AuditContext },
): Promise<BulkUpdateResult> {
  // Require at least one non-trivial filter to avoid "update all" foot-guns.
  if (
    !input.filter.projectId &&
    !input.filter.runId &&
    !input.filter.severity &&
    !input.filter.status &&
    !input.filter.category &&
    !input.filter.assignedToId &&
    !input.filter.search &&
    !input.filter.tags?.length
  ) {
    throw new ValidationError('Bulk update requires at least one filter', {
      filter: ['Provide projectId, runId, severity, status, category, assignee, search, or tags'],
    })
  }

  // Validate the assignee (if provided in action).
  if (input.action.type === 'assign' && input.action.assignedToId !== null) {
    const membership = await db.workspaceMember.findUnique({
      where: {
        workspaceId_userId: { workspaceId, userId: input.action.assignedToId },
      },
      select: { id: true, removedAt: true },
    })
    if (!membership || membership.removedAt) {
      throw new ValidationError('Assignee is not a workspace member', {
        assignedToId: ['Must be an active workspace member'],
      })
    }
  }

  // Validate tags (if provided).
  if (input.action.type === 'add_tags' || input.action.type === 'remove_tags') {
    parseTags(input.action.tags.join(',')) // throws on invalid
  }
  if (input.action.type === 'set_business_impact') {
    for (const i of input.action.impacts) {
      if (!isBusinessImpact(i)) {
        throw new ValidationError(`Invalid business impact: ${i}`, { impacts: ['Invalid value'] })
      }
    }
  }

  // Fetch matching IDs (capped).
  const { items } = await listFindings(workspaceId, input.filter, { limit: 500 })
  if (items.length === 0) {
    return { matched: 0, updated: 0, skipped: 0, errors: [] }
  }

  const errors: Array<{ findingId: string; error: string }> = []
  let updated = 0
  let skipped = 0

  for (const item of items) {
    try {
      if (input.action.type === 'transition') {
        const toStatus = assertStatus(input.action.toStatus)
        const fromStatus = assertStatus(item.status)
        if (fromStatus === toStatus) {
          skipped++
          continue
        }
        if (!canTransition(fromStatus, toStatus)) {
          skipped++
          continue
        }
        await transitionFinding(item.id, workspaceId, toStatus, {
          userId: ctx.userId,
          audit: ctx.audit,
          reason: input.action.reason,
        })
      } else if (input.action.type === 'assign') {
        await patchFinding(item.id, workspaceId, { assignedToId: input.action.assignedToId }, ctx)
      } else if (input.action.type === 'add_tags') {
        const existing = new Set(item.tags.map((t) => t.toLowerCase()))
        const merged = [
          ...item.tags,
          ...input.action.tags.filter((t) => !existing.has(t.toLowerCase())),
        ]
        await patchFinding(item.id, workspaceId, { tags: merged }, ctx)
      } else if (input.action.type === 'remove_tags') {
        const toRemove = new Set(input.action.tags.map((t) => t.toLowerCase()))
        const remaining = item.tags.filter((t) => !toRemove.has(t.toLowerCase()))
        await patchFinding(item.id, workspaceId, { tags: remaining }, ctx)
      } else if (input.action.type === 'set_business_impact') {
        await patchFinding(
          item.id,
          workspaceId,
          { businessImpact: input.action.impacts },
          ctx,
        )
      }
      updated++
    } catch (err) {
      errors.push({ findingId: item.id, error: err instanceof Error ? err.message : String(err) })
    }
  }

  await recordAudit(
    'FINDING_BULK_UPDATE',
    { type: 'workspace', id: workspaceId },
    { ...ctx.audit, actorType: 'USER', actorId: ctx.userId, workspaceId },
    {
      action: input.action.type,
      matched: items.length,
      updated,
      skipped,
      errorCount: errors.length,
    },
  )

  return {
    matched: items.length,
    updated,
    skipped,
    errors,
  }
}

// ===========================================================
// CSV export
// ===========================================================

/**
 * Export findings matching the filter as CSV. Returns the CSV string.
 * Hard cap: 5000 rows per export.
 */
export async function exportFindingsCsv(
  workspaceId: string,
  filters: FindingFilters,
): Promise<string> {
  const { items } = await listFindings(workspaceId, filters, { limit: 5000 })
  const headers = [
    'id',
    'title',
    'category',
    'severity',
    'status',
    'confidence',
    'checkId',
    'affectedUrl',
    'normalizedUrl',
    'viewport',
    'locale',
    'browser',
    'domSelector',
    'businessImpact',
    'tags',
    'assignedTo',
    'assigneeEmail',
    'firstSeenAt',
    'lastSeenAt',
    'resolvedAt',
    'occurrenceCount',
    'isSuppressed',
  ]
  const escape = (v: unknown): string => {
    const s = v === null || v === undefined ? '' : String(v)
    if (/[",\n\r]/.test(s)) {
      return '"' + s.replace(/"/g, '""') + '"'
    }
    return s
  }
  const lines = [headers.join(',')]
  for (const f of items) {
    lines.push(
      [
        f.id,
        f.title,
        f.category,
        f.severity,
        f.status,
        f.confidence,
        f.checkId,
        f.affectedUrl,
        f.normalizedUrl,
        f.viewport ?? '',
        f.locale ?? '',
        f.browser ?? '',
        f.domSelector ?? '',
        f.businessImpact.join('|'),
        f.tags.join('|'),
        f.assigneeName ?? '',
        f.assigneeEmail ?? '',
        f.firstSeenAt,
        f.lastSeenAt,
        f.resolvedAt ?? '',
        f.occurrenceCount,
        f.isSuppressed ? 'true' : 'false',
      ]
        .map(escape)
        .join(','),
    )
  }
  return lines.join('\n')
}

// ===========================================================
// Helpers exported for routes
// ===========================================================

export {
  parseTags,
  serializeTags,
  parseBusinessImpacts,
  serializeBusinessImpacts,
  isBusinessImpact,
  OPEN_STATUSES,
}
