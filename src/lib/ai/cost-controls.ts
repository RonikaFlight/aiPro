/**
 * AI cost controls — ProofPilot (Phase 8)
 *
 * Enforces budgets and rate limits on AI usage before a provider call is made.
 * The enforcement points are:
 *
 *   1. **Per-run token budget** — Total tokens consumed by a single scan run.
 *      Uses existing `AI_MAX_TOKENS_PER_RUN` env var. Checked via
 *      `getRunTokenUsage()` (reads LlmUsageRecord aggregate).
 *
 *   2. **Per-workspace daily token budget** — Total tokens consumed by a
 *      workspace in the current UTC day. Uses existing
 *      `AI_DAILY_WORKSPACE_BUDGET_TOKENS` env var. Checked via
 *      `getWorkspaceDailyTokenUsage()`.
 *
 *   3. **Per-plan AI token limit** — An additional cap based on subscription
 *      plan (currently reads from env; will be replaced by plan-tier lookup
 *      when billing is integrated). Uses `AI_PLAN_MAX_TOKENS_MONTHLY` as a
 *      workspace-monthly ceiling.
 *
 *   4. **Retry budget** — Limits how many retries (repair attempts in
 *      structured-task, provider-level retries) are allowed per (workspace,
 *      taskType, runId) tuple. Tracked in-memory with configurable per-task
 *      caps via `AI_MAX_RETRIES_PER_TASK`.
 *
 *   5. **Circuit breaker** — Wraps provider calls; tracks consecutive failures
 *      per workspace. Delegates to `circuit-breaker.ts`.
 *
 * All checks are performed by `checkBudget()` which is called inside
 * `run-task.ts` before the provider call. If any check fails, an AiError is
 * thrown with the appropriate kind (`budget_exceeded` or `circuit_open`),
 * preventing the call from reaching the provider.
 *
 * Design principles:
 *   - Budgets are checked BEFORE the call, not after. This prevents wasted
 *     tokens on calls that would exceed the budget.
 *   - Budget checks are best-effort for the database queries (swallow errors
 *     so a DB blip doesn't block all AI calls). On DB error, we log and allow
 *     the call (fail-open for availability).
 *   - Retry budget is tracked in-memory only (no persistence). A process
 *     restart resets the counter, which is acceptable.
 *   - Circuit breaker is per-workspace, so one workspace's provider issues
 *     don't affect other workspaces.
 */

import { AiError } from './types'
import type { AiTaskType } from './types'
import { getRunTokenUsage, getWorkspaceDailyTokenUsage } from './usage'
import { getCircuitBreaker, type CircuitBreakerSnapshot } from './circuit-breaker'
import { logger } from '../logger'
import { env } from '../env'
import { db } from '../db'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BudgetCheckOptions {
  /** Workspace ID for per-workspace and circuit-breaker scope. */
  workspaceId?: string | null
  /** Run ID for per-run budget. */
  runId?: string | null
  /** Task type for retry budget and per-task limits. */
  taskType: AiTaskType
  /**
   * How many tokens this call is estimated to consume. Used for pre-check
   * projection (current usage + estimated > budget → reject). If not
   * provided, we check current usage against the budget minus a generous
   * buffer (10k tokens) to avoid rejecting calls that are within budget.
   */
  estimatedTokens?: number
}

export interface BudgetCheckResult {
  /** Whether all budget checks passed. */
  allowed: boolean
  /** If not allowed, the reason. */
  reason?: BudgetExceededReason
  /** Human-readable detail. */
  detail?: string
}

export type BudgetExceededReason =
  | 'run_token_budget'
  | 'daily_workspace_budget'
  | 'monthly_plan_budget'
  | 'retry_budget_exhausted'
  | 'circuit_open'

export interface CostControlDiagnostics {
  workspaceId?: string | null
  runId?: string | null
  taskType: AiTaskType
  runTokensUsed: number
  runTokenLimit: number
  dailyTokensUsed: number
  dailyTokenLimit: number
  monthlyTokensUsed: number
  monthlyTokenLimit: number
  retryBudgetUsed: number
  retryBudgetLimit: number
  circuitBreaker: CircuitBreakerSnapshot | null
}

// ---------------------------------------------------------------------------
// Retry budget (in-memory)
// ---------------------------------------------------------------------------

/**
 * Key format: `${workspaceId}:${taskType}:${runId}`
 * Values: number of retries consumed.
 */
const retryBudgetMap = new Map<string, number>()

function retryBudgetKey(opts: {
  workspaceId?: string | null
  taskType: AiTaskType
  runId?: string | null
}): string {
  return `${opts.workspaceId ?? '_global'}:${opts.taskType}:${opts.runId ?? '_no_run'}`
}

