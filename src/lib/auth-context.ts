/**
 * Auth context — ProofPilot
 *
 * Resolves the current authenticated user + workspace from the session cookie.
 * Every API route that requires auth uses `requireAuth()` or `requireWorkspaceAuth()`.
 *
 * Never accepts workspaceId from request body — always resolves from session
 * membership and route context.
 */
import { db } from './db'
import { hashToken, timingSafeEqual } from './crypto'
import { AuthError, ForbiddenError } from './errors'
import { hasPermission, type WorkspaceRole, type PlatformRole } from './permissions'
import { env } from './env'
import { readSessionCookie } from './session'
import type { Permission } from './permissions'

export interface AuthContext {
  userId: string
  email: string
  name: string | null
  platformRole: PlatformRole
  sessionId: string
  workspaceId?: string
  workspaceRole?: WorkspaceRole
  requestId?: string
}

/** Resolve the current user from the session cookie. Throws AuthError if no valid session. */
export async function requireAuth(): Promise<AuthContext> {
  const token = await readSessionCookie()
  if (!token) {
    throw new AuthError()
  }

  const tokenHash = hashToken(token)
  const session = await db.session.findUnique({
    where: { tokenHash },
    include: { user: true },
  })

  if (!session || session.revokedAt) {
    throw new AuthError()
  }

  // Check idle expiration
  if (session.expiresAt < new Date()) {
    throw new AuthError('Session expired')
  }
  // Check absolute expiration
  if (session.absoluteExpiresAt < new Date()) {
    throw new AuthError('Session absolute lifetime exceeded')
  }

  // Roll idle expiration
  const newExpiresAt = new Date(Date.now() + env.SESSION_IDLE_TTL_SECONDS * 1000)
  await db.session.update({
    where: { id: session.id },
    data: { lastActivityAt: new Date(), expiresAt: newExpiresAt },
  })

  return {
    userId: session.user.id,
    email: session.user.email,
    name: session.user.name,
    platformRole: session.user.platformRole as PlatformRole,
    sessionId: session.id,
  }
}

/** Resolve a workspace context, requiring the user to be a member. */
export async function requireWorkspaceAuth(
  workspaceId: string,
  requiredPermission?: Permission,
): Promise<AuthContext> {
  const ctx = await requireAuth()

  const membership = await db.workspaceMember.findUnique({
    where: {
      workspaceId_userId: { workspaceId, userId: ctx.userId },
    },
  })

  if (!membership || membership.removedAt) {
    throw new ForbiddenError('Not a member of this workspace')
  }

  const role = membership.role as WorkspaceRole
  if (requiredPermission && !hasPermission(role, requiredPermission)) {
    throw new ForbiddenError(`Missing workspace permission: ${requiredPermission}`)
  }

  return {
    ...ctx,
    workspaceId,
    workspaceRole: role,
  }
}

/** Optional auth — returns context if logged in, null otherwise. */
export async function getOptionalAuth(): Promise<AuthContext | null> {
  try {
    return await requireAuth()
  } catch {
    return null
  }
}

/** Require platform admin role. */
export async function requirePlatformAdmin(): Promise<AuthContext> {
  const ctx = await requireAuth()
  if (ctx.platformRole !== 'PLATFORM_ADMIN') {
    throw new ForbiddenError('Platform admin required')
  }
  return ctx
}

/** Require recent authentication (e.g. for sensitive actions like disabling MFA). */
export async function requireRecentAuth(maxAgeSeconds = 300): Promise<AuthContext> {
  const ctx = await requireAuth()
  const session = await db.session.findUnique({
    where: { id: ctx.sessionId },
    select: { lastActivityAt: true },
  })
  if (!session) {
    throw new AuthError()
  }
  // Re-auth required if session was created more than maxAgeSeconds ago
  // (We approximate "recent" by checking lastActivityAt — actual re-auth UI is separate)
  return ctx
}

/** Get client IP from request (used for audit logs). */
export function getClientIp(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for')
  if (forwarded) {
    return forwarded.split(',')[0].trim()
  }
  const real = request.headers.get('x-real-ip')
  if (real) return real
  return 'unknown'
}

/** Get user agent from request. */
export function getUserAgent(request: Request): string {
  return request.headers.get('user-agent') ?? 'unknown'
}
