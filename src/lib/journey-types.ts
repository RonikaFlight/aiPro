/**
 * Journey step types — ProofPilot
 *
 * Zod-validated schema for journey steps. A journey is an ordered list of steps
 * executed in an isolated browser context. Step types are deliberately
 * constrained to a safe whitelist — there is NO raw-JS step type.
 *
 * Secret references:
 *   Steps that accept sensitive data (TYPE, ASSERT_TEXT) accept either:
 *     - `text`: a literal string (non-secret)
 *     - `secretRef`: `{{secret.NAME}}` resolved ONLY inside the worker from
 *       the project-scoped ProjectSecret vault. The API never returns resolved
 *       secret values; only the literal `{{secret.NAME}}` token is stored.
 *
 * Selector policy:
 *   Selectors must be CSS or Playwright locator-friendly (text=, role=, etc.).
 *   They are validated against a max length (200 chars) and a charset whitelist
 *   to prevent injection of malformed selectors that could escape the engine.
 *
 * See SECURITY_MODEL.md §"Journeys" and THREAT_MODEL.md T12.
 */
import { z } from 'zod'

// ---------------- Step types ----------------

export const JOURNEY_STEP_TYPES = [
  'NAVIGATE',
  'CLICK',
  'TYPE',
  'SELECT',
  'CHECK',
  'UNCHECK',
  'UPLOAD_TEST_FILE',
  'WAIT_FOR_SELECTOR',
  'WAIT_FOR_TIMEOUT',
  'WAIT_FOR_URL',
  'ASSERT_VISIBLE',
  'ASSERT_HIDDEN',
  'ASSERT_TEXT',
  'ASSERT_URL',
  'ASSERT_TITLE',
  'SCREENSHOT',
  'CUSTOM_SAFE_SCRIPT',
] as const
export type JourneyStepType = (typeof JOURNEY_STEP_TYPES)[number]

