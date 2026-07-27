/**
 * GET /api/v1/projects/[projectId]/secrets
 *   List secret keys (never values) for a project.
 *
 * POST /api/v1/projects/[projectId]/secrets
 *   Set (create or update) a project secret.
 */
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireWorkspaceAuth, getClientIp, getUserAgent } from '@/lib/auth-context'
import { listSecrets, setSecret } from '@/lib/project-secrets'
import { assertCsrf } from '@/lib/csrf'
import { db } from '@/lib/db'
import { problemResponse, newRequestId, ValidationError } from '@/lib/errors'

export const dynamic = 'force-dynamic'

const setSchema = z.object({
  key: z.string().min(1).max(64).regex(/^[A-Z0-9_]+$/, 'Key must be uppercase letters/digits/underscore only'),
  value: z.string().min(1).max(8192),
  description: z.string().max(500).optional(),
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
    const auth = await requireWorkspaceAuth(project.workspaceId, 'secrets.manage')
    const secrets = await listSecrets(projectId, auth.userId, auth.workspaceRole!)
    return NextResponse.json({ items: secrets })
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
    const auth = await requireWorkspaceAuth(project.workspaceId, 'secrets.manage')

    const text = await request.text()
    const body = setSchema.parse(JSON.parse(text || '{}'))

    const secret = await setSecret(
      projectId,
      body.key,
      body.value,
      body.description ?? null,
      auth.userId,
      auth.workspaceRole!,
      {
        ip: getClientIp(request as never),
        userAgent: getUserAgent(request as never),
        requestId,
      },
    )
    return NextResponse.json(secret, { status: 201 })
  } catch (err) {
    return problemResponse(err, requestId, instance)
  }
}
