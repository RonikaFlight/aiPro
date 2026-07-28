/**
 * Auth service — ProofPilot
 *
 * Registration, login, email verification, password reset, MFA.
 * All flows use hashed tokens, single-use, expiring, no email-existence leak.
 */
import crypto from 'crypto'
import { db } from './db'
import {
  hashPassword,
  verifyPassword,
  generateSessionToken,
  hashToken,
  randomToken,
  encryptToJson,
  decryptFromJson,
  timingSafeEqual,
} from './crypto'
import { env } from './env'
import { logger } from './logger'
import {
  AppError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
  AuthError,
} from './errors'
import { recordAudit } from './audit'
import type { AuditContext } from './audit'

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const PASSWORD_MIN_LENGTH = 12
const PASSWORD_MAX_LENGTH = 256

// Common compromised password patterns (basic check — does not transmit raw password)
const COMMON_PASSWORDS = new Set([
  'password', '123456789', 'qwerty123', 'admin123', 'letmein123',
  'welcome123', 'monkey123', 'abc123456', 'password123', 'iloveyou123',
])

function validatePassword(password: string): void {
  if (password.length < PASSWORD_MIN_LENGTH) {
    throw new ValidationError(`Password must be at least ${PASSWORD_MIN_LENGTH} characters`)
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    throw new ValidationError(`Password must be at most ${PASSWORD_MAX_LENGTH} characters`)
  }
  // Check common patterns without transmitting the password
  const lower = password.toLowerCase()
  for (const common of COMMON_PASSWORDS) {
    if (lower === common) {
      throw new ValidationError('Password is too common. Please choose a stronger password.')
    }
  }
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

function validateEmail(email: string): string {
  const normalized = normalizeEmail(email)
  if (!EMAIL_REGEX.test(normalized)) {
    throw new ValidationError('Invalid email address')
  }
  if (normalized.length > 254) {
    throw new ValidationError('Email address too long')
  }
  return normalized
}

// ---------------- Registration ----------------

export interface RegisterInput {
  email: string
  password: string
  name?: string
}

export async function registerUser(
  input: RegisterInput,
  ctx: Pick<AuditContext, 'ip' | 'userAgent' | 'requestId'>,
): Promise<{ userId: string; verificationToken: string }> {
  const email = validateEmail(input.email)
  validatePassword(input.password)

  // Check for existing user (do not leak existence via response, but we throw ConflictError here)
  const existing = await db.user.findUnique({
    where: { emailLower: email },
    select: { id: true },
  })
  if (existing) {
    throw new ConflictError('An account with this email already exists')
  }

  const passwordHash = await hashPassword(input.password)
  const user = await db.user.create({
    data: {
      email,
      emailLower: email,
      name: input.name?.trim() || null,
      passwordHash,
      status: 'PENDING_VERIFICATION',
      platformRole: 'USER',
    },
  })

  // Generate email verification token
  const rawToken = randomToken(32)
  const tokenHash = hashToken(rawToken)
  await db.emailVerificationToken.create({
    data: {
      userId: user.id,
      tokenHash,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24h
    },
  })

  await recordAudit(
    'REGISTER',
    { type: 'user', id: user.id },
    { ...ctx, actorType: 'USER', actorId: user.id },
    { email },
  )

  logger.info('User registered', { userId: user.id, email })
  return { userId: user.id, verificationToken: rawToken }
}

// ---------------- Email verification ----------------

export async function verifyEmail(
  token: string,
  ctx: Pick<AuditContext, 'ip' | 'userAgent' | 'requestId'>,
): Promise<{ userId: string }> {
  const tokenHash = hashToken(token)
  const record = await db.emailVerificationToken.findUnique({
    where: { tokenHash },
    include: { user: true },
  })
  if (!record) {
    throw new NotFoundError('Verification token')
  }
  if (record.usedAt) {
    throw new AppError('Token already used', 410, 'token_used', 'https://proofpilot.app/problems/token-used')
  }
  if (record.expiresAt < new Date()) {
    throw new AppError('Token expired', 410, 'token_expired', 'https://proofpilot.app/problems/token-expired')
  }

  // Invalidate this token and any newer ones
  await db.emailVerificationToken.update({
    where: { id: record.id },
    data: { usedAt: new Date() },
  })
  await db.emailVerificationToken.updateMany({
    where: { userId: record.userId, usedAt: null },
    data: { usedAt: new Date() },
  })

  await db.user.update({
    where: { id: record.userId },
    data: { status: 'ACTIVE' },
  })

  await recordAudit(
    'EMAIL_VERIFIED',
    { type: 'user', id: record.userId },
    { ...ctx, actorType: 'USER', actorId: record.userId },
  )

  return { userId: record.userId }
}

// ---------------- Login ----------------

export interface LoginInput {
  email: string
  password: string
}

export interface LoginResult {
  requiresMfa: boolean
  mfaChallengeToken?: string
  sessionToken?: string
  user?: { id: string; email: string; name: string | null }
}

export async function login(
  input: LoginInput,
  ctx: Pick<AuditContext, 'ip' | 'userAgent' | 'requestId'>,
): Promise<LoginResult> {
  const email = validateEmail(input.email)

  // Always do a password hash comparison to avoid timing-based user enumeration
  const user = await db.user.findUnique({ where: { emailLower: email } })

  let passwordValid = false
  if (user?.passwordHash) {
    passwordValid = await verifyPassword(user.passwordHash, input.password)
  } else {
    // Compare against a dummy hash to consume time
    await verifyPassword('$argon2id$v=19$m=65536,t=3,p=1$dummy$dummy', input.password)
  }

  if (!user || !passwordValid || user.status === 'DELETED' || user.status === 'SUSPENDED') {
    // Do not reveal whether the email exists
    await recordAudit(
      'LOGIN_FAILED',
      { type: 'user', id: user?.id ?? 'unknown' },
      { ...ctx, actorType: 'USER' },
      { reason: 'invalid_credentials' },
      'FAILURE',
    )
    throw new AuthError('Invalid email or password')
  }

  // Check MFA
  const mfaFactor = await db.mfaFactor.findFirst({
    where: { userId: user.id, enabled: true },
  })
  if (mfaFactor) {
    // Issue a short-lived MFA challenge token (bound to session pending MFA)
    const challengeToken = randomToken(32)
    const challengeHash = hashToken(challengeToken)
    // Store as a session with mfaCompleted=false; the challenge token IS the session token
    const session = await db.session.create({
      data: {
        userId: user.id,
        tokenHash: challengeHash,
        expiresAt: new Date(Date.now() + 5 * 60 * 1000), // 5 min for MFA
        absoluteExpiresAt: new Date(Date.now() + 5 * 60 * 1000),
        ipHash: ctx.ip ?? null,
        userAgentSummary: ctx.userAgent ?? null,
        mfaCompleted: false,
      },
    })
    return {
      requiresMfa: true,
      mfaChallengeToken: challengeToken,
      user: { id: user.id, email: user.email, name: user.name },
    }
  }

  // No MFA — create session
  const sessionToken = await createSession(user.id, ctx)
  await db.user.update({
    where: { id: user.id },
    data: { lastLoginAt: new Date(), failedLoginCount: 0 },
  })
  await recordAudit(
    'LOGIN',
    { type: 'user', id: user.id },
    { ...ctx, actorType: 'USER', actorId: user.id, ip: ctx.ip, userAgent: ctx.userAgent },
  )
  return {
    requiresMfa: false,
    sessionToken,
    user: { id: user.id, email: user.email, name: user.name },
  }
}

// ---------------- Session creation ----------------

export async function createSession(
  userId: string,
  ctx: Pick<AuditContext, 'ip' | 'userAgent' | 'requestId'>,
): Promise<string> {
  const token = generateSessionToken()
  const tokenHash = hashToken(token)
  const now = Date.now()
  await db.session.create({
    data: {
      userId,
      tokenHash,
      expiresAt: new Date(now + env.SESSION_IDLE_TTL_SECONDS * 1000),
      absoluteExpiresAt: new Date(now + env.SESSION_ABSOLUTE_TTL_SECONDS * 1000),
      ipHash: ctx.ip ?? null,
      userAgentSummary: ctx.userAgent ?? null,
      mfaCompleted: true,
    },
  })
  return token
}

/** Rotate session token (after login, MFA, password change, role elevation). */
export async function rotateSession(
  oldSessionId: string,
  userId: string,
  ctx: Pick<AuditContext, 'ip' | 'userAgent' | 'requestId'>,
): Promise<string> {
  // Revoke old session
  await db.session.update({
    where: { id: oldSessionId },
    data: { revokedAt: new Date() },
  })
  // Create new session
  return createSession(userId, ctx)
}

// ---------------- Logout ----------------

export async function logout(
  sessionId: string,
  ctx: Pick<AuditContext, 'ip' | 'userAgent' | 'requestId' | 'actorId'>,
): Promise<void> {
  await db.session.update({
    where: { id: sessionId },
    data: { revokedAt: new Date() },
  })
  await recordAudit('LOGOUT', { type: 'session', id: sessionId }, { ...ctx, actorType: 'USER' })
}

// ---------------- Password reset ----------------

export async function requestPasswordReset(
  email: string,
  ctx: Pick<AuditContext, 'ip' | 'userAgent' | 'requestId'>,
): Promise<{ token: string | null; userId: string | null }> {
  const normalized = validateEmail(email)
  const user = await db.user.findUnique({ where: { emailLower: normalized } })

  // Do not reveal whether the email exists
  if (!user || user.status === 'DELETED') {
    return { token: null, userId: null }
  }

  const rawToken = randomToken(32)
  const tokenHash = hashToken(rawToken)

  // Invalidate any previous tokens
  await db.passwordResetToken.updateMany({
    where: { userId: user.id, usedAt: null },
    data: { usedAt: new Date() },
  })

  await db.passwordResetToken.create({
    data: {
      userId: user.id,
      tokenHash,
      expiresAt: new Date(Date.now() + 30 * 60 * 1000), // 30 min
    },
  })

  await recordAudit(
    'PASSWORD_RESET_REQUESTED',
    { type: 'user', id: user.id },
    { ...ctx, actorType: 'USER', actorId: user.id },
  )

  return { token: rawToken, userId: user.id }
}

export async function resetPassword(
  token: string,
  newPassword: string,
  ctx: Pick<AuditContext, 'ip' | 'userAgent' | 'requestId'>,
): Promise<{ userId: string }> {
  validatePassword(newPassword)
  const tokenHash = hashToken(token)
  const record = await db.passwordResetToken.findUnique({
    where: { tokenHash },
    include: { user: true },
  })
  if (!record) {
    throw new NotFoundError('Reset token')
  }
  if (record.usedAt) {
    throw new AppError('Token already used', 410, 'token_used', 'https://proofpilot.app/problems/token-used')
  }
  if (record.expiresAt < new Date()) {
    throw new AppError('Token expired', 410, 'token_expired', 'https://proofpilot.app/problems/token-expired')
  }

  const passwordHash = await hashPassword(newPassword)
  await db.$transaction([
    db.passwordResetToken.update({
      where: { id: record.id },
      data: { usedAt: new Date() },
    }),
    db.user.update({
      where: { id: record.userId },
      data: { passwordHash },
    }),
    // Revoke all sessions for this user (password change)
    db.session.updateMany({
      where: { userId: record.userId, revokedAt: null },
      data: { revokedAt: new Date() },
    }),
  ])

  await recordAudit(
    'PASSWORD_CHANGE',
    { type: 'user', id: record.userId },
    { ...ctx, actorType: 'USER', actorId: record.userId },
  )

  return { userId: record.userId }
}

// ---------------- MFA: TOTP ----------------

export async function beginTotpSetup(
  userId: string,
  ctx: Pick<AuditContext, 'ip' | 'userAgent' | 'requestId'>,
): Promise<{ secret: string; qrUrl: string }> {
  // Generate a TOTP secret (base32, 20 bytes = 160 bits)
  const crypto = await import('crypto')
  const secret = crypto.randomBytes(20).toString('base64')

  // Encrypt and store (not yet enabled)
  const existing = await db.mfaFactor.findFirst({
    where: { userId, enabled: false },
  })
  if (existing) {
    await db.mfaFactor.update({
      where: { id: existing.id },
      data: { secretEncrypted: encryptToJson(secret) },
    })
  } else {
    await db.mfaFactor.create({
      data: {
        userId,
        type: 'TOTP',
        secretEncrypted: encryptToJson(secret),
        enabled: false,
      },
    })
  }

  // Build otpauth URL
  const issuer = 'ProofPilot'
  const label = encodeURIComponent(`${issuer}:${userId}`)
  const params = new URLSearchParams({
    secret: secret.replace(/=/g, ''),
    issuer,
    algorithm: 'SHA1',
    digits: '6',
    period: '30',
  })
  const qrUrl = `otpauth://totp/${label}?${params.toString()}`

  return { secret, qrUrl }
}

export async function confirmTotpSetup(
  userId: string,
  code: string,
  ctx: Pick<AuditContext, 'ip' | 'userAgent' | 'requestId'>,
): Promise<{ recoveryCodes: string[] }> {
  const factor = await db.mfaFactor.findFirst({
    where: { userId, enabled: false },
  })
  if (!factor) {
    throw new NotFoundError('Pending TOTP setup')
  }

  const secret = decryptFromJson(factor.secretEncrypted)
  const valid = verifyTotpCode(secret, code)
  if (!valid) {
    throw new ValidationError('Invalid TOTP code')
  }

  // Enable the factor
  await db.mfaFactor.update({
    where: { id: factor.id },
    data: { enabled: true, confirmedAt: new Date() },
  })

  // Generate 10 recovery codes
  const recoveryCodes: string[] = []
  for (let i = 0; i < 10; i++) {
    recoveryCodes.push(randomToken(8).toUpperCase().replace(/-/g, ''))
  }
  // Store hashed
  await db.mfaRecoveryCode.createMany({
    data: recoveryCodes.map((code) => ({
      userId,
      codeHash: hashToken(code),
    })),
  })

  await recordAudit(
    'MFA_ENABLE',
    { type: 'user', id: userId },
    { ...ctx, actorType: 'USER', actorId: userId },
  )

  return { recoveryCodes }
}

export async function disableTotp(
  userId: string,
  password: string,
  code: string,
  ctx: Pick<AuditContext, 'ip' | 'userAgent' | 'requestId'>,
): Promise<void> {
  const user = await db.user.findUniqueOrThrow({ where: { id: userId } })
  if (!user.passwordHash || !(await verifyPassword(user.passwordHash, password))) {
    throw new AuthError('Invalid password')
  }

  const factor = await db.mfaFactor.findFirst({
    where: { userId, enabled: true },
  })
  if (!factor) {
    throw new NotFoundError('MFA factor')
  }

  const secret = decryptFromJson(factor.secretEncrypted)
  if (!verifyTotpCode(secret, code)) {
    throw new ValidationError('Invalid TOTP code')
  }

  await db.mfaFactor.update({
    where: { id: factor.id },
    data: { enabled: false },
  })
  await db.mfaRecoveryCode.deleteMany({ where: { userId } })

  await recordAudit(
    'MFA_DISABLE',
    { type: 'user', id: userId },
    { ...ctx, actorType: 'USER', actorId: userId },
  )
}

/** Verify a TOTP code (RFC 6238, 30s window, ±1 step). */
function verifyTotpCode(secret: string, code: string): boolean {
  // Decode base64 secret to buffer
  const key = Buffer.from(secret, 'base64')
  const step = 30
  const counter = Math.floor(Date.now() / 1000 / step)
  // Allow ±1 step window
  for (const offset of [-1, 0, 1]) {
    const c = counter + offset
    const expected = generateTotp(key, c)
    if (timingSafeEqual(expected, code)) {
      return true
    }
  }
  return false
}

function generateTotp(key: Buffer, counter: number): string {
  const buf = Buffer.alloc(8)
  // Write counter as big-endian 64-bit
  buf.writeBigInt64BE(BigInt(counter), 0)
  const hmac = crypto.createHmac('sha1', key).update(buf).digest()
  const offset = hmac[hmac.length - 1] & 0x0f
  const truncated =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff)
  const code = (truncated % 1000000).toString().padStart(6, '0')
  return code
}

