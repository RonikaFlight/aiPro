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
import {
  generateRunSummary,
  type RunSummaryJobPayload,
} from '../../../src/lib/ai/run-summaries'
import type { Job } from '../../../src/lib/queue'

type AiEnrichmentPayload = FindingExplanationJobPayload | RunSummaryJobPayload

export async function handleAiEnrichment(job: Job<AiEnrichmentPayload>): Promise<void> {
  const payload = job.payload
  if (!payload || typeof payload.task !== 'string') {
    logger.warn('ai-enrichment: malformed payload', { jobId: job.id })
    return
  }

  // Widen to `string` so the `default` branch below does not narrow `task` to
  // `never` (TS2339) once both union literals are exhausted.
  const task: string = payload.task

  switch (task) {
    case 'finding_explanation':
      await handleFindingExplanation(job, payload as FindingExplanationJobPayload)
      break
    case 'run_summary':
      await handleRunSummary(job, payload as RunSummaryJobPayload)
      break
    default:
      logger.warn('ai-enrichment: unknown task', { jobId: job.id, task })
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

/**
 * Handle a `run_summary` ai-enrichment job.
 *
 * Generates (or returns the cached) AI summary for a completed scan run and
 * emits a `run.summarized` scan event so SSE listeners on the run can refresh
 * the UI. Generation is idempotent — if a summary already exists the job is a
 * no-op. A `ValidationError` from the service (run still QUEUED/RUNNING) is
 * treated as a soft skip rather than a failure, since the auto-enqueue path
 * fires when the last page is analyzed but the run row's status may briefly
 * still read RUNNING under contention.
 */
async function handleRunSummary(
  job: Job<AiEnrichmentPayload>,
  payload: RunSummaryJobPayload,
): Promise<void> {
  const { runId, workspaceId, projectId } = payload

  logger.info('ai-enrichment: run_summary', { jobId: job.id, runId })

  try {
    const result = await generateRunSummary(runId, {
      workspaceId,
      projectId: projectId ?? null,
      // System-triggered (no user actor).
      userId: null,
      audit: { requestId: `worker:${job.id}`, workspaceId },
    })

    if (result.skipped) {
      logger.debug('ai-enrichment: run_summary skipped (feature flag off)', {
        runId,
        jobId: job.id,
      })
      return
    }
    if (result.cached) {
      logger.debug('ai-enrichment: run_summary already present (cached)', {
        runId,
        jobId: job.id,
      })
      return
    }

    // Emit a scan event so SSE listeners on the run can refresh the UI.
    await appendScanEvent(runId, 'run.summarized', {
      provider: result.provider,
      promptVersion: result.promptVersion,
      deliveryReadiness: result.summary?.deliveryReadiness ?? null,
    }).catch(() => {
      /* best-effort */
    })

    logger.info('ai-enrichment: run_summary complete', {
      runId,
      jobId: job.id,
      provider: result.provider,
      model: result.model,
      promptVersion: result.promptVersion,
    })
  } catch (err) {
    // A ValidationError means the run wasn't ready (still QUEUED/RUNNING).
    // This can happen under contention between the last page-analysis job and
    // the orchestrator's status update. Treat as a soft skip — the on-demand
    // API endpoint will generate the summary once the run is truly done.
    if (err && typeof err === 'object' && 'name' in err && (err as { name: string }).name === 'ValidationError') {
      logger.debug('ai-enrichment: run_summary deferred (run not yet terminal)', {
        runId,
        jobId: job.id,
      })
      return
    }
    // Re-throw other errors so the queue's retry/dead-letter policy applies.
    logger.warn('ai-enrichment: run_summary failed', {
      runId,
      jobId: job.id,
      error: (err as Error).message,
    })
    throw err
  }
}
