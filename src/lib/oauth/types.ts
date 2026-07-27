/**
 * OAuth types & PKCE helpers — ProofPilot
 *
 * Authorization Code + PKCE flow for Google and GitHub.
 * See SECURITY_MODEL.md §"OAuth / federated identity".
 *
 * Security properties:
 * - `state` is a 256-bit random token (hashed at rest) — anti-CSRF, single-use.
 * - `code_verifier` is a 256-bit random token (hashed at rest) — PKCE, prevents
 *   authorization-code interception on public clients (even though we are a
 *   confidential client, PKCE is required by Google and is defense-in-depth).
 * - `code_challenge` = BASE64URL(SHA256(code_verifier)) — S256 method only.
 * - All tokens are sent over HTTPS to the provider's token endpoint.
 * - Provider profile fetching uses the access token; we never store the access
 *   token long-term (we issue our own session, per SECURITY_MODEL §"Sessions").
 */
import { createHash, randomBytes } from 'crypto'
import { AppError } from '../errors'

/** Supported OAuth providers. */
export type OAuthProviderName = 'google' | 'github'

/** Tokens returned by the provider's token endpoint. */
export interface OAuthTokens {
  accessToken: string
  refreshToken?: string
  idToken?: string
  expiresIn?: number
  tokenType: string
  scope?: string
}

/** Normalized profile fetched from the provider's userinfo endpoint. */
export interface OAuthProfile {
  provider: OAuthProviderName
  /** Stable per-provider user ID (e.g. Google `sub`, GitHub numeric user id). */
  providerUserId: string
  email: string
  emailVerified: boolean
  name: string | null
  avatarUrl: string | null
}

/** Context passed to provider adapters. */
export interface OAuthProviderContext {
  /** The redirect URI registered with the provider (must match exactly). */
  redirectUri: string
  /** PKCE code_verifier (raw, not hashed) — sent only to the token endpoint. */
  codeVerifier: string
  /** PKCE code_challenge (derived from verifier, S256). */
  codeChallenge: string
  /** Anti-CSRF state token (raw, not hashed). */
  state: string
  /** Optional post-login redirect target, echoed back in callback. */
  redirectTarget?: string
}

/** Result of building the authorization URL. */
export interface OAuthAuthorizationRequest {
  url: string
  state: string
}

/** OAuth provider adapter interface. */
export interface OAuthProvider {
  readonly name: OAuthProviderName
  /** Human-readable label for UI. */
  readonly label: string
  /** Whether the provider is configured (client ID + secret + redirect URL). */
  isConfigured(): boolean
  /** Scopes to request (space-delimited). */
  scopes(): string[]
  /** Build the authorization URL the user is redirected to. */
  buildAuthorizationUrl(ctx: OAuthProviderContext): OAuthAuthorizationRequest
  /** Exchange the authorization code for tokens (server-to-server, includes client_secret). */
  exchangeCode(code: string, ctx: OAuthProviderContext): Promise<OAuthTokens>
  /** Fetch the user profile using the access token. */
  fetchProfile(tokens: OAuthTokens): Promise<OAuthProfile>
}

// ---------------- PKCE & state helpers ----------------

/**
 * Generate a PKCE code_verifier — 32 random bytes, base64url-encoded
 * (43 chars, within RFC 7636's 43-128 char range, high entropy).
 */
export function generateCodeVerifier(): string {
  return randomBytes(32).toString('base64url')
}

/**
 * Derive the code_challenge from a code_verifier using S256.
 *   code_challenge = BASE64URL(SHA256(code_verifier))
 */
export function generateCodeChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url')
}

/**
 * Generate the `state` parameter — 32 random bytes, base64url-encoded.
 * Hashed at rest (see oauth-service.ts). Single-use, 10-minute expiry.
 */
export function generateState(): string {
  return randomBytes(32).toString('base64url')
}

/** Validate that a returned state string matches the expected format. */
export function isValidStateShape(state: string | null | undefined): state is string {
  if (!state || typeof state !== 'string') return false
  // base64url: 43 chars for 32 bytes; allow up to 128 for safety
  return /^[A-Za-z0-9_-]{32,128}$/.test(state)
}

/** Validate provider name from URL params. */
export function isValidProviderName(name: string | null | undefined): name is OAuthProviderName {
  return name === 'google' || name === 'github'
}

/** Throw a 400 if the provider returns an error response. */
export function assertProviderOk(payload: unknown, provider: string): asserts payload is Record<string, unknown> {
  if (typeof payload !== 'object' || payload === null) {
    throw new AppError(
      `${provider} returned an unexpected response`,
      502,
      'oauth_provider_error',
      'https://proofpilot.app/problems/oauth-provider-error',
    )
  }
  const obj = payload as Record<string, unknown>
  if ('error' in obj && obj.error) {
    const desc = typeof obj.error_description === 'string' ? obj.error_description : String(obj.error)
    throw new AppError(
      `${provider} authorization error: ${desc}`,
      400,
      'oauth_provider_error',
      'https://proofpilot.app/problems/oauth-provider-error',
    )
  }
}
