import { NextResponse } from 'next/server'
import { problemResponse, newRequestId } from '@/lib/errors'
import { getPublicRunStatus } from '@/lib/public-scan-service'

export const dynamic = 'force-dynamic'

/**
 * Public run status — no auth required. Only returns runs whose trigger is 'PUBLIC'.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ runId: string }> },
) {
  const requestId = request.headers.get('X-Request-Id') ?? newRequestId()
  try {
    const { runId } = await params
    const status = await getPublicRunStatus(runId)
    return NextResponse.json(status)
  } catch (err) {
    return problemResponse(err, requestId, new URL(request.url).pathname)
  }
}
