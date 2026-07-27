/**
 * Page-analysis queue handler — ProofPilot worker (Phase 5)
 *
 * Handles `page-analysis` jobs enqueued by the scan orchestrator.
 *
 * Job payload (from orchestrator):
 *   - runId, workspaceId, projectId, pageUrl, viewport (string), locale
 *   - crawlData (captured during crawl — title, httpStatus, redirectChain, lang, dir, canonical, consoleErrors, pageErrors)
 *
 * The handler:
 *   1. Loads the ScanRun + ScanPage from DB
 *   2. Resolves the Environment (for allowedOrigins)
 *   3. Calls runPageAnalysis() which re-navigates + runs all analyzers
 *   4. Updates the run's findingsCount + pagesAnalyzed counters
 *
 * The handler is idempotent: if the run is CANCELLED, it skips.
 */
import { db } from '../../../src/lib/db'
import { logger } from '../../../src/lib/logger'
import { appendScanEvent } from '../../../src/lib/scan-events'
import { computeAndPersistRunScore } from '../../../src/lib/quality-score'
import { runPageAnalysis, parseViewport } from './analyzers'
import type { Job } from '../../../src/lib/queue'
import type { CrawlData } from './analyzers/types'

interface PageAnalysisPayload {
  runId: string
  workspaceId: string
  projectId: string
  pageUrl: string
  normalizedPageUrl?: string
  viewport: string
  locale: string
  browser?: string
  crawl: CrawlData
  /** pageId — set by the orchestrator when persisting the ScanPage. */
  pageId?: string
}

export async function handlePageAnalysis(job: Job<PageAnalysisPayload>): Promise<void> {
  const payload = job.payload
  const { runId, workspaceId, projectId, pageUrl, viewport: viewportStr, locale, crawl } = payload
  const browser = payload.browser ?? 'chromium'

  logger.info('page-analysis job received', { jobId: job.id, runId, pageUrl, viewport: viewportStr, locale })

  // Load the run
  const run = await db.scanRun.findUnique({
    where: { id: runId },
    select: { id: true, status: true, environmentId: true, configSnapshot: true },
  })
  if (!run) {
    logger.warn('page-analysis: run not found', { runId })
    return
  }
  if (run.status === 'CANCELLED') {
    logger.info('page-analysis: run cancelled — skipping', { runId })
    return
  }

  // Find the ScanPage for this URL in this run (matching normalized URL)
  const normalizedPageUrl = payload.normalizedPageUrl ?? crawl.normalizedUrl
  const scanPage = await db.scanPage.findFirst({
    where: {
      runId,
      normalizedUrl: normalizedPageUrl,
      // viewport/locale are not on ScanPage — they're implied by the analysis pass.
      // The orchestrator creates one ScanPage per (URL, viewport, locale) combo by
      // storing it as a unique row. If multiple passes exist, we update the most recent.
    },
    orderBy: { analyzedAt: 'desc' },
  })

  let pageId = payload.pageId ?? scanPage?.id
  if (!pageId) {
    // Create a ScanPage if the orchestrator didn't (shouldn't happen, but be resilient)
    const created = await db.scanPage.create({
      data: {
        runId,
        url: pageUrl,
        normalizedUrl: normalizedPageUrl,
        title: crawl.title,
        httpStatus: crawl.httpStatus,
        contentType: crawl.contentType,
        redirectChain: JSON.stringify(crawl.redirectChain),
        lang: crawl.lang,
        dir: crawl.dir,
        canonical: crawl.canonical,
        depth: 0,
        analyzedAt: null,
      },
    })
    pageId = created.id
  }

  // Resolve allowed origins from the run config snapshot
  let allowedOrigins: string[] = []
  try {
    const config = typeof run.configSnapshot === 'string'
      ? JSON.parse(run.configSnapshot)
      : run.configSnapshot
    allowedOrigins = Array.isArray(config?.allowedOrigins)
      ? config.allowedOrigins
      : (() => {
          try {
            return [new URL(pageUrl).origin]
          } catch {
            return []
          }
        })()
  } catch {
    // Fall back to the page's own origin
    try {
      allowedOrigins = [new URL(pageUrl).origin]
    } catch {
      allowedOrigins = []
    }
  }

  const viewport = parseViewport(viewportStr)

  // Run the analyzers
  const result = await runPageAnalysis({
    runId,
    workspaceId,
    projectId,
    environmentId: run.environmentId ?? '',
    pageId,
    pageUrl,
    normalizedPageUrl,
    viewport,
    locale,
    browser,
    runMode: 'PASSIVE',
    allowedOrigins,
    crawl,
  })

  // Update run counters (atomically increment to avoid race conditions across pages)
  const updatedRun = await db.scanRun.update({
    where: { id: runId },
    data: {
      pagesAnalyzed: { increment: 1 },
      findingsCount: { increment: result.findings },
    },
    select: { pagesAnalyzed: true, pagesDiscovered: true, status: true },
  }).catch((err) => {
    logger.warn('Failed to update run counters', { runId, error: String(err) })
    return null
  })

  // Phase 6: recompute and persist the run's quality score after each page
  // is analyzed. This is idempotent (overwrites the previous score) and
  // converges to the final score once all pages are analyzed.
  let scoreBreakdown: Awaited<ReturnType<typeof computeAndPersistRunScore>> | null = null
  try {
    scoreBreakdown = await computeAndPersistRunScore(runId, workspaceId)
  } catch (err) {
    logger.warn('Failed to compute run score', { runId, error: String(err) })
  }

  // Append a final analysis-completed event (per page) for SSE consumers
  await appendScanEvent(runId, 'page.analysis_completed', {
    pageId,
    url: pageUrl,
    viewport: viewport.name,
    locale,
    findings: result.findings,
    analyzersRun: result.analyzersRun,
    analyzersFailed: result.analyzersFailed,
    durationMs: result.durationMs,
    score: scoreBreakdown?.score ?? null,
  }).catch(() => {
    // best-effort
  })

  // If all discovered pages have been analyzed, emit a run.scored event so
  // SSE listeners know the final score is available.
  if (
    updatedRun &&
    updatedRun.pagesAnalyzed >= updatedRun.pagesDiscovered &&
    updatedRun.pagesDiscovered > 0 &&
    scoreBreakdown
  ) {
    await appendScanEvent(runId, 'run.scored', {
      score: scoreBreakdown.score,
      grade: scoreBreakdown.grade,
      readiness: scoreBreakdown.readiness,
      hasOpenBlocker: scoreBreakdown.hasOpenBlocker,
      hasOpenCritical: scoreBreakdown.hasOpenCritical,
      openBySeverity: scoreBreakdown.openBySeverity,
      totalFindings: scoreBreakdown.totalFindings,
    }).catch(() => {
      // best-effort
    })
  }
}
