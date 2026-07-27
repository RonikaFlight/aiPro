import { NextResponse } from 'next/server'
import { z } from 'zod'
import { resetPassword } from '@/lib/auth-service'
import { getClientIp, getUserAgent } from '@/lib/auth-context'
import { checkRateLimit } from '@/lib/rate-limit'
import { RateLimitError } from '@/lib/errors'
import { problemResponse, newRequestId } from '@/lib/errors'

const Body = z.object({
  token: z.string().min(10).max(200),
  password: z.string().min(12).max(256),
})

export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  const requestId = request.headers.get('X-Request-Id') ?? newRequestId()
  const instance = new URL(request.url).pathname
  try {
    const ip = getClientIp(request as any)
    checkRateLimit('passwordReset', ip)

    const text = await request.text()
    const body = Body.parse(JSON.parse(text || '{}'))

    const { userId } = await resetPassword(body.token, body.password, {
      ip,
      userAgent: getUserAgent(request as any),
      requestId,
    })

    return NextResponse.json({ userId, reset: true })
  } catch (err) {
    if (err instanceof RateLimitError) {
      return NextResponse.json(
        { type: 'https://proofpilot.app/problems/rate-limited', title: 'Too many requests', status: 429, detail: 'Too many attempts. Try again later.', instance, requestId, code: 'rate_limited' },
        { status: 429, headers: { 'Retry-After': String(err.retryAfterSeconds), 'X-Request-Id': requestId } },
      )
    }
    return problemResponse(err, requestId, instance)
  }
}
