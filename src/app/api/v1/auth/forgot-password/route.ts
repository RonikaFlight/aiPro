import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requestPasswordReset } from '@/lib/auth-service'
import { sendEmail } from '@/lib/email'
import { getClientIp, getUserAgent } from '@/lib/auth-context'
import { checkRateLimit } from '@/lib/rate-limit'
import { RateLimitError } from '@/lib/errors'
import { problemResponse, newRequestId } from '@/lib/errors'

const Body = z.object({
  email: z.string().email(),
})

export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  const requestId = request.headers.get('X-Request-Id') ?? newRequestId()
  const instance = new URL(request.url).pathname
  try {
    const text = await request.text()
    const body = Body.parse(JSON.parse(text || '{}'))
    const emailLower = body.email.toLowerCase()

    const ip = getClientIp(request as any)
    checkRateLimit('passwordReset', ip + ':' + emailLower)

    const { token, userId } = await requestPasswordReset(body.email, {
      ip,
      userAgent: getUserAgent(request as any),
      requestId,
    })

    // Only send email if user existed (no leak via response — response is always the same)
    if (token && userId) {
      await sendEmail('password_reset', { email: emailLower, token })
    }

    // Always return the same message regardless of whether the email exists
    return NextResponse.json({
      message: 'If an account exists for that email, a reset link has been sent.',
    })
  } catch (err) {
    if (err instanceof RateLimitError) {
      return NextResponse.json(
        { type: 'https://proofpilot.app/problems/rate-limited', title: 'Too many requests', status: 429, detail: 'Too many reset attempts. Try again later.', instance, requestId, code: 'rate_limited' },
        { status: 429, headers: { 'Retry-After': String(err.retryAfterSeconds), 'X-Request-Id': requestId } },
      )
    }
    return problemResponse(err, requestId, instance)
  }
}
