/**
 * DELETE /api/v1/auth/oauth/[provider]
 *
 * Unlinks a provider identity from the authenticated user. Refuses if it's
 * the user's only sign-in method (no password + no other OAuth identities).
 *
 * CSRF: standard Origin/Referer + X-CSRF-Token header (assertCsrf).
 */
import { NextResponse } from 'next/server'
import { unlinkAccount } from '@/lib/oauth-service'
import { isValidProviderName } from '@/lib/oauth'
import { requireAuth, getClientIp, getUserAgent } from '@/lib/auth-context'
import { assertCsrf } from '@/lib/csrf'
import { problemResponse, newRequestId, ValidationError } from '@/lib/errors'

export const dynamic = 'force-dynamic'

export async function DELETE(
  request: Request,
  context: { params: Promise<{ provider: string }> | { provider: string } },
) {
  const requestId = request.headers.get('X-Request-Id') ?? newRequestId()
  const instance = new URL(request.url).pathname
  try {
    assertCsrf(request)
    const params =
      typeof context.params === 'object' && 'then' in context.params
        ? await (context.params as Promise<{ provider: string }>)
        : (context.params as { provider: string })
    if (!isValidProviderName(params.provider)) {
      throw new ValidationError(`Unknown OAuth provider: ${params.provider}`)
    }

    const auth = await requireAuth()
    await unlinkAccount(
      auth.userId,
      params.provider,
      {
        ip: getClientIp(request),
        userAgent: getUserAgent(request),
        requestId,
        actorId: auth.userId,
      },
    )

    return NextResponse.json(
      { unlinked: true, provider: params.provider },
      { status: 200, headers: { 'X-Request-Id': requestId } },
    )
  } catch (err) {
    return problemResponse(err, requestId, instance)
  }
}
