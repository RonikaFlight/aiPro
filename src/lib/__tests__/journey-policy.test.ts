/**
 * Unit tests for src/lib/journey-policy.ts
 */
import { describe, test, expect } from 'bun:test'
import {
  validateStepsAgainstPolicy,
  isDestructiveSelector,
  isDestructiveUrl,
  isDestructiveText,
  minimumModeForStep,
} from '../journey-policy'
import type { JourneyStep } from '../journey-types'

// ─── validateStepsAgainstPolicy ─────────────────────────────────────────────

describe('validateStepsAgainstPolicy()', () => {
  test('valid NAVIGATE + ASSERT steps in PASSIVE mode pass', () => {
    const steps: JourneyStep[] = [
      { type: 'NAVIGATE', url: 'https://example.com' },
      { type: 'ASSERT_TEXT', selector: 'h1', text: 'Welcome' },
      { type: 'ASSERT_VISIBLE', selector: '.nav' },
    ]
    const result = validateStepsAgainstPolicy(steps, 'PASSIVE')
    expect(result.ok).toBe(true)
    expect(result.violations).toHaveLength(0)
  })

  test('CLICK in PASSIVE fails', () => {
    const steps: JourneyStep[] = [
      { type: 'NAVIGATE', url: 'https://example.com' },
      { type: 'CLICK', selector: '.btn' },
    ]
    const result = validateStepsAgainstPolicy(steps, 'PASSIVE')
    expect(result.ok).toBe(false)
    expect(result.violations).toHaveLength(1)
    expect(result.violations[0]!.code).toBe('step_not_allowed_for_mode')
    expect(result.violations[0]!.stepType).toBe('CLICK')
  })

  test('NAVIGATE with destructive URL rejected', () => {
    const steps: JourneyStep[] = [
      { type: 'NAVIGATE', url: 'https://example.com/logout' },
    ]
    const result = validateStepsAgainstPolicy(steps, 'PASSIVE')
    expect(result.ok).toBe(false)
    expect(result.violations[0]!.code).toBe('destructive_url')
    expect(result.violations[0]!.reason).toContain('destructive pattern')
  })

  test('NAVIGATE with delete URL rejected', () => {
    const steps: JourneyStep[] = [
      { type: 'NAVIGATE', url: 'https://example.com/account/delete' },
    ]
    const result = validateStepsAgainstPolicy(steps, 'PASSIVE')
    expect(result.ok).toBe(false)
    expect(result.violations[0]!.code).toBe('destructive_url')
  })

  test('destructive selector rejected', () => {
    const steps: JourneyStep[] = [
      { type: 'ASSERT_VISIBLE', selector: '#logout-button' },
    ]
    const result = validateStepsAgainstPolicy(steps, 'PASSIVE')
    expect(result.ok).toBe(false)
    expect(result.violations[0]!.code).toBe('destructive_selector')
  })

  test('destructive text in ASSERT_TEXT rejected', () => {
    const steps: JourneyStep[] = [
      { type: 'ASSERT_TEXT', selector: 'h1', text: 'Delete Account' },
    ]
    const result = validateStepsAgainstPolicy(steps, 'PASSIVE')
    expect(result.ok).toBe(false)
    expect(result.violations[0]!.code).toBe('destructive_text')
  })

  test('multiple violations reported for multiple steps', () => {
    const steps: JourneyStep[] = [
      { type: 'NAVIGATE', url: 'https://example.com/logout' },
      { type: 'CLICK', selector: '.btn' },
      { type: 'ASSERT_TEXT', selector: 'h1', text: 'remove item' },
    ]
    const result = validateStepsAgainstPolicy(steps, 'PASSIVE')
    expect(result.ok).toBe(false)
    expect(result.violations.length).toBeGreaterThanOrEqual(2)
  })

  test('SAFE_INTERACTION allows CLICK', () => {
    const steps: JourneyStep[] = [
      { type: 'NAVIGATE', url: 'https://example.com' },
      { type: 'CLICK', selector: '.submit-btn' },
    ]
    const result = validateStepsAgainstPolicy(steps, 'SAFE_INTERACTION')
    expect(result.ok).toBe(true)
  })

  test('SAFE_INTERACTION still rejects destructive selectors', () => {
    const steps: JourneyStep[] = [
      { type: 'CLICK', selector: '#delete-account' },
    ]
    const result = validateStepsAgainstPolicy(steps, 'SAFE_INTERACTION')
    expect(result.ok).toBe(false)
    expect(result.violations[0]!.code).toBe('destructive_selector')
  })

  test('CLEAN URL and selector pass', () => {
    const steps: JourneyStep[] = [
      { type: 'NAVIGATE', url: 'https://example.com/dashboard' },
      { type: 'ASSERT_VISIBLE', selector: '#main-content' },
    ]
    const result = validateStepsAgainstPolicy(steps, 'PASSIVE')
    expect(result.ok).toBe(true)
  })

  test('UPLOAD_TEST_FILE in PASSIVE fails', () => {
    const steps: JourneyStep[] = [
      { type: 'UPLOAD_TEST_FILE', selector: 'input[type=file]', fileName: 'test.txt', mimeType: 'text/plain', content: 'hello' },
    ]
    const result = validateStepsAgainstPolicy(steps, 'PASSIVE')
    expect(result.ok).toBe(false)
    expect(result.violations[0]!.code).toBe('step_not_allowed_for_mode')
  })

  test('CUSTOM_SAFE_SCRIPT in SAFE_INTERACTION fails', () => {
    const steps: JourneyStep[] = [
      { type: 'CUSTOM_SAFE_SCRIPT', scriptId: 'scroll_to_top' },
    ]
    const result = validateStepsAgainstPolicy(steps, 'SAFE_INTERACTION')
    expect(result.ok).toBe(false)
    expect(result.violations[0]!.code).toBe('step_not_allowed_for_mode')
  })
})

