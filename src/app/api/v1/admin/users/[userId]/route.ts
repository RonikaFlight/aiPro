/**
 * GET /api/v1/admin/users/[userId]
 *   Get a single user with counts.
 *
 * PATCH /api/v1/admin/users/[userId]
 *   Update user fields.
 *
 * DELETE /api/v1/admin/users/[userId]
 *   Suspend user (soft delete via status=SUSPENDED).
 */
import { NextResponse } from 'next/server'
import { z } from 'zod'
import {
  requirePlatformAdmin,
  getClientIp,
  getUserAgent,
} from '@/lib/auth-context'
import { assertCsrf } from '@/lib/csrf'
import { db } from '@/lib/db'
import { recordAudit } from '@/lib/audit'
import { problemResponse, newRequestId, NotFoundError } from '@/lib/errors'

const PatchBody = z.object({
  name: z.string().max(100).optional(),
  platformRole: z
    .enum(['USER', 'SUPPORT', 'PLATFORM_ADMIN'])
    .optional(),
  status: z
    .enum(['PENDING_VERIFICATION', 'ACTIVE', 'SUSPENDED', 'DELETED'])
    .optional(),
})

export const dynamic = 'force-dynamic'

export async function GET(
  request: Request,
  { params }: { params: Promise<{ userId: string }> },
) {
  const requestId = request.headers.get('X-Request-Id') ?? newRequestId()
  const instance = new URL(request.url).pathname
  try {
    await requirePlatformAdmin()
    const { userId } = await params

    const user = await db.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        name: true,
        status: true,
        platformRole: true,
        locale: true,
        timezone: true,
        avatarUrl: true,
        lastLoginAt: true,
        failedLoginCount: true,
        lockedUntil: true,
        createdAt: true,
        updatedAt: true,
        _count: {
          select: {
            sessions: true,
            workspaceMembers: true,
            auditLogs: true,
          },
        },
      },
    })

    if (!user) throw new NotFoundError('User')

    return NextResponse.json(user, { headers: { 'X-Request-Id': requestId } })
  } catch (err) {
    return problemResponse(err, requestId, instance)
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ userId: string }> },
) {
  const requestId = request.headers.get('X-Request-Id') ?? newRequestId()
  const instance = new URL(request.url).pathname
  try {
    assertCsrf(request)
    const auth = await requirePlatformAdmin()
    const { userId } = await params

    const existing = await db.user.findUnique({ where: { id: userId } })
    if (!existing) throw new NotFoundError('User')

    const text = await request.text()
    const body = PatchBody.parse(JSON.parse(text || '{}'))

    if (Object.keys(body).length === 0) {
      return NextResponse.json(existing, {
        headers: { 'X-Request-Id': requestId },
      })
    }

    const user = await db.user.update({
      where: { id: userId },
      data: body,
      select: {
        id: true,
        email: true,
        name: true,
        status: true,
        platformRole: true,
        createdAt: true,
        updatedAt: true,
      },
    })

    await recordAudit(
      'USER_UPDATE',
      { type: 'USER', id: userId },
      {
        actorType: 'USER',
        actorId: auth.userId,
        ip: getClientIp(request),
        userAgent: getUserAgent(request),
        requestId,
      },
      { updatedFields: Object.keys(body) },
    )

    return NextResponse.json(user, { headers: { 'X-Request-Id': requestId } })
  } catch (err) {
    return problemResponse(err, requestId, instance)
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ userId: string }> },
) {
  const requestId = request.headers.get('X-Request-Id') ?? newRequestId()
  const instance = new URL(request.url).pathname
  try {
    assertCsrf(request)
    const auth = await requirePlatformAdmin()
    const { userId } = await params

    const existing = await db.user.findUnique({ where: { id: userId } })
    if (!existing) throw new NotFoundError('User')

    // Soft-suspend the user
    const user = await db.user.update({
      where: { id: userId },
      data: { status: 'SUSPENDED' },
      select: {
        id: true,
        email: true,
        name: true,
        status: true,
        platformRole: true,
        createdAt: true,
        updatedAt: true,
      },
    })

    await recordAudit(
      'USER_SUSPEND',
      { type: 'USER', id: userId },
      {
        actorType: 'USER',
        actorId: auth.userId,
        ip: getClientIp(request),
        userAgent: getUserAgent(request),
        requestId,
      },
      { previousStatus: existing.status },
    )

    return NextResponse.json(user, { headers: { 'X-Request-Id': requestId } })
  } catch (err) {
    return problemResponse(err, requestId, instance)
  }
}
