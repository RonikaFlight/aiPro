import { NextResponse } from 'next/server'
import { z } from 'zod'
import { verifyEmail } from '@/lib/auth-service'
import { getClientIp, getUserAgent } from '@/lib/auth-context'
import { checkRateLimit } from '@/lib/rate-limit'
import { RateLimitError } from '@/lib/errors'
import { problemResponse, newRequestId } from '@/lib/errors'

const Body = z.object({
  token: z.string().min(10).max(200),
})

export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  const requestId = request.headers.get('X-Request-Id') ?? newRequestId()
  const instance = new URL(request.url).pathname
  try {
    const ip = getClientIp(request)
    checkRateLimit('register', ip) // reuse register rate limit

    const text = await request.text()
    const body = Body.parse(JSON.parse(text || '{}'))

    const { userId } = await verifyEmail(body.token, {
      ip,
      userAgent: getUserAgent(request),
      requestId,
    })

    return NextResponse.json({ userId, verified: true })
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
