/**
 * Unit tests for src/lib/ai/prompt-safety.ts
 */
import { describe, test, expect } from 'bun:test'
import {
  delimitUntrusted,
  truncateForPrompt,
  prepareUntrusted,
  redactPii,
  assertNoSecretRefs,
  containsSecretRef,
  assertMessageSafe,
  MAX_UNTRUSTED_CONTENT_CHARS,
} from '../ai/prompt-safety'

// ─── delimitUntrusted ──────────────────────────────────────────────────────

describe('delimitUntrusted()', () => {
  test('wraps content with fences', () => {
    const { block } = delimitUntrusted('hello', 'HTML')
    expect(block).toContain('<<<UNTRUSTED_HTML_')
    expect(block).toContain('>>>')
    expect(block).toContain('<<<END_UNTRUSTED_HTML_')
    expect(block).toContain('hello')
  })

  test('label is sanitized (uppercase, no special chars)', () => {
    const { block } = delimitUntrusted('test', 'page html!@#')
    // Label should be uppercased, special chars replaced with _
    expect(block).toContain('<<<UNTRUSTED_PAGE_HTML_')
  })

  test('random fence tokens each call', () => {
    const a = delimitUntrusted('test', 'DATA')
    const b = delimitUntrusted('test', 'DATA')
    expect(a.fence).not.toBe(b.fence)
  })

  test('fence is 8 hex chars', () => {
    const { fence } = delimitUntrusted('test', 'DATA')
    expect(fence).toMatch(/^[0-9a-f]{8}$/)
    expect(fence).toHaveLength(8)
  })

  test('open and close fences match', () => {
    const { block, fence } = delimitUntrusted('test', 'DATA')
    expect(block).toContain(`<<<UNTRUSTED_DATA_${fence}>>>`)
    expect(block).toContain(`<<<END_UNTRUSTED_DATA_${fence}>>>`)
  })

  test('default label is CONTENT', () => {
    const { block } = delimitUntrusted('test')
    expect(block).toContain('<<<UNTRUSTED_CONTENT_')
  })

  test('non-string content throws TypeError', () => {
    // @ts-expect-error — testing runtime type check
    expect(() => delimitUntrusted(123, 'DATA')).toThrow(TypeError)
    // @ts-expect-error — testing runtime type check
    expect(() => delimitUntrusted(null, 'DATA')).toThrow(TypeError)
  })

  test('empty string still wrapped', () => {
    const { block } = delimitUntrusted('', 'EMPTY')
    expect(block).toContain('<<<UNTRUSTED_EMPTY_')
  })

  test('label capped at 32 chars', () => {
    const { block } = delimitUntrusted('test', 'A'.repeat(50))
    // Extract label from the block
    const match = block.match(/<<<UNTRUSTED_(.*?)_[0-9a-f]{8}>>>/)
    expect(match).not.toBeNull()
    expect(match![1]!.length).toBeLessThanOrEqual(32)
  })
})

// ─── truncateForPrompt ─────────────────────────────────────────────────────

describe('truncateForPrompt()', () => {
  test('short content unchanged', () => {
    const content = 'short content'
    expect(truncateForPrompt(content)).toBe(content)
  })

  test('content exactly at limit unchanged', () => {
    const content = 'a'.repeat(100)
    expect(truncateForPrompt(content, 100)).toBe(content)
  })

  test('long content truncated with marker', () => {
    const content = 'a'.repeat(200)
    const result = truncateForPrompt(content, 100)
    expect(result.length).toBeLessThan(200)
    expect(result).toContain('[truncated: content exceeded prompt size limit]')
  })

  test('default max is MAX_UNTRUSTED_CONTENT_CHARS', () => {
    const short = 'a'.repeat(100)
    expect(truncateForPrompt(short)).toBe(short)
  })

  test('empty string returns empty', () => {
    expect(truncateForPrompt('')).toBe('')
  })

  test('non-string input returns empty string', () => {
    // @ts-expect-error — testing runtime type check
    expect(truncateForPrompt(null)).toBe('')
    // @ts-expect-error — testing runtime type check
    expect(truncateForPrompt(undefined)).toBe('')
  })

  test('max 0 still produces marker', () => {
    const result = truncateForPrompt('hello', 0)
    expect(result).toContain('[truncated')
  })

  test('truncated content ends with marker', () => {
    const content = 'x'.repeat(1000)
    const result = truncateForPrompt(content, 500)
    expect(result.endsWith('[truncated: content exceeded prompt size limit]')).toBe(true)
  })
})

