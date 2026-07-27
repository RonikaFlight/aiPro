/**
 * Scan orchestrator — ProofPilot worker
 *
 * Handles `scan-orchestration` queue jobs.
 *
 * Flow:
 *   1. Load the run from DB
 *   2. Skip if cancelled
 *   3. Mark run RUNNING
 *   4. Launch hardened browser
 *   5. For each viewport × locale × browser combo:
 *      a. Create a fresh isolated context
 *      b. Crawl pages
 *      c. For each page: persist ScanPage + capture artifacts (screenshot, HTML)
 *      d. Enqueue a page-analysis job per page
 *   6. Mark run COMPLETED with summary stats
 *   7. Append scan events throughout for SSE consumers
 *
 * The actual analyzers (HTTP, runtime, a11y, etc.) come online in Phase 5.
 * For now, this orchestrator captures the crawl + artifacts and records findings
 * for any page errors / console errors detected.
 */
import { db } from '../../../src/lib/db'
import { env } from '../../../src/lib/env'
import { logger } from '../../../src/lib/logger'
import { appendScanEvent } from '../../../src/lib/scan-events'
import { storeArtifact } from '../../../src/lib/artifact-service'
import { revalidateTargetBeforeFetch } from '../../../src/lib/scan-auth'
import { enqueue } from '../../../src/lib/queue'
import { launchBrowser, createContext, closeContext } from './browser'
import { crawl, type CrawlPage } from './crawl'
import type { Job } from '../../../src/lib/queue'

interface ScanOrchestrationPayload {
  runId: string
  workspaceId: string
  projectId: string
  environmentId: string
  targetUrl: string
  allowedOrigins: string[]
  runMode: string
  trigger: string
  config: {
    maxPages: number
    maxDepth: number
    timeoutMs: number
    viewports: string[]
    locales: string[]
    browsers: string[]
  }
}

/** Parse a viewport string like "desktop:1920x1080" → { name, width, height }. */
function parseViewport(v: string): { name: string; width: number; height: number } {
  const m = v.match(/^([\w-]+):(\d+)x(\d+)$/)
  if (m) {
    return { name: m[1], width: parseInt(m[2], 10), height: parseInt(m[3], 10) }
  }
  return { name: 'default', width: 1366, height: 768 }
}

