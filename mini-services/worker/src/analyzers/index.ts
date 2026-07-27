/**
 * Analyzer runner — ProofPilot worker (Phase 5)
 *
 * Orchestrates a single page analysis pass:
 *   1. Re-navigate to the page in a fresh browser context (with the same
 *      viewport + locale as the crawl pass)
 *   2. Collect network responses, console events, and performance metrics
 *      during navigation
 *   3. Run each analyzer (http-nav, runtime, responsive, accessibility,
 *      forms, performance, security, seo) and collect FindingCandidate[]
 *   4. Write findings to the DB (via finding-writer)
 *   5. Persist ScanPageMetric for the dashboard
 *
 * The runner is responsible for:
 *   - Browser lifecycle (launch + close)
 *   - Setting up PerformanceObserver before navigation
 *   - Recording CSP violations (via SecurityPolicyViolationEvent)
 *   - Time-limiting each analyzer (analyzer timeout)
 *   - Catching analyzer errors (one bad analyzer shouldn't fail the run)
 */
import { db } from '../../../../src/lib/db'
import { env } from '../../../../src/lib/env'
import { logger } from '../../../../src/lib/logger'
import { appendScanEvent } from '../../../../src/lib/scan-events'
import { launchBrowser, createContext, closeContext, navigateSafely } from '../browser'
import { writeFindings, writePageMetrics } from './finding-writer'
import { httpNavAnalyzer } from './http-nav'
import { runtimeAnalyzer } from './runtime'
import { responsiveAnalyzer } from './responsive'
import { accessibilityAnalyzer } from './accessibility'
import { formsAnalyzer } from './forms'
import { performanceAnalyzer } from './performance'
import { securityAnalyzer } from './security'
import { seoAnalyzer } from './seo'
import type { Analyzer, AnalyzerContext, FindingCandidate, ObservedResponse, ObservedConsoleEvent, PerfMetrics, CrawlData } from './types'

/** Ordered list of analyzers. */
const ANALYZERS: Analyzer[] = [
  httpNavAnalyzer,
  runtimeAnalyzer,
  responsiveAnalyzer,
  accessibilityAnalyzer,
  formsAnalyzer,
  performanceAnalyzer,
  securityAnalyzer,
  seoAnalyzer,
]

/** Per-analyzer timeout (ms). */
const ANALYZER_TIMEOUT_MS = 30_000

export interface PageAnalysisInput {
  runId: string
  workspaceId: string
  projectId: string
  environmentId: string
  pageId: string
  pageUrl: string
  normalizedPageUrl: string
  viewport: { name: string; width: number; height: number }
  locale: string
  browser: string
  runMode: string
  allowedOrigins: string[]
  /** Crawl-time data captured by the orchestrator. */
  crawl: CrawlData
}

export interface PageAnalysisResult {
  findings: number
  analyzersRun: number
  analyzersFailed: number
  durationMs: number
}

/** Parse a viewport string like "desktop:1920x1080". */
function parseViewport(v: string): { name: string; width: number; height: number } {
  const m = v.match(/^([\w-]+):(\d+)x(\d+)$/)
  if (m) return { name: m[1], width: parseInt(m[2], 10), height: parseInt(m[3], 10) }
  return { name: 'default', width: 1366, height: 768 }
}

