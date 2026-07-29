/**
 * GET /api/v1/admin/users
 *   List users with filtering and cursor pagination.
 *
 * POST /api/v1/admin/users
 *   Create or update a user (upsert by email).
 */
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requirePlatformAdmin, getClientIp, getUserAgent } from '@/lib/auth-context'
import { assertCsrf } from '@/lib/csrf'
import { db } from '@/lib/db'
import { hashPassword } from '@/lib/crypto'
import { recordAudit } from '@/lib/audit'
import { problemResponse, newRequestId, ValidationError } from '@/lib/errors'

const PostBody = z.object({
  email: z.string().email().max(254),
  name: z.string().max(100).optional(),
  password: z.string().min(8).max(128).optional(),
  platformRole: z.enum(['USER', 'SUPPORT', 'PLATFORM_ADMIN']).optional(),
  status: z
    .enum(['PENDING_VERIFICATION', 'ACTIVE', 'SUSPENDED', 'DELETED'])
    .optional(),
})

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  const requestId = request.headers.get('X-Request-Id') ?? newRequestId()
  const instance = new URL(request.url).pathname
  try {
    await requirePlatformAdmin()

    const { searchParams } = new URL(request.url)
    const search = searchParams.get('search')?.trim() ?? ''
    const status = searchParams.get('status') ?? undefined
    const platformRole = searchParams.get('platformRole') ?? undefined
    const cursor = searchParams.get('cursor') ?? undefined
    const limit = Math.min(
      Math.max(Number(searchParams.get('limit')) || 20, 1),
      100,
    )

    const where: Record<string, unknown> = {}
    if (search) {
      where.OR = [
        { email: { contains: search } },
        { emailLower: { contains: search.toLowerCase() } },
        { name: { contains: search } },
      ]
    }
    if (status) where.status = status
    if (platformRole) where.platformRole = platformRole
    if (cursor) where.createdAt = { lt: new Date(cursor) }

    const [items, total] = await Promise.all([
      db.user.findMany({
        where,
        take: limit,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          email: true,
          name: true,
          status: true,
          platformRole: true,
          lastLoginAt: true,
          createdAt: true,
          updatedAt: true,
          _count: {
            select: {
              sessions: true,
              workspaceMembers: true,
            },
          },
        },
      }),
      db.user.count({ where: where.OR ? where : undefined }),
    ])

    const nextCursor =
      items.length === limit
        ? items[items.length - 1].createdAt.toISOString()
        : null

    return NextResponse.json(
      { items, nextCursor, total },
      { headers: { 'X-Request-Id': requestId } },
    )
  } catch (err) {
    return problemResponse(err, requestId, instance)
  }
}

export async function POST(request: Request) {
  const requestId = request.headers.get('X-Request-Id') ?? newRequestId()
  const instance = new URL(request.url).pathname
  try {
    assertCsrf(request)
    const auth = await requirePlatformAdmin()

    const text = await request.text()
    const body = PostBody.parse(JSON.parse(text || '{}'))

    const emailLower = body.email.toLowerCase()

    const existing = await db.user.findUnique({
      where: { emailLower },
    })

    if (existing) {
      // Update existing user
      const updateData: Record<string, string> = {}
      if (body.name !== undefined) updateData.name = body.name
      if (body.platformRole !== undefined)
        updateData.platformRole = body.platformRole
      if (body.status !== undefined) updateData.status = body.status
      if (body.password) {
        updateData.passwordHash = await hashPassword(body.password)
      }

      const user = await db.user.update({
        where: { id: existing.id },
        data: updateData,
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
        { type: 'USER', id: existing.id },
        {
          actorType: 'USER',
          actorId: auth.userId,
          ip: getClientIp(request),
          userAgent: getUserAgent(request),
          requestId,
        },
        { updatedFields: Object.keys(updateData) },
      )

      return NextResponse.json(user, { headers: { 'X-Request-Id': requestId } })
    }

    // Create new user
    if (!body.password) {
      throw new ValidationError('Password is required for new users')
    }

    const passwordHash = await hashPassword(body.password)

    const user = await db.user.create({
      data: {
        email: body.email,
        emailLower,
        name: body.name ?? null,
        passwordHash,
        platformRole: body.platformRole ?? 'USER',
        status: body.status ?? 'PENDING_VERIFICATION',
      },
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
      'USER_CREATE',
      { type: 'USER', id: user.id },
      {
        actorType: 'USER',
        actorId: auth.userId,
        ip: getClientIp(request),
        userAgent: getUserAgent(request),
        requestId,
      },
      { email: body.email, platformRole: user.platformRole },
    )

    return NextResponse.json(user, {
      status: 201,
      headers: { 'X-Request-Id': requestId },
    })
  } catch (err) {
    return problemResponse(err, requestId, instance)
  }
}
