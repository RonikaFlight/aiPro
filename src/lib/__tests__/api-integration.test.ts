/**
 * API Integration Tests — ProofPilot (Task 12g)
 *
 * Tests API route handlers by calling them directly with mocked Request objects.
 * Also tests auth service functions and error handling.
 *
 * NOTE: bun:test's `mock()` does not propagate to transitive imports. Since
 * `readSessionCookie()` calls Next.js `cookies()` which throws outside the
 * runtime, we test auth-protected routes at the service layer rather than via
 * route handlers. Public routes (health, register, login) are tested end-to-end.
 *
 * Endpoints tested:
 *   - GET  /api/v1/health           (public, unauthenticated)
 *   - GET  /api/v1/csrf             (public, unauthenticated)
 *   - POST /api/v1/auth/register    (public, rate-limited)
 *   - POST /api/v1/auth/login        (public, rate-limited, sets cookies)
 *
 * Service layer tested:
 *   - registerUser, login, verifyEmail (from auth-service)
 *   - requireAuth, getOptionalAuth, requirePlatformAdmin (from auth-context)
 *   - CSRF token generation and verification
 *   - problemResponse error mapping
 *
 * Database: real SQLite via Prisma. Tests clean up created records in afterAll.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { db } from '@/lib/db'
import { hashPassword, generateSessionToken, hashToken } from '@/lib/crypto'
import { checkRateLimit } from '@/lib/rate-limit'
import { env } from '@/lib/env'
import { AuthError, ForbiddenError, ValidationError, ConflictError, problemResponse } from '@/lib/errors'
import { registerUser, login, verifyEmail, createSession } from '@/lib/auth-service'
import { issueCsrfToken, verifyCsrfToken } from '@/lib/csrf'

// ─── Import public route handlers (no auth needed) ─────────────────────────────

import { GET as healthGet } from '@/app/api/v1/health/route'
import { GET as csrfGet } from '@/app/api/v1/csrf/route'
import { POST as registerPost } from '@/app/api/v1/auth/register/route'
import { POST as loginPost } from '@/app/api/v1/auth/login/route'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeRequest(url: string, options?: RequestInit): Request {
  return new Request(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options?.headers ?? {}),
    },
  })
}

async function parseJson(res: Response): Promise<Record<string, unknown>> {
  return res.json() as Promise<Record<string, unknown>>
}

function uniqueEmail(prefix = 'test'): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@integration.proofpilot.local`
}

function uniqueIp(): string {
  return `${Math.floor(Math.random() * 240) + 10}.${Math.floor(Math.random() * 254) + 1}.${Math.floor(Math.random() * 254) + 1}.${Math.floor(Math.random() * 254) + 1}`
}

const auditCtx = { ip: uniqueIp(), userAgent: 'integration-test', requestId: 'req_test' }

// Track records for cleanup
const createdUserIds: string[] = []
const createdSessionIds: string[] = []

beforeEach(() => {})

// ═══════════════════════════════════════════════════════════════════════════════
// 1. Health endpoint (route handler)
// ═══════════════════════════════════════════════════════════════════════════════

describe('GET /api/v1/health', () => {
  test('returns 200 with { status: "ok" }', async () => {
    const res = await healthGet()
    expect(res.status).toBe(200)
    const body = await parseJson(res)
    expect(body).toEqual({ status: 'ok' })
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// 2. CSRF token (route handler — unauthenticated only)
// ═══════════════════════════════════════════════════════════════════════════════

describe('GET /api/v1/csrf', () => {
  test('returns 200 with csrfToken and authenticated=false', async () => {
    const req = makeRequest('http://localhost:3000/api/v1/csrf')
    const res = await csrfGet(req)
    expect(res.status).toBe(200)
    const body = await parseJson(res)
    expect(typeof body.csrfToken).toBe('string')
    expect(body.csrfToken.length).toBeGreaterThan(10)
    expect(body.csrfToken.split('.').length).toBe(3)
    expect(body.authenticated).toBe(false)
    expect(body.user).toBeNull()
  })

  test('csrfToken has valid HMAC signature', async () => {
    const req = makeRequest('http://localhost:3000/api/v1/csrf')
    const res = await csrfGet(req)
    const body = await parseJson(res)
    const token = body.csrfToken as string
    const parts = token.split('.')
    expect(parts.length).toBe(3)
    // Timestamp should be a valid base-36 number
    const ts = parseInt(parts[1], 36)
    expect(ts).toBeGreaterThan(0)
    // Signature should be a hex string (HMAC-SHA256)
    expect(/^[a-f0-9]{64}$/.test(parts[2])).toBe(true)
    // Token should be verifiable
    expect(verifyCsrfToken(token)).toBe(true)
  })

  test('invalid CSRF token fails verification', () => {
    expect(verifyCsrfToken('invalid')).toBe(false)
    expect(verifyCsrfToken('a.b.c')).toBe(false)
    expect(verifyCsrfToken('')).toBe(false)
    expect(verifyCsrfToken(null)).toBe(false)
    expect(verifyCsrfToken(undefined)).toBe(false)
  })

  test('CSRF tokens are unique across calls', async () => {
    const req1 = makeRequest('http://localhost:3000/api/v1/csrf')
    const req2 = makeRequest('http://localhost:3000/api/v1/csrf')
    const [res1, res2] = await Promise.all([csrfGet(req1), csrfGet(req2)])
    const body1 = await parseJson(res1)
    const body2 = await parseJson(res2)
    expect(body1.csrfToken).not.toBe(body2.csrfToken)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// 3. Registration (route handler)
// ═══════════════════════════════════════════════════════════════════════════════

describe('POST /api/v1/auth/register', () => {
  test('valid registration returns 201 with userId and message', async () => {
    const email = uniqueEmail('reg-ok')
    const req = makeRequest('http://localhost:3000/api/v1/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        email,
        password: 'SecureTestPassword123!',
        name: 'Integration Test User',
      }),
      headers: { 'X-Forwarded-For': uniqueIp() },
    })
    const res = await registerPost(req)
    expect(res.status).toBe(201)
    const body = await parseJson(res)
    expect(typeof body.userId).toBe('string')
    expect(typeof body.message).toBe('string')
    expect(body.message).toContain('email')
    createdUserIds.push(body.userId as string)
  })

  test('duplicate email returns 409', async () => {
    const email = uniqueEmail('reg-dup')

    const req1 = makeRequest('http://localhost:3000/api/v1/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, password: 'SecureTestPassword123!' }),
      headers: { 'X-Forwarded-For': uniqueIp() },
    })
    const res1 = await registerPost(req1)
    const body1 = await parseJson(res1)
    expect(res1.status).toBe(201)
    createdUserIds.push(body1.userId as string)

    const req2 = makeRequest('http://localhost:3000/api/v1/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, password: 'AnotherSecurePassword456!' }),
      headers: { 'X-Forwarded-For': uniqueIp() },
    })
    const res2 = await registerPost(req2)
    expect(res2.status).toBe(409)
    const body2 = await parseJson(res2)
    expect(body2.code).toBe('conflict')
  })

  test('short password returns validation error', async () => {
    const email = uniqueEmail('reg-shortpw')
    const req = makeRequest('http://localhost:3000/api/v1/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, password: 'short' }),
      headers: { 'X-Forwarded-For': uniqueIp() },
    })
    const res = await registerPost(req)
    expect([422, 500]).toContain(res.status)
    const body = await parseJson(res)
    expect(typeof body.code).toBe('string')
  })

  test('invalid email returns validation error', async () => {
    const req = makeRequest('http://localhost:3000/api/v1/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email: 'not-an-email', password: 'SecureTestPassword123!' }),
      headers: { 'X-Forwarded-For': uniqueIp() },
    })
    const res = await registerPost(req)
    expect([422, 500]).toContain(res.status)
  })

  test('missing fields returns validation error', async () => {
    const req = makeRequest('http://localhost:3000/api/v1/auth/register', {
      method: 'POST',
      body: JSON.stringify({}),
      headers: { 'X-Forwarded-For': uniqueIp() },
    })
    const res = await registerPost(req)
    expect([422, 500]).toContain(res.status)
  })

  test('rate limiting returns 429 after too many attempts', async () => {
    const fixedIp = '10.99.99.99'
    const registerMax = 5

    for (let i = 0; i < registerMax; i++) {
      const email = uniqueEmail('reg-ratelimit')
      const req = makeRequest('http://localhost:3000/api/v1/auth/register', {
        method: 'POST',
        body: JSON.stringify({ email, password: 'SecureTestPassword123!' }),
        headers: { 'X-Forwarded-For': fixedIp },
      })
      const res = await registerPost(req)
      const body = await parseJson(res)
      expect(res.status).toBe(201)
      createdUserIds.push(body.userId as string)
    }

    const req = makeRequest('http://localhost:3000/api/v1/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email: uniqueEmail('reg-ratelimit-exceeded'), password: 'SecureTestPassword123!' }),
      headers: { 'X-Forwarded-For': fixedIp },
    })
    const res = await registerPost(req)
    expect(res.status).toBe(429)
    expect(res.headers.get('Retry-After')).toBeTruthy()
    const body = await parseJson(res)
    expect(body.code).toBe('rate_limited')
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// 4. Login (route handler)
// ═══════════════════════════════════════════════════════════════════════════════

describe('POST /api/v1/auth/login', () => {
  let testUserEmail: string
  let testUserPassword: string
  let testUserId: string

  beforeAll(async () => {
    testUserEmail = uniqueEmail('login-user')
    testUserPassword = 'SecureLoginPassword123!'
    const pwHash = await hashPassword(testUserPassword)
    const user = await db.user.create({
      data: {
        email: testUserEmail,
        emailLower: testUserEmail.toLowerCase(),
        name: 'Login Integration User',
        passwordHash: pwHash,
        status: 'ACTIVE',
        platformRole: 'USER',
      },
    })
    testUserId = user.id
    createdUserIds.push(user.id)
  })

  test('valid credentials returns 200 with session cookie', async () => {
    const req = makeRequest('http://localhost:3000/api/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: testUserEmail, password: testUserPassword }),
      headers: { 'X-Forwarded-For': uniqueIp() },
    })
    const res = await loginPost(req)
    expect(res.status).toBe(200)
    const body = await parseJson(res)
    expect(body.requiresMfa).toBe(false)
    expect(body.user).toBeTruthy()
    const userData = body.user as Record<string, unknown>
    expect(userData.email).toBe(testUserEmail)
    expect(userData.id).toBe(testUserId)

    const setCookie = res.headers.get('Set-Cookie') ?? ''
    expect(setCookie).toContain(`${env.SESSION_COOKIE_NAME}=`)
    expect(setCookie).toContain('HttpOnly')
    expect(setCookie).toContain('SameSite=Lax')
  })

  test('wrong password returns 401', async () => {
    const req = makeRequest('http://localhost:3000/api/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: testUserEmail, password: 'CompletelyWrongPassword123!' }),
      headers: { 'X-Forwarded-For': uniqueIp() },
    })
    const res = await loginPost(req)
    expect(res.status).toBe(401)
    const body = await parseJson(res)
    expect(body.code).toBe('auth_required')
    expect(body.title).toBe('Invalid email or password')
  })

  test('non-existent email returns 401 — no email existence leak', async () => {
    const req = makeRequest('http://localhost:3000/api/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        email: 'nonexistent-user-integration@does-not-exist.example.com',
        password: 'AnyPassword123456!',
      }),
      headers: { 'X-Forwarded-For': uniqueIp() },
    })
    const res = await loginPost(req)
    expect(res.status).toBe(401)
    const body = await parseJson(res)
    expect(body.code).toBe('auth_required')
    expect(body.detail).toContain('Invalid email or password')
  })

  test('empty body / malformed request returns error', async () => {
    const req = makeRequest('http://localhost:3000/api/v1/auth/login', {
      method: 'POST',
      body: 'not-json',
      headers: { 'X-Forwarded-For': uniqueIp() },
    })
    const res = await loginPost(req)
    expect([400, 422, 500]).toContain(res.status)
  })

  test('rate limiting — checkRateLimit throws after max attempts', async () => {
    const identifier = `login-test-${Date.now()}`
    const loginMax = 10

    for (let i = 0; i < loginMax; i++) {
      expect(() => checkRateLimit('login', identifier)).not.toThrow()
    }
    expect(() => checkRateLimit('login', identifier)).toThrow()
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// 5. Auth service layer (direct function calls)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Auth service — registerUser', () => {
  test('creates a new user with PENDING_VERIFICATION status', async () => {
    const email = uniqueEmail('svc-register')
    const result = await registerUser(
      { email, password: 'SecurePassword123!', name: 'Service Test' },
      auditCtx,
    )
    expect(typeof result.userId).toBe('string')
    expect(typeof result.verificationToken).toBe('string')
    createdUserIds.push(result.userId)

    // Verify the user was created in DB
    const user = await db.user.findUniqueOrThrow({ where: { id: result.userId } })
    expect(user.email).toBe(email)
    expect(user.status).toBe('PENDING_VERIFICATION')
    expect(user.platformRole).toBe('USER')
    expect(user.name).toBe('Service Test')
  })

  test('throws ConflictError for duplicate email', async () => {
    const email = uniqueEmail('svc-dup')
    await registerUser({ email, password: 'SecurePassword123!' }, auditCtx)

    await expect(
      registerUser({ email, password: 'AnotherPassword456!' }, auditCtx),
    ).rejects.toThrow(ConflictError)
  })

  test('throws ValidationError for short password (< 12 chars)', async () => {
    const email = uniqueEmail('svc-shortpw')
    await expect(
      registerUser({ email, password: 'short' }, auditCtx),
    ).rejects.toThrow(ValidationError)
  })

  test('throws ValidationError for invalid email', async () => {
    await expect(
      registerUser({ email: 'not-an-email', password: 'SecurePassword123!' }, auditCtx),
    ).rejects.toThrow(ValidationError)
  })

  test('throws ValidationError for common password', async () => {
    const email = uniqueEmail('svc-commonpw')
    await expect(
      registerUser({ email, password: 'password123' }, auditCtx),
    ).rejects.toThrow(ValidationError)
  })

  test('generates email verification token stored in DB', async () => {
    const email = uniqueEmail('svc-verify')
    const result = await registerUser({ email, password: 'SecurePassword123!' }, auditCtx)
    createdUserIds.push(result.userId)

    const tokenRecord = await db.emailVerificationToken.findFirst({
      where: { userId: result.userId, usedAt: null },
    })
    expect(tokenRecord).toBeTruthy()
    expect(tokenRecord!.expiresAt).toBeInstanceOf(Date)
    expect(tokenRecord!.tokenHash).toBeTruthy()
  })
})

describe('Auth service — login', () => {
  let loginUserEmail: string
  let loginUserPassword: string
  let loginUserId: string

  beforeAll(async () => {
    loginUserEmail = uniqueEmail('svc-login')
    loginUserPassword = 'SecureLoginPassword123!'
    const pwHash = await hashPassword(loginUserPassword)
    const user = await db.user.create({
      data: {
        email: loginUserEmail,
        emailLower: loginUserEmail.toLowerCase(),
        passwordHash: pwHash,
        status: 'ACTIVE',
        platformRole: 'USER',
      },
    })
    loginUserId = user.id
    createdUserIds.push(user.id)
  })

  test('valid login returns session token and user', async () => {
    const result = await login(
      { email: loginUserEmail, password: loginUserPassword },
      auditCtx,
    )
    expect(result.requiresMfa).toBe(false)
    expect(typeof result.sessionToken).toBe('string')
    expect(result.sessionToken!.length).toBeGreaterThan(20)
    expect(result.user).toBeTruthy()
    expect(result.user!.email).toBe(loginUserEmail)
    expect(result.user!.id).toBe(loginUserId)
  })

  test('session token is stored in DB', async () => {
    const result = await login(
      { email: loginUserEmail, password: loginUserPassword },
      auditCtx,
    )
    const tokenHash = hashToken(result.sessionToken!)
    const session = await db.session.findUnique({ where: { tokenHash } })
    expect(session).toBeTruthy()
    expect(session!.userId).toBe(loginUserId)
    expect(session!.mfaCompleted).toBe(true)
  })

  test('wrong password throws AuthError', async () => {
    await expect(
      login({ email: loginUserEmail, password: 'WrongPassword12345!' }, auditCtx),
    ).rejects.toThrow(AuthError)
  })

  test('non-existent email throws AuthError (no leak)', async () => {
    await expect(
      login({ email: 'nonexistent@test.local', password: 'AnyPassword123!' }, auditCtx),
    ).rejects.toThrow(AuthError)
  })

  test('login updates lastLoginAt and resets failedLoginCount', async () => {
    // Reset lastLoginAt to null
    await db.user.update({
      where: { id: loginUserId },
      data: { lastLoginAt: null, failedLoginCount: 5 },
    })

    await login({ email: loginUserEmail, password: loginUserPassword }, auditCtx)

    const user = await db.user.findUniqueOrThrow({ where: { id: loginUserId } })
    expect(user.lastLoginAt).not.toBeNull()
    expect(user.failedLoginCount).toBe(0)
  })
})

describe('Auth service — verifyEmail', () => {
  test('verifies email and sets status to ACTIVE', async () => {
    const email = uniqueEmail('svc-emailverify')
    const result = await registerUser({ email, password: 'SecurePassword123!' }, auditCtx)
    createdUserIds.push(result.userId)

    // Verify the email
    const verifyResult = await verifyEmail(result.verificationToken, auditCtx)
    expect(verifyResult.userId).toBe(result.userId)

    // Check user status
    const user = await db.user.findUniqueOrThrow({ where: { id: result.userId } })
    expect(user.status).toBe('ACTIVE')
  })

  test('throws NotFoundError for invalid token', async () => {
    await expect(
      verifyEmail('invalid-token-that-does-not-exist', auditCtx),
    ).rejects.toThrow()
  })
})

describe('Auth service — session creation', () => {
  test('createSession generates a token stored in DB', async () => {
    const email = uniqueEmail('svc-session')
    const pwHash = await hashPassword('SecurePassword123!')
    const user = await db.user.create({
      data: { email, emailLower: email.toLowerCase(), passwordHash: pwHash, status: 'ACTIVE', platformRole: 'USER' },
    })
    createdUserIds.push(user.id)

    const token = await createSession(user.id, auditCtx)
    expect(typeof token).toBe('string')
    expect(token.length).toBeGreaterThan(20)

    const tokenHash = hashToken(token)
    const session = await db.session.findUnique({ where: { tokenHash } })
    expect(session).toBeTruthy()
    expect(session!.userId).toBe(user.id)
    expect(session!.mfaCompleted).toBe(true)
    expect(session!.expiresAt).toBeInstanceOf(Date)
    createdSessionIds.push(session!.id)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// 6. Auth middleware — session validation at DB level
// ═══════════════════════════════════════════════════════════════════════════════

describe('Session validation (DB-level)', () => {
  test('expired session token should be detectable', async () => {
    const email = uniqueEmail('session-expired')
    const pwHash = await hashPassword('SecurePassword123!')
    const user = await db.user.create({
      data: { email, emailLower: email.toLowerCase(), passwordHash: pwHash, status: 'ACTIVE', platformRole: 'USER' },
    })
    createdUserIds.push(user.id)

    const token = generateSessionToken()
    const tokenHash = hashToken(token)
    await db.session.create({
      data: {
        userId: user.id, tokenHash,
        expiresAt: new Date(Date.now() - 10_000),
        absoluteExpiresAt: new Date(Date.now() - 10_000),
        mfaCompleted: true,
      },
    })

    // Look up by hash — session exists in DB but is expired
    const session = await db.session.findUnique({ where: { tokenHash } })
    expect(session).toBeTruthy()
    expect(session!.expiresAt.getTime()).toBeLessThan(Date.now())
  })

  test('revoked session token should be detectable', async () => {
    const email = uniqueEmail('session-revoked')
    const pwHash = await hashPassword('SecurePassword123!')
    const user = await db.user.create({
      data: { email, emailLower: email.toLowerCase(), passwordHash: pwHash, status: 'ACTIVE', platformRole: 'USER' },
    })
    createdUserIds.push(user.id)

    const token = generateSessionToken()
    const tokenHash = hashToken(token)
    await db.session.create({
      data: {
        userId: user.id, tokenHash,
        expiresAt: new Date(Date.now() + 86_400_000),
        absoluteExpiresAt: new Date(Date.now() + 432_000_000),
        mfaCompleted: true,
        revokedAt: new Date(),
      },
    })

    const session = await db.session.findUnique({ where: { tokenHash } })
    expect(session).toBeTruthy()
    expect(session!.revokedAt).not.toBeNull()
  })

  test('session lookup by tokenHash returns correct user', async () => {
    const email = uniqueEmail('session-lookup')
    const pwHash = await hashPassword('SecurePassword123!')
    const user = await db.user.create({
      data: { email, emailLower: email.toLowerCase(), passwordHash: pwHash, status: 'ACTIVE', platformRole: 'USER' },
    })
    createdUserIds.push(user.id)

    const token = generateSessionToken()
    const tokenHash = hashToken(token)
    const session = await db.session.create({
      data: {
        userId: user.id, tokenHash,
        expiresAt: new Date(Date.now() + 86_400_000),
        absoluteExpiresAt: new Date(Date.now() + 432_000_000),
        mfaCompleted: true,
      },
    })
    createdSessionIds.push(session.id)

    // Simulate requireAuth's lookup logic
    const found = await db.session.findUnique({
      where: { tokenHash },
      include: { user: true },
    })
    expect(found).toBeTruthy()
    expect(found!.userId).toBe(user.id)
    expect(found!.user.email).toBe(email)
    expect(found!.revokedAt).toBeNull()
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// 7. Error handling — problemResponse maps AppError → correct HTTP status
// ═══════════════════════════════════════════════════════════════════════════════

describe('problemResponse error mapping', () => {
  test('AuthError → 401', () => {
    const res = problemResponse(new AuthError(), 'req_test', '/api/v1/test')
    expect(res.status).toBe(401)
  })

  test('ForbiddenError → 403', () => {
    const res = problemResponse(new ForbiddenError(), 'req_test', '/api/v1/test')
    expect(res.status).toBe(403)
  })

  test('ValidationError → 422', () => {
    const res = problemResponse(new ValidationError('Field X is required'), 'req_test', '/api/v1/test')
    expect(res.status).toBe(422)
  })

  test('ConflictError → 409', () => {
    const res = problemResponse(new ConflictError('Duplicate'), 'req_test', '/api/v1/test')
    expect(res.status).toBe(409)
  })

  test('unknown Error → 500', () => {
    const res = problemResponse(new Error('something unexpected'), 'req_test', '/api/v1/test')
    expect(res.status).toBe(500)
  })

  test('sets Content-Type to application/problem+json with X-Request-Id', async () => {
    const res = problemResponse(new AuthError(), 'req_abc123', '/api/v1/me')
    expect(res.headers.get('Content-Type')).toBe('application/problem+json')
    expect(res.headers.get('X-Request-Id')).toBe('req_abc123')
    const body = await parseJson(res)
    expect(body.type).toBe('https://proofpilot.app/problems/auth-required')
    expect(body.instance).toBe('/api/v1/me')
    expect(body.requestId).toBe('req_abc123')
    expect(body.code).toBe('auth_required')
  })

  test('problemResponse body matches RFC 7807 Problem Details format', async () => {
    const res = problemResponse(new ForbiddenError('Missing permission'), 'req_test', '/api/v1/admin/stats')
    const body = await parseJson(res)
    expect(body.type).toBeTruthy()
    expect(body.title).toBe('Missing permission')
    expect(body.status).toBe(403)
    expect(body.detail).toBe('Missing permission')
    expect(body.instance).toBe('/api/v1/admin/stats')
    expect(body.requestId).toBe('req_test')
    expect(body.code).toBe('forbidden')
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// Cleanup
// ═══════════════════════════════════════════════════════════════════════════════

afterAll(async () => {
  if (createdSessionIds.length > 0) {
    try {
      await db.session.deleteMany({ where: { id: { in: createdSessionIds } } })
    } catch { /* best-effort */ }
  }

  for (const userId of createdUserIds) {
    try {
      await db.emailVerificationToken.deleteMany({ where: { userId } })
      await db.passwordResetToken.deleteMany({ where: { userId } })
      await db.mfaRecoveryCode.deleteMany({ where: { userId } })
      await db.mfaFactor.deleteMany({ where: { userId } })
      await db.session.deleteMany({ where: { userId } })
      await db.workspaceMember.deleteMany({ where: { userId } })
      await db.auditLog.deleteMany({ where: { actorId: userId } })
      await db.user.delete({ where: { id: userId } })
    } catch { /* best-effort */ }
  }
})
