/**
 * Journey safe-action policy — ProofPilot
 *
 * Enforces a multilingual blocklist of destructive actions (logout, delete,
 * reset, wipe, unsubscribe, etc.) that journey steps must NEVER target.
 * This is defense-in-depth on top of the run-mode whitelist — even a
 * CUSTOM_APPROVED journey cannot click a "Delete account" button.
 *
 * The blocklist covers:
 *   - URL substrings (href attributes, form actions)
 *   - Selector substrings (data-action, id, class attributes that hint at destructive intent)
 *   - Button/element text (case-insensitive, EN/FR/DE/ES/NL/FA)
 *
 * See SECURITY_MODEL.md §"Journeys" and THREAT_MODEL.md T12.
 */
import type { JourneyRunMode, JourneyStep, JourneyStepType } from './journey-types'
import { isStepAllowedForMode } from './journey-types'

// ---------------- Multilingual destructive patterns ----------------

/**
 * Destructive URL/selector substrings. Matches the crawl.ts blocklist plus
 * a few journey-specific additions (cancel, downgrade, terminate).
 *
 * Languages: EN, FR, DE, ES, NL, FA (Persian transliterated to ASCII).
 */
export const DESTRUCTIVE_PATTERNS: readonly string[] = [
  // English
  'logout', 'log-out', 'signout', 'sign-out', 'logoff', 'log-off',
  'delete', 'remove', 'destroy', 'reset', 'wipe', 'purge', 'clear-data',
  'cancel-account', 'close-account', 'terminate', 'unsubscribe', 'disable',
  'downgrade', 'opt-out',
  // French
  'deconnexion', 'deconnecter', 'supprimer', 'effacer', 'retirer',
  'reinitialiser', 'desabonner', 'annuler-compte',
  // German
  'abmelden', 'loschen', 'entfernen', 'zurucksetzen', 'abbestellen',
  'kontakt-loschen',
  // Spanish
  'cerrar-sesion', 'eliminar', 'borrar', 'restablecer', 'darse-de-baja',
  // Dutch
  'uitloggen', 'verwijderen', 'wissen', 'resetten', 'uitschrijven',
  // Persian (transliterated)
  'khoroj', 'hazf', 'pak-kardan', 'laghv',
]

// Patterns that match destructiveness in element text (longer phrases + loose match).
export const DESTRUCTIVE_TEXT_PATTERNS: readonly string[] = [
  // English
  'delete', 'remove', 'destroy', 'reset', 'wipe', 'purge',
  'cancel account', 'close account', 'terminate account',
  'unsubscribe', 'opt out', 'downgrade', 'sign out', 'log out',
  // French
  'supprimer', 'effacer', 'retirer', 'reinitialiser', 'desabonner',
  'se deconnecter', 'fermer le compte',
  // German
  'loschen', 'entfernen', 'abmelden', 'abbestellen', 'konto kunden',
  // Spanish
  'eliminar', 'borrar', 'restablecer', 'cerrar sesion', 'darse de baja',
  // Dutch
  'verwijderen', 'wissen', 'resetten', 'uitloggen', 'uitschrijven',
]

const DESTRUCTIVE_REGEX = new RegExp(
  DESTRUCTIVE_PATTERNS.map(escapeRegex).join('|'),
  'i',
)
const DESTRUCTIVE_TEXT_REGEX = new RegExp(
  DESTRUCTIVE_TEXT_PATTERNS.map(escapeRegex).join('|'),
  'i',
)

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// ---------------- Step validation ----------------

export interface PolicyViolation {
  stepIndex: number
  stepType: JourneyStepType
  reason: string
  code: 'step_not_allowed_for_mode' | 'destructive_url' | 'destructive_selector' | 'destructive_text' | 'missing_secret_ref'
}

export interface PolicyResult {
  ok: boolean
  violations: PolicyViolation[]
}