/** Run all analyzers on a single page. */
export async function runPageAnalysis(input: PageAnalysisInput): Promise<PageAnalysisResult> {
  const startedAt = Date.now()
  const { runId, workspaceId, projectId, environmentId, pageId, pageUrl, viewport, locale, browser, runMode, allowedOrigins, crawl } = input

  logger.info('Page analysis starting', { runId, pageId, pageUrl, viewport: viewport.name, locale })

  await appendScanEvent(runId, 'page.analyzing', {
    pageId,
    url: pageUrl,
    viewport: viewport.name,
    locale,
  })

  // Launch browser
  let browserInstance
  try {
    browserInstance = await launchBrowser({ allowNoSandbox: env.APP_ENV === 'development' })
  } catch (err) {
    logger.error('Page analysis failed — browser launch failed', { runId, pageId, error: String(err) })
    await appendScanEvent(runId, 'page.analysis_failed', { pageId, url: pageUrl, reason: `Browser launch failed: ${String(err)}` })
    return { findings: 0, analyzersRun: 0, analyzersFailed: 0, durationMs: Date.now() - startedAt }
  }

  let totalFindings = 0
  let analyzersRun = 0
  let analyzersFailed = 0

  try {
    const context = await createContext(browserInstance, {
      allowedOrigins,
      requestTimeoutMs: env.WORKER_BROWSER_TIMEOUT_MS,
      maxResponseBytes: env.WORKER_MAX_RESPONSE_SIZE_BYTES,
      viewport: { width: viewport.width, height: viewport.height },
      locale,
    })

    try {
      // Set up observers BEFORE navigation so we capture everything
      const responses: ObservedResponse[] = []
      const consoleEvents: ObservedConsoleEvent[] = []
      let perfMetrics: PerfMetrics = {}

      // CSP violation listener (injected via init script)
      await context.addInitScript(() => {
        window.addEventListener('securitypolicyviolation', (e) => {
          // @ts-expect-error — augmenting window for cross-page state
          const w = window as unknown as { __proofpilotCspViolations?: Array<{ violatedDirective: string; blockedUri: string; statusCode: number }> }
          if (!w.__proofpilotCspViolations) w.__proofpilotCspViolations = []
          w.__proofpilotCspViolations.push({
            violatedDirective: e.violatedDirective,
            blockedUri: e.blockedURI,
            statusCode: e.statusCode,
          })
        })
      })

      const page = await context.newPage()

      // Network response listener (synchronous — no body() call to avoid hangs)
      page.on('response', (response) => {
        try {
          const req = response.request()
          const url = response.url()
          const status = response.status()
          const headers = response.headers()
          const contentType = headers['content-type'] ?? ''
          const contentLength = headers['content-length']
          const sizeBytes = contentLength ? parseInt(contentLength, 10) : undefined
          responses.push({
            url,
            status,
            method: req.method(),
            contentType,
            headers,
            fromCache: response.fromCache(),
            redirected: response.url() !== req.url(),
            redirectedTo: response.url() !== req.url() ? response.url() : undefined,
            failed: status === 0,
            sizeBytes: sizeBytes && !Number.isNaN(sizeBytes) ? sizeBytes : undefined,
          })
        } catch {
          // ignore
        }
      })

      // Console event listener
      page.on('console', (msg) => {
        const loc = msg.location()
        consoleEvents.push({
          type: msg.type(),
          text: msg.text(),
          url: loc.url,
          line: loc.lineNumber,
          column: loc.columnNumber,
        })
      })

      // Page error listener
      page.on('pageerror', (err) => {
        consoleEvents.push({
          type: 'error',
          text: err.message,
          stackTrace: err.stack,
        })
      })

      // Request failed listener
      page.on('requestfailed', (req) => {
        const failure = req.failure()
        responses.push({
          url: req.url(),
          status: 0,
          method: req.method(),
          contentType: '',
          headers: {},
          fromCache: false,
          redirected: false,
          failed: true,
          failureReason: failure?.errorText ?? 'request failed',
        })
      })

      // Navigate
      const navResult = await navigateSafely(page, pageUrl, allowedOrigins, {
        timeoutMs: env.WORKER_BROWSER_TIMEOUT_MS,
        waitUntil: 'load',
      })

      // Allow a short settle time for late network activity + paint
      await page.waitForTimeout(1500).catch(() => {
        // ignore
      })

      // Collect performance metrics from the Performance Timeline
      perfMetrics = await collectPerfMetrics(page)

      // Build a synthetic document response from the navigation result.
      // We use this instead of searching the responses array because the
      // page.on('response') listener may not fire reliably for the main
      // document when network interception is active.
      const documentResponse: ObservedResponse = {
        url: navResult.finalUrl,
        status: navResult.responseStatus,
        method: 'GET',
        contentType: navResult.responseContentType,
        headers: navResult.responseHeaders,
        fromCache: false,
        redirected: navResult.redirectChain.length > 0,
        redirectedTo: navResult.redirectChain.length > 0 ? navResult.redirectChain[navResult.redirectChain.length - 1] : undefined,
        failed: navResult.responseStatus === 0,
      }
      // Ensure the document response is in the responses array (for HTTP/nav analyzer)
      if (!responses.some((r) => r.url === documentResponse.url)) {
        responses.push(documentResponse)
      }

      const ctx: AnalyzerContext = {
        runId,
        workspaceId,
        projectId,
        environmentId,
        pageId,
        pageUrl,
        normalizedPageUrl: input.normalizedPageUrl,
        viewport,
        locale,
        browser,
        page,
        crawl,
        responses,
        consoleEvents,
        perf: perfMetrics,
        documentResponse,
        runMode,
      }

      // Run each analyzer with a timeout
      const allFindings: FindingCandidate[] = []
      for (const analyzer of ANALYZERS) {
        try {
          const result = await withTimeout(analyzer.run(ctx), ANALYZER_TIMEOUT_MS, analyzer.id)
          allFindings.push(...result)
          analyzersRun++
        } catch (err) {
          analyzersFailed++
          logger.warn('Analyzer failed', {
            runId, pageId, analyzer: analyzer.id, error: String(err),
          })
          await appendScanEvent(runId, 'analyzer.failed', {
            pageId, analyzer: analyzer.id, error: String(err),
          }).catch(() => {
            // best-effort
          })
        }
      }

      // Write findings to DB
      const written = await writeFindings(ctx, allFindings)
      totalFindings = written.length

      // Persist performance metrics
      await writePageMetrics(pageId, {
        ttfb: perfMetrics.ttfb,
        domContentLoaded: perfMetrics.domContentLoaded,
        loadEvent: perfMetrics.loadEvent,
        lcp: perfMetrics.lcp,
        cls: perfMetrics.cls,
        inp: perfMetrics.inp,
        totalBytes: perfMetrics.totalBytes,
        requestCount: perfMetrics.requestCount,
        largestResources: perfMetrics.largestResources ? JSON.stringify(perfMetrics.largestResources) : undefined,
        longTasks: perfMetrics.longTasks,
        renderBlocking: perfMetrics.renderBlocking,
      })

      // Mark page as analyzed
      await db.scanPage.update({
        where: { id: pageId },
        data: { analyzedAt: new Date() },
      }).catch(() => {
        // best-effort
      })

      await appendScanEvent(runId, 'page.analyzed', {
        pageId,
        url: pageUrl,
        viewport: viewport.name,
        locale,
        findingsDiscovered: totalFindings,
        analyzersRun,
        analyzersFailed,
      })

      logger.info('Page analysis completed', {
        runId, pageId, pageUrl, findings: totalFindings, analyzersRun, analyzersFailed, durationMs: Date.now() - startedAt,
      })

      return {
        findings: totalFindings,
        analyzersRun,
        analyzersFailed,
        durationMs: Date.now() - startedAt,
      }
    } finally {
      await closeContext(context)
    }
  } catch (err) {
    logger.error('Page analysis failed', { runId, pageId, error: String(err) })
    await appendScanEvent(runId, 'page.analysis_failed', { pageId, url: pageUrl, reason: String(err) })
    return {
      findings: 0,
      analyzersRun,
      analyzersFailed,
      durationMs: Date.now() - startedAt,
    }
  } finally {
    try {
      await browserInstance.close()
    } catch {
      // ignore
    }
  }
}

