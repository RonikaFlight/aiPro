import { NextResponse } from 'next/server'
import { z } from 'zod'
import { problemResponse, newRequestId } from '@/lib/errors'
import { createPublicScan } from '@/lib/public-scan-service'
import { applyRateLimitHeaders, getRemainingAttempts, POLICIES } from '@/lib/rate-limit'

const Body = z.object({
  url: z.string().max(2048),
  email: z.string().email().max(255).optional(),
})

export const dynamic = 'force-dynamic'

/**
 * Public audit endpoint — no auth required, no CSRF required (publicly callable).
 *
 * Strict rate limits: 3 scans/hour per IP (configurable via env).
 * Result: a ScanRun on the shared "public-audit" workspace, queued for the worker.
 */
export async function POST(request: Request) {
  const requestId = request.headers.get('X-Request-Id') ?? newRequestId()
  const instance = new URL(request.url).pathname
  try {
    const text = await request.text()
    let parsed: unknown
    try {
      parsed = JSON.parse(text || '{}')
    } catch {
      return NextResponse.json(
        {
          type: 'https://proofpilot.app/problems/validation-error',
          title: 'Malformed JSON body',
          status: 422,
          detail: 'Request body must be valid JSON',
          instance,
          requestId,
          code: 'validation_error',
        },
        { status: 422, headers: { 'Content-Type': 'application/problem+json' } },
      )
    }
    const body = Body.parse(parsed)

    const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
      ?? request.headers.get('x-real-ip')
      ?? 'unknown'
    const userAgent = request.headers.get('user-agent') ?? 'unknown'

    const result = await createPublicScan(
      { url: body.url, email: body.email },
      { ip, userAgent, requestId },
    )

    const res = NextResponse.json(result, { status: 201 })
    const remaining = getRemainingAttempts(POLICIES.publicScan, ip)
    res.headers.set('X-RateLimit-Limit', String(POLICIES.publicScan.max))
    res.headers.set('X-RateLimit-Remaining', String(remaining))
    res.headers.set('X-RateLimit-Policy', `${POLICIES.publicScan.max}/hour`)
    return res
  } catch (err) {
    const res = problemResponse(err, requestId, instance)
    // Apply rate-limit headers even on error responses
    const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown'
    applyRateLimitHeaders(res, POLICIES.publicScan, ip)
    return res
  }
}
