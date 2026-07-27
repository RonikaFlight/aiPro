/**
 * AI-enrichment queue handler — ProofPilot worker (Phase 8)
 *
 * Handles `ai-enrichment` jobs enqueued by:
 *   - the finding-writer (when a finding is first recorded)
 *   - future AI-driven features (run summaries, business-impact, remediation,
 *     journey proposals, client reports, semantic grouping)
 *
 * The payload carries a `task` discriminator so this one handler can dispatch
 * to the appropriate service function as more Phase 8 features land.
 *
 * Handler semantics:
 *   - Idempotent: `generateFindingExplanation` skips if an explanation is
 *     already present (unless the job explicitly forces — currently never).
 *   - Best-effort: a failure records the finding id + reason on the job but
 *     does not crash the worker. The queue's retry/dead-letter policy handles
 *     transient provider errors.
 *   - Feature-flagged: when FEATURE_AI_ENRICHMENT is false, jobs complete as
 *     no-ops (the service function returns `{ skipped: true }`).
 */
import { logger } from '../../../src/lib/logger'
import { appendScanEvent } from '../../../src/lib/scan-events'
import {
  generateFindingExplanation,
  type FindingExplanationJobPayload,
} from '../../../src/lib/ai/finding-explanations'
import type { Job } from '../../../src/lib/queue'

type AiEnrichmentPayload = FindingExplanationJobPayload

export async function handleAiEnrichment(job: Job<AiEnrichmentPayload>): Promise<void> {
  const payload = job.payload
  if (!payload || typeof payload.task !== 'string') {
    logger.warn('ai-enrichment: malformed payload', { jobId: job.id })
    return
  }

  switch (payload.task) {
    case 'finding_explanation':
      await handleFindingExplanation(job, payload)
      break
    default:
      logger.warn('ai-enrichment: unknown task', { jobId: job.id, task: payload.task })
  }
}

async function handleFindingExplanation(
  job: Job<AiEnrichmentPayload>,
  payload: FindingExplanationJobPayload,
): Promise<void> {
  const { findingId, workspaceId, projectId, runId } = payload

  logger.info('ai-enrichment: finding_explanation', { jobId: job.id, findingId, runId: runId ?? undefined })

  try {
    const result = await generateFindingExplanation(findingId, {
      workspaceId,
      projectId: projectId ?? null,
      runId: runId ?? null,
      // System-triggered (no user actor).
      userId: null,
      audit: { requestId: `worker:${job.id}`, workspaceId },
    })

    if (result.skipped) {
      logger.debug('ai-enrichment: finding_explanation skipped (feature flag off)', {
        findingId,
        jobId: job.id,
      })
      return
    }
    if (result.cached) {
      logger.debug('ai-enrichment: finding_explanation already present (cached)', {
        findingId,
        jobId: job.id,
      })
      return
    }

    // Emit a scan event so SSE listeners on the parent run can refresh the UI.
    if (runId) {
      await appendScanEvent(runId, 'finding.explained', {
        findingId,
        provider: result.provider,
        promptVersion: result.promptVersion,
      }).catch(() => {
        /* best-effort */
      })
    }

    logger.info('ai-enrichment: finding_explanation complete', {
      findingId,
      jobId: job.id,
      provider: result.provider,
      model: result.model,
      promptVersion: result.promptVersion,
    })
  } catch (err) {
    // Re-throw so the queue's retry/dead-letter policy applies. The most common
    // failure is an AI provider error (timeout / schema_validation) which is
    // often transient.
    logger.warn('ai-enrichment: finding_explanation failed', {
      findingId,
      jobId: job.id,
      error: (err as Error).message,
    })
    throw err
  }
}
