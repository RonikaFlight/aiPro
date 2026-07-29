/**
 * Structured-task runner — ProofPilot (Phase 8)
 *
 * High-level wrapper that turns a task type + a prepared user message into a
 * Zod-validated, usage-recorded, version-attributed AI call. This is the
 * single entry point the product (worker + API) should use for AI work — it
 * guarantees:
 *
 *   1. The correct, versioned prompt + schema are used (from prompts.ts).
 *   2. The user message is checked for unresolved secret refs before it
 *      reaches a provider (defense-in-depth via prompt-safety.ts).
 *   3. Every call is attributed to a workspace/project/run/user so
 *      LlmUsageRecord is complete and the upcoming cost controls can enforce
 *      budgets.
 *   4. Structured output is Zod-validated by the provider; invalid output is
 *      never silently coerced (the provider throws AiError schema_validation).
 *   5. Usage recording is best-effort — a DB failure never breaks the caller.
 *
 * Callers are responsible for BUILDING the user message with the prompt-safety
 * helpers (delimitUntrusted / redactPii / truncateForPrompt) before calling
 * here. The wrapper only asserts the result is safe.
 */
import type { z } from 'zod'
import { getPrompt, getPromptVersion, isStructuredTask } from './prompts'
import type { PromptDefinition } from './prompts'
import { assertMessageSafe } from './prompt-safety'
import { getAiProvider } from './registry'
import { recordLlmUsage } from './usage'
import { assertBudget } from './cost-controls'
import { getCircuitBreaker } from './circuit-breaker'
import { AiError } from './types'
import { logger } from '../logger'
import type {
  AiProvider,
  AiProviderName,
  AiTaskType,
  ChatMessage,
  CompletionResponse,
  StructuredCompletionResponse,
  TokenUsage,
} from './types'

// ------------------------------------------------------------------
// Options + results
// ------------------------------------------------------------------

export interface RunTaskBaseOptions {
  /** Which prompt to run. Determines the system message + schema. */
  taskType: AiTaskType
  /**
   * Specific prompt version (e.g. "1.0.0"). Defaults to the latest. Use a
   * pinned version for reproducibility / rollback.
   */
  promptVersion?: string
  /**
   * The prepared user message. MUST be built with prompt-safety helpers so
   * untrusted content is delimited + redacted. The wrapper asserts no
   * unresolved {{secret.X}} refs remain.
   */
  userMessage: string
  /** Override the prompt's default temperature. */
  temperature?: number
  /** Override the prompt's default max output tokens. */
  maxTokens?: number
  /** Per-call timeout (ms). Defaults to env.AI_TIMEOUT_MS. */
  timeoutMs?: number

  // ---- Attribution (recorded on LlmUsageRecord) ----
  workspaceId?: string | null
  projectId?: string | null
  runId?: string | null
  userId?: string | null

  /**
   * Provider override (tests). Defaults to the registry's active provider.
   */
  provider?: AiProvider
}

export interface RunStructuredTaskResult<T> {
  /** The Zod-validated model output. */
  data: T
  usage: TokenUsage
  model: string
  provider: AiProviderName
  /** True if the provider needed a repair retry to satisfy the schema. */
  repaired: boolean
  /** The semantic prompt version that produced this output. */
  promptVersion: string
}

export interface RunTextTaskResult {
  content: string
  usage: TokenUsage
  model: string
  provider: AiProviderName
  finishReason: CompletionResponse['finishReason']
  promptVersion: string
}

// ------------------------------------------------------------------
// Internal helpers
// ------------------------------------------------------------------

function resolvePrompt(opts: RunTaskBaseOptions): PromptDefinition {
  return opts.promptVersion
    ? getPromptVersion(opts.taskType, opts.promptVersion)
    : getPrompt(opts.taskType)
}

function buildMessages(systemMessage: string, userMessage: string): ChatMessage[] {
  return [
    { role: 'system', content: systemMessage },
    { role: 'user', content: userMessage },
  ]
}

function resolveProvider(opts: RunTaskBaseOptions): AiProvider {
  return opts.provider ?? getAiProvider()
}

async function recordUsage(
  resp: { provider: AiProviderName; model: string; usage: TokenUsage },
  meta: {
    taskType: AiTaskType
    promptVersion: string
    workspaceId?: string | null
    projectId?: string | null
    runId?: string | null
    userId?: string | null
  },
): Promise<void> {
  // Best-effort: recordLlmUsage never throws (it catches DB errors internally),
  // but we wrap anyway to be absolutely certain a recording failure cannot
  // propagate into the caller's flow.
  try {
    await recordLlmUsage({
      provider: resp.provider,
      model: resp.model,
      usage: resp.usage,
      taskType: meta.taskType,
      promptVersion: meta.promptVersion,
      workspaceId: meta.workspaceId ?? null,
      projectId: meta.projectId ?? null,
      runId: meta.runId ?? null,
      userId: meta.userId ?? null,
    })
  } catch (err) {
    logger.warn('run-task: usage recording failed (swallowed)', {
      taskType: meta.taskType,
      promptVersion: meta.promptVersion,
      error: (err as Error).message,
    })
  }
}

// ------------------------------------------------------------------
// Circuit-breaker integration helpers
// ------------------------------------------------------------------

/**
 * Record a provider success on the workspace-scoped circuit breaker.
 * Called after a successful provider call.
 */
function recordProviderSuccess(workspaceId?: string | null): void {
  if (!workspaceId) return
  try {
    const breaker = getCircuitBreaker(`workspace:${workspaceId}`)
    breaker.recordSuccess()
  } catch (err) {
    // Circuit-breaker errors must never break the main flow.
    logger.warn('run-task: circuit breaker recordSuccess failed (swallowed)', {
      workspaceId,
      error: (err as Error).message,
    })
  }
}

