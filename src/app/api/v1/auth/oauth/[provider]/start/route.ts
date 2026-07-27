/**
 * GET /api/v1/auth/oauth/[provider]/start
 *
 * Begins an OAuth Authorization Code + PKCE flow. Generates a state token +
 * PKCE verifier, persists them (state hashed), and 302-redirects the user to
 * the provider's authorization URL.
 *
 * Query params:
 *   redirectTarget  optional relative path for post-login redirect (e.g. "/app")
 *
 * The state token in the URL is the CSRF protection for the callback — no
 * CSRF header is required because this is a top-level navigation and the
 * callback validates the state against our DB.
 *
 * Rate limited per IP to prevent state-row flooding.
 */
import { NextResponse } from 'next/server'
import { beginOAuthFlow } from '@/lib/oauth-service'
import { isValidProviderName } from '@/lib/oauth'
import { getClientIp, getUserAgent } from '@/lib/auth-context'
import { checkRateLimit } from '@/lib/rate-limit'
import { RateLimitError, problemResponse, newRequestId } from '@/lib/errors'

export const dynamic = 'force-dynamic'

export async function GET(
  request: Request,
  context: { params: Promise<{ provider: string }> | { provider: string } },
) {
  const requestId = request.headers.get('X-Request-Id') ?? newRequestId()
  const instance = new URL(request.url).pathname
  try {
    const params =
      typeof context.params === 'object' && 'then' in context.params
        ? await (context.params as Promise<{ provider: string }>)
        : (context.params as { provider: string })
    if (!isValidProviderName(params.provider)) {
      return NextResponse.json(
        {
          type: 'https://proofpilot.app/problems/unknown-provider',
          title: 'Unknown OAuth provider',
          status: 404,
          detail: `Provider '${params.provider}' is not supported.`,
          instance,
          requestId,
        },
        { status: 404, headers: { 'X-Request-Id': requestId } },
      )
    }

    const ip = getClientIp(request)
    // Rate limit state-row creation to prevent DB flooding.
    checkRateLimit('register', ip + ':oauth:start:' + params.provider)

    const url = new URL(request.url)
    const redirectTarget = url.searchParams.get('redirectTarget')

    const { authorizationUrl } = await beginOAuthFlow(
      { provider: params.provider, redirectTarget },
      { ip, userAgent: getUserAgent(request), requestId },
    )

    // 302 to the provider. Do NOT expose the code_verifier in the redirect.
    return NextResponse.redirect(authorizationUrl, { status: 302 })
  } catch (err) {
    if (err instanceof RateLimitError) {
      return NextResponse.json(
        {
          type: 'https://proofpilot.app/problems/rate-limited',
          title: 'Too many requests',
          status: 429,
          detail: 'Too many OAuth start attempts. Try again later.',
          instance,
          requestId,
          code: 'rate_limited',
        },
        {
          status: 429,
          headers: {
            'Retry-After': String(err.retryAfterSeconds),
            'X-Request-Id': requestId,
          },
        },
      )
    }
    return problemResponse(err, requestId, instance)
  }
}
