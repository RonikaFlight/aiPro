import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireWorkspaceAuth } from '@/lib/auth-context'
import { problemResponse, newRequestId } from '@/lib/errors'
import { listUsageEvents, USAGE_EVENTS } from '@/lib/usage-service'

const Query = z.object({
  eventType: z.enum(Object.values(USAGE_EVENTS) as [string, ...string[]]).optional(),
  projectId: z.string().optional(),
  runId: z.string().optional(),
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().optional(),
})

export const dynamic = 'force-dynamic'

export async function GET(
  request: Request,
  { params }: { params: Promise<{ workspaceId: string }> },
) {
  const requestId = request.headers.get('X-Request-Id') ?? newRequestId()
  try {
    const { workspaceId } = await params
    await requireWorkspaceAuth(workspaceId, 'billing.read')
    const url = new URL(request.url)
    const query = Query.parse(Object.fromEntries(url.searchParams.entries()))
    const result = await listUsageEvents(workspaceId, {
      eventType: query.eventType as (typeof USAGE_EVENTS)[keyof typeof USAGE_EVENTS] | undefined,
      projectId: query.projectId,
      runId: query.runId,
      startDate: query.startDate ? new Date(query.startDate) : undefined,
      endDate: query.endDate ? new Date(query.endDate) : undefined,
      limit: query.limit,
      cursor: query.cursor,
    })
    return NextResponse.json(result)
  } catch (err) {
    return problemResponse(err, requestId, new URL(request.url).pathname)
  }
}
