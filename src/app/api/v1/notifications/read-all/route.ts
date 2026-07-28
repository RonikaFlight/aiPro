import { NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth-context'
import { markAllNotificationsRead } from '@/lib/notification-service'
import { problemResponse, newRequestId } from '@/lib/errors'

export const dynamic = 'force-dynamic'

/**
 * POST /api/v1/notifications/read-all
 * Mark all unread notifications as read for the authenticated user.
 */
export async function POST(request: Request) {
  const requestId = request.headers.get('X-Request-Id') ?? newRequestId()
  try {
    const auth = await requireAuth()

    const result = await markAllNotificationsRead(auth.userId)
    return NextResponse.json(result)
  } catch (err) {
    return problemResponse(err, requestId, new URL(request.url).pathname)
  }
}
