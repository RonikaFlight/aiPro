/**
 * GET /api/v1/runs/[runId]
 *   Get a single run with events + config snapshot.
 *
 * DELETE /api/v1/runs/[runId]
 *   Cancel a queued/running scan (idempotent).
 */
import { NextResponse } from 'next/server'
import { assertCsrf } from '@/lib/csrf'
import { db } from '@/lib/db'
import { problemResponse, newRequestId, NotFoundError } from '@/lib/errors'
import { getRun, cancelRun } from '@/lib/run-service'
import { getClientIp, getUserAgent, requireWorkspaceAuth } from '@/lib/auth-context'

export const dynamic = 'force-dynamic'

export async function GET(
  request: Request,
  { params }: { params: Promise<{ runId: string }> },
) {
  const requestId = request.headers.get('X-Request-Id') ?? newRequestId()
  const instance = new URL(request.url).pathname
  try {
    const { runId } = await params
    // Look up the run first to get its workspaceId for auth
    const run = await db.scanRun.findUnique({
      where: { id: runId },
      select: { workspaceId: true },
    })
    if (!run) throw new NotFoundError('Run')
    const auth = await requireWorkspaceAuth(run.workspaceId, 'runs.read')
    const result = await getRun(runId, auth.userId)
    return NextResponse.json(result, { headers: { 'X-Request-Id': requestId } })
  } catch (err) {
    return problemResponse(err, requestId, instance)
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ runId: string }> },
) {
  const requestId = request.headers.get('X-Request-Id') ?? newRequestId()
  const instance = new URL(request.url).pathname
  try {
    assertCsrf(request)
    const { runId } = await params
    const run = await db.scanRun.findUnique({
      where: { id: runId },
      select: { workspaceId: true },
    })
    if (!run) throw new NotFoundError('Run')
    const auth = await requireWorkspaceAuth(run.workspaceId, 'runs.cancel')
    const result = await cancelRun(
      runId,
      auth.userId,
      {
        ip: getClientIp(request as never),
        userAgent: getUserAgent(request as never),
        requestId,
      },
    )
    return NextResponse.json(result, { headers: { 'X-Request-Id': requestId } })
  } catch (err) {
    return problemResponse(err, requestId, instance)
  }
}
