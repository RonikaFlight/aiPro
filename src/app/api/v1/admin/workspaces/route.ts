/**
 * GET /api/v1/admin/workspaces
 *   List workspaces with cursor pagination.
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
    const search = searchParams.get('search')?.trim() ?? ''
    const cursor = searchParams.get('cursor') ?? undefined
    const limit = Math.min(
      Math.max(Number(searchParams.get('limit')) || 20, 1),
      100,
    )

    const where: Record<string, unknown> = {}
    if (search) {
      where.OR = [
        { name: { contains: search } },
        { slug: { contains: search } },
      ]
    }
    if (cursor) where.createdAt = { lt: new Date(cursor) }

    const [items, total] = await Promise.all([
      db.workspace.findMany({
        where,
        take: limit,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          name: true,
          slug: true,
          customDomain: true,
          retentionDays: true,
          createdAt: true,
          updatedAt: true,
          owner: {
            select: { id: true, name: true, email: true },
          },
          _count: {
            select: {
              projects: true,
              members: true,
              subscriptions: true,
            },
          },
        },
      }),
      db.workspace.count(),
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
