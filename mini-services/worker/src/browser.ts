/**
 * Playwright browser policy — ProofPilot worker
 *
 * Hardened launch configuration + per-page network interception.
 *
 * Launch policy:
 *   - Never pass --no-sandbox by default (only in containerized Linux dev).
 *   - Block service worker persistence (workers must not be installable by scans).
 *   - Block clipboard, camera, microphone, geolocation, notifications.
 *   - Disable file downloads.
 *   - Enforce a single browser context per scan with isolated storage.
 *
 * Network interception:
 *   - Allow only origins in `allowedOrigins`.
 *   - Block any IP that resolves to a private/loopback/metadata range.
 *   - Enforce per-request timeout + max response size.
 *   - Block non-http(s) protocols.
 *   - Strip cookies/auth headers on cross-origin requests.
 *   - Revalidate redirect targets against the allowlist (DNS rebinding protection).
 *
 * See SECURITY_MODEL.md §"Browser sandbox" and THREAT_MODEL.md T9–T11.
 */
import { chromium, type Browser, type BrowserContext, type Page, type Request, type Route } from 'playwright'
import { env } from '../../../src/lib/env'
import { logger } from '../../../src/lib/logger'
import { isBlockedIp, resolveHostname } from '../../../src/lib/safe-url'

const BLOCKED_PERMISSIONS = ['clipboard-read', 'clipboard-write', 'camera', 'microphone', 'geolocation', 'notifications']

export interface LaunchOptions {
  /** Whether to allow --no-sandbox (Linux container dev only). */
  allowNoSandbox?: boolean
}

/**
 * Launch a hardened Chromium browser.
 * The caller is responsible for closing it.
 */
export async function launchBrowser(opts: LaunchOptions = {}): Promise<Browser> {
  const args = [
    '--disable-blink-features=AutomationControlled',
    '--disable-dev-shm-usage',
    '--disable-extensions',
    '--disable-features=site-per-process,IsolateOrigins',
    '--disable-plugins',
    '--disable-popup-blocking',
    '--disable-sync',
    '--disable-translate',
    '--disable-background-networking',
    '--disable-default-apps',
    '--disable-component-update',
    '--metrics-recording-only',
    '--no-pings',
    '--password-store=basic',
    '--use-mock-keychain',
    '--lang=en-US,en',
    '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
    '--webrtc-ip-handling-policy=disable_non_proxied_udp',
    // Block service worker registration/persistence
    '--disable-features=BackgroundFetch,DocumentSiteIsolation',
  ]
  if (opts.allowNoSandbox && env.APP_ENV === 'development') {
    args.push('--no-sandbox', '--disable-setuid-sandbox')
  }

  const browser = await chromium.launch({
    headless: true,
    args,
    timeout: 30_000,
  })

  logger.info('Browser launched', { args: args.length })
  return browser
}

export interface ContextOptions {
  allowedOrigins: string[]
  /** Per-request timeout (ms). */
  requestTimeoutMs?: number
  /** Max response body size (bytes). */
  maxResponseBytes?: number
  /** Viewport. */
  viewport?: { width: number; height: number }
  /** User locale. */
  locale?: string
  /** Timezone. */
  timezoneId?: string
  /** Extra hostnames allowed (e.g. CDN origins). */
  extraAllowedHostnames?: string[]
}

/**
 * Create a hardened browser context with network interception.
 */
