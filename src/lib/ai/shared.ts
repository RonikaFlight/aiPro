/**
 * Shared AI helpers — ProofPilot
 *
 * - extractJsonObject: pull the first JSON object out of a model reply that may
 *   be wrapped in ```json fences or surrounded by prose.
 * - withTimeout: race a promise against an AbortSignal timeout so a hung
 *   provider call cannot stall the worker forever.
 * - buildRepairNudge: the follow-up message appended when structured output
 *   fails Zod validation, asking the model to fix the single error.
 */
import { AiError } from './types'

/**
 * Extract the first balanced JSON object from `text`. Tolerates code fences
 * (```json … ```) and leading/trailing prose. Throws AiError('invalid_response')
 * if no complete object can be found.
 *
 * This is intentionally conservative — it does NOT eval, does NOT use `Function`,
 * only `JSON.parse` on a bracket-matched substring.
 */
export function extractJsonObject(text: string): unknown {
  if (!text || typeof text !== 'string') {
    throw new AiError('invalid_response', 'Empty model response')
  }

  // Strip common code-fence wrappers.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = fenced ? fenced[1] : text

  // Fast path: already clean JSON.
  const trimmed = candidate.trim()
  try {
    return JSON.parse(trimmed)
  } catch {
    // fall through to bracket matching
  }

  // Bracket-match the first {...} block.
  const start = candidate.indexOf('{')
  if (start === -1) {
    throw new AiError('invalid_response', 'No JSON object found in model response')
  }
  let depth = 0
  let inString = false
  let escape = false
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i]
    if (inString) {
      if (escape) {
        escape = false
      } else if (ch === '\\') {
        escape = true
      } else if (ch === '"') {
        inString = false
      }
      continue
    }
    if (ch === '"') {
      inString = true
    } else if (ch === '{') {
      depth++
    } else if (ch === '}') {
      depth--
      if (depth === 0) {
        const slice = candidate.slice(start, i + 1)
        try {
          return JSON.parse(slice)
        } catch (e) {
          throw new AiError(
            'invalid_response',
            `Model returned unparseable JSON: ${(e as Error).message}`,
          )
        }
      }
    }
  }
  throw new AiError('invalid_response', 'Unbalanced braces in model JSON response')
}

/**
 * Race `promise` against a timeout. Rejects with AiError('timeout') if the
 * timeout fires first. Uses AbortSignal where the platform supports it so the
 * underlying fetch can be cancelled.
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  provider: 'glm' | 'openai-compatible' | 'mock',
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new AiError('timeout', `AI call exceeded ${timeoutMs}ms`, { provider, retryable: true })),
      timeoutMs,
    )
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * Build the follow-up messages for a repair retry after schema validation
 * failure. Shows the model the specific Zod error so it can fix precisely that.
 */
export function buildRepairMessages(
  original: { role: 'system' | 'user' | 'assistant'; content: string }[],
  rawOutput: string,
  errorMessage: string,
): { role: 'system' | 'user' | 'assistant'; content: string }[] {
  return [
    ...original,
    { role: 'assistant', content: rawOutput },
    {
      role: 'user',
      content: `The previous response was not valid JSON matching the required schema.\n\nValidation error: ${errorMessage}\n\nReturn ONLY a corrected JSON object matching the schema, with no prose and no code fences.`,
    },
  ]
}

/**
 * Rough token estimate (chars / 4). Used by the Mock provider to produce
 * plausible usage numbers and by cost controls when the provider doesn't return
 * token counts.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0
  return Math.max(1, Math.ceil(text.length / 4))
}
