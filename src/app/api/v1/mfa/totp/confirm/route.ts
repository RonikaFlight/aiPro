import { NextResponse } from 'next/server'
import { z } from 'zod'
import { confirmTotpSetup } from '@/lib/auth-service'
import { requireAuth, getClientIp, getUserAgent } from '@/lib/auth-context'
import { assertCsrf } from '@/lib/csrf'
import { problemResponse, newRequestId } from '@/lib/errors'

const Body = z.object({
  code: z.string().regex(/^\d{6}$/),
})

export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  const requestId = request.headers.get('X-Request-Id') ?? newRequestId()
  const instance = new URL(request.url).pathname
  try {
    assertCsrf(request)
    const auth = await requireAuth()
    const text = await request.text()
    const body = Body.parse(JSON.parse(text || '{}'))
    const result = await confirmTotpSetup(auth.userId, body.code, {
      ip: getClientIp(request as any),
      userAgent: getUserAgent(request as any),
      requestId,
    })
    return NextResponse.json(result)
  } catch (err) {
    return problemResponse(err, requestId, instance)
  }
}
