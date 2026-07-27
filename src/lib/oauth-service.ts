/**
 * OAuth service — ProofPilot
 *
 * Orchestrates the Authorization Code + PKCE flow end-to-end:
 *   beginOAuthFlow  → generates state + verifier, persists in DB (state hashed), returns auth URL.
 *   completeOAuthFlow → exchanges code, fetches profile, links/creates user, issues session.
 *   linkOAuthAccount / unlinkOAuthAccount / listLinkedAccounts — account-management.
 *
 * Security model (see SECURITY_MODEL.md §"OAuth"):
 * - `state` is hashed at rest (SHA-256). It appears in URLs and provider logs,
 *   so we never store it raw.
 * - `code_verifier` is stored raw. It is 256-bit random, single-use, expires in
 *   10 minutes, and is only useful alongside our client_secret (env). Redeeming
 *   an auth code requires (code + redirect_uri + verifier + client_secret); a
 *   leaked verifier alone is insufficient. See the OAuthState schema comment.
 * - `state` is single-use: marked `usedAt` immediately on consumption. Replays
 *   are rejected by the unique constraint + `usedAt` check.
 * - `state` expires after 10 minutes.
 * - Account linking policy:
 *   1. If an OAuthIdentity already exists for (provider, providerUserId), log that user in.
 *   2. Else, if a User exists with the same email AND the provider says the email
 *      is verified → link the OAuthIdentity to that user (do NOT create a second account).
 *   3. Else, if a User exists with the same email but the provider did NOT verify
 *      the email → refuse (force password login first to prevent account takeover
 *      via a fake OAuth email claim).
 *   4. Else, create a new User with status=ACTIVE (no passwordHash — they can only
 *      log in via OAuth unless they later set a password) + OAuthIdentity.
 * - New OAuth users are auto-verified (status=ACTIVE) because the provider verified
 *   their email. They are NOT given a workspace; onboarding is handled separately
 *   (Phase 10) — we just return the session so the client can route to /app.
 * - Audit actions: OAUTH_LOGIN, OAUTH_REGISTER, OAUTH_LINK, OAUTH_UNLINK,
 *   OAUTH_LOGIN_FAILED, OAUTH_STATE_INVALID.
 */
import { db } from './db'
import { hashToken, hashIp, hashUserAgent } from './crypto'
import { createSession } from './auth-service'
import { recordAudit, recordSecurityEvent, type AuditContext } from './audit'
import { logger } from './logger'
import {
  AppError,
  AuthError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from './errors'
import { env } from './env'
import {
  getOAuthProvider,
  type OAuthProviderName,
  type OAuthProfile,
  type OAuthProviderContext,
  generateCodeVerifier,
  generateCodeChallenge,
  generateState,
  isValidStateShape,
  isValidProviderName,
} from './oauth'

const STATE_TTL_MS = 10 * 60 * 1000 // 10 minutes

// ---------------- Email helpers (mirror auth-service.ts) ----------------

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}
function validateEmail(email: string): string {
  const normalized = normalizeEmail(email)
  if (!EMAIL_REGEX.test(normalized)) {
    throw new ValidationError('Invalid email address from OAuth provider')
  }
  if (normalized.length > 254) {
    throw new ValidationError('Email address too long')
  }
  return normalized
}

/** Build the redirect URI for a provider. Always on our own origin. */
function buildRedirectUri(provider: OAuthProviderName): string {
  const base = env.APP_URL.replace(/\/+$/, '')
  return `${base}/api/v1/auth/oauth/${provider}/callback`
}

// ---------------- Begin flow ----------------

export interface BeginOAuthFlowInput {
  provider: OAuthProviderName
  /** Optional post-login redirect path (must start with "/" and be relative). */
  redirectTarget?: string | null
}

export interface BeginOAuthFlowResult {
  authorizationUrl: string
  state: string
}

/**
 * Generate state + PKCE verifier, persist their hashes, and return the
 * provider authorization URL the user should be redirected to.
 */