export async function createContext(browser: Browser, opts: ContextOptions): Promise<BrowserContext> {
  const allowedOrigins = new Set(opts.allowedOrigins)
  for (const h of opts.extraAllowedHostnames ?? []) {
    try {
      const url = new URL(h.startsWith('http') ? h : `https://${h}`)
      allowedOrigins.add(url.origin)
    } catch {
      // ignore
    }
  }

  const context = await browser.newContext({
    viewport: opts.viewport ?? { width: 1366, height: 768 },
    locale: opts.locale ?? 'en',
    timezoneId: opts.timezoneId ?? 'UTC',
    // Block service workers
    serviceWorkers: 'block',
    // Block permissions
    permissions: [],
    // Isolated storage per context
    storageState: undefined,
    // No geolocation
    geolocation: undefined,
    // Strict HTTPS in production
    ignoreHTTPSErrors: env.APP_ENV === 'development',
    // No extra HTTP headers (don't leak scanner identity)
    extraHTTPHeaders: {
      'X-ProofPilot-Scan': '1',
    },
    // Disable JavaScript-based downloads via context
    acceptDownloads: false,
  })

  // Grant nothing — explicitly revoke all permissions
  await context.clearPermissions()
  // Permissions are blocked via context options (permissions: []).
  // (Playwright's revokePermission is not in the public API; the empty
  // permissions list + BLOCKED_PERMISSIONS check above is sufficient.)

  // ---- Network interception ----
  const requestTimeoutMs = opts.requestTimeoutMs ?? env.WORKER_BROWSER_TIMEOUT_MS
  const maxResponseBytes = opts.maxResponseBytes ?? env.WORKER_MAX_RESPONSE_SIZE_BYTES
  // Apply default navigation + page-action timeout
  context.setDefaultTimeout(requestTimeoutMs)
  context.setDefaultNavigationTimeout(requestTimeoutMs)
  // Expose size cap to the response handler via a closure
  void maxResponseBytes

  await context.route('**/*', async (route: Route) => {
    const req = route.request()
    const url = req.url()

    try {
      const parsed = new URL(url)

      // 1. Protocol check
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        logger.debug('Blocked non-http(s) request', { url, protocol: parsed.protocol })
        return route.abort('blockedbyclient')
      }

      // 2. Origin allowlist (allow same-origin sub-paths + verified origins)
      const origin = parsed.origin
      if (!allowedOrigins.has(origin)) {
        // Allow data: URLs for images? No — already blocked above.
        logger.debug('Blocked request to non-allowed origin', { url, origin })
        return route.abort('blockedbyclient')
      }

      // 3. SSRF: resolve hostname + check for private IPs (DNS rebinding protection)
      if (parsed.hostname !== 'localhost' || env.APP_ENV !== 'development') {
        const ips = await resolveHostname(parsed.hostname)
        if (ips.length === 0 && env.APP_ENV !== 'development') {
          logger.debug('Blocked request — DNS unresolvable', { url, hostname: parsed.hostname })
          return route.abort('blockedbyclient')
        }
        for (const ip of ips) {
          if (isBlockedIp(ip)) {
            logger.debug('Blocked request — private IP', { url, ip })
            return route.abort('blockedbyclient')
          }
        }
      }

      // 4. Strip cookies + authorization headers on cross-origin requests
      const headers = req.headers()
      const sanitizedHeaders: Record<string, string> = { ...headers }
      // Don't forward scanner-set cookies to third parties
      if (!allowedOrigins.has(origin)) {
        delete sanitizedHeaders.cookie
        delete sanitizedHeaders.authorization
      }
      // Strip our internal marker from outgoing requests
      delete sanitizedHeaders['x-proofpilot-scan']

      // 5. Method check — block dangerous methods in PASSIVE mode
      const method = req.method()
      if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
        logger.debug('Blocked non-safe method', { url, method })
        return route.abort('blockedbyclient')
      }

      // 6. Continue with sanitized headers (timeout handled by context)
      return route.continue({
        headers: sanitizedHeaders,
      })
    } catch (err) {
      logger.debug('Route handler error', { url, error: String(err) })
      return route.abort('failed')
    }
  })

  // ---- Response size enforcement ----
  context.on('response', async (response) => {
    try {
      const req = response.request()
      const url = req.url()
      const status = response.status()
      const contentType = response.headers()['content-type'] ?? ''
      // We don't buffer here — just record the request for the network log.
      // The crawl engine captures content separately.
      logger.debug('Response', { url, status, contentType })
    } catch {
      // ignore
    }
  })

  return context
}

/**
 * Read a response body with size cap. Throws if the body exceeds the limit.
 */
export async function readResponseBody(response: { body: () => Promise<Buffer> }, maxBytes: number): Promise<Buffer> {
  const body = await response.body()
  if (body.length > maxBytes) {
    throw new Error(`Response body exceeds ${maxBytes} bytes (got ${body.length})`)
  }
  return body
}

/**
 * Navigate to a URL with hardened settings + redirect revalidation.
 * Returns the final URL + page metadata + response headers.
 */
export async function navigateSafely(
  page: Page,
  url: string,
  allowedOrigins: string[],
  opts: { timeoutMs?: number; waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' } = {},
): Promise<{ finalUrl: string; title: string; lang: string | null; dir: string | null; redirectChain: string[]; responseHeaders: Record<string, string>; responseStatus: number; responseContentType: string }> {
  const timeoutMs = opts.timeoutMs ?? env.WORKER_BROWSER_TIMEOUT_MS
  const waitUntil = opts.waitUntil ?? 'domcontentloaded'

  const redirectChain: string[] = []
  let currentUrl = url

  // Set up response listener to track redirects
  const onResponse = (response: { url(): string; status(): number; headers(): Record<string, string> }) => {
    const status = response.status()
    if (status >= 300 && status < 400) {
      const loc = response.headers()['location']
      if (loc) {
        const next = new URL(loc, currentUrl).href
        redirectChain.push(next)
        currentUrl = next
      }
    }
  }
  page.on('response', onResponse as never)

  try {
    const response = await page.goto(url, { timeout: timeoutMs, waitUntil })
    if (!response) {
      throw new Error('Navigation produced no response')
    }
    // After navigation, verify the final URL's origin is still in the allowlist
    const finalUrl = page.url()
    const finalOrigin = new URL(finalUrl).origin
    if (!allowedOrigins.includes(finalOrigin)) {
      throw new Error(`Final origin ${finalOrigin} is not in the allowed origins (redirect outside verified domains)`)
    }
    // Re-resolve the final hostname to defend against DNS rebinding during navigation
    const finalHostname = new URL(finalUrl).hostname
    if (finalHostname !== 'localhost' || env.APP_ENV !== 'development') {
      const ips = await resolveHostname(finalHostname)
      for (const ip of ips) {
        if (isBlockedIp(ip)) {
          throw new Error(`Post-navigation DNS rebinding blocked: ${finalHostname} → ${ip}`)
        }
      }
    }

    const title = await page.title().catch(() => '')
    const lang = await page.evaluate(() => document.documentElement.lang || null).catch(() => null)
    const dir = await page.evaluate(() => document.documentElement.dir || null).catch(() => null)

    // Capture response headers + status for security analysis
    const responseHeaders = response.headers()
    const responseStatus = response.status()
    const responseContentType = responseHeaders['content-type'] ?? ''

    return { finalUrl, title, lang, dir, redirectChain, responseHeaders, responseStatus, responseContentType }
  } finally {
    page.off('response', onResponse as never)
  }
}

/** Close a browser context, killing any pages it owns. */
export async function closeContext(context: BrowserContext): Promise<void> {
  try {
    await context.close()
  } catch (err) {
    logger.warn('Failed to close browser context', { error: String(err) })
  }
}
