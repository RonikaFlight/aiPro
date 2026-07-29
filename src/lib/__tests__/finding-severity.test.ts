/**
 * Unit tests for src/lib/finding-severity.ts
 */
import { describe, test, expect } from 'bun:test'
import {
  isSeverity,
  assertSeverity,
  maxSeverity,
  SEVERITY_RANK,
  isStatus,
  assertStatus,
  canTransition,
  assertCanTransition,
  parseBusinessImpacts,
  deterministicSeverity,
  resolveSeverity,
  parseTags,
  MAX_TAGS,
  SEVERITIES,
  STATUSES,
} from '../finding-severity'
import { ValidationError } from '../errors'

// ─── isSeverity / assertSeverity ────────────────────────────────────────────

describe('isSeverity()', () => {
  test('valid severities pass', () => {
    for (const s of SEVERITIES) {
      expect(isSeverity(s)).toBe(true)
    }
  })

  test('invalid severity returns false', () => {
    expect(isSeverity('')).toBe(false)
    expect(isSeverity('UNKNOWN')).toBe(false)
    expect(isSeverity('HIGH')).toBe(false)
    expect(isSeverity('blocker')).toBe(false) // case sensitive
  })
})

describe('assertSeverity()', () => {
  test('valid severity returns the value', () => {
    expect(assertSeverity('BLOCKER')).toBe('BLOCKER')
    expect(assertSeverity('INFO')).toBe('INFO')
  })

  test('invalid severity throws ValidationError', () => {
    expect(() => assertSeverity('UNKNOWN')).toThrow(ValidationError)
    expect(() => assertSeverity('HIGH')).toThrow(ValidationError)
  })

  test('error message contains the invalid value', () => {
    try {
      assertSeverity('BOGUS')
      expect(true).toBe(false)
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(ValidationError)
      expect((err as ValidationError).message).toContain('Invalid severity: BOGUS')
    }
  })
})

// ─── maxSeverity ─────────────────────────────────────────────────────────────

describe('maxSeverity()', () => {
  test('BLOCKER > CRITICAL', () => {
    expect(maxSeverity('BLOCKER', 'CRITICAL')).toBe('BLOCKER')
    expect(maxSeverity('CRITICAL', 'BLOCKER')).toBe('BLOCKER')
  })

  test('CRITICAL > MAJOR', () => {
    expect(maxSeverity('CRITICAL', 'MAJOR')).toBe('CRITICAL')
    expect(maxSeverity('MAJOR', 'CRITICAL')).toBe('CRITICAL')
  })

  test('MAJOR > MINOR', () => {
    expect(maxSeverity('MAJOR', 'MINOR')).toBe('MAJOR')
    expect(maxSeverity('MINOR', 'MAJOR')).toBe('MAJOR')
  })

  test('MINOR > INFO', () => {
    expect(maxSeverity('MINOR', 'INFO')).toBe('MINOR')
    expect(maxSeverity('INFO', 'MINOR')).toBe('MINOR')
  })

  test('same severity returns same', () => {
    expect(maxSeverity('BLOCKER', 'BLOCKER')).toBe('BLOCKER')
    expect(maxSeverity('INFO', 'INFO')).toBe('INFO')
  })

  test('full ordering BLOCKER > CRITICAL > MAJOR > MINOR > INFO', () => {
    expect(maxSeverity('BLOCKER', 'INFO')).toBe('BLOCKER')
    expect(maxSeverity('INFO', 'BLOCKER')).toBe('BLOCKER')
  })

  test('SEVERITY_RANK values are in expected order', () => {
    expect(SEVERITY_RANK.BLOCKER).toBeGreaterThan(SEVERITY_RANK.CRITICAL)
    expect(SEVERITY_RANK.CRITICAL).toBeGreaterThan(SEVERITY_RANK.MAJOR)
    expect(SEVERITY_RANK.MAJOR).toBeGreaterThan(SEVERITY_RANK.MINOR)
    expect(SEVERITY_RANK.MINOR).toBeGreaterThan(SEVERITY_RANK.INFO)
  })
})

// ─── isStatus / assertStatus ─────────────────────────────────────────────────

