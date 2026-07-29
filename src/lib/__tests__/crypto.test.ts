/**
 * Unit tests for src/lib/crypto.ts
 */
import { describe, test, expect } from 'bun:test'
import {
  timingSafeEqual,
  randomToken,
  randomHex,
  generateApiKey,
  sha256,
  hmacSha256,
  hashToken,
  encrypt,
  decrypt,
  encryptToJson,
  decryptFromJson,
  fingerprint,
  hashPassword,
  verifyPassword,
} from '../crypto'

// ─── timingSafeEqual ─────────────────────────────────────────────────────────

describe('timingSafeEqual()', () => {
  test('equal strings return true', () => {
    expect(timingSafeEqual('hello', 'hello')).toBe(true)
  })

  test('different strings return false', () => {
    expect(timingSafeEqual('hello', 'world')).toBe(false)
  })

  test('different lengths return false', () => {
    expect(timingSafeEqual('hello', 'hello!')).toBe(false)
  })

  test('empty strings return true', () => {
    expect(timingSafeEqual('', '')).toBe(true)
  })

  test('one empty, one non-empty returns false', () => {
    expect(timingSafeEqual('', 'a')).toBe(false)
  })

  test('Unicode strings compared correctly', () => {
    expect(timingSafeEqual('café', 'café')).toBe(true)
    expect(timingSafeEqual('café', 'cafe')).toBe(false)
  })
})

// ─── randomToken ────────────────────────────────────────────────────────────

