/**
 * GET /api/v1/admin/jobs
 *   List queue jobs with cursor pagination and filters.
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
    const queue = searchParams.get('queue') ?? undefined
    const status = searchParams.get('status') ?? undefined
    const cursor = searchParams.get('cursor') ?? undefined
    const limit = Math.min(
      Math.max(Number(searchParams.get('limit')) || 20, 1),
      100,
    )

    const where: Record<string, unknown> = {}
    if (queue) where.queue = queue
    if (status) where.status = status
    if (cursor) where.createdAt = { lt: new Date(cursor) }

    const [items, total] = await Promise.all([
      db.queueJob.findMany({
        where,
        take: limit,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          queue: true,
          status: true,
          priority: true,
          attempts: true,
          maxAttempts: true,
          runAt: true,
          startedAt: true,
          completedAt: true,
          failedReason: true,
          correlationId: true,
          workspaceId: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
      db.queueJob.count({ where }),
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