/**
 * Validate a journey's steps against the safe-action policy.
 *
 * Checks:
 *   1. Each step's type is permitted by the run mode (PASSIVE < SAFE_INTERACTION < TEST_TRANSACTION < CUSTOM_APPROVED).
 *   2. NAVIGATE/WAIT_FOR_URL/ASSERT_URL URLs do not contain destructive substrings.
 *   3. CLICK/TYPE/SELECT/CHECK/UNCHECK/WAIT_FOR_SELECTOR/ASSERT_VISIBLE/ASSERT_HIDDEN/ASSERT_TEXT selectors
 *      do not contain destructive substrings.
 *   4. ASSERT_TEXT text does not contain destructive substrings (defense-in-depth: asserting
 *      on destructive text would still leak it via screenshots).
 *   5. UPLOAD_TEST_FILE selectors do not target destructive actions.
 *
 * Note: This is a static check. The journey runner performs a SECOND runtime
 * check at execution time (the page's actual DOM state may differ from what
 * was configured at design time — e.g., a selector resolving to a different
 * element after a deployment).
 */
export function validateStepsAgainstPolicy(
  steps: JourneyStep[],
  runMode: JourneyRunMode,
): PolicyResult {
  const violations: PolicyViolation[] = []

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!

    // 1. Step type allowed for run mode?
    if (!isStepAllowedForMode(step.type, runMode)) {
      violations.push({
        stepIndex: i,
        stepType: step.type,
        reason: `Step type ${step.type} is not permitted in ${runMode} mode`,
        code: 'step_not_allowed_for_mode',
      })
      continue
    }

    // 2. URL check
    if ('url' in step && typeof step.url === 'string') {
      if (DESTRUCTIVE_REGEX.test(step.url)) {
        violations.push({
          stepIndex: i,
          stepType: step.type,
          reason: `URL contains a destructive pattern (logout/delete/reset/etc.): ${step.url}`,
          code: 'destructive_url',
        })
      }
    }

    // 3. Selector check
    if ('selector' in step && typeof step.selector === 'string') {
      if (DESTRUCTIVE_REGEX.test(step.selector)) {
        violations.push({
          stepIndex: i,
          stepType: step.type,
          reason: `Selector contains a destructive pattern: ${step.selector}`,
          code: 'destructive_selector',
        })
      }
    }

    // 4. Assert text check
    if (step.type === 'ASSERT_TEXT' && typeof step.text === 'string') {
      if (DESTRUCTIVE_TEXT_REGEX.test(step.text)) {
        violations.push({
          stepIndex: i,
          stepType: step.type,
          reason: 'Assertion text matches a destructive pattern',
          code: 'destructive_text',
        })
      }
    }
  }

  return { ok: violations.length === 0, violations }
}

/**
 * Runtime check: does a resolved selector or href/text on the live page
 * match a destructive pattern? Called by the journey runner before executing
 * CLICK / TYPE / SELECT / CHECK / UNCHECK.
 */
export function isDestructiveSelector(selector: string): boolean {
  return DESTRUCTIVE_REGEX.test(selector)
}

export function isDestructiveUrl(url: string): boolean {
  return DESTRUCTIVE_REGEX.test(url)
}

export function isDestructiveText(text: string): boolean {
  return DESTRUCTIVE_TEXT_REGEX.test(text)
}

/**
 * Highest run mode required to permit a given step.
 * Used to suggest a mode upgrade when the user authors a journey.
 */
export function minimumModeForStep(stepType: JourneyStepType): JourneyRunMode | null {
  if (STEP_TYPE_MIN_MODE[stepType]) return STEP_TYPE_MIN_MODE[stepType]!
  return null
}

const STEP_TYPE_MIN_MODE: Record<JourneyStepType, JourneyRunMode | undefined> = {
  NAVIGATE: 'PASSIVE',
  WAIT_FOR_SELECTOR: 'PASSIVE',
  WAIT_FOR_TIMEOUT: 'PASSIVE',
  WAIT_FOR_URL: 'PASSIVE',
  ASSERT_VISIBLE: 'PASSIVE',
  ASSERT_HIDDEN: 'PASSIVE',
  ASSERT_TEXT: 'PASSIVE',
  ASSERT_URL: 'PASSIVE',
  ASSERT_TITLE: 'PASSIVE',
  SCREENSHOT: 'PASSIVE',
  CLICK: 'SAFE_INTERACTION',
  TYPE: 'SAFE_INTERACTION',
  SELECT: 'SAFE_INTERACTION',
  CHECK: 'SAFE_INTERACTION',
  UNCHECK: 'SAFE_INTERACTION',
  UPLOAD_TEST_FILE: 'TEST_TRANSACTION',
  CUSTOM_SAFE_SCRIPT: 'CUSTOM_APPROVED',
}