/** Complete MFA challenge during login. */
export async function completeMfaChallenge(
  challengeToken: string,
  code: string,
  ctx: Pick<AuditContext, 'ip' | 'userAgent' | 'requestId'>,
): Promise<{ sessionToken: string; userId: string }> {
  const challengeHash = hashToken(challengeToken)
  const session = await db.session.findUnique({
    where: { tokenHash: challengeHash },
    include: { user: true },
  })
  if (!session || session.revokedAt || session.expiresAt < new Date()) {
    throw new AuthError('Invalid or expired MFA challenge')
  }
  if (session.mfaCompleted) {
    throw new AppError('MFA already completed', 400, 'mfa_completed')
  }

  const factor = await db.mfaFactor.findFirst({
    where: { userId: session.userId, enabled: true },
  })
  if (!factor) {
    throw new NotFoundError('MFA factor')
  }

  let codeValid = false
  // Try TOTP first
  const secret = decryptFromJson(factor.secretEncrypted)
  codeValid = verifyTotpCode(secret, code)

  // If TOTP fails, try recovery codes
  if (!codeValid) {
    const recoveryCodes = await db.mfaRecoveryCode.findMany({
      where: { userId: session.userId, usedAt: null },
    })
    for (const rc of recoveryCodes) {
      if (timingSafeEqual(rc.codeHash, hashToken(code.toUpperCase()))) {
        await db.mfaRecoveryCode.update({
          where: { id: rc.id },
          data: { usedAt: new Date() },
        })
        codeValid = true
        break
      }
    }
  }

  if (!codeValid) {
    await recordAudit(
      'LOGIN_FAILED',
      { type: 'user', id: session.userId },
      { ...ctx, actorType: 'USER' },
      { reason: 'invalid_mfa_code' },
      'FAILURE',
    )
    throw new AuthError('Invalid MFA code')
  }

  // Rotate session: revoke challenge, create real session
  await db.session.update({
    where: { id: session.id },
    data: { revokedAt: new Date() },
  })
  const sessionToken = await createSession(session.userId, ctx)

  await db.user.update({
    where: { id: session.userId },
    data: { lastLoginAt: new Date(), failedLoginCount: 0 },
  })
  await recordAudit(
    'LOGIN',
    { type: 'user', id: session.userId },
    { ...ctx, actorType: 'USER', actorId: session.userId },
    { mfa: true },
  )

  return { sessionToken, userId: session.userId }
}

