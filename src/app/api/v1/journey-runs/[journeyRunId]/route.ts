/**
 * GET /api/v1/journey-runs/[journeyRunId]
 *   Get a journey run with all step results.
 *
 * DELETE /api/v1/journey-runs/[journeyRunId]
 *   Cancel a queued/running journey run (idempotent).
 */
import { NextResponse } from 'next/server'
import { requireAuth, getClientIp, getUserAgent } from '@/lib/auth-context'
import { cancelJourneyRun, getJourneyRun } from '@/lib/journey-run-service'
import { assertCsrf } from '@/lib/csrf'
import { problemResponse, newRequestId } from '@/lib/errors'

export const dynamic = 'force-dynamic'

export async function GET(
  request: Request,
  { params }: { params: Promise<{ journeyRunId: string }> },
) {
  const requestId = request.headers.get('X-Request-Id') ?? newRequestId()
  const instance = new URL(request.url).pathname
  try {
    const { journeyRunId } = await params
    const auth = await requireAuth()
    const run = await getJourneyRun(journeyRunId, auth.userId)
    return NextResponse.json(run)
  } catch (err) {
    return problemResponse(err, requestId, instance)
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ journeyRunId: string }> },
) {
  const requestId = request.headers.get('X-Request-Id') ?? newRequestId()
  const instance = new URL(request.url).pathname
  try {
    assertCsrf(request)
    const { journeyRunId } = await params
    const auth = await requireAuth()
    await cancelJourneyRun(
      journeyRunId,
      auth.userId,
      auth.workspaceRole as 'OWNER' | 'ADMIN' | 'MEMBER' | 'VIEWER' | 'CLIENT',
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
