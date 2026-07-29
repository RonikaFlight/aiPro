/**
 * Audit log helper — ProofPilot
 *
 * Records immutable audit entries for sensitive actions.
 * Never stores secrets, raw tokens, or decrypted values.
 * See SECURITY_MODEL.md §"Audit logging".
 */
import { db } from './db'
import { hashIp, hashUserAgent } from './crypto'
import { logger } from './logger'

export interface AuditContext {
  actorType?: 'USER' | 'SYSTEM' | 'API_KEY' | 'SUPPORT'
  actorId?: string
  workspaceId?: string
  ip?: string
  userAgent?: string
  requestId?: string
}

export async function recordAudit(
  action: string,
  target: { type: string; id: string | string[] } | null,
  ctx: AuditContext,
  metadata?: Record<string, unknown>,
  outcome: 'SUCCESS' | 'FAILURE' | 'DENIED' = 'SUCCESS',
): Promise<void> {
  try {
    await db.auditLog.create({
      data: {
        actorType: ctx.actorType ?? 'USER',
        actorId: ctx.actorId ?? null,
        workspaceId: ctx.workspaceId ?? null,
        action,
        targetType: target?.type ?? null,
        targetId: Array.isArray(target?.id) ? target!.id.join(',') : target?.id ?? null,
        ipHash: ctx.ip ? hashIp(ctx.ip) : null,
        userAgentSummary: ctx.userAgent ? hashUserAgent(ctx.userAgent) : null,
        requestId: ctx.requestId ?? null,
        metadataJson: metadata ? JSON.stringify(metadata) : null,
        outcome,
      },
    })
  } catch (err) {
    logger.error('Failed to write audit log', {
      action,
      error: String(err),
      requestId: ctx.requestId,
    })
  }
}

export async function recordSecurityEvent(
  type: string,
  ctx: AuditContext,
  metadata?: Record<string, unknown>,
  severity: 'INFO' | 'WARN' | 'HIGH' | 'CRITICAL' = 'WARN',
): Promise<void> {
  try {
    await db.securityEvent.create({
      data: {
        type,
        severity,
        userId: ctx.actorId ?? null,
        workspaceId: ctx.workspaceId ?? null,
        ipHash: ctx.ip ? hashIp(ctx.ip) : null,
        requestId: ctx.requestId ?? null,
        metadataJson: metadata ? JSON.stringify(metadata) : null,
      },
    })
  } catch (err) {
    logger.error('Failed to write security event', {
      type,
      error: String(err),
    })
  }
}