export async function beginOAuthFlow(
  input: BeginOAuthFlowInput,
  ctx: Pick<AuditContext, 'ip' | 'userAgent' | 'requestId'>,
): Promise<BeginOAuthFlowResult> {
  const provider = getOAuthProvider(input.provider)
  if (!provider.isConfigured()) {
    throw new AppError(
      `${provider.label} OAuth is not configured`,
      503,
      'oauth_not_configured',
      'https://proofpilot.app/problems/oauth-not-configured',
    )
  }

  // Validate redirectTarget (must be a relative path on our origin).
  let redirectTarget: string | null = null
  if (input.redirectTarget) {
    const t = input.redirectTarget
    if (t.startsWith('/') && !t.startsWith('//') && t.length <= 200) {
      redirectTarget = t
    }
  }

  const codeVerifier = generateCodeVerifier()
  const codeChallenge = generateCodeChallenge(codeVerifier)
  const state = generateState()

  const now = Date.now()
  await db.oAuthState.create({
    data: {
      stateHash: hashToken(state),
      codeVerifier, // raw, single-use, 10-min TTL — see schema comment
      provider: input.provider,
      redirectTarget,
      ipHash: ctx.ip ? hashIp(ctx.ip) : null,
      userAgentSummary: ctx.userAgent ? hashUserAgent(ctx.userAgent) : null,
      createdAt: new Date(now),
      expiresAt: new Date(now + STATE_TTL_MS),
    },
  })

  const providerCtx: OAuthProviderContext = {
    redirectUri: buildRedirectUri(input.provider),
    codeVerifier,
    codeChallenge,
    state,
    redirectTarget: redirectTarget ?? undefined,
  }

  const { url } = provider.buildAuthorizationUrl(providerCtx)
  logger.debug('OAuth flow begun', { provider: input.provider })
  return { authorizationUrl: url, state }
}

// ---------------- Complete flow ----------------

export interface CompleteOAuthFlowInput {
  provider: OAuthProviderName
  code: string
  state: string
}

export interface CompleteOAuthFlowResult {
  sessionToken: string
  userId: string
  email: string
  name: string | null
  isNewUser: boolean
  /** Post-login redirect target (sanitized, relative). */
  redirectTarget: string | null
}

/**
 * Exchange the authorization code for tokens, fetch the profile, link or
 * create the user, and issue a session.
 *
 * Throws on: invalid state, expired state, replay (already-used state),
 * provider error, email conflict with unverified provider email.
 */
export async function completeOAuthFlow(
  input: CompleteOAuthFlowInput,
  ctx: Pick<AuditContext, 'ip' | 'userAgent' | 'requestId'>,
): Promise<CompleteOAuthFlowResult> {
  if (!isValidProviderName(input.provider)) {
    throw new ValidationError('Unknown OAuth provider')
  }
  if (!input.code || typeof input.code !== 'string' || input.code.length > 1024) {
    throw new ValidationError('Missing or invalid authorization code')
  }
  if (!isValidStateShape(input.state)) {
    await recordSecurityEvent(
      'OAUTH_STATE_INVALID',
      { ...ctx, actorType: 'USER' },
      { reason: 'bad_state_shape', provider: input.provider },
      'WARN',
    )
    throw new AuthError('Invalid OAuth state')
  }

  const provider = getOAuthProvider(input.provider)
  if (!provider.isConfigured()) {
    throw new AppError(
      `${provider.label} OAuth is not configured`,
      503,
      'oauth_not_configured',
      'https://proofpilot.app/problems/oauth-not-configured',
    )
  }

  // 1. Atomically consume the state row. We updateMany with a `usedAt: null`
  //    filter so a concurrent request cannot double-consume the same state.
  const stateHash = hashToken(input.state)
  const consumed = await db.oAuthState.updateMany({
    where: { stateHash, usedAt: null, expiresAt: { gt: new Date() } },
    data: { usedAt: new Date() },
  })
  if (consumed.count === 0) {
    // Either: state doesn't exist, already used, or expired.
    await recordSecurityEvent(
      'OAUTH_STATE_INVALID',
      { ...ctx, actorType: 'USER' },
      { reason: 'not_found_or_used_or_expired', provider: input.provider },
      'WARN',
    )
    throw new AuthError('Invalid or expired OAuth state')
  }
  const stateRow = await db.oAuthState.findUnique({ where: { stateHash } })
  if (!stateRow) {
    // Should not happen — we just updated it.
    throw new AuthError('Invalid or expired OAuth state')
  }
  if (stateRow.provider !== input.provider) {
    await recordSecurityEvent(
      'OAUTH_STATE_INVALID',
      { ...ctx, actorType: 'USER' },
      { reason: 'provider_mismatch', expected: stateRow.provider, actual: input.provider },
      'WARN',
    )
    throw new AuthError('OAuth state provider mismatch')
  }

  // 2. Reconstruct the provider context using the raw code_verifier we
  //    stored alongside the state. (See schema comment for why we store it
  //    raw rather than hashed.)
  const codeVerifier = stateRow.codeVerifier

  const providerCtx: OAuthProviderContext = {
    redirectUri: buildRedirectUri(input.provider),
    codeVerifier,
    codeChallenge: generateCodeChallenge(codeVerifier),
    state: input.state,
  }

  // 3. Exchange the code for tokens.
  let tokens
  try {
    tokens = await provider.exchangeCode(input.code, providerCtx)
  } catch (err) {
    await recordSecurityEvent(
      'OAUTH_LOGIN_FAILED',
      { ...ctx, actorType: 'USER' },
      { provider: input.provider, reason: 'token_exchange_failed', error: String(err) },
      'WARN',
    )
    throw err
  }

  // 4. Fetch the user profile.
  let profile: OAuthProfile
  try {
    profile = await provider.fetchProfile(tokens)
  } catch (err) {
    await recordSecurityEvent(
      'OAUTH_LOGIN_FAILED',
      { ...ctx, actorType: 'USER' },
      { provider: input.provider, reason: 'profile_fetch_failed', error: String(err) },
      'WARN',
    )
    throw err
  }

  // 5. Resolve the user (existing OAuthIdentity / existing email / new user).
  const email = validateEmail(profile.email)
  const result = await resolveOrCreateUser(profile, email, ctx)

  // 6. Issue session.
  const sessionToken = await createSession(result.userId, ctx)
  await db.user.update({
    where: { id: result.userId },
    data: { lastLoginAt: new Date(), failedLoginCount: 0 },
  })

  await recordAudit(
    result.isNewUser ? 'OAUTH_REGISTER' : 'OAUTH_LOGIN',
    { type: 'user', id: result.userId },
    { ...ctx, actorType: 'USER', actorId: result.userId },
    { provider: input.provider, providerUserId: profile.providerUserId, newIdentity: result.linkedNewIdentity },
  )

  return {
    sessionToken,
    userId: result.userId,
    email,
    name: result.name,
    isNewUser: result.isNewUser,
    redirectTarget: stateRow.redirectTarget,
  }
}

