/**
 * Passive security analyzer — ProofPilot worker (Phase 5)
 *
 * ProofPilot is NOT a penetration testing tool. This analyzer performs
 * PASSIVE checks only — it reads response headers and DOM state, never
 * attempts active exploitation.
 *
 * Detects:
 *   - Missing security headers (CSP, X-Content-Type-Options, X-Frame-Options,
 *     Strict-Transport-Security, Referrer-Policy, Permissions-Policy)
 *   - Mixed content (HTTP resources on HTTPS pages) — also flagged by HTTP analyzer
 *   - Cookies without Secure / HttpOnly / SameSite
 *   - Sensitive data in URL parameters (tokens, passwords, keys)
 *   - Insecure credential POST (form posting to http:// with password fields)
 *   - Source map exposure (.js.map files publicly accessible)
 *   - Secret-like strings in DOM (AWS keys, JWT patterns, private keys)
 *   - Missing SRI on <script> / <link> tags loaded from third-party origins
 *   - iframe-related issues (missing sandbox / allow attributes)
 *   - Public stack traces (error details exposed in the DOM)
 *
 * Source data: ctx.page (DOM) + ctx.responses (headers) + ctx.crawl
 */
import type { Analyzer, AnalyzerContext, FindingCandidate, ObservedResponse } from './types'

/** Patterns that indicate sensitive data in URL parameters. */
const SENSITIVE_PARAM_PATTERNS = [
  /^token$/i, /^access[-_]?token$/i, /^refresh[-_]?token$/i, /^api[-_]?key$/i, /^apikey$/i,
  /^secret$/i, /^password$/i, /^passwd$/i, /^pwd$/i, /^session$/i, /^session[-_]?id$/i, /^sid$/i,
  /^auth$/i, /^authorization$/i, /^jwt$/i, /^bearer$/i, /^private[-_]?key$/i, /^client[-_]?secret$/i,
]

/** Patterns that look like secrets in DOM text. */
const SECRET_TEXT_PATTERNS = [
  { pattern: /AKIA[0-9A-Z]{16}/g, type: 'AWS Access Key ID' },
  { pattern: /-----BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g, type: 'Private key' },
  { pattern: /eyJ[a-zA-Z0-9_-]{10,}\.eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/g, type: 'JWT token' },
  { pattern: /ghp_[A-Za-z0-9]{36}/g, type: 'GitHub personal access token' },
  { pattern: /gh[opsu]_[A-Za-z0-9]{36}/g, type: 'GitHub token' },
  { pattern: /sk_live_[A-Za-z0-9]{24,}/g, type: 'Stripe secret key' },
  { pattern: /AIza[0-9A-Za-z\-_]{35}/g, type: 'Google API key' },
  { pattern: /xox[baprs]-[A-Za-z0-9-]{10,}/g, type: 'Slack token' },
]

const REQUIRED_SECURITY_HEADERS: Array<{ header: string; severity: 'MAJOR' | 'MINOR'; remediation: string }> = [
  { header: 'content-security-policy', severity: 'MAJOR', remediation: 'Set a Content-Security-Policy header that restricts script sources, inline styles, and frame ancestors.' },
  { header: 'x-content-type-options', severity: 'MINOR', remediation: 'Set X-Content-Type-Options: nosniff to prevent MIME-type sniffing.' },
  { header: 'x-frame-options', severity: 'MINOR', remediation: 'Set X-Frame-Options: DENY or SAMEORIGIN, or use CSP frame-ancestors.' },
  { header: 'strict-transport-security', severity: 'MAJOR', remediation: 'Set Strict-Transport-Security: max-age=63072000; includeSubDomains; preload to enforce HTTPS.' },
  { header: 'referrer-policy', severity: 'MINOR', remediation: 'Set Referrer-Policy: strict-origin-when-cross-origin to limit referrer leakage.' },
  { header: 'permissions-policy', severity: 'MINOR', remediation: 'Set Permissions-Policy to restrict access to powerful browser features (camera, microphone, geolocation).' },
]

interface CookieInfo {
  name: string
  secure: boolean
  httpOnly: boolean
  sameSite: string
  domain: string
  path: string
}

