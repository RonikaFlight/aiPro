/**
 * Report approval workflow — ProofPilot
 *
 * Implements a multi-step approval process for reports before they can be
 * shared externally or published.
 *
 * State machine:
 *   DRAFT ──submit──→ PENDING_APPROVAL ──approve──→ READY
 *                                    └──reject───→ DRAFT
 *   READY can be published (→ PUBLISHED) or re-submitted (→ PENDING_APPROVAL)
 *
 * Approvals are recorded as ReportApproval rows with approved=true/false.
 * OWNER and ADMIN roles have `reports.approve` permission.
 * Any member with `reports.create` can submit/re-submit for approval.
 *
 * See spec §21 "Reports" — approval workflow.
 */

import { db } from '../db'
import { recordAudit, type AuditContext } from '../audit'
import { NotFoundError, ValidationError, ForbiddenError } from '../errors'
import { logger } from '../logger'

// ======================== Types ========================

/** Valid report statuses for approval workflow. */
export type ReportStatusType = 'DRAFT' | 'PENDING_APPROVAL' | 'READY' | 'PUBLISHED' | 'ARCHIVED'

/** A single approval/rejection decision. */
export interface ApprovalDecision {
  id: string
  approverId: string
  approverName: string
  approverEmail: string
  approved: boolean
  comment: string | null
  createdAt: string
}

/** Summary of approval state for a report. */
export interface ApprovalStatus {
  reportId: string
  status: ReportStatusType
  approvalCount: number
  rejectionCount: number
  isApproved: boolean
  decisions: ApprovalDecision[]
}

/** Options for submitForApproval. */
export interface SubmitApprovalOptions {
  reportId: string
  workspaceId: string
  userId: string
  auditCtx: AuditContext
}

/** Result of submitForApproval. */
export interface SubmitApprovalResult {
  reportId: string
  status: ReportStatusType
}

/** Options for approve/reject. */
export interface ApprovalActionOptions {
  reportId: string
  workspaceId: string
  userId: string
  comment?: string
  auditCtx: AuditContext
}

/** Result of approve/reject. */
export interface ApprovalActionResult {
  approvalId: string
  reportId: string
  status: ReportStatusType
  approved: boolean
  comment: string | null
}

/** Options for listApprovals. */
export interface ListApprovalsOptions {
  reportId: string
  workspaceId: string
  limit?: number
  cursor?: string
}

/** Result of listApprovals with cursor pagination. */
export interface ListApprovalsResult {
  decisions: ApprovalDecision[]
  totalCount: number
  nextCursor: string | null
}

// ======================== Constants ========================

/** Maximum number of approvals per report (prevent abuse). */
const MAX_APPROVALS_PER_REPORT = 50

/** Maximum comment length. */
const MAX_COMMENT_LENGTH = 2000

// ======================== Helpers ========================

function assertReportStatus(
  currentStatus: string,
  expected: ReportStatusType[],
  action: string,
): void {
  if (!expected.includes(currentStatus as ReportStatusType)) {
    throw new ValidationError(
      `Report must be in ${expected.join(' or ')} status to ${action}. Current status: ${currentStatus}`,
    )
  }
}

function validateComment(comment: unknown): string | undefined {
  if (comment === undefined || comment === null || comment === '') return undefined
  if (typeof comment !== 'string') {
    throw new ValidationError('Comment must be a string')
  }
  const trimmed = comment.trim()
  if (trimmed.length > MAX_COMMENT_LENGTH) {
    throw new ValidationError(`Comment must not exceed ${MAX_COMMENT_LENGTH} characters`)
  }
  return trimmed || undefined
}

// ======================== Service Functions ========================

/**
 * Submit a report for approval.
 * Transitions: DRAFT or READY → PENDING_APPROVAL.
 */
