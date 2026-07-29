/**
 * Unit tests for src/lib/quality-score.ts
 *
 * Tests the pure `computeBreakdown()` function.
 */
import { describe, test, expect } from 'bun:test'
import { computeBreakdown } from '../quality-score'

/**
 * Helper to create a minimal finding row for computeBreakdown.
 */
function finding(severity: string, status: string, suppressed = false) {
  return {
    severity,
    status,
    suppressions: suppressed ? [{ id: 'sup-1' }] : [],
  }
}

// ─── No findings → perfect score ────────────────────────────────────────────

describe('computeBreakdown()', () => {
  test('no findings → score 100, grade A, READY', () => {
    const result = computeBreakdown([])
    expect(result.score).toBe(100)
    expect(result.grade).toBe('A')
    expect(result.readiness).toBe('READY')
    expect(result.hasOpenBlocker).toBe(false)
    expect(result.hasOpenCritical).toBe(false)
    expect(result.totalFindings).toBe(0)
    expect(result.totalPenalty).toBe(0)
    expect(result.suppressedCount).toBe(0)
    expect(result.fixedCount).toBe(0)
  })

  // ─── Open BLOCKER → score capped at 49 ───────────────────────────────────

  test('open BLOCKER → score capped at 49, grade F, NOT_READY', () => {
    const result = computeBreakdown([
      finding('BLOCKER', 'OPEN'),
    ])
    expect(result.score).toBeLessThanOrEqual(49)
    expect(result.grade).toBe('F')
    expect(result.readiness).toBe('NOT_READY')
    expect(result.hasOpenBlocker).toBe(true)
    expect(result.openBySeverity.BLOCKER).toBe(1)
  })

  // ─── Open CRITICAL → score capped at 74 ──────────────────────────────────

  test('open CRITICAL → score capped at 74, NEEDS_WORK', () => {
    const result = computeBreakdown([
      finding('CRITICAL', 'OPEN'),
    ])
    // CRITICAL: 1 × 12 = 12 penalty (max 18). Score = 100-12 = 88, capped at 74.
    expect(result.score).toBe(74)
    expect(result.readiness).toBe('NEEDS_WORK')
    expect(result.hasOpenCritical).toBe(true)
    expect(result.openBySeverity.CRITICAL).toBe(1)
  })

  // ─── Penalties with caps ───────────────────────────────────────────────────

  test('MINOR × 2 capped at 3 (max_penalty for MINOR)', () => {
    const result = computeBreakdown([
      finding('MINOR', 'OPEN'),
      finding('MINOR', 'OPEN'),
    ])
    // MINOR: weight=2, max_penalty=3. 2 × 2 = 4 uncapped → min(4, 3) = 3
    expect(result.penaltyBySeverity.MINOR).toBe(3)
    expect(result.totalPenalty).toBe(3)
    expect(result.score).toBe(97)
  })

  test('MINOR × 1 = 2 penalty (under cap)', () => {
    const result = computeBreakdown([
      finding('MINOR', 'OPEN'),
    ])
    expect(result.penaltyBySeverity.MINOR).toBe(2)
    expect(result.score).toBe(98)
  })

  test('MAJOR × 2 capped at 8 (max_penalty for MAJOR)', () => {
    const result = computeBreakdown([
      finding('MAJOR', 'OPEN'),
      finding('MAJOR', 'OPEN'),
    ])
    // MAJOR: weight=5, max_penalty=8. 2 × 5 = 10 uncapped → min(10, 8) = 8
    expect(result.penaltyBySeverity.MAJOR).toBe(8)
    expect(result.totalPenalty).toBe(8)
    expect(result.score).toBe(92)
  })

  test('MAJOR × 1 = 5 penalty (under cap)', () => {
    const result = computeBreakdown([
      finding('MAJOR', 'OPEN'),
    ])
    expect(result.penaltyBySeverity.MAJOR).toBe(5)
    expect(result.score).toBe(95)
  })

  test('INFO findings do not reduce score', () => {
    const result = computeBreakdown([
      finding('INFO', 'OPEN'),
      finding('INFO', 'OPEN'),
      finding('INFO', 'OPEN'),
    ])
    expect(result.penaltyBySeverity.INFO).toBe(0)
    expect(result.totalPenalty).toBe(0)
    expect(result.score).toBe(100)
  })

  // ─── Suppressed findings don't reduce score ──────────────────────────────

  test('suppressed findings excluded from penalty', () => {
    const result = computeBreakdown([
      finding('BLOCKER', 'OPEN', true),
      finding('CRITICAL', 'OPEN', true),
    ])
    expect(result.suppressedCount).toBe(2)
    expect(result.hasOpenBlocker).toBe(false)
    expect(result.hasOpenCritical).toBe(false)
    expect(result.totalPenalty).toBe(0)
    expect(result.score).toBe(100)
  })

  // ─── RESOLVED findings don't reduce score ────────────────────────────────

  test('RESOLVED findings excluded from penalty', () => {
    const result = computeBreakdown([
      finding('BLOCKER', 'RESOLVED'),
      finding('CRITICAL', 'RESOLVED'),
    ])
    expect(result.fixedCount).toBe(2)
    expect(result.hasOpenBlocker).toBe(false)
    expect(result.hasOpenCritical).toBe(false)
    expect(result.totalPenalty).toBe(0)
    expect(result.score).toBe(100)
  })

  test('ACCEPTED_RISK findings excluded from penalty', () => {
    const result = computeBreakdown([
      finding('BLOCKER', 'ACCEPTED_RISK'),
    ])
    expect(result.fixedCount).toBe(1)
    expect(result.totalPenalty).toBe(0)
    expect(result.score).toBe(100)
  })

  test('FALSE_POSITIVE findings excluded from penalty', () => {
    const result = computeBreakdown([
      finding('BLOCKER', 'FALSE_POSITIVE'),
    ])
    expect(result.fixedCount).toBe(1)
    expect(result.totalPenalty).toBe(0)
    expect(result.score).toBe(100)
  })

  // ─── Multiple severities compound correctly ───────────────────────────────

  test('mixed severities compound penalties with caps', () => {
    const result = computeBreakdown([
      finding('CRITICAL', 'OPEN'),
      finding('MAJOR', 'OPEN'),
      finding('MAJOR', 'OPEN'),
      finding('MINOR', 'OPEN'),
    ])
    // CRITICAL: 1 × 12 = 12 (max 18)
    // MAJOR: 2 × 5 = 10 (max 8) → capped to 8
    // MINOR: 1 × 2 = 2 (max 3)
    expect(result.penaltyBySeverity.CRITICAL).toBe(12)
    expect(result.penaltyBySeverity.MAJOR).toBe(8)
    expect(result.penaltyBySeverity.MINOR).toBe(2)
    expect(result.totalPenalty).toBe(22)
    // Score = 100 - 22 = 78, but hasOpenCritical caps at 74
    expect(result.score).toBe(74)
    expect(result.readiness).toBe('NEEDS_WORK')
  })

  // ─── Score never goes below 0 ──────────────────────────────────────────────

  test('score never goes below 0', () => {
    // Create many high-severity findings
    const findings = [
      ...Array(20).fill(null).map(() => finding('BLOCKER', 'OPEN')),
      ...Array(20).fill(null).map(() => finding('CRITICAL', 'OPEN')),
      ...Array(20).fill(null).map(() => finding('MAJOR', 'OPEN')),
    ]
    const result = computeBreakdown(findings)
    // BLOCKER: 20 × 25 = 500, capped at 35
    // CRITICAL: 20 × 12 = 240, capped at 18
    // MAJOR: 20 × 5 = 100, capped at 8
    // Total penalty: 35 + 18 + 8 = 61
    // Score = 100 - 61 = 39, but BLOCKER caps at 49
    expect(result.score).toBeLessThanOrEqual(49)
    expect(result.score).toBeGreaterThanOrEqual(0)
    expect(result.grade).toBe('F')
  })

  // ─── Severity caps ──────────────────────────────────────────────────────

  test('BLOCKER penalty capped at 35', () => {
    const findings = Array(5).fill(null).map(() => finding('BLOCKER', 'OPEN'))
    const result = computeBreakdown(findings)
    // 5 × 25 = 125 → capped at 35
    expect(result.penaltyBySeverity.BLOCKER).toBe(35)
  })

  test('CRITICAL penalty capped at 18', () => {
    const findings = Array(5).fill(null).map(() => finding('CRITICAL', 'OPEN'))
    const result = computeBreakdown(findings)
    // 5 × 12 = 60 → capped at 18
    expect(result.penaltyBySeverity.CRITICAL).toBe(18)
  })

  // ─── Status counting ──────────────────────────────────────────────────────

  test('byStatus counts correctly', () => {
    const result = computeBreakdown([
      finding('BLOCKER', 'OPEN'),
      finding('BLOCKER', 'RESOLVED'),
      finding('MAJOR', 'ACKNOWLEDGED'),
      finding('MAJOR', 'IN_PROGRESS'),
    ])
    expect(result.byStatus.OPEN).toBe(1)
    expect(result.byStatus.RESOLVED).toBe(1)
    expect(result.byStatus.ACKNOWLEDGED).toBe(1)
    expect(result.byStatus.IN_PROGRESS).toBe(1)
  })

  // ─── Grade boundaries ────────────────────────────────────────────────────

  test('score 100 → A, READY', () => {
    const result = computeBreakdown([])
    expect(result.score).toBe(100)
    expect(result.grade).toBe('A')
    expect(result.readiness).toBe('READY')
  })

  test('score 95 → A (1 MAJOR, penalty 5)', () => {
    const result = computeBreakdown([finding('MAJOR', 'OPEN')])
    expect(result.score).toBe(95)
    expect(result.grade).toBe('A')
  })

  test('BLOCKER always caps at 49 → F, NOT_READY', () => {
    const result = computeBreakdown([
      finding('BLOCKER', 'OPEN'),
      finding('CRITICAL', 'OPEN'),
      finding('MAJOR', 'OPEN'),
      finding('MINOR', 'OPEN'),
    ])
    // Penalty: 25 + 12 + 5 + 2 = 44. Score = 100-44 = 56. Capped at 49.
    expect(result.score).toBe(49)
    expect(result.grade).toBe('F')
    expect(result.readiness).toBe('NOT_READY')
  })

  // ─── IGNORED findings ──────────────────────────────────────────────────────

  test('IGNORED findings do not count as open or fixed', () => {
    const result = computeBreakdown([
      finding('BLOCKER', 'IGNORED'),
    ])
    expect(result.hasOpenBlocker).toBe(false)
    expect(result.totalPenalty).toBe(0)
    // IGNORED is not in FIXED_STATUSES (RESOLVED, ACCEPTED_RISK, FALSE_POSITIVE)
    expect(result.fixedCount).toBe(0)
  })

  // ─── REOPENED findings ─────────────────────────────────────────────────────

  test('REOPENED findings count as open', () => {
    const result = computeBreakdown([
      finding('CRITICAL', 'REOPENED'),
    ])
    expect(result.hasOpenCritical).toBe(true)
    expect(result.openBySeverity.CRITICAL).toBe(1)
    expect(result.score).toBeLessThanOrEqual(74)
  })

  // ─── totalFindings counts all ─────────────────────────────────────────────

  test('totalFindings counts all findings regardless of status', () => {
    const result = computeBreakdown([
      finding('BLOCKER', 'OPEN'),
      finding('MAJOR', 'RESOLVED'),
      finding('MINOR', 'IGNORED'),
      finding('INFO', 'OPEN', true),
    ])
    expect(result.totalFindings).toBe(4)
    expect(result.suppressedCount).toBe(1)
    expect(result.fixedCount).toBe(1)
  })
})
