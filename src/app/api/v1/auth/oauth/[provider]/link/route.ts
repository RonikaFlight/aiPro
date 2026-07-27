/**
 * POST /api/v1/auth/oauth/[provider]/link
 *
 * Begins an OAuth "link account" flow for an already-authenticated user.
 * Returns the provider authorization URL as JSON (the frontend opens it in
 * the same window). The callback handler detects the existing session and
 * links the provider identity rather than logging in.
 *
 * Body (optional):
 *   redirectTarget  relative path to return to after linking
 *                   (default: /app/settings/security)
 */
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { beginOAuthFlow } from '@/lib/oauth-service'
import { isValidProviderName } from '@/lib/oauth'
import { requireAuth, getClientIp, getUserAgent } from '@/lib/auth-context'
import { assertCsrf } from '@/lib/csrf'
import { problemResponse, newRequestId, ValidationError } from '@/lib/errors'

const Body = z.object({
  redirectTarget: z.string().max(200).optional(),
})

export const dynamic = 'force-dynamic'

export async function POST(
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

    // Require an authenticated session — only logged-in users can link.
    await requireAuth()

    const text = await request.text()
    // Validate body shape (currently no fields are used — the redirectTarget
    // is fixed to the security settings page; link intent is signaled by the
    // existing session, not by the redirectTarget).
    Body.parse(text ? JSON.parse(text) : {})
    const redirectTarget = '/app/settings/security'

    const { authorizationUrl } = await beginOAuthFlow(
      { provider: params.provider, redirectTarget },
      {
        ip: getClientIp(request),
        userAgent: getUserAgent(request),
        requestId,
      },
    )

    return NextResponse.json(
      { authorizationUrl, provider: params.provider },
      { status: 200, headers: { 'X-Request-Id': requestId } },
    )
  } catch (err) {
    return problemResponse(err, requestId, instance)
  }
}
