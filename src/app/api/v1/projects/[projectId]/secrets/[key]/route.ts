/**
 * DELETE /api/v1/projects/[projectId]/secrets/[key]
 *   Delete a project secret by key.
 */
import { NextResponse } from 'next/server'
import { requireWorkspaceAuth, getClientIp, getUserAgent } from '@/lib/auth-context'
import { deleteSecret } from '@/lib/project-secrets'
import { assertCsrf } from '@/lib/csrf'
import { db } from '@/lib/db'
import { problemResponse, newRequestId, ValidationError } from '@/lib/errors'

export const dynamic = 'force-dynamic'

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

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ projectId: string; key: string }> },
) {
  const requestId = request.headers.get('X-Request-Id') ?? newRequestId()
  const instance = new URL(request.url).pathname
  try {
    assertCsrf(request)
    const { projectId, key } = await params
    const project = await resolveProjectWorkspace(projectId)
    const auth = await requireWorkspaceAuth(project.workspaceId, 'secrets.manage')

    await deleteSecret(
      projectId,
      key,
      auth.userId,
      auth.workspaceRole!,
      {
        ip: getClientIp(request as never),
        userAgent: getUserAgent(request as never),
        requestId,
      },
    )
    return new NextResponse(null, { status: 204 })
  } catch (err) {
    return problemResponse(err, requestId, instance)
  }
}