/** Main scan-orchestration handler. */
export async function handleScanOrchestration(job: Job<ScanOrchestrationPayload>): Promise<void> {
  // Normalize payload — support both the new shape (from run-service) and the
  // legacy public-scan shape (top-level viewport/locale/maxPages/maxDepth).
  const raw = job.payload as ScanOrchestrationPayload & {
    // legacy fields
    viewport?: string
    locale?: string
    maxPages?: number
    maxDepth?: number
    browsers?: string[]
    mode?: string
    source?: string
  }
  const config = raw.config ?? {
    maxPages: raw.maxPages ?? env.SCAN_DEFAULT_MAX_PAGES,
    maxDepth: raw.maxDepth ?? env.SCAN_DEFAULT_MAX_DEPTH,
    timeoutMs: env.WORKER_BROWSER_TIMEOUT_MS,
    viewports: raw.viewport ? [raw.viewport] : env.SCAN_DEFAULT_VIEWPORTS.split(','),
    locales: raw.locale ? [raw.locale] : ['en'],
    browsers: raw.browsers ?? ['chromium'],
  }
  const payload: ScanOrchestrationPayload = {
    runId: raw.runId,
    workspaceId: raw.workspaceId,
    projectId: raw.projectId,
    environmentId: raw.environmentId ?? '',
    targetUrl: raw.targetUrl,
    allowedOrigins: raw.allowedOrigins ?? (() => {
      try {
        return [new URL(raw.targetUrl).origin]
      } catch {
        return []
      }
    })(),
    runMode: raw.runMode ?? raw.mode ?? 'PASSIVE',
    trigger: raw.trigger ?? (raw.source === 'public' ? 'PUBLIC' : 'MANUAL'),
    config,
  }

  const { runId, workspaceId, projectId, environmentId, targetUrl, allowedOrigins, runMode, trigger } = payload

  logger.info('Scan orchestration starting', { runId, workspaceId, projectId, targetUrl })

  // Load the run
  const run = await db.scanRun.findUnique({ where: { id: runId } })
  if (!run) {
    logger.error('Scan run not found', { runId })
    return
  }
  if (run.status === 'CANCELLED') {
    logger.info('Scan run already cancelled — skipping', { runId })
    return
  }

  // Mark RUNNING
  await db.scanRun.update({
    where: { id: runId },
    data: { status: 'RUNNING', startedAt: new Date() },
  })
  await appendScanEvent(runId, 'run.validating', { targetUrl })

  // Revalidate target before fetch (DNS rebinding protection)
  try {
    await revalidateTargetBeforeFetch(targetUrl, [])
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    await markRunFailed(runId, `Target revalidation failed: ${reason}`)
    return
  }

  await appendScanEvent(runId, 'run.authorized', { targetUrl, allowedOrigins })

  // Launch browser
  let browser
  try {
    browser = await launchBrowser({ allowNoSandbox: env.APP_ENV === 'development' })
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    await markRunFailed(runId, `Browser launch failed: ${reason}`)
    return
  }

  let totalPages = 0
  // Note: totalFindings/totalBlockers are now tracked by the page-analysis handler
  // (which increments the run's findingsCount atomically as each page is analyzed).
  // The orchestrator only tracks pages discovered here.

  try {
    // We crawl per-viewport (multiple viewports produce multiple passes)
    // For Phase 4 we do the first viewport + first locale only — multi-viewport
    // expansion happens in Phase 5 (responsive analyzer).
    const viewport = parseViewport(config.viewports[0] ?? 'desktop:1366x768')
    const locale = config.locales[0] ?? 'en'

    await appendScanEvent(runId, 'run.crawling', {
      viewport: viewport.name,
      locale,
      maxPages: config.maxPages,
      maxDepth: config.maxDepth,
    })

    const context = await createContext(browser, {
      allowedOrigins,
      requestTimeoutMs: config.timeoutMs,
      maxResponseBytes: env.WORKER_MAX_RESPONSE_SIZE_BYTES,
      viewport: { width: viewport.width, height: viewport.height },
      locale,
    })

    try {
      const result = await crawl(context, {
        seedUrl: targetUrl,
        allowedOrigins,
        maxDepth: config.maxDepth,
        maxPages: config.maxPages,
        perPageTimeoutMs: config.timeoutMs,
        totalTimeoutMs: Math.min(config.timeoutMs * config.maxPages, 5 * 60 * 1000),
        viewport: { width: viewport.width, height: viewport.height },
        locale,
      })

      // Persist pages + artifacts
      for (const page of result.pages) {
        await persistPage(runId, workspaceId, projectId, page, viewport.name, locale)
        totalPages++
      }

      await appendScanEvent(runId, 'run.analyzing', {
        pagesDiscovered: totalPages,
      })

      // Enqueue page-analysis jobs with crawl-time data so analyzers can reuse it
      // (avoids re-capturing console errors, page errors, http status, redirect chain, etc.)
      for (const page of result.pages) {
        await enqueue(
          'page-analysis',
          {
            runId,
            workspaceId,
            projectId,
            pageUrl: page.url,
            normalizedPageUrl: page.normalizedUrl,
            viewport: viewport.name,
            locale,
            browser: 'chromium',
            crawl: {
              url: page.url,
              normalizedUrl: page.normalizedUrl,
              title: page.title,
              httpStatus: page.httpStatus,
              contentType: page.contentType,
              redirectChain: page.redirectChain,
              lang: page.lang,
              dir: page.dir,
              canonical: page.canonical,
              consoleErrors: page.consoleErrors,
              pageErrors: page.pageErrors,
              html: page.html,
            },
          },
          { workspaceId, correlationId: `${runId}:${page.normalizedUrl}`, priority: 3 },
        ).catch((err) => {
          logger.warn('Failed to enqueue page-analysis job', { runId, pageUrl: page.url, error: String(err) })
        })
      }

      await db.scanRun.update({
        where: { id: runId },
        data: {
          // The orchestrator marks the run COMPLETED once the crawl is done.
          // Page-analysis jobs continue running asynchronously and update
          // pagesAnalyzed + findingsCount as they finish.
          status: 'COMPLETED',
          completedAt: new Date(),
          pagesDiscovered: totalPages,
        },
      })

      await appendScanEvent(runId, 'run.completed', {
        pagesDiscovered: totalPages,
        pagesQueuedForAnalysis: totalPages,
        durationMs: result.durationMs,
      })

      logger.info('Scan orchestration completed', {
        runId,
        pages: totalPages,
        durationMs: result.durationMs,
      })
    } finally {
      await closeContext(context)
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    await markRunFailed(runId, `Scan failed: ${reason}`)
  } finally {
    try {
      await browser.close()
    } catch {
      // ignore
    }
  }
}

async function markRunFailed(runId: string, reason: string): Promise<void> {
  logger.error('Scan run failed', { runId, reason })
  await db.scanRun.update({
    where: { id: runId },
    data: {
      status: 'FAILED',
      completedAt: new Date(),
      failedReason: reason,
    },
  })
  await appendScanEvent(runId, 'run.failed', { reason })
}

async function persistPage(
  runId: string,
  workspaceId: string,
  projectId: string,
  page: CrawlPage,
  viewportName: string,
  locale: string,
): Promise<void> {
  const scanPage = await db.scanPage.create({
    data: {
      runId,
      url: page.url,
      normalizedUrl: page.normalizedUrl,
      title: page.title,
      httpStatus: page.httpStatus,
      contentType: page.contentType,
      redirectChain: JSON.stringify(page.redirectChain),
      lang: page.lang,
      dir: page.dir,
      canonical: page.canonical,
      depth: page.depth,
      analyzedAt: null, // set by the page-analysis handler when analyzers finish
    },
  })

  await appendScanEvent(runId, 'page.discovered', {
    pageId: scanPage.id,
    url: page.normalizedUrl,
    title: page.title,
    httpStatus: page.httpStatus,
    viewport: viewportName,
    locale,
    depth: page.depth,
  })

  // Store screenshot
  if (page.screenshot) {
    try {
      const artifact = await storeArtifact({
        workspaceId,
        projectId,
        runId,
        type: 'SCREENSHOT',
        filename: `screenshot-${viewportName}-${locale}.png`,
        buffer: page.screenshot,
        declaredMime: 'image/png',
      })
      await appendScanEvent(runId, 'artifact.created', {
        artifactId: artifact.id,
        type: 'SCREENSHOT',
        pageUrl: page.normalizedUrl,
        viewport: viewportName,
        locale,
        sizeBytes: artifact.sizeBytes,
      })
    } catch (err) {
      logger.warn('Failed to store screenshot', { runId, pageUrl: page.url, error: String(err) })
    }
  }

  // Store HTML snapshot (truncated to avoid huge DB rows)
  if (page.html) {
    try {
      const htmlBuffer = Buffer.from(page.html, 'utf8')
      if (htmlBuffer.length <= env.WORKER_MAX_RESPONSE_SIZE_BYTES) {
        await storeArtifact({
          workspaceId,
          projectId,
          runId,
          type: 'OTHER',
          filename: `html-${viewportName}-${locale}.html`,
          buffer: htmlBuffer,
          declaredMime: 'text/html',
        })
      }
    } catch (err) {
      logger.warn('Failed to store HTML snapshot', { runId, pageUrl: page.url, error: String(err) })
    }
  }

  // Store console log
  if (page.consoleErrors.length > 0 || page.pageErrors.length > 0) {
    try {
      const logBuffer = Buffer.from(
        JSON.stringify({ consoleErrors: page.consoleErrors, pageErrors: page.pageErrors }, null, 2),
        'utf8',
      )
      await storeArtifact({
        workspaceId,
        projectId,
        runId,
        type: 'ERROR_LOG',
        filename: `errors-${viewportName}-${locale}.json`,
        buffer: logBuffer,
        declaredMime: 'application/json',
      })
    } catch {
      // ignore
    }
  }
}


