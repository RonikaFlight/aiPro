/**
 * Finding writer — ProofPilot worker (Phase 5 + Phase 6)
 *
 * Shared utility for the analyzer runner to persist FindingCandidate results.
 *
 * Phase 6 additions:
 *   - Deterministic severity: consult `resolveSeverity()` so the same
 *     (category, checkId) always maps to the same severity, regardless of
 *     what the analyzer proposed. AI overrides are recorded but cannot
 *     silently change the severity.
 *   - Auto-reopen: if a fingerprint re-appears AND the existing finding is
 *     in RESOLVED status, transition to REOPENED (via the findings-service
 *     so the audit + scan-event hooks fire).
 *   - Suppression-aware occurrence recording: if the finding is currently
 *     suppressed (active suppression matching the fingerprint or checkId),
 *     the occurrence is still recorded (for audit) but no scan-event is
 *     emitted — the UI hides suppressed findings by default.
 */
import { db } from '../../../../src/lib/db'
import { logger } from '../../../../src/lib/logger'
import { appendScanEvent } from '../../../../src/lib/scan-events'
import { fingerprint } from '../../../../src/lib/crypto'
import { resolveSeverity } from '../../../../src/lib/finding-severity'
import { maybeAutoReopenFinding, isFindingSuppressed } from '../../../../src/lib/findings-service'
import { enqueueFindingExplanation } from '../../../../src/lib/ai/finding-explanations'
import { env } from '../../../../src/lib/env'
import type { FindingCandidate, AnalyzerContext } from './types'

export interface WrittenFinding {
  id: string
  fingerprint: string
  checkId: string
  severity: string
  title: string
  /** True if the finding was auto-reopened by this write. */
  reopened: boolean
  /** True if the finding is currently suppressed. */
  suppressed: boolean
}

/** Write a batch of finding candidates for one page analysis. */
export async function writeFindings(
  ctx: AnalyzerContext,
  candidates: FindingCandidate[],
): Promise<WrittenFinding[]> {
  const written: WrittenFinding[] = []

  // Pre-fetch suppressions for this project's checks in a single query
  // to avoid N+1 lookups during the loop. (For Phase 6 v1 we still do
  // per-finding isFindingSuppressed calls — they're cheap and only run
  // when a fingerprint matches an existing record.)
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

      // Resolve the final severity via the deterministic mapping.
      // (AI may later *propose* a different severity, but only via the
      // explicit PATCH /api/v1/findings/[id] endpoint with audit logging.)
      const { severity } = resolveSeverity(c.category, c.checkId, c.severity)

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
          // Keep severity in sync with the deterministic mapping in case
          // the rules have been updated since the finding was first recorded.
          // (Status is NOT changed here — auto-reopen is handled below.)
          severity,
        },
        create: {
          workspaceId: ctx.workspaceId,
          projectId: ctx.projectId,
          runId: ctx.runId,
          checkId: c.checkId,
          category: c.category,
          severity,
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
        select: {
          id: true,
          fingerprint: true,
          checkId: true,
          severity: true,
          title: true,
          status: true,
          aiExplanation: true,
        },
      })

      // Record an occurrence (best-effort — failures don't fail the analysis).
      await db.findingOccurrence
        .create({
          data: {
            findingId: finding.id,
            runId: ctx.runId,
            viewport: ctx.viewport.name,
            locale: ctx.locale,
            browser: ctx.browser,
            evidence: c.evidence ? JSON.stringify(c.evidence) : undefined,
          },
        })
        .catch(() => {
          /* best-effort */
        })

      // Phase 8: enqueue an AI-explanation job for findings that don't yet have
      // one. The queue's correlationId dedup collapses concurrent enqueues for
      // the same finding into a single job; `generateFindingExplanation` is
      // itself idempotent (skips when aiExplanation is already set). Best-effort
      // — never blocks the scan pipeline.
      if (env.FEATURE_AI_ENRICHMENT && !finding.aiExplanation) {
        await enqueueFindingExplanation(finding.id, ctx.workspaceId, {
          projectId: ctx.projectId,
          runId: ctx.runId,
        })
      }

      // Phase 6: auto-reopen if the finding was previously RESOLVED.
      let reopened = false
      if (finding.status === 'RESOLVED') {
        try {
          reopened = await maybeAutoReopenFinding(finding.id, ctx.runId, {
            requestId: `worker:${ctx.runId}`,
          })
        } catch (err) {
          logger.warn('Auto-reopen failed', {
            findingId: finding.id,
            runId: ctx.runId,
            error: String(err),
          })
        }
      }

      // Phase 6: check suppression status. If suppressed, we still record
      // the occurrence (for audit) but skip the scan event so SSE listeners
      // don't notify on suppressed findings.
      let suppressed = false
      try {
        suppressed = await isFindingSuppressed(fp, ctx.workspaceId, {
          checkId: c.checkId,
          projectId: ctx.projectId,
        })
      } catch (err) {
        // If the suppression check fails (e.g. transient DB error), default
        // to "not suppressed" so we don't silently hide findings.
        logger.warn('Suppression check failed', {
          findingId: finding.id,
          error: String(err),
        })
      }

      written.push({
        id: finding.id,
        fingerprint: finding.fingerprint,
        checkId: finding.checkId,
        severity: finding.severity,
        title: finding.title,
        reopened,
        suppressed,
      })

      // Emit scan event (skipped for suppressed findings).
      if (!suppressed) {
        const eventType = reopened ? 'finding.reopened' : 'finding.discovered'
        await appendScanEvent(ctx.runId, eventType, {
          findingId: finding.id,
          checkId: c.checkId,
          category: c.category,
          severity: finding.severity,
          title: c.title,
          pageUrl: ctx.pageUrl,
          viewport: ctx.viewport.name,
          locale: ctx.locale,
          selector: c.selector,
          autoReopened: reopened,
        }).catch(() => {
          /* best-effort */
        })
      }
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