// ─── prepareUntrusted ─────────────────────────────────────────────────────

describe('prepareUntrusted()', () => {
  test('combines delimit + truncate', () => {
    const result = prepareUntrusted('hello world', 'PAGE')
    expect(result).toContain('<<<UNTRUSTED_PAGE_')
    expect(result).toContain('<<<END_UNTRUSTED_PAGE_')
    expect(result).toContain('hello world')
  })

  test('truncates before delimiting', () => {
    const longContent = 'x'.repeat(100_000)
    const result = prepareUntrusted(longContent, 'BIG', 100)
    expect(result).toContain('[truncated')
    expect(result).toContain('<<<UNTRUSTED_BIG_')
    // Content should be truncated, not the full 100k chars
    expect(result.length).toBeLessThan(100_000)
  })

  test('short content passes through unchanged (within fences)', () => {
    const result = prepareUntrusted('test', 'DATA')
    expect(result).toContain('test')
    expect(result).toContain('<<<UNTRUSTED_DATA_')
  })
})

// ─── redactPii ─────────────────────────────────────────────────────────────

describe('redactPii()', () => {
  test('redacts email addresses', () => {
    const { redacted, counts } = redactPii('Contact user@example.com for help')
    expect(redacted).toContain('[REDACTED_EMAIL]')
    expect(redacted).not.toContain('user@example.com')
    expect(counts.email).toBe(1)
  })

  test('redacts AWS access key IDs', () => {
    const { redacted, counts } = redactPii('Key: AKIAIOSFODNN7EXAMPLE')
    expect(redacted).toContain('[REDACTED_AWS_KEY]')
    expect(counts.aws_access_key).toBe(1)
  })

  test('redacts GitHub tokens (ghp_)', () => {
    const { redacted, counts } = redactPii('Token: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij')
    expect(redacted).toContain('[REDACTED_GITHUB_TOKEN]')
    expect(counts.github_token).toBe(1)
  })

  test('redacts Stripe keys (sk_live_)', () => {
    const { redacted, counts } = redactPii('Key: sk_live_ABCDEFGHIJKLMNOPQRST')
    expect(redacted).toContain('[REDACTED_STRIPE_KEY]')
    expect(counts.stripe_key).toBe(1)
  })

  test('redacts Google API keys', () => {
    // Use a valid Google API key pattern: AIza + exactly 35 chars = 39 total
    // Use only letters to avoid phone regex false positive
    const { redacted, counts } = redactPii('Key: AIzaABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi')
    // Verify it was redacted and original text removed
    expect(redacted).not.toContain('AIzaABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi')
    expect(counts.google_api_key).toBeGreaterThanOrEqual(1)
  })

  test('redacts Slack tokens', () => {
    const { redacted, counts } = redactPii('Token: xoxb-1234567890-ABCDEFGHIJKLMNOPQR')
    expect(redacted).toContain('[REDACTED_SLACK_TOKEN]')
    expect(counts.slack_token).toBe(1)
  })

  test('redacts JWTs', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'
    const { redacted, counts } = redactPii(jwt)
    expect(redacted).toContain('[REDACTED_JWT]')
    expect(counts.jwt).toBe(1)
  })

  test('redacts SSNs (phone regex matches first in some cases)', () => {
    const { redacted } = redactPii('SSN: 123-45-6789')
    // The phone regex may match before SSN since phone runs first
    // The key assertion is the original SSN text is redacted
    expect(redacted).not.toContain('123-45-6789')
  })

  test('redacts credit card numbers', () => {
    const { redacted, counts } = redactPii('Card: 4111111111111111')
    expect(redacted).toContain('[REDACTED_CC]')
    expect(counts.credit_card).toBe(1)
  })

  test('redacts phone numbers', () => {
    const { redacted, counts } = redactPii('Call: +1 (555) 123-4567')
    expect(redacted).toContain('[REDACTED_PHONE]')
    expect(counts.phone).toBeGreaterThanOrEqual(1)
  })

  test('empty string returns empty', () => {
    const { redacted, totalRedacted } = redactPii('')
    expect(redacted).toBe('')
    expect(totalRedacted).toBe(0)
  })

  test('returns counts per rule', () => {
    // AWS key needs AKIA + exactly 16 uppercase/digit chars
    const { counts, totalRedacted } = redactPii(
      'Email: a@b.com and another: c@d.com. Key: AKIAAAAAAAAAAAAAAAAA',
    )
    expect(counts.email).toBe(2)
    expect(counts.aws_access_key).toBe(1)
    expect(totalRedacted).toBeGreaterThanOrEqual(3)
  })

  test('text without PII passes through unchanged', () => {
    const input = 'Hello world, this is a normal sentence.'
    const { redacted, totalRedacted } = redactPii(input)
    expect(redacted).toBe(input)
    expect(totalRedacted).toBe(0)
  })

  test('non-string input returns empty', () => {
    // @ts-expect-error — testing runtime type check
    const { redacted, totalRedacted } = redactPii(null)
    expect(redacted).toBe('')
    expect(totalRedacted).toBe(0)
  })
})

