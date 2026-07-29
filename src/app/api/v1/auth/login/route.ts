import { NextResponse } from 'next/server'
import { z } from 'zod'
import { login } from '@/lib/auth-service'
import { getClientIp, getUserAgent } from '@/lib/auth-context'
import { checkRateLimit, getProgressiveDelay } from '@/lib/rate-limit'
import { RateLimitError } from '@/lib/errors'
import { problemResponse, newRequestId } from '@/lib/errors'
import { env } from '@/lib/env'

const Body = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(256),
})

export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  const requestId = request.headers.get('X-Request-Id') ?? newRequestId()
  const instance = new URL(request.url).pathname
  try {
    const ip = getClientIp(request)

    // Read body once
    const text = await request.text()
    const parsed = JSON.parse(text || '{}')
    const body = Body.parse(parsed)
    const emailLower = body.email.toLowerCase()

    // Rate limit by IP + email
    checkRateLimit('login', ip + ':' + emailLower)

    // Progressive delay for repeated failures
    const delay = getProgressiveDelay(ip + ':' + emailLower)
    if (delay > 0) {
      await new Promise((r) => setTimeout(r, delay))
    }

    const result = await login(body, {
      ip,
      userAgent: getUserAgent(request),
      requestId,
    })

    const isProd = env.APP_ENV === 'production'
    if (result.requiresMfa) {
      const res = NextResponse.json({
        requiresMfa: true,
        user: result.user,
      }, { status: 200 })
      res.headers.append(
        'Set-Cookie',
        `${env.SESSION_COOKIE_NAME}=${result.mfaChallengeToken}; Path=/; SameSite=Lax; HttpOnly${isProd ? '; Secure' : ''}; Max-Age=300`,
      )
      return res
    }

    const res = NextResponse.json({
      requiresMfa: false,
      user: result.user,
    }, { status: 200 })
    res.headers.append(
      'Set-Cookie',
      `${env.SESSION_COOKIE_NAME}=${result.sessionToken}; Path=/; SameSite=Lax; HttpOnly${isProd ? '; Secure' : ''}; Max-Age=${env.SESSION_IDLE_TTL_SECONDS}`,
    )
    return res
  } catch (err) {
    if (err instanceof RateLimitError) {
      return NextResponse.json(
        { type: 'https://proofpilot.app/problems/rate-limited', title: 'Too many requests', status: 429, detail: 'Too many login attempts. Try again later.', instance, requestId, code: 'rate_limited' },
        { status: 429, headers: { 'Retry-After': String(err.retryAfterSeconds), 'X-Request-Id': requestId } },
      )
    }
    return problemResponse(err, requestId, instance)
  }
}
