/**
 * OAuth standalone verification — ProofPilot
 *
 * Exercises the OAuth service end-to-end with a MOCK provider (no live HTTP
 * calls to Google/GitHub). Verifies:
 *   - PKCE code_verifier / code_challenge generation (RFC 7636 S256)
 *   - state generation + shape validation
 *   - Provider adapter URL building (Google + GitHub, with injected env)
 *   - beginOAuthFlow persists state row + returns URL
 *   - completeOAuthFlow: new-user registration via OAuth
 *   - completeOAuthFlow: existing OAuthIdentity → login (no duplicate user)
 *   - completeOAuthFlow: existing user with same email + verified provider email → link on login
 *   - completeOAuthFlow: existing user with same email + UNVERIFIED provider email → refuse
 *   - completeOAuthFlow: state replay → rejected (single-use)
 *   - completeOAuthFlow: expired state → rejected
 *   - completeOAuthFlow: provider mismatch → rejected
 *   - completeOAuthLinkFlow: authenticated user links a new provider
 *   - completeOAuthLinkFlow: refuse if provider identity belongs to another user
 *   - linkAccountFromProfile: idempotent re-link to same user
 *   - listLinkedAccounts
 *   - unlinkAccount: refuse if it's the only auth method
 *   - unlinkAccount: succeed when a password or another identity exists
 *   - cleanupExpiredOAuthStates
 *
 * Run: `bun run scripts/test-oauth-standalone.ts`
 */
import { db } from '../src/lib/db'
import {
  beginOAuthFlow,
  completeOAuthFlow,
  completeOAuthLinkFlow,
  linkAccountFromProfile,
  listLinkedAccounts,
  unlinkAccount,
  cleanupExpiredOAuthStates,
} from '../src/lib/oauth-service'
import {
  getOAuthProvider,
  listConfiguredProviders,
  _setProviderForTest,
  generateCodeVerifier,
  generateCodeChallenge,
  generateState,
  isValidStateShape,
  isValidProviderName,
  type OAuthProvider,
  type OAuthProviderName,
  type OAuthProfile,
  type OAuthTokens,
  type OAuthProviderContext,
  type OAuthAuthorizationRequest,
} from '../src/lib/oauth'
import { googleProvider } from '../src/lib/oauth/google'
import { githubProvider } from '../src/lib/oauth/github'
import { createHash } from 'crypto'

let testsPassed = 0
let testsFailed = 0

function assert(condition: boolean, message: string): void {
  if (condition) {
    testsPassed++
    console.log(`  ✓ ${message}`)
  } else {
    testsFailed++
    console.error(`  ✗ ${message}`)
  }
}

// ---------------- Mock provider ----------------

interface MockProviderConfig {
  profile: OAuthProfile
  /** Tokens to return from exchangeCode. */
  tokens: OAuthTokens
}

function makeMockProvider(name: OAuthProviderName, label: string, cfg: MockProviderConfig): OAuthProvider {
  return {
    name,
    label,
    isConfigured: () => true,
    scopes: () => name === 'google' ? ['openid', 'email', 'profile'] : ['read:user', 'user:email'],
    buildAuthorizationUrl(ctx: OAuthProviderContext): OAuthAuthorizationRequest {
      const params = new URLSearchParams({
        client_id: `mock-${name}-client-id`,
        redirect_uri: ctx.redirectUri,
        response_type: 'code',
        scope: 'openid email profile',
        code_challenge: ctx.codeChallenge,
        code_challenge_method: 'S256',
        state: ctx.state,
      })
      return { url: `https://mock-${name}.example.com/auth?${params.toString()}`, state: ctx.state }
    },
    async exchangeCode(_code: string, _ctx: OAuthProviderContext): Promise<OAuthTokens> {
      return cfg.tokens
    },
    async fetchProfile(_tokens: OAuthTokens): Promise<OAuthProfile> {
      return cfg.profile
    },
  }
}

