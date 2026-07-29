/**
 * Prompt-injection & content-safety controls — ProofPilot (Phase 8)
 *
 * These utilities are the foundation under the versioned-prompt wrapper
 * (`run-task.ts`). Every piece of untrusted content that reaches a model —
 * page HTML, console output, error messages, element snippets — MUST pass
 * through `delimitUntrusted` so a malicious page cannot embed instructions
 * that the model mistakes for our system prompt (indirect prompt injection).
 *
 * Controls implemented here (see THREAT_MODEL.md §"AI" + SECURITY_MODEL.md
 * §"AI controls"):
 *
 *   1. delimitUntrusted  — wraps untrusted content in a randomized fence the
 *      content itself cannot forge. The model is instructed (in the system
 *      prompt) to treat everything inside the fence as DATA, never commands.
 *
 *   2. truncateForPrompt — caps untrusted content size so a single huge page
 *      cannot blow the context window or the per-run token budget.
 *
 *   3. redactPii         — scrubs common PII / secret patterns (emails, phone
 *      numbers, credit-card-like runs, JWTs, AWS / GitHub / Stripe / Google /
 *      Slack API keys) before the text is sent to any provider. Defense in
 *      depth on top of the scanner's own secret detection — a leaked key in
 *      page HTML should never reach an LLM.
 *
 *   4. assertNoSecretRefs — rejects any text still containing a `{{secret.X}}`
 *      token. Secret refs must be resolved inside the worker BEFORE the prompt
 *      is assembled; this guard catches a caller that forgot.
 *
 * These are intentionally pure, side-effect-free functions so they can be unit
 * tested without a provider or database.
 */
import { randomBytes } from 'crypto'

/**
 * Hard cap on the size of any single untrusted content block fed to a model.
 * ~50k chars ≈ ~12k tokens, leaving headroom for the system prompt + output
 * budget within typical 16k–32k context windows. Callers may pass a smaller
 * `maxChars` per call.
 */
export const MAX_UNTRUSTED_CONTENT_CHARS = 50_000

// ---------------- 1. Delimit untrusted content ----------------

export interface DelimitedContent {
  /** The full text including fences, ready to embed in a user message. */
  block: string
  /** The fence token used (for assertions / logging). */
  fence: string
}

/**
 * Wrap `content` in a clearly-delimited block so the model treats it as data.
 *
 * The fence token is randomized per call (8 hex chars) so untrusted content
 * cannot pre-emptively include the closing fence. The block is labelled so the
 * model understands what kind of data it is looking at.
 *
 * Example output:
 *   <<<UNTRUSTED_PAGE_HTML_3f9a2c1d>>>
 *   <html>...page content...</html>
 *   <<<END_UNTRUSTED_PAGE_HTML_3f9a2c1d>>>
 */
