/**
 * Secure report sharing — ProofPilot
 *
 * Implements secure public report links with:
 * - High-entropy share token (256-bit, stored as SHA-256 hash)
 * - Optional password (Argon2id hashed)
 * - Optional expiration
 * - Optional email restriction
 * - Revocation support
 * - View counting + audit trail
 * - Signed artifact URLs for authorized image/document access
 * - ID-guessing prevention (cuid IDs + hashed tokens)
 *
 * Uses the existing ReportShare model (linked to Report → ScanRun).
 * When a user creates a share, a Report record is ensured for the
 * run+type combination, and a ReportShare is created.
 *
 * See spec §21.4 "Report sharing".
 */
import { db } from '../db'
import { hashToken, randomToken, hashPassword, verifyPassword, timingSafeEqual, hmacSha256 } from '../crypto'
import { env } from '../env'
import { recordAudit, type AuditContext } from '../audit'
import { NotFoundError, ValidationError, ForbiddenError } from '../errors'
import { logger } from '../logger'
import {
  generateTechnicalReport,
  generateClientFacingReport,
  type TechnicalReport,
  type ClientFacingReport,
} from './technical-report'

// ======================== Types ========================

export type ShareType = 'TECHNICAL' | 'CLIENT'

/** Status returned from share access verification. */
export type ShareAccessStatus = 'VALID' | 'REVOKED' | 'EXPIRED' | 'PASSWORD_REQUIRED' | 'PASSWORD_INCORRECT' | 'EMAIL_RESTRICTED' | 'NOT_FOUND'

export interface CreateShareOptions {
  runId: string
  workspaceId: string
  userId: string
  shareType: ShareType
  password?: string
  expiresAt?: Date
  emailRestriction?: string
  auditCtx?: AuditContext
}

export interface CreateShareResult {
  shareId: string
  token: string
  expiresAt: Date | null
  emailRestriction: string | null
  hasPassword: boolean
  createdAt: Date
}

export interface ShareAccessOptions {
  /** Viewer's email (if provided in query/body, for email restriction check). */
  viewerEmail?: string
  /** Password provided by the viewer (if the share is password-protected). */
  password?: string
  /** Viewer IP for audit. */
  ip?: string
  /** Viewer UA for audit. */
  userAgent?: string
}

export interface ShareAccessResult {
  shareId: string
  runId: string
  workspaceId: string
  shareType: ShareType
  expiresAt: Date | null
  emailRestriction: string | null
  hasPassword: boolean
  viewCount: number
  report: TechnicalReport | ClientFacingReport
}

/** Returned when share access is denied but the caller needs to know why. */
export interface ShareAccessDenied {
  status: Exclude<ShareAccessStatus, 'VALID'>
  shareId?: string
}

export interface ShareDetails {
  id: string
  reportId: string
  shareType: ShareType
  expiresAt: Date | null
  emailRestriction: string | null
  hasPassword: boolean
  viewCount: number
  lastViewedAt: Date | null
  revokedAt: Date | null
  createdAt: Date
  createdBy: { id: string; name: string | null; email: string } | null
}

export interface ListSharesResult {
  shares: ShareDetails[]
}

export interface SignedArtifactParams {
  artifactId: string
  shareToken: string
  expiresAt: number // epoch seconds
  signature: string
}

export const SHARE_TOKEN_BYTES = 32 // 256 bits of entropy
export const SIGNED_ARTIFACT_EXPIRY_MINUTES = 60
export const MAX_SHARES_PER_REPORT = 20

// ======================== Service ========================

/**
 * Create a secure share link for a run's report.
 *
 * Ensures a Report record exists for the run+type, then creates a ReportShare.
 * The plaintext token is returned exactly once — it is never stored.
 *
 * @throws ValidationError if password is too short, email restriction is invalid, etc.
 * @throws NotFoundError if the run does not exist or is not in the workspace.
 * @throws ValidationError if MAX_SHARES_PER_REPORT limit is exceeded.
 */