/**
 * Record a provider failure on the workspace-scoped circuit breaker.
 * Called when a provider call throws. Only records for "real" errors
 * (timeout, rate_limited, provider_error) — not for schema_validation
 * (which indicates a model quality issue, not a provider availability issue).
 */
function recordProviderFailure(workspaceId?: string | null, err: unknown): void {
  if (!workspaceId) return
  try {
    // Only count transient provider failures, not validation errors.
    if (err instanceof AiError) {
      const transient = ['timeout', 'rate_limited', 'provider_error'].includes(err.kind)
      if (!transient) return
    }

    const breaker = getCircuitBreaker(`workspace:${workspaceId}`)
    breaker.recordFailure()
  } catch (err2) {
    logger.warn('run-task: circuit breaker recordFailure failed (swallowed)', {
      workspaceId,
      error: (err2 as Error).message,
    })
  }
}

// ------------------------------------------------------------------
// Public API
// ------------------------------------------------------------------

/**
 * Run a structured (Zod-validated) AI task.
 *
 * Throws AiError (schema_validation / timeout / not_configured / ...) on
 * failure — the caller decides the fallback. Usage is recorded best-effort
 * regardless of success/failure of recording.
 */
export async function runStructuredTask<T>(
  opts: RunTaskBaseOptions,
): Promise<RunStructuredTaskResult<T>> {
  const prompt = resolvePrompt(opts)

  if (!isStructuredTask(opts.taskType) || !prompt.schema) {
    throw new Error(
      `runStructuredTask: task type "${opts.taskType}" has no structured schema; use runTextTask instead.`,
    )
  }

  // Defense-in-depth: never send unresolved secret refs to a model.
  assertMessageSafe(opts.userMessage, `task=${opts.taskType}`)

  // Cost-control pre-check (budget + circuit breaker). Throws AiError if exceeded.
  await assertBudget({
    workspaceId: opts.workspaceId,
    runId: opts.runId,
    taskType: opts.taskType,
  })

  const provider = resolveProvider(opts)
  const messages = buildMessages(prompt.systemMessage, opts.userMessage)

  let resp: StructuredCompletionResponse<T>
  try {
    resp = await provider.completeStructured<T>(
      {
        messages,
        taskType: opts.taskType,
        promptVersion: prompt.version,
        temperature: opts.temperature ?? prompt.temperature,
        maxTokens: opts.maxTokens ?? prompt.maxTokens,
        timeoutMs: opts.timeoutMs,
        schema: prompt.schema as z.ZodType<T>,
        schemaName: prompt.schemaName ?? `${opts.taskType}_schema`,
      },
      prompt.schema as z.ZodType<T>,
    )
  } catch (err) {
    // Record failure on the circuit breaker (if workspace-scoped).
    recordProviderFailure(opts.workspaceId, err)
    throw err
  }

  // Record success on the circuit breaker.
  recordProviderSuccess(opts.workspaceId)

  await recordUsage(resp, {
    taskType: opts.taskType,
    promptVersion: prompt.version,
    workspaceId: opts.workspaceId,
    projectId: opts.projectId,
    runId: opts.runId,
    userId: opts.userId,
  })

  return {
    data: resp.data,
    usage: resp.usage,
    model: resp.model,
    provider: resp.provider,
    repaired: resp.repaired,
    promptVersion: prompt.version,
  }
}

/**
 * Run a text (free-form) AI task. Used for the `general` task type and any
 * future text-only prompt. Structured tasks should use runStructuredTask.
 */
export async function runTextTask(opts: RunTaskBaseOptions): Promise<RunTextTaskResult> {
  const prompt = resolvePrompt(opts)

  if (isStructuredTask(opts.taskType)) {
    throw new Error(
      `runTextTask: task type "${opts.taskType}" is a structured task; use runStructuredTask instead.`,
    )
  }

  assertMessageSafe(opts.userMessage, `task=${opts.taskType}`)

  // Cost-control pre-check (budget + circuit breaker). Throws AiError if exceeded.
  await assertBudget({
    workspaceId: opts.workspaceId,
    runId: opts.runId,
    taskType: opts.taskType,
  })

  const provider = resolveProvider(opts)
  const messages = buildMessages(prompt.systemMessage, opts.userMessage)

  let resp: CompletionResponse
  try {
    resp = await provider.complete({
      messages,
      taskType: opts.taskType,
      promptVersion: prompt.version,
      temperature: opts.temperature ?? prompt.temperature,
      maxTokens: opts.maxTokens ?? prompt.maxTokens,
      timeoutMs: opts.timeoutMs,
    })
  } catch (err) {
    recordProviderFailure(opts.workspaceId, err)
    throw err
  }

  recordProviderSuccess(opts.workspaceId)

  await recordUsage(resp, {
    taskType: opts.taskType,
    promptVersion: prompt.version,
    workspaceId: opts.workspaceId,
    projectId: opts.projectId,
    runId: opts.runId,
    userId: opts.userId,
  })

  return {
    content: resp.content,
    usage: resp.usage,
    model: resp.model,
    provider: resp.provider,
    finishReason: resp.finishReason,
    promptVersion: prompt.version,
  }
}

/**
 * Convenience: run a task and let the wrapper pick structured vs text based on
 * the prompt definition. Returns a discriminated union.
 */
export async function runTask(
  opts: RunTaskBaseOptions,
): Promise<RunStructuredTaskResult<unknown> | RunTextTaskResult> {
  if (isStructuredTask(opts.taskType)) {
    return runStructuredTask<unknown>(opts)
  }
  return runTextTask(opts)
}
