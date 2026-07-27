/**
 * POST /api/v1/journeys/[journeyId]/versions/[version]/rollback
 *   Roll back the journey's currentVersion to the specified version.
 *   No version row is deleted — old versions are retained for audit.
 */
import { NextResponse } from 'next/server'
import { requireAuth, getClientIp, getUserAgent } from '@/lib/auth-context'
import { rollbackJourney } from '@/lib/journey-service'
import { assertCsrf } from '@/lib/csrf'
import { problemResponse, newRequestId } from '@/lib/errors'

export const dynamic = 'force-dynamic'

export async function POST(
  request: Request,
  { params }: { params: Promise<{ journeyId: string; version: string }> },
) {
  const requestId = request.headers.get('X-Request-Id') ?? newRequestId()
  const instance = new URL(request.url).pathname
  try {
    assertCsrf(request)
    const { journeyId, version: versionStr } = await params
    const version = parseInt(versionStr, 10)
    if (!Number.isInteger(version) || version < 1) {
      return NextResponse.json(
        { error: 'Invalid version number', type: 'about:blank', status: 400 },
        { status: 400 },
      )
    }
    const auth = await requireAuth()
    const journey = await rollbackJourney(
      journeyId,
      version,
      auth.userId,
      auth.workspaceRole as 'OWNER' | 'ADMIN' | 'MEMBER' | 'VIEWER' | 'CLIENT',
      {
        ip: getClientIp(request as never),
        userAgent: getUserAgent(request as never),
        requestId,
      },
    )
    return NextResponse.json(journey)
  } catch (err) {
    return problemResponse(err, requestId, instance)
  }
}
