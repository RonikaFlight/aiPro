/**
 * Crawl engine — ProofPilot worker
 *
 * Discovers pages by following same-origin links from the seed URL,
 * subject to:
 *   - max depth (default 3)
 *   - max pages (default 20, capped at WORKER_MAX_PAGES_PER_RUN)
 *   - per-page timeout (default 60s)
 *   - total timeout (default 5 min)
 *   - same-origin only (must be in allowedOrigins)
 *   - URL normalization (drop fragment, sort query, deduplicate)
 *   - logout/destructive action avoidance (skip URLs matching blocklist)
 *   - redirect revalidation (must remain in allowedOrigins)
 *
 * For each discovered page, captures:
 *   - URL (final, after redirects)
 *   - Title, lang, dir
 *   - HTTP status, content type
 *   - Redirect chain
 *   - Console errors, page errors
 *   - Screenshot (full-page PNG)
 *   - DOM snapshot (HTML)
 *
 * See SECURITY_MODEL.md §"Crawl policy" and THREAT_MODEL.md T11.
 */
import type { BrowserContext, Page } from 'playwright'
import { env } from '../../../src/lib/env'
import { logger } from '../../../src/lib/logger'
import { normalizeUrl } from '../../../src/lib/safe-url'
import { navigateSafely } from './browser'

// Multilingual logout/destructive URL patterns — skip these to avoid being logged out
// or triggering destructive actions during a PASSIVE scan.
const DESTRUCTIVE_PATTERNS: RegExp[] = [
  /\/logout/i, /\/log-out/i, /\/signout/i, /\/sign-out/i, /\/sign_off/i, /\/deconnexion/i, /\/abmeldung/i, /\/sair/i, /\/salir/i, /\/uitschrijven/i,
  /\/delete/i, /\/remove/i, /\/destroy/i, /\/purge/i, /\/reset/i, /\/wipe/i,
  /\/unsubscribe/i, /\/cancel/i,
  /\/admin\/delete/i, /\/admin\/reset/i, /\/admin\/purge/i,
  /\baction=delete\b/i, /\baction=remove\b/i, /\baction=logout\b/i, /\baction=reset\b/i,
  /\bop=delete\b/i, /\bop=logout\b/i,
  /\bcmd=delete\b/i, /\bcmd=logout\b/i,
  /\bdo=delete\b/i, /\bdo=logout\b/i,
  /\bmethod=delete\b/i, /\b_method=delete\b/i,
  /\bcsrf=delete\b/i,
]

export interface CrawlPage {
  url: string
  normalizedUrl: string
  title: string | null
  httpStatus: number | null
  contentType: string | null
  redirectChain: string[]
  lang: string | null
  dir: string | null
  depth: number
  discoveredAt: Date
  consoleErrors: Array<{ type: string; text: string; url?: string; line?: number; column?: number }>
  pageErrors: string[]
  screenshot?: Buffer
  html?: string
  canonical?: string | null
}

export interface CrawlOptions {
  seedUrl: string
  allowedOrigins: string[]
  maxDepth: number
  maxPages: number
  perPageTimeoutMs: number
  totalTimeoutMs: number
  viewport?: { width: number; height: number }
  locale?: string
  /** Capture screenshots + HTML (default true). */
  captureArtifacts?: boolean
}

export interface CrawlResult {
  pages: CrawlPage[]
  discovered: number
  analyzed: number
  skipped: number
  timedOut: boolean
  durationMs: number
}

/**
 * Crawl a site starting from `seedUrl`. Returns all discovered pages.
 */
