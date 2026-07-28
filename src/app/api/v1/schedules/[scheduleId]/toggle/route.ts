import { NextRequest, NextResponse } from 'next/server'
import { requireWorkspaceAuth, getClientIp, getUserAgent } from '@/lib/auth-context'
import { db } from '@/lib/db'
import { toggleSchedule } from '@/lib/scheduling-service'
import { problemResponse, newRequestId, NotFoundError, ValidationError } from '@/lib/errors'

export const dynamic = 'force-dynamic'

/**
 * POST /api/v1/schedules/[scheduleId]/toggle
 * Enable or disable a schedule.
 *
 * Body: { enabled: boolean }
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ scheduleId: string }> },
) {
  const requestId = request.headers.get('X-Request-Id') ?? newRequestId()
  try {
    const { scheduleId } = await params

    const schedule = await db.scanSchedule.findUnique({
      where: { id: scheduleId },
      include: { project: { select: { workspaceId: true } } },
    })
    if (!schedule) throw new NotFoundError('Schedule')

    const auth = await requireWorkspaceAuth(
      schedule.project.workspaceId,
      'projects.update',
    )

    const body = (await request.json()) as { enabled?: boolean }
    if (typeof body.enabled !== 'boolean') {
      throw new ValidationError('enabled (boolean) is required')
    }

    const updated = await toggleSchedule(
      scheduleId,
      body.enabled,
      auth.userId,
      {
        ip: getClientIp(request),
        userAgent: getUserAgent(request),
        requestId,
      },
    )

    return NextResponse.json(updated)
  } catch (err) {
    return problemResponse(err, requestId, new URL(request.url).pathname)
  }
}
