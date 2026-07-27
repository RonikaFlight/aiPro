/**
 * Google OAuth 2.0 adapter — ProofPilot
 *
 * Authorization Code + PKCE flow against Google's OAuth 2.0 / OpenID Connect.
 * - Authorization endpoint: https://accounts.google.com/o/oauth2/v2/auth
 * - Token endpoint:         https://oauth2.googleapis.com/token
 * - Userinfo endpoint:      https://openidconnect.googleapis.com/v1/userinfo
 *
 * Scopes requested: openid email profile
 *
 * Configuration (env):
 *   GOOGLE_OAUTH_CLIENT_ID
 *   GOOGLE_OAUTH_CLIENT_SECRET
 *   GOOGLE_OAUTH_REDIRECT_URL   (must be registered in Google Cloud Console)
 *
 * Security notes:
 * - `access_type=online` (we do not request refresh tokens; we issue our own session).
 * - `prompt=select_account` so users with multiple Google accounts get a chooser.
 * - We do NOT verify the id_token JWT signature here — instead we fetch the
 *   userinfo endpoint with the access_token, which Google serves only for
 *   valid tokens (Google validates the token server-side). This avoids
 *   pulling in a JWT library; if tighter validation is required, swap
 *   fetchProfile for `https://oauth2.googleapis.com/tokeninfo?id_token=...`.
 */
import { env } from '../env'
import { AppError } from '../errors'
import {
  type OAuthProvider,
  type OAuthProviderContext,
  type OAuthAuthorizationRequest,
  type OAuthTokens,
  type OAuthProfile,
  assertProviderOk,
} from './types'

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo'

export class GoogleOAuthProvider implements OAuthProvider {
  readonly name = 'google' as const
  readonly label = 'Google'

  isConfigured(): boolean {
    return (
      !!env.GOOGLE_OAUTH_CLIENT_ID &&
      !!env.GOOGLE_OAUTH_CLIENT_SECRET &&
      !!env.GOOGLE_OAUTH_REDIRECT_URL
    )
  }

  scopes(): string[] {
    return ['openid', 'email', 'profile']
  }

  buildAuthorizationUrl(ctx: OAuthProviderContext): OAuthAuthorizationRequest {
    if (!this.isConfigured()) {
      throw new AppError(
        'Google OAuth is not configured',
        503,
        'oauth_not_configured',
        'https://proofpilot.app/problems/oauth-not-configured',
      )
    }
    const params = new URLSearchParams({
      client_id: env.GOOGLE_OAUTH_CLIENT_ID,
      redirect_uri: ctx.redirectUri,
      response_type: 'code',
      scope: this.scopes().join(' '),
      // PKCE — Google requires `code_challenge` + `code_challenge_method=S256`.
      code_challenge: ctx.codeChallenge,
      code_challenge_method: 'S256',
      state: ctx.state,
      // Online access — we don't need refresh tokens.
      access_type: 'online',
      // Force account chooser for users with multiple Google accounts.
      prompt: 'select_account',
    })
    return { url: `${AUTH_URL}?${params.toString()}`, state: ctx.state }
  }

  async exchangeCode(code: string, ctx: OAuthProviderContext): Promise<OAuthTokens> {
    if (!this.isConfigured()) {
      throw new AppError(
        'Google OAuth is not configured',
        503,
        'oauth_not_configured',
        'https://proofpilot.app/problems/oauth-not-configured',
      )
    }
    const body = new URLSearchParams({
      code,
      client_id: env.GOOGLE_OAUTH_CLIENT_ID,
      client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET,
      redirect_uri: ctx.redirectUri,
      grant_type: 'authorization_code',
      code_verifier: ctx.codeVerifier,
    })
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    })
    const payload: unknown = await res.json().catch(() => null)
    assertProviderOk(payload, 'Google')
    const data = payload as Record<string, unknown>
    const accessToken = typeof data.access_token === 'string' ? data.access_token : ''
    if (!accessToken) {
      throw new AppError(
        'Google did not return an access token',
        502,
        'oauth_provider_error',
        'https://proofpilot.app/problems/oauth-provider-error',
      )
    }
    return {
      accessToken,
      refreshToken: typeof data.refresh_token === 'string' ? data.refresh_token : undefined,
      idToken: typeof data.id_token === 'string' ? data.id_token : undefined,
      expiresIn: typeof data.expires_in === 'number' ? data.expires_in : undefined,
      tokenType: typeof data.token_type === 'string' ? data.token_type : 'Bearer',
      scope: typeof data.scope === 'string' ? data.scope : undefined,
    }
  }

  async fetchProfile(tokens: OAuthTokens): Promise<OAuthProfile> {
    const res = await fetch(USERINFO_URL, {
      headers: { Authorization: `Bearer ${tokens.accessToken}` },
    })
    if (!res.ok) {
      throw new AppError(
        `Google userinfo request failed (HTTP ${res.status})`,
        502,
        'oauth_provider_error',
        'https://proofpilot.app/problems/oauth-provider-error',
      )
    }
    const payload: unknown = await res.json().catch(() => null)
    assertProviderOk(payload, 'Google')
    const data = payload as Record<string, unknown>
    const sub = typeof data.sub === 'string' ? data.sub : ''
    const email = typeof data.email === 'string' ? data.email : ''
    if (!sub || !email) {
      throw new AppError(
        'Google profile missing required fields (sub, email)',
        502,
        'oauth_provider_error',
        'https://proofpilot.app/problems/oauth-provider-error',
      )
    }
    return {
      provider: 'google',
      providerUserId: sub,
      email,
      // Google's `email_verified` is a boolean in the userinfo response.
      emailVerified: data.email_verified === true || data.email_verified === 'true',
      name: typeof data.name === 'string' && data.name.length > 0 ? data.name : null,
      avatarUrl: typeof data.picture === 'string' && data.picture.length > 0 ? data.picture : null,
    }
  }
}

/** Singleton adapter instance. */
export const googleProvider = new GoogleOAuthProvider()
