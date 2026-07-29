/**
 * GET /api/v1/admin/security-events
 *   List security events ordered by createdAt desc.
 */
import { NextResponse } from 'next/server'
import { requirePlatformAdmin } from '@/lib/auth-context'
import { db } from '@/lib/db'
import { problemResponse, newRequestId } from '@/lib/errors'

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  const requestId = request.headers.get('X-Request-Id') ?? newRequestId()
  const instance = new URL(request.url).pathname
  try {
    await requirePlatformAdmin()

    const { searchParams } = new URL(request.url)
    const type = searchParams.get('type') ?? undefined
    const severity = searchParams.get('severity') ?? undefined
    const cursor = searchParams.get('cursor') ?? undefined
    const limit = Math.min(
      Math.max(Number(searchParams.get('limit')) || 50, 1),
      100,
    )

    const where: Record<string, unknown> = {}
    if (type) where.type = type
    if (severity) where.severity = severity
    if (cursor) where.createdAt = { lt: new Date(cursor) }

    const [items, total] = await Promise.all([
      db.securityEvent.findMany({
        where,
        take: limit,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          type: true,
          severity: true,
          userId: true,
          workspaceId: true,
          requestId: true,
          metadataJson: true,
          createdAt: true,
        },
      }),
      db.securityEvent.count({ where }),
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
