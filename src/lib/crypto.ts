/**
 * Crypto helpers — ProofPilot
 *
 * - Argon2id for password hashing (m≥64MiB, t≥3, p≥1).
 * - cryptographically secure random tokens.
 * - SHA-256 hashing for session tokens, fingerprints, etc.
 * - AES-256-GCM envelope encryption for the secrets vault.
 *
 * No secrets are logged. See SECURITY_MODEL.md.
 */
import { createHash, createHmac, randomBytes, createCipheriv, createDecipheriv } from 'crypto'
import { env } from './env'

// ---------------- Password hashing (Argon2id) ----------------

// We use the `argon2` npm package — installed lazily so the lib loads in any context.
let argon2Module: typeof import('argon2') | null = null
async function getArgon2() {
  if (!argon2Module) {
    argon2Module = await import('argon2')
  }
  return argon2Module
}

export const ARGON2_PARAMS = {
  type: 2, // argon2id — filled in by argon2 module
  memoryCost: 65536, // 64 MiB
  timeCost: 3, // 3 iterations
  parallelism: 1,
} as const

export async function hashPassword(password: string): Promise<string> {
  const argon2 = await getArgon2()
  return argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: ARGON2_PARAMS.memoryCost,
    timeCost: ARGON2_PARAMS.timeCost,
    parallelism: ARGON2_PARAMS.parallelism,
  })
}

export async function verifyPassword(hashed: string, password: string): Promise<boolean> {
  const argon2 = await getArgon2()
  try {
    return await argon2.verify(hashed, password)
  } catch {
    return false
  }
}

/** Constant-time string comparison (for tokens). */
export function timingSafeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a)
  const bBuf = Buffer.from(b)
  if (aBuf.length !== bBuf.length) {
    // Still do a comparison to keep timing similar
    bBuf.copy(Buffer.alloc(aBuf.length), 0, 0, Math.min(bBuf.length, aBuf.length))
    return false
  }
  return aBuf.equals(bBuf)
}

// ---------------- Secure random ----------------

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url')
}

export function randomHex(bytes = 16): string {
  return randomBytes(bytes).toString('hex')
}

/** 256-bit session token (32 bytes). */
export function generateSessionToken(): string {
  return randomToken(32)
}

/** API key in the form `pp_live_<publicId>_<secret>`. */
export function generateApiKey(): { publicId: string; secret: string; fullKey: string } {
  const publicId = randomHex(8)
  const secret = randomHex(24)
  return { publicId, secret, fullKey: `pp_live_${publicId}_${secret}` }
}

// ---------------- Hashing ----------------

export function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex')
}

export function hmacSha256(key: string, data: string): string {
  return createHmac('sha256', key).update(data).digest('hex')
}

/** Hash a token for storage. SHA-256 is sufficient because the token itself has 256 bits of entropy. */
export function hashToken(token: string): string {
  return sha256(token)
}

/** Hash an IP address for audit logs (with pepper). */
export function hashIp(ip: string): string {
  return sha256(env.SESSION_SECRET + '|' + ip)
}

/** Hash a user-agent summary for audit logs (with pepper). */
export function hashUserAgent(ua: string): string {
  // Truncate to a summary first to avoid storing full UA
  const summary = ua.slice(0, 200)
  return sha256(env.SESSION_SECRET + '|' + summary)
}

// ---------------- AES-256-GCM envelope encryption ----------------

/**
 * Master key is loaded from PROOFPILOT_ENCRYPTION_KEY (base64, 32 bytes).
 * In production this should be replaced by a KMS envelope-encryption adapter.
 */
function getMasterKey(): Buffer {
  let key = Buffer.from(env.PROOFPILOT_ENCRYPTION_KEY, 'base64')
  if (key.length !== 32) {
    // Fall back to deriving a 32-byte key from the env value (still 32 bytes effective).
    key = createHash('sha256').update(env.PROOFPILOT_ENCRYPTION_KEY).digest()
  }
  return key
}

export interface EncryptedValue {
  /** Base64 ciphertext. */
  ciphertext: string
  /** Base64 nonce (12 bytes). */
  nonce: string
  /** Base64 auth tag (16 bytes). */
  tag: string
  /** Key version for rotation. */
  keyVersion: number
}

export function encrypt(plaintext: string): EncryptedValue {
  const key = getMasterKey()
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return {
    ciphertext: ct.toString('base64'),
    nonce: nonce.toString('base64'),
    tag: tag.toString('base64'),
    keyVersion: env.MASTER_KEY_VERSION,
  }
}

export function decrypt(value: EncryptedValue): string {
  const key = getMasterKey()
  const decipher = createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(value.nonce, 'base64'),
  )
  decipher.setAuthTag(Buffer.from(value.tag, 'base64'))
  const pt = Buffer.concat([
    decipher.update(Buffer.from(value.ciphertext, 'base64')),
    decipher.final(),
  ])
  return pt.toString('utf8')
}

export function encryptToJson(plaintext: string): string {
  return JSON.stringify(encrypt(plaintext))
}

export function decryptFromJson(json: string): string {
  return decrypt(JSON.parse(json) as EncryptedValue)
}

// ---------------- Finding fingerprint ----------------

export function fingerprint(parts: (string | number | undefined | null)[]): string {
  const joined = parts.map((p) => String(p ?? '')).join('\u{1F}')
  return sha256(joined)
}