export async function submitForApproval(
  opts: SubmitApprovalOptions,
): Promise<SubmitApprovalResult> {
  const report = await db.report.findUnique({
    where: { id: opts.reportId },
    select: {
      id: true,
      workspaceId: true,
      status: true,
      title: true,
    },
  })

  if (!report) throw new NotFoundError('Report')
  if (report.workspaceId !== opts.workspaceId) throw new NotFoundError('Report')

  assertReportStatus(report.status, ['DRAFT', 'READY'], 'submit for approval')

  const updated = await db.report.update({
    where: { id: opts.reportId },
    data: { status: 'PENDING_APPROVAL' },
    select: { id: true, status: true },
  })

  await recordAudit(
    'REPORT_SUBMIT_APPROVAL',
    { type: 'Report', id: opts.reportId },
    { ...opts.auditCtx, workspaceId: opts.workspaceId, actorId: opts.userId },
    { reportTitle: report.title, previousStatus: report.status, newStatus: 'PENDING_APPROVAL' },
  )

  logger.info('Report submitted for approval', {
    reportId: opts.reportId,
    workspaceId: opts.workspaceId,
    userId: opts.userId,
    requestId: opts.auditCtx.requestId,
  })

  return { reportId: updated.id, status: updated.status as ReportStatusType }
}

/**
 * Approve a report.
 * Transitions: PENDING_APPROVAL → READY.
 * Creates a ReportApproval record with approved=true.
 */
export async function approveReport(
  opts: ApprovalActionOptions,
): Promise<ApprovalActionResult> {
  const report = await db.report.findUnique({
    where: { id: opts.reportId },
    select: {
      id: true,
      workspaceId: true,
      status: true,
      title: true,
    },
  })

  if (!report) throw new NotFoundError('Report')
  if (report.workspaceId !== opts.workspaceId) throw new NotFoundError('Report')

  assertReportStatus(report.status, ['PENDING_APPROVAL'], 'approve')

  const comment = validateComment(opts.comment)

  // Check approval count
  const existingApprovals = await db.reportApproval.count({
    where: { reportId: opts.reportId },
  })
  if (existingApprovals >= MAX_APPROVALS_PER_REPORT) {
    throw new ValidationError(
      `Maximum number of approvals (${MAX_APPROVALS_PER_REPORT}) reached for this report`,
    )
  }

  // Prevent duplicate approval from same user
  const existingApproval = await db.reportApproval.findFirst({
    where: { reportId: opts.reportId, approverId: opts.userId },
  })
  if (existingApproval) {
    throw new ValidationError('You have already submitted an approval decision for this report')
  }

  const approval = await db.reportApproval.create({
    data: {
      reportId: opts.reportId,
      approverId: opts.userId,
      approved: true,
      comment: comment ?? null,
    },
  })

  // Transition to READY
  const updated = await db.report.update({
    where: { id: opts.reportId },
    data: { status: 'READY' },
    select: { id: true, status: true },
  })

  await recordAudit(
    'REPORT_APPROVE',
    { type: 'Report', id: opts.reportId },
    { ...opts.auditCtx, workspaceId: opts.workspaceId, actorId: opts.userId },
    {
      reportTitle: report.title,
      approvalId: approval.id,
      comment,
      previousStatus: report.status,
      newStatus: 'READY',
    },
  )

  logger.info('Report approved', {
    reportId: opts.reportId,
    approvalId: approval.id,
    workspaceId: opts.workspaceId,
    userId: opts.userId,
    requestId: opts.auditCtx.requestId,
  })

  return {
    approvalId: approval.id,
    reportId: updated.id,
    status: updated.status as ReportStatusType,
    approved: true,
    comment: comment ?? null,
  }
}

/**
 * Reject a report.
 * Transitions: PENDING_APPROVAL → DRAFT.
 * Creates a ReportApproval record with approved=false.
 * Requires a comment for rejection.
 */