export async function crawl(context: BrowserContext, opts: CrawlOptions): Promise<CrawlResult> {
  const startedAt = Date.now()
  const maxPages = Math.min(opts.maxPages, env.WORKER_MAX_PAGES_PER_RUN)
  const visited = new Set<string>()
  const pages: CrawlPage[] = []
  const queue: Array<{ url: string; depth: number }> = [{ url: opts.seedUrl, depth: 0 }]
  let skipped = 0
  let timedOut = false

  const totalDeadline = startedAt + opts.totalTimeoutMs

  while (queue.length > 0 && pages.length < maxPages) {
    if (Date.now() > totalDeadline) {
      logger.warn('Crawl timed out (total)', { pagesFound: pages.length, queueRemaining: queue.length })
      timedOut = true
      break
    }

    const { url, depth } = queue.shift()!
    const normalized = normalizeUrl(url)
    if (visited.has(normalized)) continue
    visited.add(normalized)

    // Skip destructive URLs
    if (DESTRUCTIVE_PATTERNS.some((p) => p.test(url))) {
      logger.debug('Skipping destructive URL', { url })
      skipped++
      continue
    }

    // Verify origin is in allowlist
    let origin: string
    try {
      origin = new URL(url).origin
    } catch {
      skipped++
      continue
    }
    if (!opts.allowedOrigins.includes(origin)) {
      skipped++
      continue
    }

    if (depth > opts.maxDepth) {
      skipped++
      continue
    }

    // Crawl the page
    let page: Page | null = null
    try {
      page = await context.newPage()
      const consoleErrors: CrawlPage['consoleErrors'] = []
      const pageErrors: string[] = []

      page.on('console', (msg) => {
        if (msg.type() === 'error') {
          const loc = msg.location()
          consoleErrors.push({
            type: msg.type(),
            text: msg.text(),
            url: loc.url,
            line: loc.lineNumber,
            column: loc.columnNumber,
          })
        }
      })
      page.on('pageerror', (err) => {
        pageErrors.push(err.message)
      })

      // Apply viewport + locale to this page (overrides context defaults if needed)
      if (opts.viewport) {
        await page.setViewportSize(opts.viewport)
      }

      const result = await navigateSafely(page, url, opts.allowedOrigins, {
        timeoutMs: opts.perPageTimeoutMs,
        waitUntil: 'domcontentloaded',
      })

      // Capture metadata
      const title = result.title || null
      const httpStatus = await page.evaluate(() => (window as unknown as { __proofpilot_status?: number }).__proofpilot_status ?? null).catch(() => null)
      const contentType = await page.evaluate(() => document.contentType).catch(() => null)
      const canonical = await page.evaluate(() => {
        const link = document.querySelector('link[rel="canonical"]') as HTMLLinkElement | null
        return link?.href ?? null
      }).catch(() => null)

      // Capture artifacts
      let screenshot: Buffer | undefined
      let html: string | undefined
      if (opts.captureArtifacts !== false) {
        try {
          screenshot = await page.screenshot({ fullPage: true, type: 'png', timeout: 10_000 })
        } catch (err) {
          logger.debug('Screenshot failed', { url, error: String(err) })
        }
        try {
          html = await page.content()
        } catch {
          // ignore
        }
      }

      // Discover links
      if (depth < opts.maxDepth) {
        const links = await page.evaluate((originArg) => {
          const out: string[] = []
          for (const a of Array.from(document.querySelectorAll('a[href]'))) {
            const href = (a as HTMLAnchorElement).href
            if (!href) continue
            try {
              const u = new URL(href, window.location.href)
              if (u.origin === originArg || u.origin === window.location.origin) {
                out.push(u.href.split('#')[0])
              }
            } catch {
              // ignore
            }
          }
          return out
        }, origin).catch(() => [] as string[])

        for (const link of links) {
          const normalizedLink = normalizeUrl(link)
          if (!visited.has(normalizedLink) && !queue.some((q) => normalizeUrl(q.url) === normalizedLink)) {
            queue.push({ url: link, depth: depth + 1 })
          }
        }
      }

      pages.push({
        url: result.finalUrl,
        normalizedUrl: normalizeUrl(result.finalUrl),
        title,
        httpStatus,
        contentType,
        redirectChain: result.redirectChain,
        lang: result.lang,
        dir: result.dir,
        depth,
        discoveredAt: new Date(),
        consoleErrors,
        pageErrors,
        screenshot,
        html,
        canonical,
      })

      logger.debug('Crawled page', { url: result.finalUrl, title, depth, linksFound: queue.length })
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      logger.warn('Page crawl failed', { url, error: reason })
      pages.push({
        url,
        normalizedUrl: normalized,
        title: null,
        httpStatus: null,
        contentType: null,
        redirectChain: [],
        lang: null,
        dir: null,
        depth,
        discoveredAt: new Date(),
        consoleErrors: [],
        pageErrors: [reason],
      })
      skipped++
    } finally {
      if (page) {
        try {
          await page.close()
        } catch {
          // ignore
        }
      }
    }
  }

  return {
    pages,
    discovered: pages.length,
    analyzed: pages.length,
    skipped,
    timedOut,
    durationMs: Date.now() - startedAt,
  }
}
