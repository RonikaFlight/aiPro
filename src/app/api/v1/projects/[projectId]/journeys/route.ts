/**
 * GET /api/v1/projects/[projectId]/journeys
 *   List journeys for a project (cursor pagination).
 *
 * POST /api/v1/projects/[projectId]/journeys
 *   Create a new journey (DRAFT, version 1).
 */
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireWorkspaceAuth, getClientIp, getUserAgent } from '@/lib/auth-context'
import { createJourney, listJourneys } from '@/lib/journey-service'
import { assertCsrf } from '@/lib/csrf'
import { db } from '@/lib/db'
import { JourneyStepSchema } from '@/lib/journey-types'
import { problemResponse, newRequestId, ValidationError } from '@/lib/errors'

export const dynamic = 'force-dynamic'

const listQuerySchema = z.object({
  status: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().optional(),
})

const createSchema = z.object({
  name: z.string().min(2).max(200),
  description: z.string().max(2000).optional(),
  entryUrl: z.string().max(2048).optional(),
  personaId: z.string().optional(),
  steps: z.array(JourneyStepSchema).min(1).max(100),
  changeLog: z.string().max(500).optional(),
})

async function resolveProjectWorkspace(projectId: string) {
  const project = await db.project.findUnique({
    where: { id: projectId },
    select: { id: true, workspaceId: true, status: true },
  })
  if (!project || project.status === 'DELETED') {
    throw new ValidationError('Project not found')
  }
  return project
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const requestId = request.headers.get('X-Request-Id') ?? newRequestId()
  const instance = new URL(request.url).pathname
  try {
    const { projectId } = await params
    const project = await resolveProjectWorkspace(projectId)
    const auth = await requireWorkspaceAuth(project.workspaceId, 'projects.read')

    const url = new URL(request.url)
    const query = listQuerySchema.parse(Object.fromEntries(url.searchParams.entries()))

    const result = await listJourneys(projectId, auth.userId, query)
    return NextResponse.json(result)
  } catch (err) {
    return problemResponse(err, requestId, instance)
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const requestId = request.headers.get('X-Request-Id') ?? newRequestId()
  const instance = new URL(request.url).pathname
  try {
    assertCsrf(request)
    const { projectId } = await params
    const project = await resolveProjectWorkspace(projectId)
    const auth = await requireWorkspaceAuth(project.workspaceId, 'journeys.create')

    const text = await request.text()
    const body = createSchema.parse(JSON.parse(text || '{}'))

    const journey = await createJourney(
      {
        projectId,
        name: body.name,
        description: body.description,
        entryUrl: body.entryUrl,
        personaId: body.personaId,
        steps: body.steps,
        changeLog: body.changeLog,
      },
      auth.userId,
      auth.workspaceRole!,
      {
        ip: getClientIp(request as never),
        userAgent: getUserAgent(request as never),
        requestId,
      },
    )
    return NextResponse.json(journey, { status: 201 })
  } catch (err) {
    return problemResponse(err, requestId, instance)
  }
}
