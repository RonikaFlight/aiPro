import { NextRequest, NextResponse } from 'next/server'
import { requireWorkspaceAuth, getClientIp, getUserAgent } from '@/lib/auth-context'
import { db } from '@/lib/db'
import {
  getSchedule,
  updateSchedule,
  deleteSchedule,
} from '@/lib/scheduling-service'
import { problemResponse, newRequestId, NotFoundError } from '@/lib/errors'

export const dynamic = 'force-dynamic'

/**
 * GET /api/v1/schedules/[scheduleId]
 * Get a single scan schedule.
 */
export async function GET(
  request: Request,
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

    await requireWorkspaceAuth(schedule.project.workspaceId, 'projects.read')
    const result = await getSchedule(scheduleId)

    return NextResponse.json(result)
  } catch (err) {
    return problemResponse(err, requestId, new URL(request.url).pathname)
  }
}

/**
 * PUT /api/v1/schedules/[scheduleId]
 * Update a scan schedule.
 */
export async function PUT(
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

    const body = (await request.json()) as {
      cron?: string
      timezone?: string
      scanProfileId?: string | null
      enabled?: boolean
    }

    const updated = await updateSchedule(
      scheduleId,
      {
        cron: body.cron,
        timezone: body.timezone,
        scanProfileId: body.scanProfileId,
        enabled: body.enabled,
      },
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

/**
 * DELETE /api/v1/schedules/[scheduleId]
 * Delete a scan schedule.
 */
export async function DELETE(
  request: Request,
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

    await deleteSchedule(scheduleId, auth.userId, {
      ip: getClientIp(request),
      userAgent: getUserAgent(request),
      requestId,
    })

    return NextResponse.json({ deleted: true })
  } catch (err) {
    return problemResponse(err, requestId, new URL(request.url).pathname)
  }
}