// ─── isDestructiveSelector ──────────────────────────────────────────────────

describe('isDestructiveSelector()', () => {
  test('matches logout', () => {
    expect(isDestructiveSelector('#logout')).toBe(true)
  })

  test('matches delete', () => {
    expect(isDestructiveSelector('#delete-account')).toBe(true)
  })

  test('matches remove', () => {
    expect(isDestructiveSelector('.remove-item')).toBe(true)
  })

  test('matches destroy', () => {
    expect(isDestructiveSelector('[data-action="destroy"]')).toBe(true)
  })

  test('matches reset', () => {
    expect(isDestructiveSelector('#reset-form')).toBe(true)
  })

  test('matches signout', () => {
    expect(isDestructiveSelector('.signout-link')).toBe(true)
  })

  test('matches unsubscribe', () => {
    expect(isDestructiveSelector('#unsubscribe-btn')).toBe(true)
  })

  test('matches terminate', () => {
    expect(isDestructiveSelector('.terminate-session')).toBe(true)
  })

  test('clean selector does not match', () => {
    expect(isDestructiveSelector('#main-content')).toBe(false)
    expect(isDestructiveSelector('.submit-btn')).toBe(false)
    expect(isDestructiveSelector('nav.menu')).toBe(false)
  })
})

// ─── isDestructiveUrl ──────────────────────────────────────────────────────

describe('isDestructiveUrl()', () => {
  test('matches logout URL', () => {
    expect(isDestructiveUrl('https://example.com/logout')).toBe(true)
  })

  test('matches delete URL', () => {
    expect(isDestructiveUrl('https://example.com/account/delete')).toBe(true)
  })

  test('matches remove URL', () => {
    expect(isDestructiveUrl('https://example.com/remove-item')).toBe(true)
  })

  test('matches cancel-account', () => {
    expect(isDestructiveUrl('https://example.com/cancel-account')).toBe(true)
  })

  test('matches opt-out', () => {
    expect(isDestructiveUrl('https://example.com/opt-out')).toBe(true)
  })

  test('matches disable', () => {
    expect(isDestructiveUrl('https://example.com/disable-feature')).toBe(true)
  })

  test('matches downgrade', () => {
    expect(isDestructiveUrl('https://example.com/downgrade-plan')).toBe(true)
  })

  test('clean URL does not match', () => {
    expect(isDestructiveUrl('https://example.com/dashboard')).toBe(false)
    expect(isDestructiveUrl('https://example.com/settings')).toBe(false)
  })
})

// ─── isDestructiveText ──────────────────────────────────────────────────────