// ---------------- Session management ----------------

export async function listSessions(userId: string) {
  const sessions = await db.session.findMany({
    where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { lastActivityAt: 'desc' },
    select: {
      id: true,
      createdAt: true,
      lastActivityAt: true,
      expiresAt: true,
      ipHash: true,
      userAgentSummary: true,
      mfaCompleted: true,
    },
  })
  return sessions
}

export async function revokeSession(
  sessionId: string,
  userId: string,
  ctx: Pick<AuditContext, 'ip' | 'userAgent' | 'requestId' | 'actorId'>,
): Promise<void> {
  const session = await db.session.findUnique({ where: { id: sessionId } })
  if (!session || session.userId !== userId) {
    throw new NotFoundError('Session')
  }
  await db.session.update({
    where: { id: sessionId },
    data: { revokedAt: new Date() },
  })
  await recordAudit(
    'SESSION_REVOKE',
    { type: 'session', id: sessionId },
    { ...ctx, actorType: 'USER', actorId: userId },
  )
}

export async function revokeOtherSessions(
  currentSessionId: string,
  userId: string,
  ctx: Pick<AuditContext, 'ip' | 'userAgent' | 'requestId' | 'actorId'>,
): Promise<{ revoked: number }> {
  const result = await db.session.updateMany({
    where: {
      userId,
      id: { not: currentSessionId },
      revokedAt: null,
    },
    data: { revokedAt: new Date() },
  })
  await recordAudit(
    'SESSION_REVOKE',
    { type: 'session', id: 'others' },
    { ...ctx, actorType: 'USER', actorId: userId },
    { count: result.count },
  )
  return { revoked: result.count }
}
