import { NextResponse } from 'next/server'
import { z } from 'zod'
import { completeMfaChallenge } from '@/lib/auth-service'
import { getClientIp, getUserAgent, readSessionCookieFromRequest } from '@/lib/auth-context'
import { checkRateLimit } from '@/lib/rate-limit'
import { RateLimitError, AuthError } from '@/lib/errors'
import { problemResponse, newRequestId } from '@/lib/errors'
import { env } from '@/lib/env'

const Body = z.object({
  code: z.string().min(6).max(64),
})

export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  const requestId = request.headers.get('X-Request-Id') ?? newRequestId()
  const instance = new URL(request.url).pathname
  try {
    const challengeToken = readSessionCookieFromRequest(request as any)
    if (!challengeToken) {
      throw new AuthError('No MFA challenge in progress')
    }

    const ip = getClientIp(request as any)
    checkRateLimit('login', ip + ':mfa')

    const text = await request.text()
    const body = Body.parse(JSON.parse(text || '{}'))

    const { sessionToken, userId } = await completeMfaChallenge(challengeToken, body.code, {
      ip,
      userAgent: getUserAgent(request as any),
      requestId,
    })

    const isProd = env.APP_ENV === 'production'
    const res = NextResponse.json({ ok: true, userId })
    res.headers.append(
      'Set-Cookie',
      `${env.SESSION_COOKIE_NAME}=${sessionToken}; Path=/; SameSite=Lax; HttpOnly${isProd ? '; Secure' : ''}; Max-Age=${env.SESSION_IDLE_TTL_SECONDS}`,
    )
    return res
  } catch (err) {
    if (err instanceof RateLimitError) {
      return NextResponse.json(
        { type: 'https://proofpilot.app/problems/rate-limited', title: 'Too many requests', status: 429, detail: 'Too many MFA attempts. Try again later.', instance, requestId, code: 'rate_limited' },
        { status: 429, headers: { 'Retry-After': String(err.retryAfterSeconds), 'X-Request-Id': requestId } },
      )
    }
    return problemResponse(err, requestId, instance)
  }
}