// ---------------- Authenticated link flow ----------------

export interface CompleteOAuthLinkFlowResult {
  userId: string
  provider: OAuthProviderName
  providerUserId: string
  email: string
  /** Post-link redirect target (sanitized, relative). */
  redirectTarget: string | null
}

/**
 * Authenticated variant of completeOAuthFlow: exchanges the code + fetches the
 * profile, then links the provider identity to the ALREADY-AUTHENTICATED user
 * (does NOT issue a new session — the caller keeps their existing one).
 *
 * Refuses if the provider identity is already linked to a DIFFERENT user.
 */
export async function completeOAuthLinkFlow(
  input: CompleteOAuthFlowInput,
  authenticatedUserId: string,
  ctx: Pick<AuditContext, 'ip' | 'userAgent' | 'requestId' | 'actorId'>,
): Promise<CompleteOAuthLinkFlowResult> {
  if (!isValidProviderName(input.provider)) {
    throw new ValidationError('Unknown OAuth provider')
  }
  if (!input.code || typeof input.code !== 'string' || input.code.length > 1024) {
    throw new ValidationError('Missing or invalid authorization code')
  }
  if (!isValidStateShape(input.state)) {
    await recordSecurityEvent(
      'OAUTH_STATE_INVALID',
      { ...ctx, actorType: 'USER' },
      { reason: 'bad_state_shape', provider: input.provider },
      'WARN',
    )
    throw new AuthError('Invalid OAuth state')
  }

  const provider = getOAuthProvider(input.provider)
  if (!provider.isConfigured()) {
    throw new AppError(
      `${provider.label} OAuth is not configured`,
      503,
      'oauth_not_configured',
      'https://proofpilot.app/problems/oauth-not-configured',
    )
  }

  // Atomically consume the state row.
  const stateHash = hashToken(input.state)
  const consumed = await db.oAuthState.updateMany({
    where: { stateHash, usedAt: null, expiresAt: { gt: new Date() } },
    data: { usedAt: new Date() },
  })
  if (consumed.count === 0) {
    await recordSecurityEvent(
      'OAUTH_STATE_INVALID',
      { ...ctx, actorType: 'USER' },
      { reason: 'not_found_or_used_or_expired', provider: input.provider },
      'WARN',
    )
    throw new AuthError('Invalid or expired OAuth state')
  }
  const stateRow = await db.oAuthState.findUnique({ where: { stateHash } })
  if (!stateRow) {
    throw new AuthError('Invalid or expired OAuth state')
  }
  if (stateRow.provider !== input.provider) {
    await recordSecurityEvent(
      'OAUTH_STATE_INVALID',
      { ...ctx, actorType: 'USER' },
      { reason: 'provider_mismatch', expected: stateRow.provider, actual: input.provider },
      'WARN',
    )
    throw new AuthError('OAuth state provider mismatch')
  }

  const codeVerifier = stateRow.codeVerifier
  const providerCtx: OAuthProviderContext = {
    redirectUri: buildRedirectUri(input.provider),
    codeVerifier,
    codeChallenge: generateCodeChallenge(codeVerifier),
    state: input.state,
  }

  const tokens = await provider.exchangeCode(input.code, providerCtx)
  const profile = await provider.fetchProfile(tokens)

  const linked = await linkAccountFromProfile(authenticatedUserId, profile, ctx)

  return {
    userId: linked.userId,
    provider: linked.provider,
    providerUserId: linked.providerUserId,
    email: linked.email,
    redirectTarget: stateRow.redirectTarget,
  }
}