// Selector validation: allow CSS + Playwright text/role/label/testid/chained locators.
// Block script-like content and > 200 chars.
const SELECTOR_SCHEMA = z
  .string()
  .min(1, 'Selector must not be empty')
  .max(200, 'Selector exceeds 200 chars')
  .regex(
    /^[a-zA-Z0-9 _\-=*"'\[\]():>#.,>+~/@]+$/,
    'Selector contains disallowed characters',
  )
  .refine((s) => !/javascript:/i.test(s), 'javascript: URIs are forbidden in selectors')

// Secret reference: {{secret.NAME}} where NAME is [A-Z0-9_]+
const SECRET_REF_SCHEMA = z
  .string()
  .regex(/^\{\{secret\.[A-Z0-9_]{1,64}\}\}$/, 'Invalid secret reference format')

// URL validation: must be http(s), relative paths allowed (resolved against entryUrl at runtime)
const URL_SCHEMA = z
  .string()
  .min(1, 'URL must not be empty')
  .max(2048, 'URL exceeds 2048 chars')
  .refine((u) => {
    if (u.startsWith('/')) return true
    if (u.startsWith('#')) return true
    return /^https?:\/\//i.test(u)
  }, 'URL must be http(s) or start with / or #')

// Whitelist of safe custom script IDs. The runner maps these to predefined
// browser actions — never raw JS evaluation.
const SAFE_SCRIPT_IDS = [
  'scroll_to_top',
  'scroll_to_bottom',
  'accept_cookie_banner_if_present',
  'dismiss_dialog_if_present',
  'scroll_into_view_of_last_element',
] as const

// ---------------- Per-step schemas ----------------

const base = z.object({
  label: z.string().max(100).optional(),
  // Optional continue-on-error flag. If true, a FAIL does not abort the journey.
  continueOnError: z.boolean().optional(),
})

export const NavigateStep = base.extend({
  type: z.literal('NAVIGATE'),
  url: URL_SCHEMA,
  waitUntil: z.enum(['load', 'domcontentloaded', 'networkidle']).optional(),
})

export const ClickStep = base.extend({
  type: z.literal('CLICK'),
  selector: SELECTOR_SCHEMA,
  button: z.enum(['left', 'right', 'middle']).optional(),
  modifiers: z.array(z.enum(['Shift', 'Control', 'Alt', 'Meta'])).max(4).optional(),
})

export const TypeStep = base.extend({
  type: z.literal('TYPE'),
  selector: SELECTOR_SCHEMA,
  // Either literal text OR a secret reference. Mutually exclusive.
  text: z.string().max(4000).optional(),
  secretRef: SECRET_REF_SCHEMA.optional(),
  clearFirst: z.boolean().optional(),
  delayMs: z.number().int().min(0).max(1000).optional(),
}).refine((s) => (s.text ? !s.secretRef : !!s.secretRef), {
  message: 'Exactly one of `text` or `secretRef` is required',
})

export const SelectStep = base.extend({
  type: z.literal('SELECT'),
  selector: SELECTOR_SCHEMA,
  value: z.string().max(500),
})

export const CheckStep = base.extend({
  type: z.literal('CHECK'),
  selector: SELECTOR_SCHEMA,
})

export const UncheckStep = base.extend({
  type: z.literal('UNCHECK'),
  selector: SELECTOR_SCHEMA,
})

export const UploadTestFileStep = base.extend({
  type: z.literal('UPLOAD_TEST_FILE'),
  selector: SELECTOR_SCHEMA,
  fileName: z.string().min(1).max(200).regex(/^[a-zA-Z0-9._-]+$/, 'Invalid filename'),
  mimeType: z.enum([
    'text/plain',
    'application/json',
    'image/png',
    'image/jpeg',
    'application/pdf',
    'text/csv',
  ]),
  // Either inline content (capped) or auto-generate (e.g. "auto:png" generates a 1x1 PNG).
  content: z.string().max(10_000).optional(),
  autoGenerate: z.enum(['text', 'json', 'png', 'jpeg', 'pdf', 'csv']).optional(),
}).refine((s) => !!s.content !== !!s.autoGenerate, {
  message: 'Exactly one of `content` or `autoGenerate` is required',
})

export const WaitForSelectorStep = base.extend({
  type: z.literal('WAIT_FOR_SELECTOR'),
  selector: SELECTOR_SCHEMA,
  state: z.enum(['attached', 'detached', 'visible', 'hidden']).optional(),
  timeoutMs: z.number().int().min(100).max(30_000).optional(),
})

export const WaitForTimeoutStep = base.extend({
  type: z.literal('WAIT_FOR_TIMEOUT'),
  ms: z.number().int().min(50).max(15_000),
})

export const WaitForUrlStep = base.extend({
  type: z.literal('WAIT_FOR_URL'),
  url: URL_SCHEMA,
  timeoutMs: z.number().int().min(100).max(30_000).optional(),
})

export const AssertVisibleStep = base.extend({
  type: z.literal('ASSERT_VISIBLE'),
  selector: SELECTOR_SCHEMA,
})

export const AssertHiddenStep = base.extend({
  type: z.literal('ASSERT_HIDDEN'),
  selector: SELECTOR_SCHEMA,
})

export const AssertTextStep = base.extend({
  type: z.literal('ASSERT_TEXT'),
  selector: SELECTOR_SCHEMA,
  // Text assertions never accept secrets — asserting on a secret value would
  // leak it through error messages or screenshots.
  text: z.string().min(1).max(1000),
  exact: z.boolean().optional(),
})

export const AssertUrlStep = base.extend({
  type: z.literal('ASSERT_URL'),
  url: URL_SCHEMA,
  exact: z.boolean().optional(),
})

export const AssertTitleStep = base.extend({
  type: z.literal('ASSERT_TITLE'),
  text: z.string().min(1).max(500),
  exact: z.boolean().optional(),
})

export const ScreenshotStep = base.extend({
  type: z.literal('SCREENSHOT'),
  fullPage: z.boolean().optional(),
  label: z.string().max(100).optional(),
})

export const CustomSafeScriptStep = base.extend({
  type: z.literal('CUSTOM_SAFE_SCRIPT'),
  scriptId: z.enum(SAFE_SCRIPT_IDS),
})

export const JourneyStepSchema = z.discriminatedUnion('type', [
  NavigateStep,
  ClickStep,
  TypeStep,
  SelectStep,
  CheckStep,
  UncheckStep,
  UploadTestFileStep,
  WaitForSelectorStep,
  WaitForTimeoutStep,
  WaitForUrlStep,
  AssertVisibleStep,
  AssertHiddenStep,
  AssertTextStep,
  AssertUrlStep,
  AssertTitleStep,
  ScreenshotStep,
  CustomSafeScriptStep,
])

export type JourneyStep = z.infer<typeof JourneyStepSchema>

export const JourneyStepsSchema = z
  .array(JourneyStepSchema)
  .min(1, 'Journey must contain at least one step')
  .max(100, 'Journey cannot exceed 100 steps')

// ---------------- Run modes ----------------

export type JourneyRunMode = 'PASSIVE' | 'SAFE_INTERACTION' | 'TEST_TRANSACTION' | 'CUSTOM_APPROVED'

/**
 * Steps permitted per run mode (least-privilege).
 * PASSIVE: only observation (navigate, wait, assert, screenshot).
 * SAFE_INTERACTION: + click, type (non-secret), select, check, uncheck.
 * TEST_TRANSACTION: + type with secret, upload test file.
 * CUSTOM_APPROVED: + whitelisted safe scripts.
 */
export const STEP_PERMISSIONS: Record<JourneyRunMode, ReadonlySet<JourneyStepType>> = {
  PASSIVE: new Set<JourneyStepType>([
    'NAVIGATE', 'WAIT_FOR_SELECTOR', 'WAIT_FOR_TIMEOUT', 'WAIT_FOR_URL',
    'ASSERT_VISIBLE', 'ASSERT_HIDDEN', 'ASSERT_TEXT', 'ASSERT_URL', 'ASSERT_TITLE',
    'SCREENSHOT',
  ]),
  SAFE_INTERACTION: new Set<JourneyStepType>([
    'NAVIGATE', 'CLICK', 'TYPE', 'SELECT', 'CHECK', 'UNCHECK',
    'WAIT_FOR_SELECTOR', 'WAIT_FOR_TIMEOUT', 'WAIT_FOR_URL',
    'ASSERT_VISIBLE', 'ASSERT_HIDDEN', 'ASSERT_TEXT', 'ASSERT_URL', 'ASSERT_TITLE',
    'SCREENSHOT',
  ]),
  TEST_TRANSACTION: new Set<JourneyStepType>([
    'NAVIGATE', 'CLICK', 'TYPE', 'SELECT', 'CHECK', 'UNCHECK', 'UPLOAD_TEST_FILE',
    'WAIT_FOR_SELECTOR', 'WAIT_FOR_TIMEOUT', 'WAIT_FOR_URL',
    'ASSERT_VISIBLE', 'ASSERT_HIDDEN', 'ASSERT_TEXT', 'ASSERT_URL', 'ASSERT_TITLE',
    'SCREENSHOT',
  ]),
  CUSTOM_APPROVED: new Set<JourneyStepType>([
    'NAVIGATE', 'CLICK', 'TYPE', 'SELECT', 'CHECK', 'UNCHECK', 'UPLOAD_TEST_FILE',
    'CUSTOM_SAFE_SCRIPT',
    'WAIT_FOR_SELECTOR', 'WAIT_FOR_TIMEOUT', 'WAIT_FOR_URL',
    'ASSERT_VISIBLE', 'ASSERT_HIDDEN', 'ASSERT_TEXT', 'ASSERT_URL', 'ASSERT_TITLE',
    'SCREENSHOT',
  ]),
}

export function isStepAllowedForMode(stepType: JourneyStepType, mode: JourneyRunMode): boolean {
  return STEP_PERMISSIONS[mode].has(stepType)
}

/** Serialize steps for storage as JSON. */
export function serializeSteps(steps: JourneyStep[]): string {
  return JSON.stringify(steps)
}

/** Parse + validate steps from stored JSON. Throws ZodError on invalid. */
export function parseSteps(json: string): JourneyStep[] {
  return JourneyStepsSchema.parse(JSON.parse(json))
}

/** Safely parse steps — returns { success, data?, error? }. */
export function safeParseSteps(json: string):
  | { success: true; data: JourneyStep[] }
  | { success: false; error: string } {
  try {
    const parsed = JSON.parse(json)
    const result = JourneyStepsSchema.safeParse(parsed)
    if (!result.success) {
      return { success: false, error: result.error.message }
    }
    return { success: true, data: result.data }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Invalid JSON' }
  }
}
