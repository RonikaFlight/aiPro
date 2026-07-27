/**
 * GET /api/v1/journeys/[journeyId]/versions
 *   List all versions of a journey (newest first).
 */
import { NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth-context'
import { listJourneyVersions } from '@/lib/journey-service'
import { problemResponse, newRequestId } from '@/lib/errors'

export const dynamic = 'force-dynamic'

export async function GET(
  request: Request,
  { params }: { params: Promise<{ journeyId: string }> },
) {
  const requestId = request.headers.get('X-Request-Id') ?? newRequestId()
  const instance = new URL(request.url).pathname
  try {
    const { journeyId } = await params
    const auth = await requireAuth()
    const versions = await listJourneyVersions(journeyId, auth.userId)
    return NextResponse.json({ items: versions })
  } catch (err) {
    return problemResponse(err, requestId, instance)
  }
}