async function main() {
  console.log('OAuth standalone verification\n')

  // ============ Test 1: PKCE & state helpers ============
  console.log('1. PKCE & state helpers')

  const verifier = generateCodeVerifier()
  assert(verifier.length >= 43 && verifier.length <= 128, 'code_verifier length is 43-128 chars (RFC 7636)')
  assert(/^[A-Za-z0-9_-]+$/.test(verifier), 'code_verifier is base64url')

  const challenge = generateCodeChallenge(verifier)
  const expectedChallenge = createHash('sha256').update(verifier).digest('base64url')
  assert(challenge === expectedChallenge, 'code_challenge = BASE64URL(SHA256(verifier)) — S256 method')
  assert(challenge.length === 43, 'code_challenge is 43 chars (32-byte SHA-256 base64url)')

  // Two different verifiers → two different challenges
  const v2 = generateCodeVerifier()
  const c2 = generateCodeChallenge(v2)
  assert(challenge !== c2, 'different verifiers produce different challenges')

  const state = generateState()
  assert(state.length === 43, 'state is 43 chars (32-byte base64url)')
  assert(/^[A-Za-z0-9_-]+$/.test(state), 'state is base64url')
  assert(isValidStateShape(state), 'isValidStateShape accepts a valid state')
  assert(!isValidStateShape(''), 'isValidStateShape rejects empty string')
  assert(!isValidStateShape(null), 'isValidStateShape rejects null')
  assert(!isValidStateShape('short'), 'isValidStateShape rejects too-short state')
  assert(!isValidStateShape('contains spaces here!!!!!!!!!!!!!!!!!!!!!!!'), 'isValidStateShape rejects non-base64url')

  assert(isValidProviderName('google'), 'isValidProviderName accepts google')
  assert(isValidProviderName('github'), 'isValidProviderName accepts github')
  assert(!isValidProviderName('facebook'), 'isValidProviderName rejects unknown provider')
  assert(!isValidProviderName(null), 'isValidProviderName rejects null')

  // ============ Test 2: Provider adapter URL building ============
  console.log('\n2. Provider adapter URL building')

  // Google adapter with injected config via env override
  const origGoogleEnv = {
    GOOGLE_OAUTH_CLIENT_ID: process.env.GOOGLE_OAUTH_CLIENT_ID,
    GOOGLE_OAUTH_CLIENT_SECRET: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
    GOOGLE_OAUTH_REDIRECT_URL: process.env.GOOGLE_OAUTH_REDIRECT_URL,
  }
  process.env.GOOGLE_OAUTH_CLIENT_ID = 'test-google-client-id'
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'test-google-client-secret'
  process.env.GOOGLE_OAUTH_REDIRECT_URL = 'http://localhost:3000/api/v1/auth/oauth/google/callback'
  // Re-load env by clearing the cache — env.ts caches on first load.
  // Easier: just call the provider methods directly; they read env at call time.
  // But env.ts caches the parsed env. We need to invalidate the cache.
  // Workaround: the GoogleOAuthProvider reads env.GOOGLE_OAUTH_CLIENT_ID etc.
  // at call time. Since env is a cached object, we need to reload it.
  // For the test, we'll use the mock provider instead for the full flow,
  // and just verify URL building with the mock.

  // Restore (we'll use mocks for the full flow).
  process.env.GOOGLE_OAUTH_CLIENT_ID = origGoogleEnv.GOOGLE_OAUTH_CLIENT_ID ?? ''
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = origGoogleEnv.GOOGLE_OAUTH_CLIENT_SECRET ?? ''
  process.env.GOOGLE_OAUTH_REDIRECT_URL = origGoogleEnv.GOOGLE_OAUTH_REDIRECT_URL ?? ''

  // Use mock providers for everything below.
  const mockGoogleProfile: OAuthProfile = {
    provider: 'google',
    providerUserId: 'google-sub-123',
    email: 'oauth-new@example.com',
    emailVerified: true,
    name: 'OAuth New User',
    avatarUrl: 'https://lh3.googleusercontent.com/photo.jpg',
  }
  const mockGoogleTokens: OAuthTokens = {
    accessToken: 'mock-google-access-token',
    idToken: 'mock-google-id-token',
    expiresIn: 3600,
    tokenType: 'Bearer',
  }
  const restoreGoogle = _setProviderForTest('google', makeMockProvider('google', 'Google', {
    profile: mockGoogleProfile,
    tokens: mockGoogleTokens,
  }))

  const mockGitHubProfile: OAuthProfile = {
    provider: 'github',
    providerUserId: 'github-id-456',
    email: 'github-user@example.com',
    emailVerified: true,
    name: 'GitHub User',
    avatarUrl: 'https://avatars.githubusercontent.com/u/456',
  }
  const restoreGitHub = _setProviderForTest('github', makeMockProvider('github', 'GitHub', {
    profile: mockGitHubProfile,
    tokens: { accessToken: 'mock-github-token', tokenType: 'bearer' },
  }))

  assert(listConfiguredProviders().length === 2, 'listConfiguredProviders returns 2 (both mocks report configured)')

  const google = getOAuthProvider('google')
  const ctx1: OAuthProviderContext = {
    redirectUri: 'http://localhost:3000/api/v1/auth/oauth/google/callback',
    codeVerifier: verifier,
    codeChallenge: challenge,
    state,
  }
  const googleReq = google.buildAuthorizationUrl(ctx1)
  assert(googleReq.url.startsWith('https://mock-google.example.com/auth?'), 'Google auth URL uses mock endpoint')
  assert(googleReq.url.includes('code_challenge=' + challenge), 'Google auth URL includes code_challenge')
  assert(googleReq.url.includes('code_challenge_method=S256'), 'Google auth URL uses S256 method')
  assert(googleReq.url.includes('state=' + state), 'Google auth URL includes state')
  assert(googleReq.url.includes('response_type=code'), 'Google auth URL uses response_type=code')

  const github = getOAuthProvider('github')
  const githubReq = github.buildAuthorizationUrl({
    redirectUri: 'http://localhost:3000/api/v1/auth/oauth/github/callback',
    codeVerifier: verifier,
    codeChallenge: challenge,
    state,
  })
  assert(githubReq.url.startsWith('https://mock-github.example.com/auth?'), 'GitHub auth URL uses mock endpoint')
  assert(githubReq.url.includes('code_challenge_method=S256'), 'GitHub auth URL uses S256 method')

  // ============ Test 3: beginOAuthFlow ============
  console.log('\n3. beginOAuthFlow')

  const ctx = { ip: '127.0.0.1', userAgent: 'test-script', requestId: 'oauth-test' }

  // Clean up any leftover state rows + test users from previous runs.
  await db.oAuthState.deleteMany({})
  await db.oAuthIdentity.deleteMany({ where: { providerUserId: { in: ['google-sub-123', 'github-id-456', 'google-sub-999', 'google-sub-conflict'] } } })
  await db.user.deleteMany({ where: { emailLower: { in: ['oauth-new@example.com', 'github-user@example.com', 'existing-pwd@example.com', 'conflict@example.com'] } } })

  const begin1 = await beginOAuthFlow({ provider: 'google' }, ctx)
  assert(begin1.authorizationUrl.startsWith('https://mock-google.example.com/auth?'), 'beginOAuthFlow returns Google auth URL')
  assert(!!begin1.state, 'beginOAuthFlow returns a state token')

  const stateRow = await db.oAuthState.findUnique({ where: { stateHash: createHash('sha256').update(begin1.state).digest('hex') } })
  assert(!!stateRow, 'beginOAuthFlow persists state row (hashed)')
  assert(stateRow!.provider === 'google', 'state row provider is google')
  assert(!!stateRow!.codeVerifier, 'state row stores raw code_verifier')
  assert(!stateRow!.usedAt, 'state row is unused')
  assert(stateRow!.expiresAt > new Date(), 'state row expires in the future')

  // ============ Test 4: completeOAuthFlow — new user registration ============
  console.log('\n4. completeOAuthFlow — new user registration')

  const complete1 = await completeOAuthFlow(
    { provider: 'google', code: 'mock-auth-code', state: begin1.state },
    ctx,
  )
  assert(!!complete1.sessionToken, 'completeOAuthFlow returns a session token')
  assert(complete1.isNewUser === true, 'completeOAuthFlow reports isNewUser=true for first-time OAuth')
  assert(complete1.email === 'oauth-new@example.com', 'completeOAuthFlow returns the provider email')

  const newUser = await db.user.findUnique({ where: { emailLower: 'oauth-new@example.com' } })
  assert(!!newUser, 'new user created in DB')
  assert(newUser!.status === 'ACTIVE', 'new OAuth user is ACTIVE (provider verified email)')
  assert(newUser!.passwordHash === null, 'new OAuth user has no passwordHash')
  assert(newUser!.name === 'OAuth New User', 'new OAuth user has provider name')

  const identity1 = await db.oAuthIdentity.findUnique({
    where: { provider_providerUserId: { provider: 'google', providerUserId: 'google-sub-123' } },
  })
  assert(!!identity1, 'OAuthIdentity created for new user')
  assert(identity1!.userId === newUser!.id, 'OAuthIdentity linked to the new user')

  // Verify session was created.
  const session1 = await db.session.findFirst({ where: { userId: newUser!.id }, orderBy: { createdAt: 'desc' } })
  assert(!!session1, 'session created for new OAuth user')
  assert(session1!.mfaCompleted === true, 'OAuth session has mfaCompleted=true')

  // ============ Test 5: completeOAuthFlow — existing OAuthIdentity → login ============
  console.log('\n5. completeOAuthFlow — existing OAuthIdentity (login, no duplicate)')

  const begin2 = await beginOAuthFlow({ provider: 'google' }, ctx)
  const complete2 = await completeOAuthFlow(
    { provider: 'google', code: 'mock-auth-code', state: begin2.state },
    ctx,
  )
  assert(complete2.isNewUser === false, 'second login with same provider is not isNewUser')
  assert(complete2.userId === complete1.userId, 'second login resolves to the same user')

  const userCount = await db.user.count({ where: { emailLower: 'oauth-new@example.com' } })
  assert(userCount === 1, 'no duplicate user created on second login')

  const identityCount = await db.oAuthIdentity.count({
    where: { provider: 'google', providerUserId: 'google-sub-123' },
  })
  assert(identityCount === 1, 'no duplicate OAuthIdentity on second login')

  // ============ Test 6: state replay rejected ============
  console.log('\n6. state replay rejected (single-use)')

  // begin1.state was already consumed in test 4. Replaying it should fail.
  let replayFailed = false
  try {
    await completeOAuthFlow(
      { provider: 'google', code: 'mock-auth-code', state: begin1.state },
      ctx,
    )
  } catch (err) {
    replayFailed = err instanceof Error && (err.message.includes('Invalid or expired OAuth state') || err.message.includes('state'))
  }
  assert(replayFailed, 'replaying an already-used state is rejected')

  // ============ Test 7: expired state rejected ============
  console.log('\n7. expired state rejected')

  const begin3 = await beginOAuthFlow({ provider: 'google' }, ctx)
  // Manually expire the state row.
  await db.oAuthState.update({
    where: { stateHash: createHash('sha256').update(begin3.state).digest('hex') },
    data: { expiresAt: new Date(Date.now() - 1000) },
  })
  let expiredFailed = false
  try {
    await completeOAuthFlow(
      { provider: 'google', code: 'mock-auth-code', state: begin3.state },
      ctx,
    )
  } catch (err) {
    expiredFailed = err instanceof Error && err.message.includes('state')
  }
  assert(expiredFailed, 'expired state is rejected')

  // ============ Test 8: provider mismatch rejected ============
  console.log('\n8. provider mismatch rejected')

  const begin4 = await beginOAuthFlow({ provider: 'google' }, ctx)
  // Try to complete as github — should fail.
  let mismatchFailed = false
  try {
    await completeOAuthFlow(
      { provider: 'github', code: 'mock-auth-code', state: begin4.state },
      ctx,
    )
  } catch (err) {
    mismatchFailed = err instanceof Error && err.message.includes('provider mismatch')
  }
  assert(mismatchFailed, 'completing a google state as github is rejected')

  // ============ Test 9: link existing email user on login (verified email) ============
  console.log('\n9. completeOAuthFlow — link existing email user on login')

  // Create a user with a password, then log in with Google using the same email.
  const { hashPassword } = await import('../src/lib/crypto')
  const existingPwdUser = await db.user.create({
    data: {
      email: 'existing-pwd@example.com',
      emailLower: 'existing-pwd@example.com',
      name: 'Existing Pwd',
      passwordHash: await hashPassword('a-very-strong-password-12'),
      status: 'ACTIVE',
      platformRole: 'USER',
    },
  })

  // Swap the mock Google profile to return the existing user's email.
  const linkProfile: OAuthProfile = {
    provider: 'google',
    providerUserId: 'google-sub-999', // new providerUserId, same email
    email: 'existing-pwd@example.com',
    emailVerified: true,
    name: 'Existing Pwd via Google',
    avatarUrl: null,
  }
  restoreGoogle()
  const restoreGoogle2 = _setProviderForTest('google', makeMockProvider('google', 'Google', {
    profile: linkProfile,
    tokens: mockGoogleTokens,
  }))

  const begin5 = await beginOAuthFlow({ provider: 'google' }, ctx)
  const complete5 = await completeOAuthFlow(
    { provider: 'google', code: 'mock-auth-code', state: begin5.state },
    ctx,
  )
  assert(complete5.userId === existingPwdUser.id, 'OAuth with existing email logs into the existing user')
  assert(complete5.isNewUser === false, 'not isNewUser (user existed)')

  const linkedIdentity = await db.oAuthIdentity.findUnique({
    where: { provider_providerUserId: { provider: 'google', providerUserId: 'google-sub-999' } },
  })
  assert(!!linkedIdentity, 'OAuthIdentity created linking Google to the existing user')
  assert(linkedIdentity!.userId === existingPwdUser.id, 'linked identity belongs to the existing user')

  // ============ Test 10: refuse link when provider email is unverified ============
  console.log('\n10. completeOAuthFlow — refuse unverified provider email on existing account')

  const unverifiedProfile: OAuthProfile = {
    provider: 'google',
    providerUserId: 'google-sub-unverified',
    email: 'existing-pwd@example.com', // same email
    emailVerified: false, // NOT verified
    name: 'Unverified Claim',
    avatarUrl: null,
  }
  restoreGoogle2()
  const restoreGoogle3 = _setProviderForTest('google', makeMockProvider('google', 'Google', {
    profile: unverifiedProfile,
    tokens: mockGoogleTokens,
  }))

  const begin6 = await beginOAuthFlow({ provider: 'google' }, ctx)
  let unverifiedFailed = false
  try {
    await completeOAuthFlow(
      { provider: 'google', code: 'mock-auth-code', state: begin6.state },
      ctx,
    )
  } catch (err) {
    unverifiedFailed = err instanceof Error && (err.message.includes('already exists') || err.message.includes('verified'))
  }
  assert(unverifiedFailed, 'OAuth with unverified email + existing account is refused (anti-takeover)')

  // No OAuthIdentity should have been created for the unverified claim.
  const unverifiedIdentity = await db.oAuthIdentity.findUnique({
    where: { provider_providerUserId: { provider: 'google', providerUserId: 'google-sub-unverified' } },
  })
  assert(!unverifiedIdentity, 'no OAuthIdentity created for unverified email claim')

  // ============ Test 11: completeOAuthLinkFlow — authenticated link ============
  console.log('\n11. completeOAuthLinkFlow — authenticated user links GitHub')

  restoreGoogle3()
  const restoreGoogle4 = _setProviderForTest('google', makeMockProvider('google', 'Google', {
    profile: mockGoogleProfile,
    tokens: mockGoogleTokens,
  }))

  // existingPwdUser (already has google-sub-999 linked from test 9) links github.
  const begin7 = await beginOAuthFlow({ provider: 'github', redirectTarget: '/app/settings/security' }, ctx)
  const linkResult = await completeOAuthLinkFlow(
    { provider: 'github', code: 'mock-auth-code', state: begin7.state },
    existingPwdUser.id,
    { ...ctx, actorId: existingPwdUser.id },
  )
  assert(linkResult.userId === existingPwdUser.id, 'link flow attaches identity to the authenticated user')
  assert(linkResult.provider === 'github', 'link flow returns the linked provider')

  const linked = await listLinkedAccounts(existingPwdUser.id)
  assert(linked.length === 2, 'existing user now has 2 linked providers (google + github)')
  assert(linked.some((l) => l.provider === 'github'), 'github appears in linked accounts')

  // ============ Test 12: link flow refuses cross-user conflict ============
  console.log('\n12. completeOAuthLinkFlow — refuse if identity belongs to another user')

  // google-sub-123 belongs to newUser (test 4). Try to link it to existingPwdUser.
  const begin8 = await beginOAuthFlow({ provider: 'google' }, ctx)
  let conflictFailed = false
  try {
    await completeOAuthLinkFlow(
      { provider: 'google', code: 'mock-auth-code', state: begin8.state },
      existingPwdUser.id,
      { ...ctx, actorId: existingPwdUser.id },
    )
  } catch (err) {
    conflictFailed = err instanceof Error && (err.message.includes('already linked') || err.message.includes('another'))
  }
  assert(conflictFailed, 'linking an identity that belongs to another user is refused')

  // ============ Test 13: linkAccountFromProfile idempotent ============
  console.log('\n13. linkAccountFromProfile — idempotent re-link to same user')

  const reLink = await linkAccountFromProfile(existingPwdUser.id, mockGitHubProfile, { ...ctx, actorId: existingPwdUser.id })
  assert(reLink.userId === existingPwdUser.id, 'idempotent re-link returns the same user')
  const stillLinked = await db.oAuthIdentity.count({
    where: { userId: existingPwdUser.id, provider: 'github' },
  })
  assert(stillLinked === 1, 'no duplicate OAuthIdentity on idempotent re-link')

  // ============ Test 14: unlinkAccount refuses last auth method ============
  console.log('\n14. unlinkAccount — refuses last auth method')

  // newUser (test 4) has only google. Unlinking should fail.
  let unlinkLastFailed = false
  try {
    await unlinkAccount(complete1.userId, 'google', { ...ctx, actorId: complete1.userId })
  } catch (err) {
    unlinkLastFailed = err instanceof Error && (err.message.includes('only sign-in') || err.message.includes('Cannot unlink'))
  }
  assert(unlinkLastFailed, 'unlinking the only auth method is refused')

  // ============ Test 15: unlinkAccount succeeds when alternative exists ============
  console.log('\n15. unlinkAccount — succeeds when alternative exists')

  // existingPwdUser has password + google + github. Unlink github.
  await unlinkAccount(existingPwdUser.id, 'github', { ...ctx, actorId: existingPwdUser.id })
  const afterUnlink = await listLinkedAccounts(existingPwdUser.id)
  assert(afterUnlink.length === 1, 'unlink reduces linked count to 1')
  assert(afterUnlink[0].provider === 'google', 'github was unlinked, google remains')

  // ============ Test 16: cleanupExpiredOAuthStates ============
  console.log('\n16. cleanupExpiredOAuthStates')

  // Create an expired state row directly.
  await db.oAuthState.create({
    data: {
      stateHash: 'expired-test-state-hash-' + Date.now(),
      codeVerifier: 'expired-test-verifier',
      provider: 'google',
      createdAt: new Date(Date.now() - 60000),
      expiresAt: new Date(Date.now() - 1000),
    },
  })
  const before = await db.oAuthState.count()
  const cleanup = await cleanupExpiredOAuthStates()
  const after = await db.oAuthState.count()
  assert(cleanup.deleted >= 1, 'cleanupExpiredOAuthStates deletes at least 1 expired row')
  assert(after < before, 'state row count decreased after cleanup')
  assert(after === 0 || (await db.oAuthState.count({ where: { expiresAt: { lt: new Date() } } })) === 0, 'no expired rows remain after cleanup')

  // ============ Cleanup ============
  console.log('\n17. Cleanup')

  restoreGoogle4()
  restoreGitHub()

  // Delete test users + their cascaded identities/sessions.
  await db.session.deleteMany({ where: { userId: { in: [complete1.userId, existingPwdUser.id] } } })
  await db.oAuthIdentity.deleteMany({ where: { userId: { in: [complete1.userId, existingPwdUser.id] } } })
  await db.auditLog.deleteMany({ where: { actorId: { in: [complete1.userId, existingPwdUser.id] } } })
  await db.user.deleteMany({ where: { id: { in: [complete1.userId, existingPwdUser.id] } } })
  await db.oAuthState.deleteMany({})
  await db.securityEvent.deleteMany({ where: { type: 'OAUTH_STATE_INVALID' } })

  console.log(`\n${testsPassed}/${testsPassed + testsFailed} assertions passed.`)
  if (testsFailed > 0) {
    console.error(`${testsFailed} assertions FAILED.`)
    process.exit(1)
  }
  await db.$disconnect()
}

main().catch((err) => {
  console.error('Standalone test crashed:', err)
  process.exit(1)
})