describe('randomToken()', () => {
  test('returns 43-char base64url string for 32 bytes', () => {
    const token = randomToken(32)
    // 32 bytes → base64url = ceil(32 * 4/3) = 43 chars (no padding)
    expect(token).toHaveLength(43)
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  test('unique across calls', () => {
    const tokens = new Set(Array.from({ length: 50 }, () => randomToken()))
    expect(tokens.size).toBe(50)
  })

  test('custom byte count produces correct length', () => {
    const token16 = randomToken(16)
    // 16 bytes → ceil(16 * 4/3) = 22 chars
    expect(token16).toHaveLength(22)
  })
})

// ─── randomHex ────────────────────────────────────────────────────────────────

describe('randomHex()', () => {
  test('returns hex string', () => {
    const hex = randomHex()
    expect(hex).toMatch(/^[0-9a-f]+$/)
  })

  test('correct length for default 16 bytes (32 hex chars)', () => {
    const hex = randomHex(16)
    expect(hex).toHaveLength(32)
  })

  test('correct length for 8 bytes (16 hex chars)', () => {
    const hex = randomHex(8)
    expect(hex).toHaveLength(16)
  })

  test('unique across calls', () => {
    const hexes = new Set(Array.from({ length: 50 }, () => randomHex()))
    expect(hexes.size).toBe(50)
  })
})

// ─── generateApiKey ─────────────────────────────────────────────────────────

describe('generateApiKey()', () => {
  test('returns format pp_live_{8hex}_{24hex}', () => {
    const { publicId, secret, fullKey } = generateApiKey()
    expect(fullKey).toMatch(/^pp_live_[0-9a-f]{16}_[0-9a-f]{48}$/)
  })

  test('publicId is 16 chars', () => {
    const { publicId } = generateApiKey()
    expect(publicId).toHaveLength(16)
    expect(publicId).toMatch(/^[0-9a-f]+$/)
  })

  test('secret is 48 chars', () => {
    const { secret } = generateApiKey()
    expect(secret).toHaveLength(48)
    expect(secret).toMatch(/^[0-9a-f]+$/)
  })

  test('unique across calls', () => {
    const keys = new Set(Array.from({ length: 20 }, () => generateApiKey().fullKey))
    expect(keys.size).toBe(20)
  })
})

// ─── sha256 ─────────────────────────────────────────────────────────────────

describe('sha256()', () => {
  test('deterministic output', () => {
    const a = sha256('hello')
    const b = sha256('hello')
    expect(a).toBe(b)
  })

  test('known test vector (empty string)', () => {
    const result = sha256('')
    expect(result).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  })

  test('known test vector ("hello")', () => {
    const result = sha256('hello')
    expect(result).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824')
  })

  test('different inputs produce different hashes', () => {
    expect(sha256('a')).not.toBe(sha256('b'))
  })
})

// ─── hmacSha256 ──────────────────────────────────────────────────────────────

describe('hmacSha256()', () => {
  test('deterministic output', () => {
    const a = hmacSha256('key', 'message')
    const b = hmacSha256('key', 'message')
    expect(a).toBe(b)
  })

  test('different key produces different result', () => {
    const a = hmacSha256('key1', 'message')
    const b = hmacSha256('key2', 'message')
    expect(a).not.toBe(b)
  })

  test('different data produces different result', () => {
    const a = hmacSha256('key', 'message1')
    const b = hmacSha256('key', 'message2')
    expect(a).not.toBe(b)
  })

  test('returns 64-char hex string', () => {
    const result = hmacSha256('key', 'data')
    expect(result).toHaveLength(64)
    expect(result).toMatch(/^[0-9a-f]+$/)
  })
})

// ─── hashToken ────────────────────────────────────────────────────────────────

describe('hashToken()', () => {
  test('same as sha256 (deterministic)', () => {
    const token = 'my-session-token-abc123'
    expect(hashToken(token)).toBe(sha256(token))
  })

  test('different tokens produce different hashes', () => {
    expect(hashToken('token-a')).not.toBe(hashToken('token-b'))
  })
})

// ─── encrypt / decrypt ──────────────────────────────────────────────────────

describe('encrypt() / decrypt()', () => {
  test('round-trip works', () => {
    const plaintext = 'Hello, ProofPilot!'
    const encrypted = encrypt(plaintext)
    const decrypted = decrypt(encrypted)
    expect(decrypted).toBe(plaintext)
  })

  test('different nonce each time', () => {
    const a = encrypt('test')
    const b = encrypt('test')
    expect(a.nonce).not.toBe(b.nonce)
    // Ciphertexts should differ due to different nonces
    expect(a.ciphertext).not.toBe(b.ciphertext)
  })

  test('encrypted value has expected fields', () => {
    const encrypted = encrypt('data')
    expect(encrypted.ciphertext).toBeTruthy()
    expect(encrypted.nonce).toBeTruthy()
    expect(encrypted.tag).toBeTruthy()
    expect(typeof encrypted.keyVersion).toBe('number')
  })

  test('can encrypt long strings', () => {
    const plaintext = 'a'.repeat(10000)
    expect(decrypt(encrypt(plaintext))).toBe(plaintext)
  })

  test('can encrypt empty string', () => {
    expect(decrypt(encrypt(''))).toBe('')
  })

  test('can encrypt unicode', () => {
    const plaintext = 'Hello 世界 🌍 café'
    expect(decrypt(encrypt(plaintext))).toBe(plaintext)
  })
})

// ─── encryptToJson / decryptFromJson ────────────────────────────────────────

describe('encryptToJson() / decryptFromJson()', () => {
  test('round-trip works', () => {
    const plaintext = 'secret-data'
    const json = encryptToJson(plaintext)
    expect(typeof json).toBe('string')
    const decrypted = decryptFromJson(json)
    expect(decrypted).toBe(plaintext)
  })

  test('JSON is valid and parseable', () => {
    const json = encryptToJson('test')
    const parsed = JSON.parse(json)
    expect(parsed).toHaveProperty('ciphertext')
    expect(parsed).toHaveProperty('nonce')
    expect(parsed).toHaveProperty('tag')
    expect(parsed).toHaveProperty('keyVersion')
  })
})

// ─── fingerprint ────────────────────────────────────────────────────────────

describe('fingerprint()', () => {
  test('deterministic for same inputs', () => {
    const a = fingerprint(['page1', 'css', 'missing-alt'])
    const b = fingerprint(['page1', 'css', 'missing-alt'])
    expect(a).toBe(b)
  })

  test('different inputs produce different fingerprints', () => {
    const a = fingerprint(['page1', 'css', 'missing-alt'])
    const b = fingerprint(['page2', 'css', 'missing-alt'])
    expect(a).not.toBe(b)
  })

  test('null treated as empty string', () => {
    const a = fingerprint(['a', null, 'c'])
    const b = fingerprint(['a', '', 'c'])
    expect(a).toBe(b)
  })

  test('undefined treated as empty string', () => {
    const a = fingerprint(['a', undefined, 'c'])
    const b = fingerprint(['a', '', 'c'])
    expect(a).toBe(b)
  })

  test('numbers are stringified', () => {
    const a = fingerprint(['a', 42, 'c'])
    const b = fingerprint(['a', '42', 'c'])
    expect(a).toBe(b)
  })

  test('empty array produces consistent hash', () => {
    const a = fingerprint([])
    const b = fingerprint([])
    expect(a).toBe(b)
  })

  test('returns 64-char hex string', () => {
    const result = fingerprint(['test'])
    expect(result).toHaveLength(64)
    expect(result).toMatch(/^[0-9a-f]+$/)
  })
})

// ─── hashPassword / verifyPassword ───────────────────────────────────────────

describe('hashPassword() / verifyPassword()', () => {
  test('correct password verifies', async () => {
    const hash = await hashPassword('my-secure-password')
    expect(await verifyPassword(hash, 'my-secure-password')).toBe(true)
  })

  test('wrong password fails', async () => {
    const hash = await hashPassword('my-secure-password')
    expect(await verifyPassword(hash, 'wrong-password')).toBe(false)
  })

  test('empty password works', async () => {
    const hash = await hashPassword('')
    expect(await verifyPassword(hash, '')).toBe(true)
    expect(await verifyPassword(hash, 'not-empty')).toBe(false)
  })

  test('hash includes $argon2id$', async () => {
    const hash = await hashPassword('test')
    expect(hash).toContain('$argon2id$')
  })
})
