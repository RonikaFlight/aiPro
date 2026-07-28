import { NextResponse } from 'next/server'
import { z } from 'zod'
import { registerUser } from '@/lib/auth-service'
import { sendEmail } from '@/lib/email'
import { getClientIp, getUserAgent } from '@/lib/auth-context'
import { checkRateLimit } from '@/lib/rate-limit'
import { RateLimitError } from '@/lib/errors'
import { problemResponse, newRequestId } from '@/lib/errors'

const Body = z.object({
  email: z.string().email(),
  password: z.string().min(12).max(256),
  name: z.string().max(100).optional(),
})

export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  const requestId = request.headers.get('X-Request-Id') ?? newRequestId()
  const instance = new URL(request.url).pathname
  try {
    const ip = getClientIp(request)
    checkRateLimit('register', ip)

    const text = await request.text()
    const body = Body.parse(JSON.parse(text || '{}'))

    const { userId, verificationToken } = await registerUser(body, {
      ip,
      userAgent: getUserAgent(request),
      requestId,
    })

    // Send verification email (dev mode logs to console)
    await sendEmail('email_verification', {
      email: body.email,
      token: verificationToken,
    })

    return NextResponse.json({ userId, message: 'Check your email for a verification link.' }, { status: 201 })
  } catch (err) {
    if (err instanceof RateLimitError) {
      return NextResponse.json(
        { type: 'https://proofpilot.app/problems/rate-limited', title: 'Too many requests', status: 429, detail: 'Too many registration attempts. Try again later.', instance, requestId, code: 'rate_limited' },
        { status: 429, headers: { 'Retry-After': String(err.retryAfterSeconds), 'X-Request-Id': requestId } },
      )
    }
    return problemResponse(err, requestId, instance)
  }
}
