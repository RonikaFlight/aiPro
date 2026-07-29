/**
 * PATCH /api/v1/admin/feature-flags/[flagId]
 *   Update a feature flag.
 *
 * DELETE /api/v1/admin/feature-flags/[flagId]
 *   Delete a feature flag.
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
  description: z.string().max(500).optional(),
  enabled: z.boolean().optional(),
  rolloutPercent: z.number().int().min(0).max(100).optional(),
})

export const dynamic = 'force-dynamic'

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ flagId: string }> },
) {
  const requestId = request.headers.get('X-Request-Id') ?? newRequestId()
  const instance = new URL(request.url).pathname
  try {
    assertCsrf(request)
    const auth = await requirePlatformAdmin()
    const { flagId } = await params

    const existing = await db.featureFlag.findUnique({ where: { id: flagId } })
    if (!existing) throw new NotFoundError('FeatureFlag')

    const text = await request.text()
    const body = PatchBody.parse(JSON.parse(text || '{}'))

    if (Object.keys(body).length === 0) {
      return NextResponse.json(existing, {
        headers: { 'X-Request-Id': requestId },
      })
    }

    const flag = await db.featureFlag.update({
      where: { id: flagId },
      data: body,
    })

    await recordAudit(
      'FEATURE_FLAG_UPDATE',
      { type: 'FEATURE_FLAG', id: flagId },
      {
        actorType: 'USER',
        actorId: auth.userId,
        ip: getClientIp(request),
        userAgent: getUserAgent(request),
        requestId,
      },
      { key: flag.key, updatedFields: Object.keys(body) },
    )

    return NextResponse.json(flag, { headers: { 'X-Request-Id': requestId } })
  } catch (err) {
    return problemResponse(err, requestId, instance)
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ flagId: string }> },
) {
  const requestId = request.headers.get('X-Request-Id') ?? newRequestId()
  const instance = new URL(request.url).pathname
  try {
    assertCsrf(request)
    const auth = await requirePlatformAdmin()
    const { flagId } = await params

    const existing = await db.featureFlag.findUnique({ where: { id: flagId } })
    if (!existing) throw new NotFoundError('FeatureFlag')

    await db.featureFlag.delete({ where: { id: flagId } })

    await recordAudit(
      'FEATURE_FLAG_DELETE',
      { type: 'FEATURE_FLAG', id: flagId },
      {
        actorType: 'USER',
        actorId: auth.userId,
        ip: getClientIp(request),
        userAgent: getUserAgent(request),
        requestId,
      },
      { key: existing.key },
    )

    return NextResponse.json(
      { deleted: true, id: flagId },
      { headers: { 'X-Request-Id': requestId } },
    )
  } catch (err) {
    return problemResponse(err, requestId, instance)
  }
}
