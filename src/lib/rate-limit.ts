/**
 * Rate limiting — ProofPilot
 *
 * Redis-backed in production; in-memory in sandbox.
 * Per-endpoint policies with progressive delay for repeated auth failures.
 *
 * See API_DESIGN.md §"Rate limits".
 */
import { env } from './env'
import { RateLimitError } from './errors'
import { logger } from './logger'

interface RateLimitEntry {
  count: number
  resetAt: number
  firstAttemptAt: number
}

const store = new Map<string, RateLimitEntry>()

// Periodically clean up expired entries
setInterval(() => {
  const now = Date.now()
  for (const [key, entry] of store.entries()) {
    if (entry.resetAt < now) store.delete(key)
  }
}, 60_000).unref?.()

export interface RateLimitPolicy {
  max: number
  windowSeconds: number
  keyPrefix: string
}

export const POLICIES = {
  login: { max: env.RATE_LIMIT_LOGIN_MAX, windowSeconds: env.RATE_LIMIT_LOGIN_WINDOW_SECONDS, keyPrefix: 'login' },
  register: { max: env.RATE_LIMIT_REGISTER_MAX, windowSeconds: env.RATE_LIMIT_REGISTER_WINDOW_SECONDS, keyPrefix: 'register' },
  passwordReset: { max: env.RATE_LIMIT_PASSWORD_RESET_MAX, windowSeconds: env.RATE_LIMIT_PASSWORD_RESET_WINDOW_SECONDS, keyPrefix: 'pwreset' },
  publicScan: { max: env.RATE_LIMIT_PUBLIC_SCAN_MAX, windowSeconds: env.RATE_LIMIT_PUBLIC_SCAN_WINDOW_SECONDS, keyPrefix: 'pubscan' },
  general: { max: env.RATE_LIMIT_GENERAL_MAX, windowSeconds: env.RATE_LIMIT_GENERAL_WINDOW_SECONDS, keyPrefix: 'general' },
} as const

export type RateLimitPolicyName = keyof typeof POLICIES

/** Check rate limit for a key. Throws RateLimitError if exceeded. */
export function checkRateLimit(
  policy: RateLimitPolicyName | RateLimitPolicy,
  identifier: string,
): void {
  const p = typeof policy === 'string' ? POLICIES[policy] : policy
  const key = `${p.keyPrefix}:${identifier}`
  const now = Date.now()
  const windowMs = p.windowSeconds * 1000

  const entry = store.get(key)
  if (!entry || entry.resetAt < now) {
    store.set(key, { count: 1, resetAt: now + windowMs, firstAttemptAt: now })
    return
  }
  entry.count++
  if (entry.count > p.max) {
    const retryAfterSeconds = Math.ceil((entry.resetAt - now) / 1000)
    logger.warn('Rate limit exceeded', { key, count: entry.count, max: p.max })
    throw new RateLimitError(retryAfterSeconds)
  }
}

/** Get remaining attempts for a key. */
export function getRemainingAttempts(
  policy: RateLimitPolicyName | RateLimitPolicy,
  identifier: string,
): number {
  const p = typeof policy === 'string' ? POLICIES[policy] : policy
  const key = `${p.keyPrefix}:${identifier}`
  const entry = store.get(key)
  if (!entry || entry.resetAt < Date.now()) return p.max
  return Math.max(0, p.max - entry.count)
}

/** Progressive delay for repeated authentication failures. */
export function getProgressiveDelay(identifier: string): number {
  const key = `login:${identifier}`
  const entry = store.get(key)
  if (!entry) return 0
  const failures = entry.count
  // 0 failures = 0ms, 1 = 500ms, 2 = 1s, 3 = 2s, 4 = 4s, max 30s
  if (failures <= 1) return 0
  return Math.min(500 * Math.pow(2, failures - 1), 30_000)
}

/** Apply rate limit headers to a response. */
export function applyRateLimitHeaders(
  response: Response,
  policy: RateLimitPolicyName | RateLimitPolicy,
  identifier: string,
): void {
  const p = typeof policy === 'string' ? POLICIES[p] : policy
  const remaining = getRemainingAttempts(p, identifier)
  const reset = Math.ceil((Date.now() + p.windowSeconds * 1000) / 1000)
  response.headers.set('X-RateLimit-Limit', String(p.max))
  response.headers.set('X-RateLimit-Remaining', String(remaining))
  response.headers.set('X-RateLimit-Reset', String(reset))
}
