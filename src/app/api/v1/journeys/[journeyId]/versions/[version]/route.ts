/**
 * GET /api/v1/journeys/[journeyId]/versions/[version]
 *   Get a specific version of a journey with its steps.
 */
import { NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth-context'
import { getJourneyVersion } from '@/lib/journey-service'
import { problemResponse, newRequestId } from '@/lib/errors'

export const dynamic = 'force-dynamic'

export async function GET(
  request: Request,
  { params }: { params: Promise<{ journeyId: string; version: string }> },
) {
  const requestId = request.headers.get('X-Request-Id') ?? newRequestId()
  const instance = new URL(request.url).pathname
  try {
    const { journeyId, version: versionStr } = await params
    const version = parseInt(versionStr, 10)
    if (!Number.isInteger(version) || version < 1) {
      return NextResponse.json(
        { error: 'Invalid version number', type: 'about:blank', status: 400 },
        { status: 400 },
      )
    }
    const auth = await requireAuth()
    const result = await getJourneyVersion(journeyId, version, auth.userId)
    return NextResponse.json(result)
  } catch (err) {
    return problemResponse(err, requestId, instance)
  }
}
