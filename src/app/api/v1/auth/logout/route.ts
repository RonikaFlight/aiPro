import { NextResponse } from 'next/server'
import { z } from 'zod'
import { logout } from '@/lib/auth-service'
import { requireAuth, getClientIp, getUserAgent } from '@/lib/auth-context'
import { env } from '@/lib/env'
import { problemResponse, newRequestId } from '@/lib/errors'
import { assertCsrf } from '@/lib/csrf'

export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  const requestId = request.headers.get('X-Request-Id') ?? newRequestId()
  const instance = new URL(request.url).pathname
  try {
    assertCsrf(request)
    const auth = await requireAuth()
    await logout(auth.sessionId, {
      ip: getClientIp(request),
      userAgent: getUserAgent(request),
      requestId,
      actorId: auth.userId,
    })
    const res = NextResponse.json({ ok: true })
    res.headers.append(
      'Set-Cookie',
      `${env.SESSION_COOKIE_NAME}=; Path=/; SameSite=Lax; HttpOnly${env.APP_ENV === 'production' ? '; Secure' : ''}; Max-Age=0`,
    )
    return res
  } catch (err) {
    return problemResponse(err, requestId, instance)
  }
}
