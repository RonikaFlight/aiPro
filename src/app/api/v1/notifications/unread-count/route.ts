import { NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth-context'
import { getUnreadCount } from '@/lib/notification-service'
import { problemResponse, newRequestId } from '@/lib/errors'

export const dynamic = 'force-dynamic'

/**
 * GET /api/v1/notifications/unread-count
 * Get the count of unread notifications for the authenticated user.
 */
export async function GET(request: Request) {
  const requestId = request.headers.get('X-Request-Id') ?? newRequestId()
  try {
    const auth = await requireAuth()

    const count = await getUnreadCount(auth.userId)
    return NextResponse.json({ count })
  } catch (err) {
    return problemResponse(err, requestId, new URL(request.url).pathname)
  }
}