/** Collect performance metrics via Performance Timeline + PerformanceObserver. */
async function collectPerfMetrics(page: import('playwright').Page): Promise<PerfMetrics> {
  try {
    const data = await page.evaluate(() => {
      const perf = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined
      const paintEntries = performance.getEntriesByType('paint')
      const fcpEntry = paintEntries.find((e) => e.name === 'first-contentful-paint')

      // Largest Contentful Paint (best-effort)
      let lcp = 0
      try {
        const lcpEntries = performance.getEntriesByType('largest-contentful-paint') as Array<{ startTime: number; renderTime: number; loadTime: number; size: number }>
        const last = lcpEntries[lcpEntries.length - 1]
        if (last) lcp = last.renderTime || last.loadTime || last.startTime
      } catch {
        // LCP not supported
      }

      // Cumulative Layout Shift (best-effort)
      let cls = 0
      try {
        const clsEntries = performance.getEntriesByType('layout-shift') as Array<{ hadRecentInput: boolean; value: number }>
        for (const e of clsEntries) {
          if (!e.hadRecentInput) cls += e.value
        }
      } catch {
        // CLS not supported
      }

      // Long Tasks (best-effort)
      let longTasks = 0
      try {
        const ltEntries = performance.getEntriesByType('longtask')
        longTasks = ltEntries.length
      } catch {
        // longtask not supported
      }

      // Resource entries
      const resourceEntries = performance.getEntriesByType('resource') as PerformanceResourceTiming[]
      const totalBytes = resourceEntries.reduce((sum, r) => sum + (r.transferSize ?? 0), 0)
      const requestCount = resourceEntries.length

      // Largest resources by transfer size
      const largestResources = resourceEntries
        .map((r) => ({
          url: r.name,
          sizeBytes: r.transferSize ?? 0,
          type: r.initiatorType,
        }))
        .sort((a, b) => b.sizeBytes - a.sizeBytes)
        .slice(0, 5)

      // Render-blocking resources (scripts without async/defer in head, link rel=stylesheet in head)
      let renderBlocking = 0
      const headScripts = document.querySelectorAll('head script:not([async]):not([defer]):not([type="application/ld+json"])')
      const headStylesheets = document.querySelectorAll('head link[rel="stylesheet"]')
      renderBlocking = headScripts.length + headStylesheets.length

      // INP approximation: max interaction duration from Event Timing API (best-effort)
      let inp = 0
      try {
        const eventEntries = performance.getEntriesByType('event') as Array<{ duration: number; processingStart: number; startTime: number }>
        // INP is the worst (highest) interaction latency, excluding the very first click which is FID
        if (eventEntries.length > 0) {
          const sorted = [...eventEntries].sort((a, b) => b.duration - a.duration)
          inp = Math.round(sorted[0].duration)
        }
      } catch {
        // event timing not supported
      }

      return {
        ttfb: perf?.responseStart ?? undefined,
        domContentLoaded: perf?.domContentLoadedEventEnd ?? undefined,
        loadEvent: perf?.loadEventEnd ?? undefined,
        fcp: fcpEntry?.startTime ?? undefined,
        lcp: lcp > 0 ? lcp : undefined,
        cls: cls > 0 ? cls : undefined,
        inp: inp > 0 ? inp : undefined,
        totalBytes,
        requestCount,
        largestResources,
        longTasks,
        renderBlocking,
      }
    })

    return data
  } catch {
    return {}
  }
}

/** Run a promise with a timeout. Rejects if the timeout elapses. */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Analyzer "${label}" timed out after ${ms}ms`))
    }, ms)
    promise.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      },
    )
  })
}

/** Re-export for the page-analysis handler. */
export { parseViewport }