interface ResolveResult {
  userId: string
  name: string | null
  isNewUser: boolean
  linkedNewIdentity: boolean
}

async function resolveOrCreateUser(
  profile: OAuthProfile,
  normalizedEmail: string,
  ctx: Pick<AuditContext, 'ip' | 'userAgent' | 'requestId'>,
): Promise<ResolveResult> {
  // 1. Existing OAuthIdentity for this provider+providerUserId?
  const existing = await db.oAuthIdentity.findUnique({
    where: {
      provider_providerUserId: {
        provider: profile.provider,
        providerUserId: profile.providerUserId,
      },
    },
    include: { user: true },
  })
  if (existing) {
    // Existing linked account — log in.
    if (existing.user.status === 'DELETED' || existing.user.status === 'SUSPENDED') {
      throw new ForbiddenError('Account is suspended or deleted')
    }
    return {
      userId: existing.userId,
      name: existing.user.name,
      isNewUser: false,
      linkedNewIdentity: false,
    }
  }

  // 2. Existing user with the same email?
  const userByEmail = await db.user.findUnique({
    where: { emailLower: normalizedEmail },
    include: { oauthIdentities: true },
  })

  if (userByEmail) {
    if (userByEmail.status === 'DELETED' || userByEmail.status === 'SUSPENDED') {
      throw new ForbiddenError('Account is suspended or deleted')
    }
    // 3. Provider must have verified the email to link.
    if (!profile.emailVerified) {
      // Refuse — force password login first to prevent account takeover via
      // a fake OAuth email claim.
      await recordSecurityEvent(
        'OAUTH_LOGIN_FAILED',
        { ...ctx, actorType: 'USER', actorId: userByEmail.id },
        { reason: 'email_not_verified_by_provider', provider: profile.provider },
        'HIGH',
      )
      throw new ForbiddenError(
        'An account with this email already exists. Sign in with your password to link this provider from your account settings.',
      )
    }
    // Link the OAuthIdentity to the existing user.
    await db.oAuthIdentity.create({
      data: {
        userId: userByEmail.id,
        provider: profile.provider,
        providerUserId: profile.providerUserId,
      },
    })
    await recordAudit(
      'OAUTH_LINK',
      { type: 'user', id: userByEmail.id },
      { ...ctx, actorType: 'USER', actorId: userByEmail.id },
      { provider: profile.provider, providerUserId: profile.providerUserId, onLogin: true },
    )
    return {
      userId: userByEmail.id,
      name: userByEmail.name,
      isNewUser: false,
      linkedNewIdentity: true,
    }
  }

  // 4. New user. Provider verified email → status=ACTIVE, no passwordHash.
  if (!profile.emailVerified) {
    // We could still create the account but mark it PENDING_VERIFICATION and
    // require an email-verification step. For simplicity and because both
    // Google and GitHub verify emails via their primary/verified endpoint,
    // we refuse — if a provider claims an unverified email, we don't trust it
    // to bootstrap an account.
    await recordSecurityEvent(
      'OAUTH_LOGIN_FAILED',
      { ...ctx, actorType: 'USER' },
      { reason: 'email_not_verified_by_provider_on_register', provider: profile.provider },
      'WARN',
    )
    throw new ForbiddenError(
      'Your OAuth provider did not return a verified email address. Please verify your email with the provider and try again.',
    )
  }

  const newUser = await db.user.create({
    data: {
      email: normalizedEmail,
      emailLower: normalizedEmail,
      name: profile.name,
      avatarUrl: profile.avatarUrl,
      passwordHash: null, // OAuth-only user (can set a password later)
      status: 'ACTIVE',
      platformRole: 'USER',
      oauthIdentities: {
        create: {
          provider: profile.provider,
          providerUserId: profile.providerUserId,
        },
      },
    },
  })

  return {
    userId: newUser.id,
    name: newUser.name,
    isNewUser: true,
    linkedNewIdentity: true,
  }
}

