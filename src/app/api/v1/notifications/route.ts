import { NextRequest, NextResponse } from 'next/server'
import { requireAuth, getClientIp, getUserAgent } from '@/lib/auth-context'
import { listNotifications } from '@/lib/notification-service'
import { problemResponse, newRequestId } from '@/lib/errors'

export const dynamic = 'force-dynamic'

/**
 * GET /api/v1/notifications
 * List notifications for the authenticated user, cursor-paginated.
 *
 * Query params:
 *   cursor?    - ISO timestamp cursor for next page
 *   limit?     - page size (max 100, default 20)
 *   unreadOnly?- "true" to filter only unread
 *   type?      - notification type filter (comma-separated for multiple)
 */
export async function GET(request: NextRequest) {
  const requestId = request.headers.get('X-Request-Id') ?? newRequestId()
  try {
    const auth = await requireAuth()
    const { searchParams } = new URL(request.url)

    const cursor = searchParams.get('cursor') ?? undefined
    const limit = searchParams.get('limit')
      ? Math.min(Number(searchParams.get('limit')), 100)
      : undefined
    const unreadOnly = searchParams.get('unreadOnly') === 'true'
    const typeParam = searchParams.get('type')
    const type = typeParam
      ? (typeParam.split(',') as Array<'FINDING_CREATED' | 'FINDING_RESOLVED' | 'RUN_COMPLETED' | 'RUN_FAILED' | 'JOURNEY_COMPLETED' | 'REPORT_SHARED' | 'INVITATION_ACCEPTED' | 'MEMBER_REMOVED' | 'SUBSCRIPTION_UPDATED'>)
      : undefined

    const result = await listNotifications(auth.userId, {
      cursor,
      limit,
      unreadOnly,
      type,
    })

    return NextResponse.json(result)
  } catch (err) {
    return problemResponse(err, requestId, new URL(request.url).pathname)
  }
}