describe('isStatus()', () => {
  test('valid statuses pass', () => {
    for (const s of STATUSES) {
      expect(isStatus(s)).toBe(true)
    }
  })

  test('invalid status returns false', () => {
    expect(isStatus('')).toBe(false)
    expect(isStatus('FIXED')).toBe(false)
    expect(isStatus('OPEN')).toBe(true) // but mixed case fails
    expect(isStatus('open')).toBe(false)
  })
})

describe('assertStatus()', () => {
  test('valid status returns the value', () => {
    expect(assertStatus('OPEN')).toBe('OPEN')
    expect(assertStatus('RESOLVED')).toBe('RESOLVED')
  })

  test('invalid status throws ValidationError', () => {
    expect(() => assertStatus('FIXED')).toThrow(ValidationError)
    expect(() => assertStatus('')).toThrow(ValidationError)
  })

  test('error message contains the invalid value', () => {
    try {
      assertStatus('BOGUS')
      expect(true).toBe(false)
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(ValidationError)
      expect((err as ValidationError).message).toContain('Invalid finding status: BOGUS')
    }
  })
})

// ─── canTransition / assertCanTransition ───────────────────────────────────

describe('canTransition()', () => {
  // Valid transitions from OPEN
  test('OPEN → ACKNOWLEDGED is valid', () => {
    expect(canTransition('OPEN', 'ACKNOWLEDGED')).toBe(true)
  })
  test('OPEN → IN_PROGRESS is valid', () => {
    expect(canTransition('OPEN', 'IN_PROGRESS')).toBe(true)
  })
  test('OPEN → RESOLVED is valid', () => {
    expect(canTransition('OPEN', 'RESOLVED')).toBe(true)
  })
  test('OPEN → IGNORED is valid', () => {
    expect(canTransition('OPEN', 'IGNORED')).toBe(true)
  })
  test('OPEN → ACCEPTED_RISK is valid', () => {
    expect(canTransition('OPEN', 'ACCEPTED_RISK')).toBe(true)
  })
  test('OPEN → FALSE_POSITIVE is valid', () => {
    expect(canTransition('OPEN', 'FALSE_POSITIVE')).toBe(true)
  })
  test('OPEN → OPEN is invalid', () => {
    expect(canTransition('OPEN', 'OPEN')).toBe(false)
  })

  // RESOLVED can only go to REOPENED
  test('RESOLVED → REOPENED is valid', () => {
    expect(canTransition('RESOLVED', 'REOPENED')).toBe(true)
  })
  test('RESOLVED → OPEN is invalid', () => {
    expect(canTransition('RESOLVED', 'OPEN')).toBe(false)
  })
  test('RESOLVED → ACKNOWLEDGED is invalid', () => {
    expect(canTransition('RESOLVED', 'ACKNOWLEDGED')).toBe(false)
  })
  test('RESOLVED → RESOLVED is invalid', () => {
    expect(canTransition('RESOLVED', 'RESOLVED')).toBe(false)
  })

  // ACKNOWLEDGED transitions
  test('ACKNOWLEDGED → OPEN is valid', () => {
    expect(canTransition('ACKNOWLEDGED', 'OPEN')).toBe(true)
  })
  test('ACKNOWLEDGED → IN_PROGRESS is valid', () => {
    expect(canTransition('ACKNOWLEDGED', 'IN_PROGRESS')).toBe(true)
  })
  test('ACKNOWLEDGED → RESOLVED is valid', () => {
    expect(canTransition('ACKNOWLEDGED', 'RESOLVED')).toBe(true)
  })

  // IN_PROGRESS transitions
  test('IN_PROGRESS → OPEN is valid', () => {
    expect(canTransition('IN_PROGRESS', 'OPEN')).toBe(true)
  })
  test('IN_PROGRESS → RESOLVED is valid', () => {
    expect(canTransition('IN_PROGRESS', 'RESOLVED')).toBe(true)
  })

  // REOPENED transitions
  test('REOPENED → ACKNOWLEDGED is valid', () => {
    expect(canTransition('REOPENED', 'ACKNOWLEDGED')).toBe(true)
  })
  test('REOPENED → RESOLVED is valid', () => {
    expect(canTransition('REOPENED', 'RESOLVED')).toBe(true)
  })
  test('REOPENED → OPEN is invalid', () => {
    expect(canTransition('REOPENED', 'OPEN')).toBe(false)
  })

  // Terminal-like states
  test('IGNORED → REOPENED is valid', () => {
    expect(canTransition('IGNORED', 'REOPENED')).toBe(true)
  })
  test('IGNORED → OPEN is valid', () => {
    expect(canTransition('IGNORED', 'OPEN')).toBe(true)
  })
  test('IGNORED → RESOLVED is invalid', () => {
    expect(canTransition('IGNORED', 'RESOLVED')).toBe(false)
  })

  test('ACCEPTED_RISK → REOPENED is valid', () => {
    expect(canTransition('ACCEPTED_RISK', 'REOPENED')).toBe(true)
  })

  test('FALSE_POSITIVE → REOPENED is valid', () => {
    expect(canTransition('FALSE_POSITIVE', 'REOPENED')).toBe(true)
  })
  test('FALSE_POSITIVE → OPEN is valid', () => {
    expect(canTransition('FALSE_POSITIVE', 'OPEN')).toBe(true)
  })
})