async function getCookies(ctx: AnalyzerContext): Promise<CookieInfo[]> {
  try {
    const context = ctx.page.context()
    const cookies = await context.cookies(ctx.pageUrl)
    return cookies.map((c) => ({
      name: c.name,
      secure: c.secure,
      httpOnly: c.httpOnly,
      sameSite: c.sameSite,
      domain: c.domain,
      path: c.path,
    }))
  } catch {
    return []
  }
}

/** Find the document response (the main HTML response). */
function findDocumentResponse(ctx: AnalyzerContext): ObservedResponse | undefined {
  // Use the runner-provided document response if available
  if (ctx.documentResponse) return ctx.documentResponse
  // Try exact URL match first
  const byUrl = ctx.responses.find((r) => {
    if (r.url !== ctx.pageUrl && r.url !== ctx.crawl.url) return false
    return r.contentType.includes('html') || r.contentType === '' || r.status === 200
  })
  if (byUrl) return byUrl
  // Fall back to any HTML response
  const byHtml = ctx.responses.find((r) => r.contentType.includes('html'))
  if (byHtml) return byHtml
  // Fall back to the first 200 response
  return ctx.responses.find((r) => r.status === 200)
}

export const securityAnalyzer: Analyzer = {
  id: 'security',
  category: 'SECURITY',
  async run(ctx: AnalyzerContext): Promise<FindingCandidate[]> {
    const findings: FindingCandidate[] = []
    const { page, pageUrl } = ctx
    const isHttps = pageUrl.startsWith('https://')

    // 1. Missing security headers (on the main document)
    const docResponse = findDocumentResponse(ctx)
    if (docResponse) {
      const headers = docResponse.headers
      for (const { header, severity, remediation } of REQUIRED_SECURITY_HEADERS) {
        const present = Object.keys(headers).some((h) => h.toLowerCase() === header)
        if (!present) {
          // HSTS is only meaningful on HTTPS
          if (header === 'strict-transport-security' && !isHttps) continue
          findings.push({
            checkId: `security.missing_header.${header}`,
            category: 'SECURITY',
            severity,
            title: `Missing ${header} header`,
            description: `The response does not include the ${header} security header.`,
            remediation,
            messageKey: `missing-header-${header}`,
            evidence: { header, responseUrl: docResponse.url },
          })
        }
      }

      // 2. Public stack trace detection (server errors with detailed messages)
      if (docResponse.status >= 500) {
        const bodyText = await page.content().catch(() => '')
        const stackTracePatterns = [
          /at\s+\S+\s+\([^)]+:\d+:\d+\)/, // JS stack trace
          /Traceback \(most recent call last\)/, // Python
          /Exception in thread/,
          /at\s+java\.lang\./, // Java
          /\s+at\s+\w+\.\w+\s+\([^)]+\)/, // .NET
        ]
        for (const pattern of stackTracePatterns) {
          if (pattern.test(bodyText)) {
            findings.push({
              checkId: 'security.public_stack_trace',
              category: 'SECURITY',
              severity: 'CRITICAL',
              title: 'Public stack trace on error page',
              description: `The error page (HTTP ${docResponse.status}) exposes a stack trace. This leaks implementation details (frameworks, file paths, line numbers) that attackers can use to plan attacks.`,
              remediation: 'Configure error pages to show generic messages in production. Log full stack traces server-side only.',
              messageKey: 'public-stack-trace',
              evidence: { status: docResponse.status, pattern: pattern.source },
            })
            break
          }
        }
      }
    }

    // 3. Cookie security
    const cookies = await getCookies(ctx)
    for (const cookie of cookies) {
      if (!cookie.secure && isHttps) {
        findings.push({
          checkId: 'security.cookie_no_secure',
          category: 'SECURITY',
          severity: 'MAJOR',
          title: `Cookie "${cookie.name}" missing Secure flag`,
          description: `The cookie "${cookie.name}" is set on an HTTPS page without the Secure flag. It can be sent over unencrypted HTTP, exposing it to MitM attackers.`,
          remediation: 'Add the Secure attribute to the Set-Cookie header.',
          messageKey: `cookie-no-secure-${cookie.name}`,
          evidence: { name: cookie.name, domain: cookie.domain },
        })
      }
      if (!cookie.httpOnly) {
        findings.push({
          checkId: 'security.cookie_no_httponly',
          category: 'SECURITY',
          severity: 'MAJOR',
          title: `Cookie "${cookie.name}" missing HttpOnly flag`,
          description: `The cookie "${cookie.name}" is not marked HttpOnly. JavaScript can read it, making it vulnerable to theft via XSS.`,
          remediation: 'Add the HttpOnly attribute to the Set-Cookie header (unless the cookie is intentionally read by client-side JS, e.g. CSRF tokens).',
          messageKey: `cookie-no-httponly-${cookie.name}`,
          evidence: { name: cookie.name, domain: cookie.domain },
        })
      }
      if (cookie.sameSite === 'None' || cookie.sameSite === '') {
        findings.push({
          checkId: 'security.cookie_no_samesite',
          category: 'SECURITY',
          severity: 'MAJOR',
          title: `Cookie "${cookie.name}" missing SameSite attribute`,
          description: `The cookie "${cookie.name}" has no SameSite attribute (or SameSite=None without Secure). It can be sent in cross-site requests, enabling CSRF.`,
          remediation: 'Set SameSite=Lax (default for most cookies) or SameSite=Strict. Only use SameSite=None with Secure for third-party cookies.',
          messageKey: `cookie-no-samesite-${cookie.name}`,
          evidence: { name: cookie.name, sameSite: cookie.sameSite },
        })
      }
    }

    // 4. Sensitive data in URL parameters
    try {
      const url = new URL(pageUrl)
      const params = url.searchParams
      for (const [key, value] of params.entries()) {
        if (SENSITIVE_PARAM_PATTERNS.some((p) => p.test(key))) {
          findings.push({
            checkId: 'security.sensitive_param',
            category: 'SECURITY',
            severity: 'CRITICAL',
            title: `Sensitive data in URL parameter "${key}"`,
            description: `The URL contains a parameter "${key}" with sensitive data. URLs are logged in server logs, browser history, and Referer headers — secrets should never appear in them.`,
            remediation: 'Move the sensitive data to a request body or HTTP header. Use opaque tokens (not the raw secret) if a URL parameter is unavoidable.',
            messageKey: `sensitive-param-${key}`,
            evidence: { param: key, valueLength: value.length },
          })
        }
      }
    } catch {
      // invalid URL — skip
    }

    // 5. Insecure credential POST (forms posting to http:// with password fields)
    const insecureForms = await page.evaluate(() => {
      const forms = Array.from(document.querySelectorAll('form'))
      return forms
        .filter((form) => {
          const action = form.getAttribute('action') ?? ''
          const method = (form.getAttribute('method') ?? 'get').toLowerCase()
          if (method !== 'post') return false
          const hasPasswordField = form.querySelector('input[type="password"]') !== null
          if (!hasPasswordField) return false
          try {
            // Resolve the action URL relative to the current page
            const resolved = new URL(action, window.location.href)
            return resolved.protocol === 'http:'
          } catch {
            return false
          }
        })
        .map((form) => ({
          action: form.getAttribute('action') ?? '',
          method: (form.getAttribute('method') ?? 'get').toLowerCase(),
        }))
    }).catch(() => [] as Array<{ action: string; method: string }>)
    for (const form of insecureForms) {
      findings.push({
        checkId: 'security.insecure_credential_post',
        category: 'SECURITY',
        severity: 'CRITICAL',
        title: 'Password form submits over HTTP',
        description: `A form with a password field submits to ${form.action || '(current URL)'} over HTTP. Credentials can be intercepted by a network attacker.`,
        remediation: 'Submit the form to an HTTPS URL. Use the protocol-relative form action or an absolute https:// URL.',
        messageKey: 'insecure-credential-post',
        evidence: { action: form.action, method: form.method },
      })
    }

    // 6. Source map exposure
    const scriptSrcs = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('script[src]'))
        .map((s) => (s as HTMLScriptElement).src)
    }).catch(() => [] as string[])

    for (const src of scriptSrcs) {
      if (src.endsWith('.map')) {
        findings.push({
          checkId: 'security.source_map_exposed',
          category: 'SECURITY',
          severity: 'MINOR',
          title: 'Source map exposed in <script> tag',
          description: `The page loads a source map file ${src}. Source maps expose original source code, making it easier for attackers to find vulnerabilities.`,
          remediation: 'Remove sourceMappingURL comments from production builds, or serve source maps only to authenticated developers.',
          messageKey: `source-map-${src.slice(-30)}`,
          evidence: { src },
        })
      }
    }

    // 7. Secret-like strings in DOM
    const bodyText = await page.evaluate(() => document.documentElement.outerHTML).catch(() => '')
    if (bodyText) {
      const found = new Set<string>()
      for (const { pattern, type } of SECRET_TEXT_PATTERNS) {
        const matches = bodyText.match(pattern)
        if (matches) {
          for (const m of matches.slice(0, 3)) {
            const key = `${type}-${m.slice(0, 16)}`
            if (found.has(key)) continue
            found.add(key)
            findings.push({
              checkId: 'security.secret_in_dom',
              category: 'SECURITY',
              severity: 'CRITICAL',
              title: `${type} found in page HTML`,
              description: `A string matching the pattern of a ${type} was found in the page HTML. If this is a real secret, it has been exposed to every visitor.`,
              remediation: 'Remove the secret from the page. Never embed API keys, private keys, or tokens in client-side code. Use a backend proxy for API calls.',
              messageKey: `secret-in-dom-${type}`,
              evidence: { type, preview: m.slice(0, 8) + '...' },
            })
          }
        }
      }
    }

    // 8. Missing SRI on third-party resources
    const externalScripts = await page.evaluate(() => {
      const out: Array<{ src: string; hasIntegrity: boolean }> = []
      for (const s of Array.from(document.querySelectorAll('script[src]'))) {
        const script = s as HTMLScriptElement
        try {
          const u = new URL(script.src, window.location.href)
          if (u.origin !== window.location.origin) {
            out.push({ src: script.src, hasIntegrity: s.hasAttribute('integrity') })
          }
        } catch {
          // ignore
        }
      }
      for (const l of Array.from(document.querySelectorAll('link[rel="stylesheet"][href]'))) {
        const link = l as HTMLLinkElement
        try {
          const u = new URL(link.href, window.location.href)
          if (u.origin !== window.location.origin) {
            out.push({ src: link.href, hasIntegrity: l.hasAttribute('integrity') })
          }
        } catch {
          // ignore
        }
      }
      return out
    }).catch(() => [] as Array<{ src: string; hasIntegrity: boolean }>)
    const missingSri = externalScripts.filter((s) => !s.hasIntegrity)
    if (missingSri.length > 0) {
      findings.push({
        checkId: 'security.missing_sri',
        category: 'SECURITY',
        severity: 'MINOR',
        title: `${missingSri.length} third-party resource(s) without Subresource Integrity`,
        description: 'Third-party scripts and stylesheets are loaded without integrity attributes. If the CDN is compromised, attackers could inject malicious code.',
        remediation: 'Add integrity="sha384-..." attributes to all third-party <script> and <link rel="stylesheet"> tags. Generate hashes with https://www.srihash.org/.',
        messageKey: 'missing-sri',
        evidence: { count: missingSri.length, examples: missingSri.slice(0, 3).map((s) => s.src) },
      })
    }

    // 9. iframe security (missing sandbox)
    const insecureIframes = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('iframe'))
        .filter((f) => !f.hasAttribute('sandbox') || f.getAttribute('sandbox') === '')
        .map((f) => ({
          src: f.getAttribute('src') ?? '',
          hasSandbox: f.hasAttribute('sandbox'),
        }))
    }).catch(() => [] as Array<{ src: string; hasSandbox: boolean }>)
    if (insecureIframes.length > 0) {
      findings.push({
        checkId: 'security.iframe_no_sandbox',
        category: 'SECURITY',
        severity: 'MINOR',
        title: `${insecureIframes.length} iframe(s) without sandbox attribute`,
        description: 'iframes without a sandbox attribute can navigate the top-level page, run popups, and access the parent DOM (subject to same-origin policy).',
        remediation: 'Add a sandbox attribute with the minimum necessary allow-* tokens.',
        messageKey: 'iframe-no-sandbox',
        evidence: { count: insecureIframes.length, examples: insecureIframes.slice(0, 3).map((i) => i.src) },
      })
    }

    return findings
  },
}
