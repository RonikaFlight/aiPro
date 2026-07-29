/**
 * GET /api/v1/projects/[projectId]/deployment-hooks
 *   List all deployment hooks for a project.
 *
 * POST /api/v1/projects/[projectId]/deployment-hooks
 *   Create a new deployment hook.
 *   Returns { hook, secret } — the secret is shown only once.
 */
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireWorkspaceAuth, getClientIp, getUserAgent } from '@/lib/auth-context'
import {
  createDeploymentHook,
  listDeploymentHooks,
} from '@/lib/deployment-hook-service'
import { assertCsrf } from '@/lib/csrf'
import { db } from '@/lib/db'
import { problemResponse, newRequestId, ValidationError } from '@/lib/errors'

export const dynamic = 'force-dynamic'

const createSchema = z.object({
  environmentId: z.string().optional(),
  branchFilter: z.string().max(200).optional(),
  scanProfileId: z.string().optional(),
})

/** Resolve the project's workspaceId; throws 404 if missing or deleted. */
async function resolveProjectWorkspace(projectId: string): Promise<{ id: string; workspaceId: string }> {
  const project = await db.project.findUnique({
    where: { id: projectId },
    select: { id: true, workspaceId: true, status: true },
  })
  if (!project || project.status === 'DELETED') {
    throw new ValidationError('Project not found')
  }
  return { id: project.id, workspaceId: project.workspaceId }
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const requestId = request.headers.get('X-Request-Id') ?? newRequestId()
  const instance = new URL(request.url).pathname
  try {
    const { projectId } = await params
    const { workspaceId } = await resolveProjectWorkspace(projectId)
    await requireWorkspaceAuth(workspaceId, 'projects.write')

    const hooks = await listDeploymentHooks(projectId, workspaceId)
    return NextResponse.json({ items: hooks }, { headers: { 'X-Request-Id': requestId } })
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
    const { workspaceId } = await resolveProjectWorkspace(projectId)
    const auth = await requireWorkspaceAuth(workspaceId, 'projects.write')

    const text = await request.text()
    const body = createSchema.parse(JSON.parse(text || '{}'))

    const result = await createDeploymentHook(
      {
        projectId,
        environmentId: body.environmentId,
        branchFilter: body.branchFilter,
        scanProfileId: body.scanProfileId,
      },
      workspaceId,
      auth.userId,
      {
        ip: getClientIp(request),
        userAgent: getUserAgent(request),
        requestId,
      },
    )

    return NextResponse.json(result, {
      status: 201,
      headers: { 'X-Request-Id': requestId },
    })
  } catch (err) {
    return problemResponse(err, requestId, instance)
  }
}