describe('assertCanTransition()', () => {
  test('valid transition does not throw', () => {
    expect(() => assertCanTransition('OPEN', 'ACKNOWLEDGED')).not.toThrow()
  })

  test('invalid transition throws ValidationError', () => {
    expect(() => assertCanTransition('RESOLVED', 'OPEN')).toThrow(ValidationError)
    expect(() => assertCanTransition('OPEN', 'OPEN')).toThrow(ValidationError)
  })

  test('error message mentions from → to', () => {
    try {
      assertCanTransition('RESOLVED', 'OPEN')
      expect(true).toBe(false)
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(ValidationError)
      expect((err as ValidationError).message).toContain('RESOLVED → OPEN')
    }
  })
})

// ─── parseBusinessImpacts ────────────────────────────────────────────────────

describe('parseBusinessImpacts()', () => {
  test('parses comma-separated impacts', () => {
    const result = parseBusinessImpacts('REVENUE_LOSS, BRAND_DAMAGE, USER_EXPERIENCE')
    expect(result).toEqual(['REVENUE_LOSS', 'BRAND_DAMAGE', 'USER_EXPERIENCE'])
  })

  test('deduplicates', () => {
    const result = parseBusinessImpacts('REVENUE_LOSS, REVENUE_LOSS, BRAND_DAMAGE')
    expect(result).toEqual(['REVENUE_LOSS', 'BRAND_DAMAGE'])
  })

  test('ignores unknown impacts', () => {
    const result = parseBusinessImpacts('REVENUE_LOSS, BOGUS, BRAND_DAMAGE')
    expect(result).toEqual(['REVENUE_LOSS', 'BRAND_DAMAGE'])
  })

  test('null returns empty array', () => {
    expect(parseBusinessImpacts(null)).toEqual([])
  })

  test('undefined returns empty array', () => {
    expect(parseBusinessImpacts(undefined)).toEqual([])
  })

  test('empty string returns empty array', () => {
    expect(parseBusinessImpacts('')).toEqual([])
  })

  test('whitespace-only string returns empty array', () => {
    expect(parseBusinessImpacts('  ')).toEqual([])
  })

  test('handles extra whitespace', () => {
    const result = parseBusinessImpacts(' REVENUE_LOSS ,  BRAND_DAMAGE ')
    expect(result).toEqual(['REVENUE_LOSS', 'BRAND_DAMAGE'])
  })

  test('all valid impacts pass', () => {
    const input = [
      'REVENUE_LOSS', 'CONVERSION_LOSS', 'BRAND_DAMAGE',
      'ACCESSIBILITY_BARRIER', 'LEGAL_COMPLIANCE', 'SEO_TRAFFIC_LOSS',
      'USER_EXPERIENCE', 'SECURITY_EXPOSURE', 'PERFORMANCE_DEGRADATION',
      'LOCALIZATION_BARRIER', 'TECHNICAL_DEBT', 'OTHER',
    ].join(', ')
    const result = parseBusinessImpacts(input)
    expect(result.length).toBe(12)
  })
})

// ─── deterministicSeverity ───────────────────────────────────────────────────

