import { NextResponse } from 'next/server'
import { revokeSession } from '@/lib/auth-service'
import { requireAuth, getClientIp, getUserAgent } from '@/lib/auth-context'
import { assertCsrf } from '@/lib/csrf'
import { problemResponse, newRequestId } from '@/lib/errors'

export const dynamic = 'force-dynamic'

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const requestId = request.headers.get('X-Request-Id') ?? newRequestId()
  const instance = new URL(request.url).pathname
  try {
    assertCsrf(request)
    const auth = await requireAuth()
    const { sessionId } = await params
    await revokeSession(sessionId, auth.userId, {
      ip: getClientIp(request),
      userAgent: getUserAgent(request),
      requestId,
      actorId: auth.userId,
    })
    return NextResponse.json({ ok: true })
  } catch (err) {
    return problemResponse(err, requestId, instance)
  }
}
