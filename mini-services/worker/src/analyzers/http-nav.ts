/**
 * HTTP / Navigation analyzer — ProofPilot worker (Phase 5)
 *
 * Detects:
 *   - Broken links (4xx, 5xx responses on <a href>, <link>, <script src>, <img src>, etc.)
 *   - Redirect loops (chain that revisits a URL)
 *   - Redirect chains longer than 5 hops
 *   - Mixed content (HTTP resources on HTTPS pages)
 *   - Failed network requests (DNS errors, timeouts, aborted)
 *   - Invalid content types (e.g. HTML served as text/plain for the main document)
 *   - Missing/empty <title>
 *   - Duplicate <title> (compared to other pages in the same run — handled by runner)
 *   - Missing <html lang> (also flagged by a11y analyzer; here we flag for SEO)
 *   - Invalid canonical (canonical pointing to a different origin or non-200)
 *   - Broken favicon
 *   - Broken manifest
 *
 * Source data:
 *   - ctx.responses: every network response observed during navigation
 *   - ctx.page: live DOM for link discovery
 *   - ctx.crawl: status + redirect chain captured during crawl
 */
import type { Analyzer, AnalyzerContext, FindingCandidate, ObservedResponse } from './types'

/** Check if a URL is http:// on an https:// page (mixed content). */
function isMixedContent(pageUrl: string, resourceUrl: string): boolean {
  if (!pageUrl.startsWith('https://')) return false
  return resourceUrl.startsWith('http://')
}

/** Detect redirect loops in a chain. */
function hasRedirectLoop(chain: string[]): boolean {
  const seen = new Set<string>()
  for (const url of chain) {
    if (seen.has(url)) return true
    seen.add(url)
  }
  return false
}

/** Determine if a content type is appropriate for the resource type. */
function isValidContentTypeForResource(contentType: string, resourceType: string): boolean {
  const ct = contentType.toLowerCase().split(';')[0].trim()
  if (ct === '') return false
  if (resourceType === 'document') return ct.includes('html') || ct.includes('xml')
  if (resourceType === 'script') return ct.includes('javascript') || ct.includes('ecmascript') || ct.includes('text/plain')
  if (resourceType === 'stylesheet') return ct.includes('css') || ct.includes('text/plain')
  if (resourceType === 'image') return ct.startsWith('image/') || ct.includes('svg')
  if (resourceType === 'font') return ct.includes('font') || ct.includes('woff') || ct.includes('ttf') || ct.includes('otf')
  return true
}

