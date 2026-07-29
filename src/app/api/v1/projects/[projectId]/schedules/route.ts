import { NextRequest, NextResponse } from 'next/server'
import { requireWorkspaceAuth, getClientIp, getUserAgent } from '@/lib/auth-context'
import { db } from '@/lib/db'
import { createSchedule, listSchedules } from '@/lib/scheduling-service'
import { problemResponse, newRequestId, NotFoundError } from '@/lib/errors'

export const dynamic = 'force-dynamic'

/**
 * GET /api/v1/projects/[projectId]/schedules
 * List all scan schedules for a project.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const requestId = request.headers.get('X-Request-Id') ?? newRequestId()
  try {
    const { projectId } = await params

    // Resolve workspace from project
    const project = await db.project.findUnique({
      where: { id: projectId },
      select: { workspaceId: true },
    })
    if (!project) throw new NotFoundError('Project')

    await requireWorkspaceAuth(project.workspaceId, 'projects.read')

    const schedules = await listSchedules(projectId)
    return NextResponse.json({ schedules })
  } catch (err) {
    return problemResponse(err, requestId, new URL(request.url).pathname)
  }
}

/**
 * POST /api/v1/projects/[projectId]/schedules
 * Create a new scan schedule.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const requestId = request.headers.get('X-Request-Id') ?? newRequestId()
  try {
    const { projectId } = await params

    const project = await db.project.findUnique({
      where: { id: projectId },
      select: { workspaceId: true },
    })
    if (!project) throw new NotFoundError('Project')

    const auth = await requireWorkspaceAuth(
      project.workspaceId,
      'projects.update',
    )

    const body = (await request.json()) as {
      cron?: string
      timezone?: string
      scanProfileId?: string
      enabled?: boolean
    }

    if (!body.cron) {
      return NextResponse.json(
        { error: 'cron is required', code: 'validation_error' },
        { status: 422 },
      )
    }
    if (!body.timezone) {
      return NextResponse.json(
        { error: 'timezone is required', code: 'validation_error' },
        { status: 422 },
      )
    }

    const schedule = await createSchedule(
      {
        projectId,
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

    return NextResponse.json(schedule, { status: 201 })
  } catch (err) {
    return problemResponse(err, requestId, new URL(request.url).pathname)
  }
}
