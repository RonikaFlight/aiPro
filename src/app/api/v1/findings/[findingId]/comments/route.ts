/**
 * GET  /api/v1/findings/[findingId]/comments   List comments (oldest first).
 * POST /api/v1/findings/[findingId]/comments   Add a comment.
 */
import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { requireWorkspaceAuth, getClientIp, getUserAgent } from '@/lib/auth-context'
import { addComment, listComments } from '@/lib/findings-service'
import { db } from '@/lib/db'
import { problemResponse, newRequestId, NotFoundError } from '@/lib/errors'

export const dynamic = 'force-dynamic'

const createSchema = z.object({
  body: z.string().min(1).max(4000),
})

async function resolveFindingWorkspaceId(findingId: string): Promise<string> {
  const finding = await db.finding.findUnique({
    where: { id: findingId },
    select: { workspaceId: true },
  })
  if (!finding) {
    throw new NotFoundError('Finding')
  }
  return finding.workspaceId
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ findingId: string }> },
) {
  const requestId = request.headers.get('X-Request-Id') ?? newRequestId()
  const instance = new URL(request.url).pathname
  try {
    const { findingId } = await params
    const workspaceId = await resolveFindingWorkspaceId(findingId)
    await requireWorkspaceAuth(workspaceId, 'findings.read')

    const url = new URL(request.url)
    const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '50', 10) || 50, 200)
    const cursor = url.searchParams.get('cursor') ?? undefined

    const result = await listComments(findingId, workspaceId, { limit, cursor })
    return NextResponse.json(result, { headers: { 'X-Request-Id': requestId } })
  } catch (err) {
    return problemResponse(err, requestId, instance)
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ findingId: string }> },
) {
  const requestId = request.headers.get('X-Request-Id') ?? newRequestId()
  const instance = new URL(request.url).pathname
  try {
    const { findingId } = await params
    const workspaceId = await resolveFindingWorkspaceId(findingId)
    const auth = await requireWorkspaceAuth(workspaceId, 'findings.update')

    const text = await request.text()
    const body = createSchema.parse(JSON.parse(text || '{}'))

    const comment = await addComment(findingId, workspaceId, auth.userId, body.body, {
      ip: getClientIp(request as never),
      userAgent: getUserAgent(request as never),
      requestId,
      workspaceId,
    })

    return NextResponse.json({ comment }, { status: 201, headers: { 'X-Request-Id': requestId } })
  } catch (err) {
    return problemResponse(err, requestId, instance)
  }
}
