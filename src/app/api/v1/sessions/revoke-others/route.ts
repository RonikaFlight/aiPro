import { NextResponse } from 'next/server'
import { revokeOtherSessions } from '@/lib/auth-service'
import { requireAuth, getClientIp, getUserAgent } from '@/lib/auth-context'
import { assertCsrf } from '@/lib/csrf'
import { problemResponse, newRequestId } from '@/lib/errors'

export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  const requestId = request.headers.get('X-Request-Id') ?? newRequestId()
  const instance = new URL(request.url).pathname
  try {
    assertCsrf(request)
    const auth = await requireAuth()
    const result = await revokeOtherSessions(auth.sessionId, auth.userId, {
      ip: getClientIp(request as any),
      userAgent: getUserAgent(request as any),
      requestId,
      actorId: auth.userId,
    })
    return NextResponse.json(result)
  } catch (err) {
    return problemResponse(err, requestId, instance)
  }
}
