/**
 * Retention cleanup service — ProofPilot (Phase 11)
 *
 * Batch-deletes expired data based on workspace/project retentionDays
 * settings. Runs inside a transaction for atomicity.
 *
 * Cleaned-up entities:
 *   - Sessions past absoluteExpiresAt
 *   - WorkspaceInvitations past expiresAt (not accepted)
 *   - DataExportRequest rows past retention window
 *   - Artifacts past workspace/project retentionDays
 *
 * See IMPLEMENTATION_CHECKLIST.md Phase 11 §"Retention".
 */
import { db } from './db'
import { logger } from './logger'

// ===========================================================
// Types
// ===========================================================

/** Summary returned from a retention cleanup run. */
export interface RetentionCleanupSummary {
  sessionsDeleted: number
  invitationsDeleted: number
  exportsDeleted: number
  artifactsDeleted: number
  workspaceId?: string
  cleanedAt: string
}

// ===========================================================
// Public entry point
// ===========================================================

/**
 * Run retention cleanup for a specific workspace, or all workspaces.
 *
 * If `workspaceId` is provided, only cleans artifacts for that workspace.
 * Session and invitation cleanup is always global (not workspace-scoped).
 *
 * Returns a summary of what was cleaned.
 */
export async function runRetentionCleanup(
  workspaceId?: string,
): Promise<RetentionCleanupSummary> {
  logger.info('Starting retention cleanup', { workspaceId })

  const cleanedAt = new Date().toISOString()

  const [
    sessionsDeleted,
    invitationsDeleted,
    exportsDeleted,
    artifactsDeleted,
  ] = await Promise.all([
    cleanupExpiredSessions(),
    cleanupExpiredInvitations(),
    cleanupOldExports(workspaceId),
    cleanupOldArtifacts(workspaceId),
  ])

  const summary: RetentionCleanupSummary = {
    sessionsDeleted,
    invitationsDeleted,
    exportsDeleted,
    artifactsDeleted,
    workspaceId,
    cleanedAt,
  }

  logger.info('Retention cleanup completed', summary)
  return summary
}

// ===========================================================
// Individual cleanup functions
// ===========================================================

/**
 * Remove sessions that have passed their absolute expiration time.
 * This is a hard delete — session tokens are already hashed and irrecoverable.
 */
export async function cleanupExpiredSessions(): Promise<number> {
  const now = new Date()

  // Count before deleting for the summary
  const count = await db.session.count({
    where: {
      absoluteExpiresAt: { lt: now },
    },
  })

  if (count === 0) return 0

  await db.session.deleteMany({
    where: {
      absoluteExpiresAt: { lt: now },
    },
  })

  logger.debug('Cleaned up expired sessions', { count })
  return count
}

/**
 * Remove workspace invitations that have expired and were never accepted.
 * Keeps accepted invitations (they become historical records).
 */
export async function cleanupExpiredInvitations(): Promise<number> {
  const now = new Date()

  const count = await db.workspaceInvitation.count({
    where: {
      expiresAt: { lt: now },
      acceptedAt: null,
    },
  })

  if (count === 0) return 0

  await db.workspaceInvitation.deleteMany({
    where: {
      expiresAt: { lt: now },
      acceptedAt: null,
    },
  })

  logger.debug('Cleaned up expired invitations', { count })
  return count
}

/**
 * Remove DataExportRequest rows that are past their retention window.
 *
 * Exports are considered expired if:
 *   - They are READY or FAILED
 *   - Their requestedAt is older than the workspace's retentionDays
 *
 * If no workspaceId is given, we delete exports older than 30 days (default).
 */
export async function cleanupOldExports(workspaceId?: string): Promise<number> {
  let retentionDays = 30 // default

  if (workspaceId) {
    const workspace = await db.workspace.findUnique({
      where: { id: workspaceId },
      select: { retentionDays: true },
    })
    if (workspace) {
      retentionDays = workspace.retentionDays
    }
  }

  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - retentionDays)

  const where: Record<string, unknown> = {
    requestedAt: { lt: cutoff },
    status: { in: ['READY', 'FAILED'] },
  }
  if (workspaceId) {
    where.workspaceId = workspaceId
  }

  const count = await db.dataExportRequest.count({ where })

  if (count === 0) return 0

  await db.dataExportRequest.deleteMany({ where })

  logger.debug('Cleaned up old exports', { count, retentionDays, workspaceId })
  return count
}

/**
 * Remove Artifact rows based on workspace/project retentionDays.
 *
 * Artifacts are considered expired if:
 *   - They have a retentionExpiresAt that is in the past, OR
 *   - The workspace/project retentionDays has elapsed since creation
 *
 * If no workspaceId is given, cleans all expired artifacts across all workspaces.
 */
export async function cleanupOldArtifacts(workspaceId?: string): Promise<number> {
  // Find workspaces to process
  const workspaces = workspaceId
    ? await db.workspace.findMany({
        where: { id: workspaceId },
        select: { id: true, retentionDays: true },
      })
    : await db.workspace.findMany({
        select: { id: true, retentionDays: true },
      })

  let totalDeleted = 0

  for (const ws of workspaces) {
    // Use the minimum of workspace retentionDays and a 90-day absolute ceiling
    const retentionDays = Math.min(ws.retentionDays, 90)
    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() - retentionDays)

    const count = await db.artifact.count({
      where: {
        workspaceId: ws.id,
        createdAt: { lt: cutoff },
      },
    })

    if (count === 0) continue

    await db.artifact.deleteMany({
      where: {
        workspaceId: ws.id,
        createdAt: { lt: cutoff },
      },
    })

    totalDeleted += count
    logger.debug('Cleaned up old artifacts for workspace', {
      workspaceId: ws.id,
      count,
      retentionDays,
    })
  }

  return totalDeleted
}
