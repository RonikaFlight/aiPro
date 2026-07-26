import { NextResponse } from 'next/server'
import { acceptInvitation } from '@/lib/workspace-service'
import { requireAuth, getClientIp, getUserAgent } from '@/lib/auth-context'
import { assertCsrf } from '@/lib/csrf'
import { problemResponse, newRequestId } from '@/lib/errors'

export const dynamic = 'force-dynamic'

export async function POST(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const requestId = request.headers.get('X-Request-Id') ?? newRequestId()
  const instance = new URL(request.url).pathname
  try {
    // Note: invitation acceptance is exempt from CSRF because the user clicks
    // a link in their email. We still require auth (must be logged in).
    const auth = await requireAuth()
    const { token } = await params
    const result = await acceptInvitation(token, auth.userId, auth.email, {
      ip: getClientIp(request as any),
      userAgent: getUserAgent(request as any),
      requestId,
    })
    return NextResponse.json(result)
  } catch (err) {
    return problemResponse(err, requestId, instance)
  }
}