export async function rejectReport(
  opts: ApprovalActionOptions,
): Promise<ApprovalActionResult> {
  const report = await db.report.findUnique({
    where: { id: opts.reportId },
    select: {
      id: true,
      workspaceId: true,
      status: true,
      title: true,
    },
  })

  if (!report) throw new NotFoundError('Report')
  if (report.workspaceId !== opts.workspaceId) throw new NotFoundError('Report')

  assertReportStatus(report.status, ['PENDING_APPROVAL'], 'reject')

  const comment = validateComment(opts.comment)
  if (!comment) {
    throw new ValidationError('A comment is required when rejecting a report')
  }

  // Check approval count
  const existingApprovals = await db.reportApproval.count({
    where: { reportId: opts.reportId },
  })
  if (existingApprovals >= MAX_APPROVALS_PER_REPORT) {
    throw new ValidationError(
      `Maximum number of approvals (${MAX_APPROVALS_PER_REPORT}) reached for this report`,
    )
  }

  // Prevent duplicate approval from same user
  const existingApproval = await db.reportApproval.findFirst({
    where: { reportId: opts.reportId, approverId: opts.userId },
  })
  if (existingApproval) {
    throw new ValidationError('You have already submitted an approval decision for this report')
  }

  const approval = await db.reportApproval.create({
    data: {
      reportId: opts.reportId,
      approverId: opts.userId,
      approved: false,
      comment,
    },
  })

  // Transition back to DRAFT
  const updated = await db.report.update({
    where: { id: opts.reportId },
    data: { status: 'DRAFT' },
    select: { id: true, status: true },
  })

  await recordAudit(
    'REPORT_REJECT',
    { type: 'Report', id: opts.reportId },
    { ...opts.auditCtx, workspaceId: opts.workspaceId, actorId: opts.userId },
    {
      reportTitle: report.title,
      approvalId: approval.id,
      comment,
      previousStatus: report.status,
      newStatus: 'DRAFT',
    },
  )

  logger.info('Report rejected', {
    reportId: opts.reportId,
    approvalId: approval.id,
    workspaceId: opts.workspaceId,
    userId: opts.userId,
    requestId: opts.auditCtx.requestId,
  })

  return {
    approvalId: approval.id,
    reportId: updated.id,
    status: updated.status as ReportStatusType,
    approved: false,
    comment,
  }
}

/**
 * List approval decisions for a report.
 * Returns cursor-paginated list with approver name/email.
 */
export async function listApprovals(
  opts: ListApprovalsOptions,
): Promise<ListApprovalsResult> {
  const report = await db.report.findUnique({
    where: { id: opts.reportId },
    select: { id: true, workspaceId: true },
  })

  if (!report) throw new NotFoundError('Report')
  if (report.workspaceId !== opts.workspaceId) throw new NotFoundError('Report')

  const totalCount = await db.reportApproval.count({
    where: { reportId: opts.reportId },
  })

  const queryOpts: Record<string, unknown> = {
    where: { reportId: opts.reportId },
    orderBy: { createdAt: 'desc' },
    take: Math.min(opts.limit ?? 20, 50),
    include: {
      approver: {
        select: { id: true, name: true, email: true },
      },
    },
  }

  if (opts.cursor) {
    queryOpts.cursor = { id: opts.cursor }
    queryOpts.skip = 1
  }

  const rows = await db.reportApproval.findMany(queryOpts)

  const decisions: ApprovalDecision[] = rows.map((row) => ({
    id: row.id,
    approverId: row.approverId,
    approverName: row.approver.name,
    approverEmail: row.approver.email,
    approved: row.approved,
    comment: row.comment,
    createdAt: row.createdAt.toISOString(),
  }))

  const nextCursor = rows.length === (opts.limit ?? 20)
    ? rows[rows.length - 1].id
    : null

  return { decisions, totalCount, nextCursor }
}

/**
 * Get the approval status summary for a report.
 * Returns whether the report is currently approved, and all decisions.
 */
export async function getApprovalStatus(
  reportId: string,
  workspaceId: string,
): Promise<ApprovalStatus> {
  const report = await db.report.findUnique({
    where: { id: reportId },
    select: { id: true, workspaceId: true, status: true },
  })

  if (!report) throw new NotFoundError('Report')
  if (report.workspaceId !== workspaceId) throw new NotFoundError('Report')

  const approvals = await db.reportApproval.findMany({
    where: { reportId },
    orderBy: { createdAt: 'desc' },
    include: {
      approver: {
        select: { id: true, name: true, email: true },
      },
    },
  })

  const approvalCount = approvals.filter((a) => a.approved).length
  const rejectionCount = approvals.filter((a) => !a.approved).length

  // A report is "approved" if it's in READY or PUBLISHED status
  const isApproved = report.status === 'READY' || report.status === 'PUBLISHED'

  const decisions: ApprovalDecision[] = approvals.map((a) => ({
    id: a.id,
    approverId: a.approverId,
    approverName: a.approver.name,
    approverEmail: a.approver.email,
    approved: a.approved,
    comment: a.comment,
    createdAt: a.createdAt.toISOString(),
  }))

  return {
    reportId,
    status: report.status as ReportStatusType,
    approvalCount,
    rejectionCount,
    isApproved,
    decisions,
  }
}
