/**
 * Finding writer — ProofPilot worker (Phase 5)
 *
 * Shared utility for the analyzer runner to persist FindingCandidate results.
 * Phase 5 uses a simple fingerprint (project + checkId + url + viewport + locale
 * + messageKey). Phase 6 will introduce proper dedup + lifecycle.
 */
import { db } from '../../../../src/lib/db'
import { logger } from '../../../../src/lib/logger'
import { appendScanEvent } from '../../../../src/lib/scan-events'
import { fingerprint } from '../../../../src/lib/crypto'
import type { FindingCandidate, AnalyzerContext } from './types'

export interface WrittenFinding {
  id: string
  fingerprint: string
  checkId: string
  severity: string
  title: string
}

/** Write a batch of finding candidates for one page analysis. */
export async function writeFindings(
  ctx: AnalyzerContext,
  candidates: FindingCandidate[],
): Promise<WrittenFinding[]> {
  const written: WrittenFinding[] = []
  for (const c of candidates) {
    try {
      const fp = fingerprint([
        ctx.projectId,
        c.checkId,
        ctx.normalizedPageUrl,
        c.selector ?? '',
        ctx.viewport.name,
        ctx.locale,
        c.messageKey,
      ])
      // Upsert: if the fingerprint already exists (same project+page+viewport+locale+check+message),
      // update lastSeenAt + refresh evidence. Otherwise insert.
      const finding = await db.finding.upsert({
        where: { fingerprint: fp },
        update: {
          lastSeenAt: new Date(),
          runId: ctx.runId,
          evidence: c.evidence ? JSON.stringify(c.evidence) : undefined,
          description: c.description,
          remediation: c.remediation,
        },
        create: {
          workspaceId: ctx.workspaceId,
          projectId: ctx.projectId,
          runId: ctx.runId,
          checkId: c.checkId,
          category: c.category,
          severity: c.severity,
          status: 'OPEN',
          confidence: c.confidence ?? 'HIGH',
          title: c.title,
          description: c.description,
          remediation: c.remediation,
          fingerprint: fp,
          affectedUrl: ctx.pageUrl,
          normalizedUrl: ctx.normalizedPageUrl,
          viewport: ctx.viewport.name,
          locale: ctx.locale,
          browser: ctx.browser,
          domSelector: c.selector,
          evidence: c.evidence ? JSON.stringify(c.evidence) : undefined,
          firstSeenAt: new Date(),
          lastSeenAt: new Date(),
        },
        select: { id: true, fingerprint: true, checkId: true, severity: true, title: true },
      })

      // Record an occurrence (Phase 6 will use this for dedup tracking)
      await db.findingOccurrence.create({
        data: {
          findingId: finding.id,
          runId: ctx.runId,
          viewport: ctx.viewport.name,
          locale: ctx.locale,
          browser: ctx.browser,
          evidence: c.evidence ? JSON.stringify(c.evidence) : undefined,
        },
      }).catch(() => {
        // Occurrence recording is best-effort — don't fail the analysis if it errors.
      })

      written.push(finding)

      await appendScanEvent(ctx.runId, 'finding.discovered', {
        findingId: finding.id,
        checkId: c.checkId,
        category: c.category,
        severity: c.severity,
        title: c.title,
        pageUrl: ctx.pageUrl,
        viewport: ctx.viewport.name,
        locale: ctx.locale,
        selector: c.selector,
      }).catch(() => {
        // best-effort
      })
    } catch (err) {
      logger.warn('Failed to write finding', {
        runId: ctx.runId,
        checkId: c.checkId,
        error: String(err),
      })
    }
  }
  return written
}

/** Persist performance metrics for a page. */
export async function writePageMetrics(
  pageId: string,
  metrics: {
    ttfb?: number
    domContentLoaded?: number
    loadEvent?: number
    lcp?: number
    cls?: number
    inp?: number
    totalBytes?: number
    requestCount?: number
    largestResources?: string
    longTasks?: number
    renderBlocking?: number
  },
): Promise<void> {
  try {
    await db.scanPageMetric.upsert({
      where: { pageId },
      update: metrics,
      create: { pageId, ...metrics },
    })
  } catch (err) {
    logger.warn('Failed to write page metrics', { pageId, error: String(err) })
  }
}
