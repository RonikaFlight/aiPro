import { NextResponse } from 'next/server'
import { requireWorkspaceAuth } from '@/lib/auth-context'
import { db } from '@/lib/db'
import { problemResponse, newRequestId } from '@/lib/errors'
import { z } from 'zod'

const Query = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  action: z.string().optional(),
})

export const dynamic = 'force-dynamic'

export async function GET(
  request: Request,
  { params }: { params: Promise<{ workspaceId: string }> },
) {
  const requestId = request.headers.get('X-Request-Id') ?? newRequestId()
  try {
    const { workspaceId } = await params
    const auth = await requireWorkspaceAuth(workspaceId, 'audit.read')
    const url = new URL(request.url)
    const query = Query.parse(Object.fromEntries(url.searchParams.entries()))

    const where = {
      workspaceId,
      ...(query.action ? { action: query.action } : {}),
    }
    const [items, total] = await Promise.all([
      db.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      db.auditLog.count({ where }),
    ])
    return NextResponse.json({ items, total, page: query.page, pageSize: query.pageSize })
  } catch (err) {
    return problemResponse(err, requestId, new URL(request.url).pathname)
  }
}