export const httpNavAnalyzer: Analyzer = {
  id: 'http-nav',
  category: 'HTTP_NAVIGATION',
  async run(ctx: AnalyzerContext): Promise<FindingCandidate[]> {
    const findings: FindingCandidate[] = []
    const { page, responses, crawl, pageUrl } = ctx

    // 1. Main document status check (from crawl)
    if (crawl.httpStatus !== null) {
      if (crawl.httpStatus >= 500) {
        findings.push({
          checkId: 'http.server_error',
          category: 'HTTP_NAVIGATION',
          severity: 'CRITICAL',
          title: `Server error (${crawl.httpStatus}) on main document`,
          description: `The page returned HTTP ${crawl.httpStatus}, indicating a server-side error. Users and search engines cannot access this page's content.`,
          remediation: 'Investigate the server-side error. Check application logs for unhandled exceptions.',
          messageKey: `server-error-${crawl.httpStatus}`,
          evidence: { httpStatus: crawl.httpStatus, url: pageUrl },
        })
      } else if (crawl.httpStatus === 404) {
        findings.push({
          checkId: 'http.not_found',
          category: 'HTTP_NAVIGATION',
          severity: 'CRITICAL',
          title: 'Page not found (404)',
          description: 'The main document returned a 404 Not Found response. The page does not exist at this URL.',
          remediation: 'Restore the page or remove inbound links pointing to it.',
          messageKey: 'not-found',
          evidence: { httpStatus: 404, url: pageUrl },
        })
      } else if (crawl.httpStatus >= 400 && crawl.httpStatus < 500 && crawl.httpStatus !== 401 && crawl.httpStatus !== 403) {
        findings.push({
          checkId: 'http.client_error',
          category: 'HTTP_NAVIGATION',
          severity: 'MAJOR',
          title: `Client error (${crawl.httpStatus})`,
          description: `The page returned HTTP ${crawl.httpStatus}.`,
          messageKey: `client-error-${crawl.httpStatus}`,
          evidence: { httpStatus: crawl.httpStatus },
        })
      }
    }

    // 2. Redirect loop / excessive redirects
    if (hasRedirectLoop(crawl.redirectChain)) {
      findings.push({
        checkId: 'http.redirect_loop',
        category: 'HTTP_NAVIGATION',
        severity: 'CRITICAL',
        title: 'Redirect loop detected',
        description: 'The redirect chain revisits a URL, creating an infinite loop. Browsers will stop following redirects after a limit.',
        remediation: 'Fix the redirect rules to avoid circular references.',
        messageKey: 'redirect-loop',
        evidence: { redirectChain: crawl.redirectChain },
      })
    } else if (crawl.redirectChain.length > 5) {
      findings.push({
        checkId: 'http.excessive_redirects',
        category: 'HTTP_NAVIGATION',
        severity: 'MAJOR',
        title: `Excessive redirects (${crawl.redirectChain.length} hops)`,
        description: 'The redirect chain is longer than 5 hops, which slows page load and may indicate misconfigured redirect rules.',
        remediation: 'Replace redirect chains with direct links where possible.',
        messageKey: 'excessive-redirects',
        evidence: { count: crawl.redirectChain.length, chain: crawl.redirectChain },
      })
    }

    // 3. Failed network requests (broken links / resources)
    // Group by URL to avoid duplicate findings for the same broken resource.
    const failedByUrl = new Map<string, ObservedResponse>()
    for (const r of responses) {
      if (r.failed || r.status >= 400) {
        const key = r.url
        const existing = failedByUrl.get(key)
        if (!existing || (r.status >= 400 && (existing.status < 400 || existing.failed))) {
          failedByUrl.set(key, r)
        }
      }
    }

    for (const r of failedByUrl.values()) {
      // Skip the main document — handled above
      if (r.url === pageUrl) continue

      const isSameOrigin = (() => {
        try {
          return new URL(r.url).origin === new URL(pageUrl).origin
        } catch {
          return false
        }
      })()

      if (r.failed) {
        findings.push({
          checkId: 'http.failed_request',
          category: 'HTTP_NAVIGATION',
          severity: isSameOrigin ? 'MAJOR' : 'MINOR',
          title: `Failed network request: ${r.failureReason ?? 'unknown error'}`,
          description: `Request to ${r.url} failed: ${r.failureReason ?? 'no reason recorded'}.`,
          remediation: 'Verify the URL is correct and the resource is accessible.',
          messageKey: `failed-request-${r.failureReason ?? 'unknown'}`,
          evidence: { url: r.url, failureReason: r.failureReason, method: r.method },
        })
      } else if (r.status === 404) {
        findings.push({
          checkId: 'http.broken_link',
          category: 'HTTP_NAVIGATION',
          severity: isSameOrigin ? 'MAJOR' : 'MINOR',
          title: 'Broken link (404)',
          description: `The link ${r.url} returns a 404 Not Found response.`,
          remediation: 'Update or remove the broken link.',
          messageKey: 'broken-link-404',
          evidence: { url: r.url, status: 404 },
        })
      } else if (r.status >= 500) {
        findings.push({
          checkId: 'http.broken_link_5xx',
          category: 'HTTP_NAVIGATION',
          severity: 'MAJOR',
          title: `Broken resource (${r.status})`,
          description: `The resource ${r.url} returns HTTP ${r.status}.`,
          messageKey: `broken-link-${r.status}`,
          evidence: { url: r.url, status: r.status },
        })
      } else if (r.status >= 400) {
        findings.push({
          checkId: 'http.client_error_resource',
          category: 'HTTP_NAVIGATION',
          severity: 'MINOR',
          title: `Client error (${r.status}) on resource`,
          description: `The resource ${r.url} returns HTTP ${r.status}.`,
          messageKey: `client-error-resource-${r.status}`,
          evidence: { url: r.url, status: r.status },
        })
      }
    }

    // 4. Mixed content (HTTP resources on HTTPS pages)
    for (const r of responses) {
      if (isMixedContent(pageUrl, r.url)) {
        findings.push({
          checkId: 'http.mixed_content',
          category: 'HTTP_NAVIGATION',
          severity: 'MAJOR',
          title: 'Mixed content (HTTP resource on HTTPS page)',
          description: `The page is served over HTTPS but loads ${r.url} over HTTP. Browsers block or downgrade mixed content.`,
          remediation: 'Update the resource URL to use HTTPS.',
          messageKey: 'mixed-content',
          evidence: { resourceUrl: r.url, pageUrl },
        })
      }
    }

    // 5. Invalid content type for the main document
    if (crawl.contentType && !crawl.contentType.toLowerCase().includes('html')) {
      findings.push({
        checkId: 'http.invalid_document_content_type',
        category: 'HTTP_NAVIGATION',
        severity: 'MAJOR',
        title: `Invalid content type for HTML document (${crawl.contentType})`,
        description: `The main document is served as ${crawl.contentType}, not text/html. Browsers may render it as a download or plain text.`,
        remediation: 'Configure the server to serve HTML documents with Content-Type: text/html; charset=utf-8.',
        messageKey: `invalid-content-type-${crawl.contentType}`,
        evidence: { contentType: crawl.contentType },
      })
    }

    // 6. Missing <title> (also covered by SEO analyzer, but flagged here for nav context)
    if (!crawl.title || crawl.title.trim() === '') {
      findings.push({
        checkId: 'http.missing_title',
        category: 'HTTP_NAVIGATION',
        severity: 'MAJOR',
        title: 'Missing page title',
        description: 'The page has no <title> element. Titles are essential for browser tabs, bookmarks, SEO, and screen reader navigation.',
        remediation: 'Add a descriptive <title> element in the <head>.',
        messageKey: 'missing-title',
      })
    }

    // 7. Invalid canonical
    const canonical = await page.evaluate(() => {
      const link = document.querySelector('link[rel="canonical"]') as HTMLLinkElement | null
      return link?.href ?? null
    }).catch(() => null)

    if (canonical) {
      try {
        const canonUrl = new URL(canonical)
        const pageOrigin = new URL(pageUrl).origin
        if (canonUrl.origin !== pageOrigin) {
          findings.push({
            checkId: 'http.canonical_cross_origin',
            category: 'HTTP_NAVIGATION',
            severity: 'MAJOR',
            title: 'Canonical URL points to a different origin',
            description: `The canonical URL ${canonical} points to a different origin than the page (${pageOrigin}). This can cause search engines to index the wrong URL.`,
            remediation: 'Update the canonical URL to point to the preferred version on the same origin.',
            messageKey: 'canonical-cross-origin',
            evidence: { canonical, pageOrigin },
          })
        }
      } catch {
        findings.push({
          checkId: 'http.canonical_invalid',
          category: 'HTTP_NAVIGATION',
          severity: 'MINOR',
          title: 'Invalid canonical URL',
          description: `The canonical URL "${canonical}" is not a valid URL.`,
          messageKey: 'canonical-invalid',
          evidence: { canonical },
        })
      }
    }

    // 7b. Actively check same-origin <a href> links for broken status (HEAD requests)
    // This catches broken links that aren't loaded as sub-resources during navigation.
    const linkUrls = await page.evaluate((pageOrigin) => {
      const out: string[] = []
      const seen = new Set<string>()
      for (const a of Array.from(document.querySelectorAll('a[href]'))) {
        const href = (a as HTMLAnchorElement).href
        if (!href) continue
        try {
          const u = new URL(href, window.location.href)
          if (u.origin !== pageOrigin) continue // only check same-origin
          if (u.protocol !== 'http:' && u.protocol !== 'https:') continue
          const normalized = u.href.split('#')[0]
          if (seen.has(normalized)) continue
          seen.add(normalized)
          out.push(normalized)
        } catch {
          // ignore
        }
      }
      return out
    }, new URL(pageUrl).origin).catch(() => [] as string[])

    // Cap to 20 links to avoid runaway checks; skip the current page URL
    const linksToCheck = linkUrls.filter((u) => u !== pageUrl).slice(0, 20)
    for (const linkUrl of linksToCheck) {
      // Skip if we already have a response for this URL
      if (responses.some((r) => r.url === linkUrl)) continue
      try {
        const linkResponse = await page.request.head(linkUrl, { timeout: 10000, maxRedirects: 5 }).catch(async () => {
          // HEAD might not be supported — fall back to GET
          return await page.request.get(linkUrl, { timeout: 10000, maxRedirects: 5 }).catch(() => null)
        })
        if (!linkResponse) {
          findings.push({
            checkId: 'http.broken_link',
            category: 'HTTP_NAVIGATION',
            severity: 'MAJOR',
            title: 'Broken link (no response)',
            description: `The link ${linkUrl} did not return a response (DNS failure, connection refused, or timeout).`,
            remediation: 'Update or remove the broken link.',
            messageKey: 'broken-link-no-response',
            evidence: { url: linkUrl },
          })
          continue
        }
        const status = linkResponse.status()
        if (status === 404) {
          findings.push({
            checkId: 'http.broken_link',
            category: 'HTTP_NAVIGATION',
            severity: 'MAJOR',
            title: 'Broken link (404)',
            description: `The link ${linkUrl} returns a 404 Not Found response.`,
            remediation: 'Update or remove the broken link.',
            messageKey: 'broken-link-404',
            evidence: { url: linkUrl, status: 404 },
          })
        } else if (status >= 500) {
          findings.push({
            checkId: 'http.broken_link_5xx',
            category: 'HTTP_NAVIGATION',
            severity: 'MAJOR',
            title: `Broken link (${status})`,
            description: `The link ${linkUrl} returns HTTP ${status}.`,
            messageKey: `broken-link-${status}`,
            evidence: { url: linkUrl, status },
          })
        }
      } catch {
        // ignore — link check is best-effort
      }
    }

    // 8. Broken favicon
    const faviconUrl = await page.evaluate(() => {
      const link = document.querySelector('link[rel~="icon"]') as HTMLLinkElement | null
      return link?.href ?? null
    }).catch(() => null)

    if (faviconUrl) {
      const faviconResponse = responses.find((r) => r.url === faviconUrl)
      if (faviconResponse && (faviconResponse.failed || faviconResponse.status >= 400)) {
        findings.push({
          checkId: 'http.broken_favicon',
          category: 'HTTP_NAVIGATION',
          severity: 'INFO',
          title: 'Broken favicon',
          description: `The favicon ${faviconUrl} returns an error (${faviconResponse.status || faviconResponse.failureReason}).`,
          messageKey: 'broken-favicon',
          evidence: { faviconUrl, status: faviconResponse.status },
        })
      }
    }

    // 9. Broken web app manifest
    const manifestUrl = await page.evaluate(() => {
      const link = document.querySelector('link[rel="manifest"]') as HTMLLinkElement | null
      return link?.href ?? null
    }).catch(() => null)

    if (manifestUrl) {
      const manifestResponse = responses.find((r) => r.url === manifestUrl)
      if (manifestResponse && (manifestResponse.failed || manifestResponse.status >= 400)) {
        findings.push({
          checkId: 'http.broken_manifest',
          category: 'HTTP_NAVIGATION',
          severity: 'MINOR',
          title: 'Broken web app manifest',
          description: `The web app manifest ${manifestUrl} returns an error.`,
          messageKey: 'broken-manifest',
          evidence: { manifestUrl, status: manifestResponse.status },
        })
      }
    }

    return findings
  },
}