// ---------------- Account management (authenticated) ----------------

export interface LinkAccountResult {
  userId: string
  provider: OAuthProviderName
  providerUserId: string
  email: string
}

/**
 * Link a provider identity to an already-authenticated user, given a profile
 * obtained out-of-band (the authenticated callback handler fetches the
 * profile via the provider adapter, then calls this).
 *
 * - If the (provider, providerUserId) is already linked to THIS user → idempotent.
 * - If already linked to a DIFFERENT user → ConflictError (refuse).
 * - Otherwise → create OAuthIdentity + audit OAUTH_LINK.
 */
export async function linkAccountFromProfile(
  userId: string,
  profile: OAuthProfile,
  ctx: Pick<AuditContext, 'ip' | 'userAgent' | 'requestId' | 'actorId'>,
): Promise<LinkAccountResult> {
  // Is this provider+providerUserId already linked to someone?
  const existing = await db.oAuthIdentity.findUnique({
    where: {
      provider_providerUserId: {
        provider: profile.provider,
        providerUserId: profile.providerUserId,
      },
    },
    include: { user: true },
  })
  if (existing && existing.userId !== userId) {
    throw new ConflictError(
      `This ${profile.provider} account is already linked to another ProofPilot user.`,
    )
  }
  if (existing && existing.userId === userId) {
    // Already linked — idempotent.
    return {
      userId,
      provider: profile.provider,
      providerUserId: profile.providerUserId,
      email: profile.email,
    }
  }

  await db.oAuthIdentity.create({
    data: {
      userId,
      provider: profile.provider,
      providerUserId: profile.providerUserId,
    },
  })
  await recordAudit(
    'OAUTH_LINK',
    { type: 'user', id: userId },
    { ...ctx, actorType: 'USER', actorId: userId },
    { provider: profile.provider, providerUserId: profile.providerUserId, onLogin: false },
  )
  return {
    userId,
    provider: profile.provider,
    providerUserId: profile.providerUserId,
    email: profile.email,
  }
}

export interface LinkedAccountInfo {
  provider: OAuthProviderName
  providerUserId: string
  email: string | null
  createdAt: Date
}

export async function listLinkedAccounts(userId: string): Promise<LinkedAccountInfo[]> {
  const rows = await db.oAuthIdentity.findMany({ where: { userId } })
  return rows.map((r) => ({
    provider: r.provider as OAuthProviderName,
    providerUserId: r.providerUserId,
    email: null, // not stored on OAuthIdentity; user.email is the canonical email
    createdAt: r.createdAt,
  }))
}

export async function unlinkAccount(
  userId: string,
  provider: OAuthProviderName,
  ctx: Pick<AuditContext, 'ip' | 'userAgent' | 'requestId' | 'actorId'>,
): Promise<void> {
  const user = await db.user.findUnique({
    where: { id: userId },
    include: { oauthIdentities: true },
  })
  if (!user) {
    throw new NotFoundError('User')
  }

  const identity = user.oauthIdentities.find((i) => i.provider === provider)
  if (!identity) {
    // Idempotent — already unlinked.
    return
  }

  // Safety: refuse to unlink if it's the user's ONLY auth method AND they
  // have no password. (Otherwise they'd be locked out.)
  const otherIdentities = user.oauthIdentities.filter((i) => i.provider !== provider)
  if (!user.passwordHash && otherIdentities.length === 0) {
    throw new ForbiddenError(
      `Cannot unlink your only sign-in method. Set a password or link another provider first.`,
    )
  }

  await db.oAuthIdentity.delete({ where: { id: identity.id } })
  await recordAudit(
    'OAUTH_UNLINK',
    { type: 'user', id: userId },
    { ...ctx, actorType: 'USER', actorId: userId },
    { provider },
  )
}

// ---------------- Cleanup ----------------

/** Remove expired OAuth state rows. Called by the maintenance job (Phase 11). */
export async function cleanupExpiredOAuthStates(): Promise<{ deleted: number }> {
  const result = await db.oAuthState.deleteMany({
    where: { expiresAt: { lt: new Date() } },
  })
  return { deleted: result.count }
}