export function delimitUntrusted(
  content: string,
  label: string = 'CONTENT',
): DelimitedContent {
  if (typeof content !== 'string') {
    throw new TypeError('delimitUntrusted: content must be a string')
  }
  // Sanitize the label: uppercase letters / digits / underscore only, capped.
  const safeLabel = label
    .toUpperCase()
    .replace(/[^A-Z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32) || 'CONTENT'

  const fence = randomBytes(4).toString('hex')
  const open = `<<<UNTRUSTED_${safeLabel}_${fence}>>>`
  const close = `<<<END_UNTRUSTED_${safeLabel}_${fence}>>>`
  const block = `${open}\n${content}\n${close}`
  return { block, fence }
}

// ---------------- 2. Truncate ----------------

/**
 * Cap `content` to `maxChars`. If truncation occurs, a visible marker is
 * appended so the model knows the data was cut (and won't hallucinate the
 * missing tail). Defaults to MAX_UNTRUSTED_CONTENT_CHARS.
 */
export function truncateForPrompt(
  content: string,
  maxChars: number = MAX_UNTRUSTED_CONTENT_CHARS,
): string {
  if (typeof content !== 'string') return ''
  if (content.length <= maxChars) return content
  // Leave room for the truncation marker.
  const marker = '\n…[truncated: content exceeded prompt size limit]'
  return content.slice(0, Math.max(0, maxChars - marker.length)) + marker
}

/**
 * Convenience: delimit + truncate in one call. This is the typical path for
 * untrusted page content destined for a prompt.
 */
export function prepareUntrusted(
  content: string,
  label: string,
  maxChars: number = MAX_UNTRUSTED_CONTENT_CHARS,
): string {
  return delimitUntrusted(truncateForPrompt(content, maxChars), label).block
}

// ---------------- 3. PII / secret redaction ----------------

/**
 * Ordered list of (pattern → replacement). Order matters: longer/more-specific
 * patterns run first so they aren't shadowed by shorter ones (e.g. a JWT before
 * the generic long-token sweep).
 */
const REDACTION_RULES: ReadonlyArray<{ pattern: RegExp; replacement: string; name: string }> = [
  // JWTs (three base64url segments, starts with eyJ).
  { name: 'jwt', replacement: '[REDACTED_JWT]', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  // AWS access key IDs.
  { name: 'aws_access_key', replacement: '[REDACTED_AWS_KEY]', pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  // GitHub tokens (ghp_/gho_/ghu_/ghs_/ghr_).
  { name: 'github_token', replacement: '[REDACTED_GITHUB_TOKEN]', pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  // Stripe keys (sk_/pk_/rk_ live or test).
  { name: 'stripe_key', replacement: '[REDACTED_STRIPE_KEY]', pattern: /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g },
  // Google API keys.
  { name: 'google_api_key', replacement: '[REDACTED_GOOGLE_KEY]', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  // Slack tokens.
  { name: 'slack_token', replacement: '[REDACTED_SLACK_TOKEN]', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  // Email addresses.
  { name: 'email', replacement: '[REDACTED_EMAIL]', pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  // Credit-card-like runs (13–19 digits, optional spaces/dashes).
  { name: 'credit_card', replacement: '[REDACTED_CC]', pattern: /\b(?:\d[ -]?){13,19}\b/g },
  // Phone numbers: 7+ digits with optional +, spaces, dashes, parentheses.
  { name: 'phone', replacement: '[REDACTED_PHONE]', pattern: /(?:\+?\d[\d\s().-]{6,}\d)/g },
  // SSN-like (US).
  { name: 'ssn', replacement: '[REDACTED_SSN]', pattern: /\b\d{3}-\d{2}-\d{4}\b/g },
]

export interface RedactionResult {
  redacted: string
  /** How many replacements were made, broken down by rule name. */
  counts: Record<string, number>
  totalRedacted: number
}

/**
 * Redact common PII and secret-like substrings from `text`. Returns the cleaned
 * text plus per-rule counts so callers can audit/log how much was scrubbed.
 *
 * This is conservative: false-positives (redacting a benign long number) are
 * acceptable; false-negatives (leaving a real key) are not. It is a defense in
 * depth on top of the scanner's own `secret_in_dom` analyzer — by the time text
 * reaches a model it should already be clean, but this guarantees it.
 */
export function redactPii(text: string): RedactionResult {
  if (typeof text !== 'string' || text.length === 0) {
    return { redacted: text ?? '', counts: {}, totalRedacted: 0 }
  }
  let working = text
  const counts: Record<string, number> = {}
  let total = 0
  for (const rule of REDACTION_RULES) {
    // Reset lastIndex in case the regex has the global flag and was reused.
    rule.pattern.lastIndex = 0
    const matches = working.match(rule.pattern)
    if (matches && matches.length > 0) {
      counts[rule.name] = matches.length
      total += matches.length
      working = working.replace(rule.pattern, rule.replacement)
    }
  }
  return { redacted: working, counts, totalRedacted: total }
}

// ---------------- 4. Secret-reference guard ----------------

/**
 * Matches an unresolved project-secret reference: `{{secret.NAME}}`.
 * These MUST be resolved inside the worker (via project-secrets.ts) before the
 * prompt is assembled. A literal token reaching the model would either leak the
 * placeholder (harmless but useless) or, worse, confuse the model. The resolved
 * secret value must NEVER be sent to the model — only the worker uses it.
 */
const SECRET_REF_PATTERN = /\{\{secret\.[A-Z0-9_]{1,64}\}\}/

/**
 * Throws if `text` contains an unresolved `{{secret.NAME}}` reference. Call this
 * on every user-message fragment before handing it to a provider. This is a
 * defense-in-depth guard: the correct flow is to resolve secrets in the worker
 * and only pass non-secret literals to the prompt builder.
 */
export function assertNoSecretRefs(text: string, context?: string): void {
  if (typeof text !== 'string') return
  const match = text.match(SECRET_REF_PATTERN)
  if (match) {
    throw new Error(
      `Refusing to send unresolved secret reference "${match[0]}" to AI model${
        context ? ` (${context})` : ''
      }. Resolve secret references inside the worker before building the prompt.`,
    )
  }
}

/**
 * Non-throwing variant. Returns true if the text contains a secret reference.
 */
export function containsSecretRef(text: string): boolean {
  return typeof text === 'string' && SECRET_REF_PATTERN.test(text)
}

/**
 * Validate an entire prepared user message (one or more string fragments).
 * Throws on the first unresolved secret reference found.
 */
export function assertMessageSafe(
  fragments: string | string[],
  context?: string,
): void {
  const parts = Array.isArray(fragments) ? fragments : [fragments]
  for (let i = 0; i < parts.length; i++) {
    assertNoSecretRefs(parts[i], context ? `${context}[fragment ${i}]` : `fragment ${i}`)
  }
}