describe('isDestructiveText()', () => {
  test('matches "delete account"', () => {
    expect(isDestructiveText('delete account')).toBe(true)
  })

  test('matches "Delete Account" (case insensitive)', () => {
    expect(isDestructiveText('Delete Account')).toBe(true)
  })

  test('matches "remove"', () => {
    expect(isDestructiveText('remove item')).toBe(true)
  })

  test('matches "cancel account"', () => {
    expect(isDestructiveText('cancel account')).toBe(true)
  })

  test('matches "unsubscribe"', () => {
    expect(isDestructiveText('unsubscribe from newsletter')).toBe(true)
  })

  test('matches "sign out"', () => {
    expect(isDestructiveText('sign out')).toBe(true)
  })

  test('matches "log out"', () => {
    expect(isDestructiveText('log out')).toBe(true)
  })

  test('matches "opt out"', () => {
    expect(isDestructiveText('opt out')).toBe(true)
  })

  test('clean text does not match', () => {
    expect(isDestructiveText('Welcome to the dashboard')).toBe(false)
    expect(isDestructiveText('Your order has been placed')).toBe(false)
  })

  // ─── Multilingual ──────────────────────────────────────────────────────

  test('French: supprimer', () => {
    expect(isDestructiveText('Supprimer le compte')).toBe(true)
    expect(isDestructiveSelector('#supprimer-btn')).toBe(true)
  })

  test('French: effacer', () => {
    expect(isDestructiveText('effacer les données')).toBe(true)
    expect(isDestructiveSelector('#effacer')).toBe(true)
  })

  test('French: retirer', () => {
    expect(isDestructiveText('retirer cet article')).toBe(true)
    expect(isDestructiveSelector('.retirer')).toBe(true)
  })

  test('German: loschen', () => {
    expect(isDestructiveText('Loschen Sie das Konto')).toBe(true)
    expect(isDestructiveSelector('#loschen')).toBe(true)
  })

  test('German: entfernen', () => {
    expect(isDestructiveText('entfernen')).toBe(true)
    expect(isDestructiveSelector('.entfernen')).toBe(true)
  })

  test('German: abmelden', () => {
    expect(isDestructiveText('abmelden')).toBe(true)
    expect(isDestructiveSelector('.abmelden')).toBe(true)
  })

  test('Spanish: eliminar', () => {
    expect(isDestructiveText('eliminar cuenta')).toBe(true)
    expect(isDestructiveSelector('#eliminar')).toBe(true)
  })

  test('Spanish: borrar', () => {
    expect(isDestructiveText('borrar datos')).toBe(true)
    expect(isDestructiveSelector('.borrar')).toBe(true)
  })

  test('Dutch: verwijderen', () => {
    expect(isDestructiveText('verwijderen account')).toBe(true)
    expect(isDestructiveSelector('#verwijderen')).toBe(true)
  })

  test('Dutch: wissen', () => {
    expect(isDestructiveText('wissen')).toBe(true)
    expect(isDestructiveSelector('.wissen')).toBe(true)
  })

  test('Dutch: uitloggen', () => {
    expect(isDestructiveText('uitloggen')).toBe(true)
    expect(isDestructiveSelector('.uitloggen')).toBe(true)
  })

  test('Persian: hazf', () => {
    expect(isDestructiveSelector('#hazf')).toBe(true)
  })

  test('Persian: khoroj', () => {
    expect(isDestructiveSelector('#khoroj')).toBe(true)
  })
})

// ─── minimumModeForStep ────────────────────────────────────────────────────

describe('minimumModeForStep()', () => {
  test('NAVIGATE → PASSIVE', () => {
    expect(minimumModeForStep('NAVIGATE')).toBe('PASSIVE')
  })

  test('ASSERT_TEXT → PASSIVE', () => {
    expect(minimumModeForStep('ASSERT_TEXT')).toBe('PASSIVE')
  })

  test('SCREENSHOT → PASSIVE', () => {
    expect(minimumModeForStep('SCREENSHOT')).toBe('PASSIVE')
  })

  test('WAIT_FOR_SELECTOR → PASSIVE', () => {
    expect(minimumModeForStep('WAIT_FOR_SELECTOR')).toBe('PASSIVE')
  })

  test('WAIT_FOR_TIMEOUT → PASSIVE', () => {
    expect(minimumModeForStep('WAIT_FOR_TIMEOUT')).toBe('PASSIVE')
  })

  test('ASSERT_VISIBLE → PASSIVE', () => {
    expect(minimumModeForStep('ASSERT_VISIBLE')).toBe('PASSIVE')
  })

  test('ASSERT_HIDDEN → PASSIVE', () => {
    expect(minimumModeForStep('ASSERT_HIDDEN')).toBe('PASSIVE')
  })

  test('ASSERT_URL → PASSIVE', () => {
    expect(minimumModeForStep('ASSERT_URL')).toBe('PASSIVE')
  })

  test('ASSERT_TITLE → PASSIVE', () => {
    expect(minimumModeForStep('ASSERT_TITLE')).toBe('PASSIVE')
  })

  test('WAIT_FOR_URL → PASSIVE', () => {
    expect(minimumModeForStep('WAIT_FOR_URL')).toBe('PASSIVE')
  })

  test('CLICK → SAFE_INTERACTION', () => {
    expect(minimumModeForStep('CLICK')).toBe('SAFE_INTERACTION')
  })

  test('TYPE → SAFE_INTERACTION', () => {
    expect(minimumModeForStep('TYPE')).toBe('SAFE_INTERACTION')
  })

  test('SELECT → SAFE_INTERACTION', () => {
    expect(minimumModeForStep('SELECT')).toBe('SAFE_INTERACTION')
  })

  test('CHECK → SAFE_INTERACTION', () => {
    expect(minimumModeForStep('CHECK')).toBe('SAFE_INTERACTION')
  })

  test('UNCHECK → SAFE_INTERACTION', () => {
    expect(minimumModeForStep('UNCHECK')).toBe('SAFE_INTERACTION')
  })

  test('UPLOAD_TEST_FILE → TEST_TRANSACTION', () => {
    expect(minimumModeForStep('UPLOAD_TEST_FILE')).toBe('TEST_TRANSACTION')
  })

  test('CUSTOM_SAFE_SCRIPT → CUSTOM_APPROVED', () => {
    expect(minimumModeForStep('CUSTOM_SAFE_SCRIPT')).toBe('CUSTOM_APPROVED')
  })
})
