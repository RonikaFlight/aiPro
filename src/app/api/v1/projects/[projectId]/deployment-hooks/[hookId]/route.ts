/**
 * PATCH /api/v1/projects/[projectId]/deployment-hooks/[hookId]
 *   Toggle a deployment hook enabled/disabled.
 *
 * DELETE /api/v1/projects/[projectId]/deployment-hooks/[hookId]
 *   Delete a deployment hook.
 */
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireWorkspaceAuth, getClientIp, getUserAgent } from '@/lib/auth-context'
import {
  toggleDeploymentHook,
  deleteDeploymentHook,
} from '@/lib/deployment-hook-service'
import { assertCsrf } from '@/lib/csrf'
import { db } from '@/lib/db'
import { problemResponse, newRequestId, ValidationError } from '@/lib/errors'

export const dynamic = 'force-dynamic'

const toggleSchema = z.object({
  enabled: z.boolean(),
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

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ projectId: string; hookId: string }> },
) {
  const requestId = request.headers.get('X-Request-Id') ?? newRequestId()
  const instance = new URL(request.url).pathname
  try {
    assertCsrf(request)
    const { projectId, hookId } = await params
    const { workspaceId } = await resolveProjectWorkspace(projectId)
    const auth = await requireWorkspaceAuth(workspaceId, 'projects.write')

    const text = await request.text()
    const body = toggleSchema.parse(JSON.parse(text || '{}'))

    const hook = await toggleDeploymentHook(
      hookId,
      workspaceId,
      body.enabled,
      auth.userId,
      {
        ip: getClientIp(request),
        userAgent: getUserAgent(request),
        requestId,
      },
    )

    return NextResponse.json(hook, { headers: { 'X-Request-Id': requestId } })
  } catch (err) {
    return problemResponse(err, requestId, instance)
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ projectId: string; hookId: string }> },
) {
  const requestId = request.headers.get('X-Request-Id') ?? newRequestId()
  const instance = new URL(request.url).pathname
  try {
    assertCsrf(request)
    const { projectId, hookId } = await params
    const { workspaceId } = await resolveProjectWorkspace(projectId)
    const auth = await requireWorkspaceAuth(workspaceId, 'projects.write')

    await deleteDeploymentHook(
      hookId,
      workspaceId,
      auth.userId,
      {
        ip: getClientIp(request),
        userAgent: getUserAgent(request),
        requestId,
      },
    )

    return new NextResponse(null, { status: 204 })
  } catch (err) {
    return problemResponse(err, requestId, instance)
  }
}