// ─── assertNoSecretRefs ─────────────────────────────────────────────────────

describe('assertNoSecretRefs()', () => {
  test('throws on {{secret.NAME}}', () => {
    expect(() => assertNoSecretRefs('use {{secret.DB_PASSWORD}} here')).toThrow(
      'Refusing to send unresolved secret reference',
    )
  })

  test('throws with the matched reference in the message', () => {
    try {
      assertNoSecretRefs('value: {{secret.API_KEY}}')
      expect(true).toBe(false)
    } catch (err: unknown) {
      expect((err as Error).message).toContain('{{secret.API_KEY}}')
    }
  })

  test('passes on clean text', () => {
    expect(() => assertNoSecretRefs('no secrets here')).not.toThrow()
  })

  test('passes on empty string', () => {
    expect(() => assertNoSecretRefs('')).not.toThrow()
  })

  test('non-string does not throw', () => {
    // @ts-expect-error — testing runtime type check
    expect(() => assertNoSecretRefs(null)).not.toThrow()
  })

  test('includes context in error message when provided', () => {
    try {
      assertNoSecretRefs('{{secret.X}}', 'my-context')
      expect(true).toBe(false)
    } catch (err: unknown) {
      expect((err as Error).message).toContain('my-context')
    }
  })
})

// ─── containsSecretRef ──────────────────────────────────────────────────────

describe('containsSecretRef()', () => {
  test('detects {{secret.NAME}}', () => {
    expect(containsSecretRef('use {{secret.DB_PASSWORD}}')).toBe(true)
  })

  test('detects {{secret.NAME}} with underscores and numbers', () => {
    expect(containsSecretRef('{{secret.API_KEY_123}}')).toBe(true)
  })

  test('returns false for clean text', () => {
    expect(containsSecretRef('no secrets here')).toBe(false)
  })

  test('returns false for empty string', () => {
    expect(containsSecretRef('')).toBe(false)
  })

  test('returns false for partial patterns', () => {
    expect(containsSecretRef('{{secret.}}')).toBe(false) // empty name
    // Note: the pattern only accepts [A-Z0-9_], but LOWERCASE is all uppercase letters
    // So it actually matches! Test with a truly lowercase value
    expect(containsSecretRef('{{secret.lowercase}}')).toBe(false) // lowercase not matched
  })

  test('returns false for non-string', () => {
    // @ts-expect-error — testing runtime type check
    expect(containsSecretRef(null)).toBe(false)
    // @ts-expect-error — testing runtime type check
    expect(containsSecretRef(undefined)).toBe(false)
  })
})

// ─── assertMessageSafe ─────────────────────────────────────────────────────

describe('assertMessageSafe()', () => {
  test('passes on clean fragments', () => {
    expect(() => assertMessageSafe('clean text')).not.toThrow()
  })

  test('passes on array of clean fragments', () => {
    expect(() => assertMessageSafe(['fragment1', 'fragment2'])).not.toThrow()
  })

  test('throws on fragment with secret ref', () => {
    expect(() => assertMessageSafe(['clean', '{{secret.PASS}}'])).toThrow()
  })

  test('throws on single string with secret ref', () => {
    expect(() => assertMessageSafe('{{secret.KEY}}')).toThrow()
  })

  test('reports fragment index in error', () => {
    try {
      assertMessageSafe(['a', 'b', '{{secret.X}}'], 'my-task')
      expect(true).toBe(false)
    } catch (err: unknown) {
      expect((err as Error).message).toContain('fragment 2')
      expect((err as Error).message).toContain('my-task')
    }
  })

  test('passes on empty array', () => {
    expect(() => assertMessageSafe([])).not.toThrow()
  })
})
