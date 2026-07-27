/**
 * LLM usage recording — ProofPilot
 *
 * Persists every AI call as an immutable LlmUsageRecord row. This is the
 * foundation for Phase 8 cost controls (per-run / per-workspace-daily / per-plan
 * budgets + circuit breaker). The records also feed the admin "AI usage" view
 * and the usage ledger aggregation.
 *
 * Records are written best-effort: a failure to record must never break the
 * caller's flow (e.g. a scan completing). Errors are logged but not re-thrown.
 */
import { db } from '../db'
import { logger } from '../logger'
import { estimateCostUsd } from './types'
import type { AiProviderName, AiTaskType, TokenUsage } from './types'

export interface RecordLlmUsageInput {
  workspaceId?: string | null
  projectId?: string | null
  runId?: string | null
  userId?: string | null
  provider: AiProviderName
  model: string
  usage: TokenUsage
  taskType: AiTaskType
  promptVersion: string
  /** Optional override; if absent, estimated from model + usage. */
  estimatedCostUsd?: number
}

/**
 * Persist a usage record. Safe to call from the worker (writes to the shared
 * SQLite DB) or the API process. Never throws — returns true on success.
 */
export async function recordLlmUsage(input: RecordLlmUsageInput): Promise<boolean> {
  try {
    const estimatedCostUsd =
      input.estimatedCostUsd ??
      estimateCostUsd(input.model, input.usage)
    await db.llmUsageRecord.create({
      data: {
        workspaceId: input.workspaceId ?? null,
        projectId: input.projectId ?? null,
        runId: input.runId ?? null,
        userId: input.userId ?? null,
        provider: input.provider,
        model: input.model,
        promptTokens: input.usage.promptTokens,
        completionTokens: input.usage.completionTokens,
        estimatedCostUsd,
        taskType: input.taskType,
        promptVersion: input.promptVersion,
      },
    })
    return true
  } catch (err) {
    // Never let usage recording break the calling flow.
    logger.error('Failed to record LLM usage', {
      error: (err as Error).message,
      provider: input.provider,
      taskType: input.taskType,
      promptVersion: input.promptVersion,
    })
    return false
  }
}

/**
 * Sum tokens used in a single run. Used by the per-run budget guard.
 */
export async function getRunTokenUsage(runId: string): Promise<number> {
  // totalTokens isn't a stored column (we persist prompt + completion separately),
  // so sum the two and add them.
  const agg = await db.llmUsageRecord.aggregate({
    _sum: { promptTokens: true, completionTokens: true },
    where: { runId },
  })
  return (agg._sum.promptTokens ?? 0) + (agg._sum.completionTokens ?? 0)
}

/**
 * Sum tokens used by a workspace in the current UTC day. Used by the
 * per-workspace-daily budget guard.
 */
export async function getWorkspaceDailyTokenUsage(workspaceId: string): Promise<number> {
  const startOfDay = new Date()
  startOfDay.setUTCHours(0, 0, 0, 0)
  const agg = await db.llmUsageRecord.aggregate({
    _sum: { promptTokens: true, completionTokens: true },
    where: {
      workspaceId,
      createdAt: { gte: startOfDay },
    },
  })
  return (agg._sum.promptTokens ?? 0) + (agg._sum.completionTokens ?? 0)
}

/**
 * Convenience: record usage from a CompletionResponse-like object.
 */
export async function recordFromResponse(
  resp: {
    provider: AiProviderName
    model: string
    usage: TokenUsage
  },
  meta: {
    taskType: AiTaskType
    promptVersion: string
    workspaceId?: string | null
    projectId?: string | null
    runId?: string | null
    userId?: string | null
  },
): Promise<boolean> {
  return recordLlmUsage({
    ...meta,
    provider: resp.provider,
    model: resp.model,
    usage: resp.usage,
  })
}
