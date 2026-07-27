/**
 * POST /api/v1/projects/[projectId]/runs
 *   Create (enqueue) a new scan run.
 *
 * GET /api/v1/projects/[projectId]/runs
 *   List runs for a project (cursor pagination).
 */
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireWorkspaceAuth, getClientIp, getUserAgent } from '@/lib/auth-context'
import { createRun, listRuns } from '@/lib/run-service'
import { assertCsrf } from '@/lib/csrf'
import { db } from '@/lib/db'
import { problemResponse, newRequestId, ValidationError } from '@/lib/errors'

export const dynamic = 'force-dynamic'

const createSchema = z.object({
  environmentId: z.string().optional(),
  targetUrl: z.string().optional(),
  runMode: z.enum(['PASSIVE', 'SAFE_INTERACTION', 'TEST_TRANSACTION', 'CUSTOM_APPROVED']).default('PASSIVE'),
  trigger: z.enum(['MANUAL', 'RESCAN']).default('MANUAL'),
  scanProfileId: z.string().optional(),
  userConfirmedDestructive: z.boolean().optional(),
  config: z
    .object({
      maxPages: z.number().int().min(1).max(50).optional(),
      maxDepth: z.number().int().min(1).max(5).optional(),
      timeoutMs: z.number().int().min(1000).max(120000).optional(),
      viewports: z.array(z.string()).optional(),
      locales: z.array(z.string()).optional(),
      browsers: z.array(z.string()).optional(),
      analyzers: z.array(z.string()).nullable().optional(),
      journeyIds: z.array(z.string()).nullable().optional(),
    })
    .optional(),
})

/** Resolve the project's workspaceId; throws 404 if missing or deleted. */
async function resolveProjectWorkspaceId(projectId: string): Promise<{ projectId: string; workspaceId: string }> {
  const project = await db.project.findUnique({
    where: { id: projectId },
    select: { id: true, workspaceId: true, status: true },
  })
  if (!project || project.status === 'DELETED') {
    throw new ValidationError('Project not found')
  }
  return { projectId: project.id, workspaceId: project.workspaceId }
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
    const { workspaceId } = await resolveProjectWorkspaceId(projectId)
    const auth = await requireWorkspaceAuth(workspaceId, 'runs.create')

    const text = await request.text()
    const body = createSchema.parse(JSON.parse(text || '{}'))

    const result = await createRun(
      {
        projectId,
        environmentId: body.environmentId,
        targetUrl: body.targetUrl,
        runMode: body.runMode,
        trigger: body.trigger,
        scanProfileId: body.scanProfileId,
        userConfirmedDestructive: body.userConfirmedDestructive,
        config: body.config,
      },
      auth.userId,
      auth.workspaceRole!,
      {
        ip: getClientIp(request as never),
        userAgent: getUserAgent(request as never),
        requestId,
      },
    )
    return NextResponse.json(result, { status: 201, headers: { 'X-Request-Id': requestId } })
  } catch (err) {
    return problemResponse(err, requestId, instance)
  }
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const requestId = request.headers.get('X-Request-Id') ?? newRequestId()
  const instance = new URL(request.url).pathname
  try {
    const { projectId } = await params
    const { workspaceId } = await resolveProjectWorkspaceId(projectId)
    const auth = await requireWorkspaceAuth(workspaceId, 'runs.read')

    const url = new URL(request.url)
    const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '25', 10) || 25, 100)
    const cursor = url.searchParams.get('cursor') ?? undefined
    const status = url.searchParams.get('status') ?? undefined

    const result = await listRuns(projectId, auth.userId, { status, limit, cursor })
    return NextResponse.json(result, { headers: { 'X-Request-Id': requestId } })
  } catch (err) {
    return problemResponse(err, requestId, instance)
  }
}