export async function createShare(opts: CreateShareOptions): Promise<CreateShareResult> {
  const { runId, workspaceId, userId, shareType, auditCtx } = opts

  // 1. Validate the run exists and belongs to the workspace
  const run = await db.scanRun.findUnique({
    where: { id: runId },
    select: { id: true, projectId: true, workspaceId: true },
  })
  if (!run || run.workspaceId !== workspaceId) {
    throw new NotFoundError('Run')
  }

  // 2. Validate input
  if (opts.password !== undefined && opts.password.length > 0 && opts.password.length < 8) {
    throw new ValidationError('Share password must be at least 8 characters')
  }
  if (opts.emailRestriction !== undefined && opts.emailRestriction !== '') {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    if (!emailRegex.test(opts.emailRestriction)) {
      throw new ValidationError('emailRestriction must be a valid email address')
    }
  }
  if (opts.expiresAt !== undefined && opts.expiresAt <= new Date()) {
    throw new ValidationError('expiresAt must be in the future')
  }

  // 3. Ensure a Report record exists for this run + type
  const reportType = shareType === 'CLIENT' ? 'CLIENT' : 'TECHNICAL'
  const reportId = await findOrCreateReportId(run.id, run.projectId, workspaceId, reportType)

  // 4. Check share count limit
  const shareCount = await db.reportShare.count({
    where: { reportId, revokedAt: null },
  })
  if (shareCount >= MAX_SHARES_PER_REPORT) {
    throw new ValidationError(
      `Maximum of ${MAX_SHARES_PER_REPORT} active shares per report reached. Revoke existing shares first.`,
    )
  }

  // 5. Generate high-entropy token + hash it for storage
  const token = randomToken(SHARE_TOKEN_BYTES)
  const tokenHash = hashToken(token)

  // 6. Hash the password if provided
  let passwordHash: string | undefined
  if (opts.password && opts.password.length > 0) {
    passwordHash = await hashPassword(opts.password)
  }

  // 7. Create the share
  const share = await db.reportShare.create({
    data: {
      reportId,
      tokenHash,
      passwordHash: passwordHash ?? null,
      expiresAt: opts.expiresAt ?? null,
      emailRestriction: opts.emailRestriction ?? null,
      createdById: userId,
    },
  })

  // 8. Audit
  await recordAudit(
    'REPORT_SHARE_CREATE',
    { type: 'ReportShare', id: share.id },
    {
      actorType: 'USER',
      actorId: userId,
      workspaceId,
      ip: auditCtx?.ip,
      userAgent: auditCtx?.userAgent,
      requestId: auditCtx?.requestId,
    },
    {
      runId,
      reportId,
      shareType,
      hasPassword: !!passwordHash,
      expiresAt: opts.expiresAt?.toISOString() ?? null,
      emailRestriction: opts.emailRestriction ?? null,
    },
  )

  return {
    shareId: share.id,
    token,
    expiresAt: share.expiresAt,
    emailRestriction: share.emailRestriction,
    hasPassword: !!passwordHash,
    createdAt: share.createdAt,
  }
}

/**
 * Verify share access and return the report data.
 *
 * This is the core access-control function. It:
 * 1. Hashes the plaintext token and looks up the share
 * 2. Checks revocation, expiration, email restriction, password
 * 3. Increments view count on success
 * 4. Generates the report (technical or client-facing)
 *
 * Returns the result or throws appropriate errors.
 */
