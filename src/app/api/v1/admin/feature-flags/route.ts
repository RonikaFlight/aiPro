/**
 * GET /api/v1/admin/feature-flags
 *   List all feature flags.
 *
 * POST /api/v1/admin/feature-flags
 *   Create a new feature flag.
 */
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requirePlatformAdmin, getClientIp, getUserAgent } from '@/lib/auth-context'
import { assertCsrf } from '@/lib/csrf'
import { db } from '@/lib/db'
import { recordAudit } from '@/lib/audit'
import { problemResponse, newRequestId, ConflictError } from '@/lib/errors'

const PostBody = z.object({
  key: z.string().min(1).max(100).regex(/^[a-zA-Z0-9_.-]+$/),
  description: z.string().max(500).optional(),
  enabled: z.boolean().optional().default(false),
  rolloutPercent: z.number().int().min(0).max(100).optional().default(0),
})

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  const requestId = request.headers.get('X-Request-Id') ?? newRequestId()
  const instance = new URL(request.url).pathname
  try {
    await requirePlatformAdmin()

    const flags = await db.featureFlag.findMany({
      orderBy: { updatedAt: 'desc' },
    })

    return NextResponse.json(
      { items: flags, total: flags.length },
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

    // Check for duplicate key
    const existing = await db.featureFlag.findUnique({
      where: { key: body.key },
    })
    if (existing) {
      throw new ConflictError(`Feature flag with key "${body.key}" already exists`)
    }

    const flag = await db.featureFlag.create({
      data: {
        key: body.key,
        description: body.description ?? null,
        enabled: body.enabled,
        rolloutPercent: body.rolloutPercent,
      },
    })

    await recordAudit(
      'FEATURE_FLAG_CREATE',
      { type: 'FEATURE_FLAG', id: flag.id },
      {
        actorType: 'USER',
        actorId: auth.userId,
        ip: getClientIp(request),
        userAgent: getUserAgent(request),
        requestId,
      },
      { key: flag.key, enabled: flag.enabled, rolloutPercent: flag.rolloutPercent },
    )

    return NextResponse.json(flag, {
      status: 201,
      headers: { 'X-Request-Id': requestId },
    })
  } catch (err) {
    return problemResponse(err, requestId, instance)
  }
}