describe('deterministicSeverity()', () => {
  test('known pairs return correct severity', () => {
    expect(deterministicSeverity('RUNTIME', 'page_crash')).toBe('BLOCKER')
    expect(deterministicSeverity('SECURITY', 'secret_in_dom')).toBe('BLOCKER')
    expect(deterministicSeverity('HTTP_NAVIGATION', 'server_error_5xx')).toBe('CRITICAL')
    expect(deterministicSeverity('HTTP_NAVIGATION', 'broken_link_404')).toBe('MAJOR')
    expect(deterministicSeverity('HTTP_NAVIGATION', 'missing_title')).toBe('MINOR')
    expect(deterministicSeverity('HTTP_NAVIGATION', 'broken_favicon')).toBe('INFO')
    expect(deterministicSeverity('SEO', 'missing_favicon')).toBe('INFO')
  })

  test('unknown pair returns null', () => {
    expect(deterministicSeverity('UNKNOWN_CATEGORY', 'unknown_check')).toBe(null)
    expect(deterministicSeverity('', '')).toBe(null)
    expect(deterministicSeverity('RUNTIME', 'custom_check')).toBe(null)
  })
})

// ─── resolveSeverity ─────────────────────────────────────────────────────────

describe('resolveSeverity()', () => {
  test('deterministic override wins over analyzer', () => {
    const result = resolveSeverity('RUNTIME', 'page_crash', 'INFO', 'INFO')
    expect(result.severity).toBe('BLOCKER')
    expect(result.overridden).toBe(true)
  })

  test('deterministic matches analyzer — no override flag', () => {
    const result = resolveSeverity('RUNTIME', 'page_crash', 'BLOCKER')
    expect(result.severity).toBe('BLOCKER')
    expect(result.overridden).toBe(false)
  })

  test('no deterministic rule — analyzer severity stands', () => {
    const result = resolveSeverity('CUSTOM', 'my_check', 'MAJOR')
    expect(result.severity).toBe('MAJOR')
    expect(result.overridden).toBe(false)
  })

  test('no deterministic rule — AI proposed ignored', () => {
    const result = resolveSeverity('CUSTOM', 'my_check', 'MAJOR', 'BLOCKER')
    expect(result.severity).toBe('MAJOR')
    expect(result.overridden).toBe(false)
  })
})

// ─── parseTags ──────────────────────────────────────────────────────────────

describe('parseTags()', () => {
  test('valid tags parsed', () => {
    const result = parseTags('accessibility, mobile, responsive')
    expect(result).toEqual(['accessibility', 'mobile', 'responsive'])
  })

  test('max 12 tags', () => {
    const input = Array.from({ length: 13 }, (_, i) => `tag${i + 1}`).join(', ')
    expect(() => parseTags(input)).toThrow(ValidationError)
  })

  test('12 tags is valid', () => {
    const input = Array.from({ length: 12 }, (_, i) => `tag${i + 1}`).join(', ')
    const result = parseTags(input)
    expect(result.length).toBe(12)
  })

  test('invalid characters rejected', () => {
    expect(() => parseTags('tag<script>')).toThrow(ValidationError)
    expect(() => parseTags('tag@special')).toThrow(ValidationError)
  })

  test('deduplicated', () => {
    const result = parseTags('mobile, mobile, desktop')
    expect(result).toEqual(['mobile', 'desktop'])
  })

  test('case-insensitive deduplication preserves original case', () => {
    const result = parseTags('Mobile, MOBILE, mobile')
    expect(result).toEqual(['Mobile'])
  })

  test('null returns empty', () => {
    expect(parseTags(null)).toEqual([])
  })

  test('undefined returns empty', () => {
    expect(parseTags(undefined)).toEqual([])
  })

  test('empty string returns empty', () => {
    expect(parseTags('')).toEqual([])
  })

  test('tags with spaces, dashes, underscores allowed', () => {
    const result = parseTags('my-tag, my_tag, my tag')
    expect(result).toEqual(['my-tag', 'my_tag', 'my tag'])
  })

  test('error message mentions too many tags', () => {
    try {
      parseTags('a,b,c,d,e,f,g,h,i,j,k,l,m')
      expect(true).toBe(false)
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(ValidationError)
      expect((err as ValidationError).message).toContain(`Too many tags (max ${MAX_TAGS})`)
    }
  })
})