export async function verifyShareAccess(
  token: string,
  opts: ShareAccessOptions,
): Promise<ShareAccessResult | ShareAccessDenied> {
  // 1. Look up share by token hash
  const tokenHash = hashToken(token)
  const share = await db.reportShare.findUnique({
    where: { tokenHash },
    include: {
      report: {
        include: {
          run: {
            select: { id: true, projectId: true, workspaceId: true },
          },
        },
      },
    },
  })

  if (!share) {
    return { status: 'NOT_FOUND' }
  }

  // 2. Check revocation
  if (share.revokedAt) {
    return { status: 'REVOKED', shareId: share.id }
  }

  // 3. Check expiration
  if (share.expiresAt && share.expiresAt < new Date()) {
    return { status: 'EXPIRED', shareId: share.id }
  }

  // 4. Check email restriction
  if (share.emailRestriction) {
    if (!opts.viewerEmail || opts.viewerEmail.toLowerCase() !== share.emailRestriction.toLowerCase()) {
      return { status: 'EMAIL_RESTRICTED', shareId: share.id }
    }
  }

  // 5. Check password
  if (share.passwordHash) {
    if (!opts.password) {
      return { status: 'PASSWORD_REQUIRED', shareId: share.id }
    }
    const valid = await verifyPassword(share.passwordHash, opts.password)
    if (!valid) {
      return { status: 'PASSWORD_INCORRECT', shareId: share.id }
    }
  }

  // 6. Access granted — increment view count
  await db.reportShare.update({
    where: { id: share.id },
    data: {
      viewCount: { increment: 1 },
      lastViewedAt: new Date(),
    },
  })

  // 7. Generate the report
  const reportRun = share.report.run
  if (!reportRun) {
    logger.warn('Share references a report with no associated run', { shareId: share.id, reportId: share.report.id })
    return { status: 'NOT_FOUND', shareId: share.id }
  }

  const shareType: ShareType = share.report.type === 'CLIENT' ? 'CLIENT' : 'TECHNICAL'

  let report: TechnicalReport | ClientFacingReport
  if (shareType === 'CLIENT') {
    report = await generateClientFacingReport({
      runId: reportRun.id,
      workspaceId: reportRun.workspaceId,
    })
  } else {
    report = await generateTechnicalReport({
      runId: reportRun.id,
      workspaceId: reportRun.workspaceId,
    })
  }

  return {
    shareId: share.id,
    runId: reportRun.id,
    workspaceId: reportRun.workspaceId,
    shareType,
    expiresAt: share.expiresAt,
    emailRestriction: share.emailRestriction,
    hasPassword: !!share.passwordHash,
    viewCount: share.viewCount + 1, // already incremented
    report,
  }
}

/**
 * Resolve share token to basic info (without generating full report).
 * Used for "password required" gate or share preview.
 */
export async function resolveShareInfo(
  token: string,
): Promise<{ shareId: string; hasPassword: boolean; expiresAt: Date | null; emailRestriction: string | null; revokedAt: Date | null } | null> {
  const tokenHash = hashToken(token)
  const share = await db.reportShare.findUnique({
    where: { tokenHash },
    select: {
      id: true,
      passwordHash: true,
      expiresAt: true,
      emailRestriction: true,
      revokedAt: true,
    },
  })
  if (!share) return null
  return {
    shareId: share.id,
    hasPassword: !!share.passwordHash,
    expiresAt: share.expiresAt,
    emailRestriction: share.emailRestriction,
    revokedAt: share.revokedAt,
  }
}

/**
 * Revoke a share link. Sets `revokedAt` timestamp.
 * The share still exists in DB (for audit trail) but access is denied.
 */
export async function revokeShare(
  shareId: string,
  workspaceId: string,
  userId: string,
  auditCtx?: AuditContext,
): Promise<void> {
  // 1. Find the share and verify workspace ownership
  const share = await db.reportShare.findUnique({
    where: { id: shareId },
    include: {
      report: {
        select: { workspaceId: true, runId: true },
      },
    },
  })

  if (!share) {
    throw new NotFoundError('Share')
  }
  if (share.report.workspaceId !== workspaceId) {
    throw new ForbiddenError('Share does not belong to this workspace')
  }
  if (share.revokedAt) {
    throw new ValidationError('Share is already revoked')
  }

  // 2. Revoke
  await db.reportShare.update({
    where: { id: shareId },
    data: { revokedAt: new Date() },
  })

  // 3. Audit
  await recordAudit(
    'REPORT_SHARE_REVOKE',
    { type: 'ReportShare', id: shareId },
    {
      actorType: 'USER',
      actorId: userId,
      workspaceId,
      ip: auditCtx?.ip,
      userAgent: auditCtx?.userAgent,
      requestId: auditCtx?.requestId,
    },
    { reportId: share.reportId, runId: share.report.runId },
  )
}

/**
 * Get detailed information about a specific share.
 * Requires workspace membership (checked by caller).
 */
export async function getShare(shareId: string, workspaceId: string): Promise<ShareDetails> {
  const share = await db.reportShare.findUnique({
    where: { id: shareId },
    include: {
      report: {
        select: { workspaceId: true, type: true },
      },
      createdBy: {
        select: { id: true, name: true, email: true },
      },
    },
  })

  if (!share || share.report.workspaceId !== workspaceId) {
    throw new NotFoundError('Share')
  }

  return {
    id: share.id,
    reportId: share.reportId,
    shareType: share.report.type === 'CLIENT' ? 'CLIENT' : 'TECHNICAL',
    expiresAt: share.expiresAt,
    emailRestriction: share.emailRestriction,
    hasPassword: !!share.passwordHash,
    viewCount: share.viewCount,
    lastViewedAt: share.lastViewedAt,
    revokedAt: share.revokedAt,
    createdAt: share.createdAt,
    createdBy: share.createdBy ?? null,
  }
}

