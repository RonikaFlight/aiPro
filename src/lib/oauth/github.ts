/**
 * GitHub OAuth adapter — ProofPilot
 *
 * Authorization Code + PKCE flow against GitHub's OAuth 2.0 API.
 * GitHub added PKCE support in late 2024; we always send code_challenge.
 *
 * - Authorization endpoint: https://github.com/login/oauth/authorize
 * - Token endpoint:         https://github.com/login/oauth/access_token
 * - User endpoint:          https://api.github.com/user
 * - Emails endpoint:        https://api.github.com/user/emails
 *
 * Scopes requested: `read:user user:email`
 *
 * Configuration (env):
 *   GITHUB_OAUTH_CLIENT_ID
 *   GITHUB_OAUTH_CLIENT_SECRET
 *   GITHUB_OAUTH_REDIRECT_URL   (must be registered in GitHub OAuth App settings)
 *
 * Security notes:
 * - We request `user:email` because the user's primary email may be private;
 *   we then call /user/emails to find the primary+verified address.
 * - GitHub does NOT return `email_verified` on the /user endpoint; we treat a
 *   verified email (per /user/emails) as the source of truth.
 * - We never store the GitHub access token; we issue our own session.
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

const AUTH_URL = 'https://github.com/login/oauth/authorize'
const TOKEN_URL = 'https://github.com/login/oauth/access_token'
const USER_URL = 'https://api.github.com/user'
const EMAILS_URL = 'https://api.github.com/user/emails'

export class GitHubOAuthProvider implements OAuthProvider {
  readonly name = 'github' as const
  readonly label = 'GitHub'

  isConfigured(): boolean {
    return (
      !!env.GITHUB_OAUTH_CLIENT_ID &&
      !!env.GITHUB_OAUTH_CLIENT_SECRET &&
      !!env.GITHUB_OAUTH_REDIRECT_URL
    )
  }

  scopes(): string[] {
    return ['read:user', 'user:email']
  }

  buildAuthorizationUrl(ctx: OAuthProviderContext): OAuthAuthorizationRequest {
    if (!this.isConfigured()) {
      throw new AppError(
        'GitHub OAuth is not configured',
        503,
        'oauth_not_configured',
        'https://proofpilot.app/problems/oauth-not-configured',
      )
    }
    const params = new URLSearchParams({
      client_id: env.GITHUB_OAUTH_CLIENT_ID,
      redirect_uri: ctx.redirectUri,
      response_type: 'code',
      scope: this.scopes().join(' '),
      // PKCE — GitHub supports S256 code_challenge.
      code_challenge: ctx.codeChallenge,
      code_challenge_method: 'S256',
      state: ctx.state,
    })
    return { url: `${AUTH_URL}?${params.toString()}`, state: ctx.state }
  }

  async exchangeCode(code: string, ctx: OAuthProviderContext): Promise<OAuthTokens> {
    if (!this.isConfigured()) {
      throw new AppError(
        'GitHub OAuth is not configured',
        503,
        'oauth_not_configured',
        'https://proofpilot.app/problems/oauth-not-configured',
      )
    }
    const body = new URLSearchParams({
      code,
      client_id: env.GITHUB_OAUTH_CLIENT_ID,
      client_secret: env.GITHUB_OAUTH_CLIENT_SECRET,
      redirect_uri: ctx.redirectUri,
      grant_type: 'authorization_code',
      code_verifier: ctx.codeVerifier,
    })
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        // GitHub returns JSON when we set Accept: application/json.
        Accept: 'application/json',
      },
      body,
    })
    const payload: unknown = await res.json().catch(() => null)
    assertProviderOk(payload, 'GitHub')
    const data = payload as Record<string, unknown>
    const accessToken = typeof data.access_token === 'string' ? data.access_token : ''
    if (!accessToken) {
      throw new AppError(
        'GitHub did not return an access token',
        502,
        'oauth_provider_error',
        'https://proofpilot.app/problems/oauth-provider-error',
      )
    }
    return {
      accessToken,
      refreshToken: typeof data.refresh_token === 'string' ? data.refresh_token : undefined,
      idToken: undefined,
      expiresIn: typeof data.expires_in === 'number' ? data.expires_in : undefined,
      tokenType: typeof data.token_type === 'string' ? data.token_type : 'bearer',
      scope: typeof data.scope === 'string' ? data.scope : undefined,
    }
  }

  async fetchProfile(tokens: OAuthTokens): Promise<OAuthProfile> {
    // 1. Fetch the user record.
    const userRes = await fetch(USER_URL, {
      headers: {
        Authorization: `Bearer ${tokens.accessToken}`,
        Accept: 'application/vnd.github+json',
      },
    })
    if (!userRes.ok) {
      throw new AppError(
        `GitHub /user request failed (HTTP ${userRes.status})`,
        502,
        'oauth_provider_error',
        'https://proofpilot.app/problems/oauth-provider-error',
      )
    }
    const userPayload: unknown = await userRes.json().catch(() => null)
    assertProviderOk(userPayload, 'GitHub')
    const user = userPayload as Record<string, unknown>
    const providerUserId =
      typeof user.id === 'number' ? String(user.id) : typeof user.id === 'string' ? user.id : ''
    if (!providerUserId) {
      throw new AppError(
        'GitHub profile missing required field (id)',
        502,
        'oauth_provider_error',
        'https://proofpilot.app/problems/oauth-provider-error',
      )
    }

    // 2. Resolve the primary+verified email. The /user endpoint may have a
    //    public email; if it's missing or not verified, call /user/emails.
    let email = typeof user.email === 'string' && user.email ? user.email : ''
    let emailVerified = false

    if (email) {
      // GitHub's public email is always verified (per GitHub docs).
      emailVerified = true
    } else {
      // Fetch /user/emails — array of { email, primary, verified, visibility }.
      const emailsRes = await fetch(EMAILS_URL, {
        headers: {
          Authorization: `Bearer ${tokens.accessToken}`,
          Accept: 'application/vnd.github+json',
        },
      })
      if (emailsRes.ok) {
        const emailsPayload: unknown = await emailsRes.json().catch(() => null)
        if (Array.isArray(emailsPayload)) {
          // Prefer the primary+verified entry; fall back to any verified.
          const primaryVerified = emailsPayload.find(
            (e): e is { email: string; primary: boolean; verified: boolean } =>
              typeof e === 'object' &&
              e !== null &&
              (e as Record<string, unknown>).primary === true &&
              (e as Record<string, unknown>).verified === true &&
              typeof (e as Record<string, unknown>).email === 'string',
          )
          const anyVerified = emailsPayload.find(
            (e): e is { email: string; primary: boolean; verified: boolean } =>
              typeof e === 'object' &&
              e !== null &&
              (e as Record<string, unknown>).verified === true &&
              typeof (e as Record<string, unknown>).email === 'string',
          )
          const chosen = primaryVerified ?? anyVerified
          if (chosen) {
            email = chosen.email
            emailVerified = true
          }
        }
      }
    }

    if (!email) {
      throw new AppError(
        'GitHub profile has no usable email address',
        400,
        'oauth_no_email',
        'https://proofpilot.app/problems/oauth-no-email',
      )
    }

    const name =
      typeof user.name === 'string' && user.name.length > 0
        ? user.name
        : typeof user.login === 'string' && user.login.length > 0
          ? user.login
          : null
    const avatarUrl =
      typeof user.avatar_url === 'string' && user.avatar_url.length > 0 ? user.avatar_url : null

    return {
      provider: 'github',
      providerUserId,
      email,
      emailVerified,
      name,
      avatarUrl,
    }
  }
}

/** Singleton adapter instance. */
export const githubProvider = new GitHubOAuthProvider()