/**
 * Consume one retry attempt. Returns false if the budget is exhausted.
 */
export function consumeRetryBudget(opts: {
  workspaceId?: string | null
  taskType: AiTaskType
  runId?: string | null
}): boolean {
  const key = retryBudgetKey(opts)
  const current = retryBudgetMap.get(key) ?? 0
  const max = env.AI_MAX_RETRIES_PER_TASK

  if (current >= max) {
    return false
  }

  retryBudgetMap.set(key, current + 1)
  return true
}

/**
 * Get the current retry budget consumption for a given key.
 */
export function getRetryBudgetUsed(opts: {
  workspaceId?: string | null
  taskType: AiTaskType
  runId?: string | null
}): number {
  return retryBudgetMap.get(retryBudgetKey(opts)) ?? 0
}

/**
 * Reset retry budget for a key (test helper).
 */
export function resetRetryBudget(opts: {
  workspaceId?: string | null
  taskType: AiTaskType
  runId?: string | null
}): void {
  retryBudgetMap.delete(retryBudgetKey(opts))
}

/**
 * Reset all retry budgets (test helper).
 */
export function resetAllRetryBudgets(): void {
  retryBudgetMap.clear()
}

// ---------------------------------------------------------------------------
// Budget checking
// ---------------------------------------------------------------------------

/**
 * Check all budgets for a pending AI call. Should be called BEFORE the provider
 * call in run-task.ts.
 *
 * Returns `{ allowed: true }` if all checks pass, or
 * `{ allowed: false, reason, detail }` if any check fails.
 *
 * Fail-open: if a DB query fails, we log and allow the call. We don't want a
 * transient DB issue to block all AI enrichment.
 */
export async function checkBudget(opts: BudgetCheckOptions): Promise<BudgetCheckResult> {
  // ---- 1. Circuit breaker check (in-memory, no DB) ----

  if (opts.workspaceId) {
    const breaker = getCircuitBreaker(`workspace:${opts.workspaceId}`)
    if (!breaker.allow()) {
      const snap = breaker.snapshot()
      logger.warn('AI circuit breaker is open', {
        workspaceId: opts.workspaceId,
        taskType: opts.taskType,
        consecutiveFailures: snap.consecutiveFailures,
        state: snap.state,
      })
      return {
        allowed: false,
        reason: 'circuit_open',
        detail: `AI circuit breaker is open for workspace ${opts.workspaceId} after ${snap.consecutiveFailures} consecutive failures. Try again later.`,
      }
    }
  }

  // ---- 2. Per-run token budget ----

  if (opts.runId) {
    try {
      const used = await getRunTokenUsage(opts.runId)
      const limit = env.AI_MAX_TOKENS_PER_RUN
      const estimated = opts.estimatedTokens ?? 10000 // conservative buffer
      if (used + estimated > limit) {
        logger.warn('Per-run AI token budget exceeded', {
          runId: opts.runId,
          taskType: opts.taskType,
          used,
          limit,
          estimated,
        })
        return {
          allowed: false,
          reason: 'run_token_budget',
          detail: `Run ${opts.runId} has used ${used}/${limit} tokens (estimated ${estimated} more needed).`,
        }
      }
    } catch (err) {
      // Fail-open: log but don't block
      logger.warn('checkBudget: failed to query per-run usage (fail-open)', {
        runId: opts.runId,
        error: (err as Error).message,
      })
    }
  }

  // ---- 3. Per-workspace daily token budget ----

  if (opts.workspaceId) {
    try {
      const used = await getWorkspaceDailyTokenUsage(opts.workspaceId)
      const limit = env.AI_DAILY_WORKSPACE_BUDGET_TOKENS
      const estimated = opts.estimatedTokens ?? 10000
      if (used + estimated > limit) {
        logger.warn('Daily workspace AI token budget exceeded', {
          workspaceId: opts.workspaceId,
          taskType: opts.taskType,
          used,
          limit,
          estimated,
        })
        return {
          allowed: false,
          reason: 'daily_workspace_budget',
          detail: `Workspace has used ${used}/${limit} tokens today (estimated ${estimated} more needed). Daily budget resets at midnight UTC.`,
        }
      }
    } catch (err) {
      // Fail-open: log but don't block
      logger.warn('checkBudget: failed to query daily usage (fail-open)', {
        workspaceId: opts.workspaceId,
        error: (err as Error).message,
      })
    }
  }

  // ---- 4. Per-plan monthly budget (workspace-scoped) ----

  if (opts.workspaceId && env.AI_PLAN_MAX_TOKENS_MONTHLY > 0) {
    try {
      const used = await getWorkspaceMonthlyTokenUsage(opts.workspaceId)
      const limit = env.AI_PLAN_MAX_TOKENS_MONTHLY
      const estimated = opts.estimatedTokens ?? 10000
      if (used + estimated > limit) {
        logger.warn('Monthly plan AI token budget exceeded', {
          workspaceId: opts.workspaceId,
          taskType: opts.taskType,
          used,
          limit,
          estimated,
        })
        return {
          allowed: false,
          reason: 'monthly_plan_budget',
          detail: `Workspace has used ${used}/${limit} tokens this month. Upgrade your plan or wait for the next billing cycle.`,
        }
      }
    } catch (err) {
      // Fail-open
      logger.warn('checkBudget: failed to query monthly usage (fail-open)', {
        workspaceId: opts.workspaceId,
        error: (err as Error).message,
      })
    }
  }

  // ---- 5. Retry budget ----

  const retriesUsed = getRetryBudgetUsed({
    workspaceId: opts.workspaceId,
    taskType: opts.taskType,
    runId: opts.runId,
  })
  if (retriesUsed >= env.AI_MAX_RETRIES_PER_TASK) {
    logger.warn('Retry budget exhausted', {
      workspaceId: opts.workspaceId,
      taskType: opts.taskType,
      runId: opts.runId,
      retriesUsed,
      max: env.AI_MAX_RETRIES_PER_TASK,
    })
    return {
      allowed: false,
      reason: 'retry_budget_exhausted',
      detail: `Retry budget exhausted for ${opts.taskType} (${retriesUsed}/${env.AI_MAX_RETRIES_PER_TASK}).`,
    }
  }

  return { allowed: true }
}

