import { NextRequest, NextResponse } from 'next/server'
import { requireAuth, getClientIp, getUserAgent } from '@/lib/auth-context'
import { markNotificationRead } from '@/lib/notification-service'
import { problemResponse, newRequestId } from '@/lib/errors'

export const dynamic = 'force-dynamic'

/**
 * POST /api/v1/notifications/[id]/read
 * Mark a single notification as read. Idempotent.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const requestId = request.headers.get('X-Request-Id') ?? newRequestId()
  try {
    const auth = await requireAuth()
    const { id } = await params

    const notification = await markNotificationRead(id, auth.userId)
    return NextResponse.json(notification)
  } catch (err) {
    return problemResponse(err, requestId, new URL(request.url).pathname)
  }
}
