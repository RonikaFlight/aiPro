/**
 * CSRF protection — ProofPilot
 *
 * Because authentication uses cookies, we validate Origin/Referer for
 * state-changing requests and require a CSRF token for browser requests.
 * The token is HMAC-signed and self-verifying (no server-side storage needed).
 * Frontend stores it in memory and sends it in the X-CSRF-Token header.
 * Exempt only verified external webhook endpoints.
 *
 * See SECURITY_MODEL.md §"CSRF protection".
 */
import { hmacSha256, timingSafeEqual } from './crypto'
import { env } from './env'
import { ForbiddenError } from './errors'

/** Generate a CSRF token bound to a random secret + timestamp. */
export function generateCsrfToken(): { token: string; maxAge: number } {
  const nonce = Math.random().toString(36).slice(2, 18)
  const ts = Date.now().toString(36)
  const sig = hmacSha256(env.CSRF_SECRET, `${nonce}.${ts}`)
  return {
    token: `${nonce}.${ts}.${sig}`,
    maxAge: 60 * 60, // 1 hour
  }
}

/** Verify a CSRF token from the X-CSRF-Token header. */
export function verifyCsrfToken(token: string | null | undefined): boolean {
  if (!token || typeof token !== 'string') return false
  const parts = token.split('.')
  if (parts.length !== 3) return false
  const [nonce, ts, sig] = parts
  const expected = hmacSha256(env.CSRF_SECRET, `${nonce}.${ts}`)
  if (!timingSafeEqual(sig, expected)) return false

  // Check timestamp (1 hour window)
  const tsNum = parseInt(ts, 36)
  if (isNaN(tsNum)) return false
  const ageMs = Date.now() - tsNum
  if (ageMs > 60 * 60 * 1000 || ageMs < -5000) return false

  return true
}

/** Issue a CSRF token (stateless — no cookie needed since the token is self-verifying). */
export function issueCsrfToken(): { token: string } {
  return generateCsrfToken()
}

/** Validate CSRF for a state-changing request. Throws if invalid. */
export function assertCsrf(request: Request): void {
  // Exempt verified webhook endpoints (signature-gated)
  const url = new URL(request.url)
  if (
    url.pathname.startsWith('/api/v1/webhooks/') ||
    url.pathname.startsWith('/api/v1/deployment-hooks/')
  ) {
    return
  }

  // Check Origin / Referer
  // In development mode, skip strict origin checking — CSRF tokens still protect
  // state-changing requests. In production, validate origins strictly.
  if (env.APP_ENV === 'development') {
    // Still require Origin or Referer to exist (just not validate its value)
    const origin = request.headers.get('origin')
    const referer = request.headers.get('referer')
    if (!origin && !referer) {
      throw new ForbiddenError('Missing Origin/Referer header')
    }
    // Proceed to CSRF token check below (skip origin matching)
  } else {
    const origin = request.headers.get('origin')
    const referer = request.headers.get('referer')
    const allowedOrigins = [env.APP_URL]

    // Also allow the origin derived from the request's own Host header
    // so requests through reverse proxies (Caddy, etc.) are accepted
    const hostHeader = request.headers.get('host')
    if (hostHeader) {
      const protocol = request.headers.get('x-forwarded-proto') || 'https'
      allowedOrigins.push(`${protocol}://${hostHeader}`)
    }

    if (origin) {
      if (!allowedOrigins.includes(origin)) {
        throw new ForbiddenError(`Invalid Origin: ${origin}`)
      }
    } else if (referer) {
      try {
        const refererUrl = new URL(referer)
        if (!allowedOrigins.includes(refererUrl.origin)) {
          throw new ForbiddenError(`Invalid Referer: ${refererUrl.origin}`)
        }
      } catch {
        throw new ForbiddenError('Malformed Referer')
      }
    } else {
      throw new ForbiddenError('Missing Origin/Referer header')
    }
  }

  // Check CSRF token (for non-GET requests)
  if (request.method !== 'GET' && request.method !== 'HEAD' && request.method !== 'OPTIONS') {
    const csrfToken = request.headers.get('x-csrf-token')
    if (!csrfToken || !verifyCsrfToken(csrfToken)) {
      throw new ForbiddenError('Invalid or missing CSRF token')
    }
  }
}
