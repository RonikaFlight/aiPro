/**
 * GET /api/v1/auth/oauth/[provider]/callback
 *
 * OAuth redirect_uri target. Receives `code` + `state` from the provider,
 * exchanges them for tokens, fetches the user profile, links/creates the
 * ProofPilot user, issues a session cookie, and 302-redirects to the app.
 *
 * Error handling: on failure, redirect to /login?error=<code> so the user
 * sees a friendly message rather than a JSON error. The state token (validated
 * against DB) is the CSRF protection — no CSRF header required.
 *
 * On success: redirect to `redirectTarget` (sanitized) or `/app`.
 */
import { NextResponse } from 'next/server'
import { completeOAuthFlow, completeOAuthLinkFlow } from '@/lib/oauth-service'
import { isValidProviderName } from '@/lib/oauth'
import { getClientIp, getUserAgent, getOptionalAuth } from '@/lib/auth-context'
import { env } from '@/lib/env'
import { logger } from '@/lib/logger'
import { newRequestId } from '@/lib/errors'

export const dynamic = 'force-dynamic'

function sanitizeRedirectTarget(raw: string | null): string {
  if (!raw) return '/app'
  // Must be a relative path on our origin.
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.length > 200) return '/app'
  // Block path traversal.
  if (raw.includes('..')) return '/app'
  return raw
}

function errorRedirect(provider: string, code: string): NextResponse {
  const url = new URL('/login', env.APP_URL)
  url.searchParams.set('error', code)
  url.searchParams.set('provider', provider)
  return NextResponse.redirect(url.toString(), { status: 302 })
}

export async function GET(
  request: Request,
  context: { params: Promise<{ provider: string }> | { provider: string } },
) {
  const requestId = request.headers.get('X-Request-Id') ?? newRequestId()
  const params =
    typeof context.params === 'object' && 'then' in context.params
      ? await (context.params as Promise<{ provider: string }>)
      : (context.params as { provider: string })
  const provider = params.provider

  if (!isValidProviderName(provider)) {
    return errorRedirect('unknown', 'unknown_provider')
  }

  const url = new URL(request.url)
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')

  // Provider error response (e.g. user denied consent).
  const providerError = url.searchParams.get('error')
  if (providerError) {
    logger.info('OAuth callback received provider error', { provider, error: providerError })
    return errorRedirect(provider, 'provider_error')
  }

  if (!code || !state) {
    return errorRedirect(provider, 'missing_code_or_state')
  }

  try {
    const ip = getClientIp(request)
    const userAgent = getUserAgent(request)

    // Branch on auth state: if the user is already logged in, this is a
    // "link account" flow (the user explicitly started it from settings).
    // Otherwise it's a login/register flow.
    const existingAuth = await getOptionalAuth()

    if (existingAuth) {
      // Link flow — does NOT rotate the session; the user keeps their existing
      // session. We just attach the new provider identity.
      const linkResult = await completeOAuthLinkFlow(
        { provider, code, state },
        existingAuth.userId,
        { ip, userAgent, requestId, actorId: existingAuth.userId },
      )
      const target = sanitizeRedirectTarget(linkResult.redirectTarget) || '/app/settings/security'
      const redirectUrl = new URL(target, env.APP_URL).toString()
      const url = new URL(redirectUrl)
      url.searchParams.set('linked', provider)
      return NextResponse.redirect(url.toString(), { status: 302 })
    }

    const result = await completeOAuthFlow(
      { provider, code, state },
      { ip, userAgent, requestId },
    )

    const isProd = env.APP_ENV === 'production'
    const target = sanitizeRedirectTarget(result.redirectTarget)
    const redirectUrl = new URL(target, env.APP_URL).toString()

    const res = NextResponse.redirect(redirectUrl, { status: 302 })
    res.headers.append(
      'Set-Cookie',
      `${env.SESSION_COOKIE_NAME}=${result.sessionToken}; Path=/; SameSite=Lax; HttpOnly${isProd ? '; Secure' : ''}; Max-Age=${env.SESSION_IDLE_TTL_SECONDS}`,
    )
    return res
  } catch (err) {
    logger.warn('OAuth callback failed', {
      provider,
      error: String(err),
      requestId,
    })
    // Map known errors to user-facing codes.
    const msg = String(err instanceof Error ? err.message : err)
    if (msg.includes('not configured')) {
      return errorRedirect(provider, 'not_configured')
    }
    if (msg.includes('Invalid or expired OAuth state') || msg.includes('state')) {
      return errorRedirect(provider, 'invalid_state')
    }
    if (msg.includes('already exists') || msg.includes('already linked')) {
      return errorRedirect(provider, 'account_conflict')
    }
    if (msg.includes('suspended') || msg.includes('deleted')) {
      return errorRedirect(provider, 'account_suspended')
    }
    if (msg.includes('did not return a verified email') || msg.includes('verified')) {
      return errorRedirect(provider, 'email_not_verified')
    }
    return errorRedirect(provider, 'internal_error')
  }
}