/**
 * Convenience: check budget and throw AiError if not allowed. Used by
 * run-task.ts to keep the integration point concise.
 */
export async function assertBudget(opts: BudgetCheckOptions): Promise<void> {
  const result = await checkBudget(opts)
  if (!result.allowed) {
    const kind = result.reason === 'circuit_open' ? 'circuit_open' : 'budget_exceeded'
    throw new AiError(kind, result.detail ?? 'AI budget exceeded', {
      retryable: result.reason === 'circuit_open', // circuit_open is retryable (will eventually recover)
    })
  }
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

/**
 * Collect cost-control diagnostics for a workspace/run. Used by admin endpoints.
 */
export async function getCostControlDiagnostics(opts: {
  workspaceId?: string | null
  runId?: string | null
  taskType: AiTaskType
}): Promise<CostControlDiagnostics> {
  const [runTokensUsed, dailyTokensUsed, monthlyTokensUsed] = await Promise.all([
    opts.runId ? getRunTokenUsage(opts.runId).catch(() => 0) : Promise.resolve(0),
    opts.workspaceId
      ? getWorkspaceDailyTokenUsage(opts.workspaceId).catch(() => 0)
      : Promise.resolve(0),
    opts.workspaceId
      ? getWorkspaceMonthlyTokenUsage(opts.workspaceId).catch(() => 0)
      : Promise.resolve(0),
  ])

  const circuitBreaker = opts.workspaceId
    ? getCircuitBreakerSnapshot(`workspace:${opts.workspaceId}`)
    : null

  return {
    workspaceId: opts.workspaceId,
    runId: opts.runId,
    taskType: opts.taskType,
    runTokensUsed,
    runTokenLimit: env.AI_MAX_TOKENS_PER_RUN,
    dailyTokensUsed,
    dailyTokenLimit: env.AI_DAILY_WORKSPACE_BUDGET_TOKENS,
    monthlyTokensUsed,
    monthlyTokenLimit: env.AI_PLAN_MAX_TOKENS_MONTHLY,
    retryBudgetUsed: getRetryBudgetUsed(opts),
    retryBudgetLimit: env.AI_MAX_RETRIES_PER_TASK,
    circuitBreaker,
  }
}

// ---------------------------------------------------------------------------
// Monthly usage aggregation (for per-plan limits)
// ---------------------------------------------------------------------------

/**
 * Sum tokens used by a workspace in the current calendar month.
 * Used by the per-plan monthly budget check.
 *
 * Uses SQLite aggregation on LlmUsageRecord — efficient with the
 * `[workspaceId, createdAt]` index.
 */
async function getWorkspaceMonthlyTokenUsage(workspaceId: string): Promise<number> {
  const now = new Date()
  const startOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0))

  const agg = await db.llmUsageRecord.aggregate({
    _sum: { promptTokens: true, completionTokens: true },
    where: {
      workspaceId,
      createdAt: { gte: startOfMonth },
    },
  })
  return (agg._sum.promptTokens ?? 0) + (agg._sum.completionTokens ?? 0)
}