/**
 * List all shares for a specific run (across both TECHNICAL and CLIENT reports).
 * Requires workspace membership (checked by caller).
 */
export async function listShares(runId: string, workspaceId: string): Promise<ListSharesResult> {
  // Find all reports for this run in this workspace
  const reports = await db.report.findMany({
    where: { runId, workspaceId },
    select: { id: true, type: true },
  })

  if (reports.length === 0) {
    return { shares: [] }
  }

  const reportIds = reports.map((r) => r.id)
  const reportTypeMap = new Map(reports.map((r) => [r.id, r.type]))

  const shares = await db.reportShare.findMany({
    where: { reportId: { in: reportIds } },
    include: {
      createdBy: {
        select: { id: true, name: true, email: true },
      },
    },
    orderBy: { createdAt: 'desc' },
  })

  return {
    shares: shares.map((s) => ({
      id: s.id,
      reportId: s.reportId,
      shareType: (reportTypeMap.get(s.reportId) ?? 'TECHNICAL') === 'CLIENT' ? 'CLIENT' : 'TECHNICAL',
      expiresAt: s.expiresAt,
      emailRestriction: s.emailRestriction,
      hasPassword: !!s.passwordHash,
      viewCount: s.viewCount,
      lastViewedAt: s.lastViewedAt,
      revokedAt: s.revokedAt,
      createdAt: s.createdAt,
      createdBy: s.createdBy ?? null,
    })),
  }
}

/**
 * Generate a signed URL for artifact access within a share context.
 *
 * The signature is HMAC-SHA256(SHARE_SIGNING_KEY, artifactId + "|" + shareToken + "|" + expiresAt).
 * The URL expires after `expiresInMinutes` (default 60 minutes).
 *
 * The public artifact endpoint validates the signature and checks that the
 * share token is still valid (not revoked, not expired).
 */
export function generateSignedArtifactUrl(
  artifactId: string,
  shareToken: string,
  expiresInMinutes: number = SIGNED_ARTIFACT_EXPIRY_MINUTES,
): SignedArtifactParams {
  const expiresAt = Math.floor(Date.now() / 1000) + (expiresInMinutes * 60)
  const payload = `${artifactId}|${shareToken}|${expiresAt}`
  const signature = hmacSha256(shareSigningKey(), payload)

  return { artifactId, shareToken, expiresAt, signature }
}

/**
 * Verify a signed artifact URL. Returns true if the signature is valid and not expired.
 * Does NOT check share validity (that's done separately).
 */
export function verifySignedArtifactUrl(
  artifactId: string,
  shareToken: string,
  expiresAt: number,
  signature: string,
): boolean {
  // Check expiry first (fast path)
  const now = Math.floor(Date.now() / 1000)
  if (expiresAt < now) {
    return false
  }

  // Recompute signature
  const payload = `${artifactId}|${shareToken}|${expiresAt}`
  const expected = hmacSha256(shareSigningKey(), payload)

  return timingSafeEqual(expected, signature)
}

/**
 * Get the signing key for artifact URLs.
 * Derived from SESSION_SECRET to avoid needing a separate env var.
 */
function shareSigningKey(): string {
  return env.SESSION_SECRET + '|artifact-share-signing'
}

/**
 * Helper: find an existing Report for this run+type, or create one.
 * Returns the report ID.
 */
async function findOrCreateReportId(
  runId: string,
  projectId: string,
  workspaceId: string,
  reportType: string,
): Promise<string> {
  // Try to find existing report
  const existing = await db.report.findFirst({
    where: { runId, workspaceId, type: reportType },
    select: { id: true },
  })
  if (existing) return existing.id

  // Create new report
  const title = reportType === 'CLIENT'
    ? 'Client-Facing Report'
    : 'Technical Report'

  const report = await db.report.create({
    data: {
      projectId,
      runId,
      workspaceId,
      type: reportType,
      title,
      status: 'READY',
      sectionsJson: '[]',
    },
    select: { id: true },
  })
  return report.id
}
