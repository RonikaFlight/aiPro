/**
 * AI provider abstraction — ProofPilot
 *
 * Provider-agnostic interface for LLM completions. Three implementations:
 *   - GlmProvider         (z-ai-web-dev-sdk → Z.ai GLM, the default in production)
 *   - OpenAiCompatible    (any OpenAI-compatible /v1/chat/completions endpoint)
 *   - MockProvider        (deterministic, offline — used in tests + when no keys)
 *
 * Design constraints (spec §"AI" + SECURITY_MODEL.md §"AI controls"):
 *   - Structured output is Zod-validated; invalid output is rejected, never
 *     silently coerced. The caller decides the fallback.
 *   - Every call carries a `taskType` + `promptVersion` so LlmUsageRecord is
 *     auditable and cost can be attributed per task.
 *   - Providers never receive secrets. Untrusted page content is delimited by
 *     the caller (see prompt-safety.ts — Phase 8 follow-up); the provider only
 *     sees already-prepared messages.
 *   - No tool selection, no code execution, no system-instruction injection —
 *     the provider emits text or JSON only.
 */
import type { z } from 'zod'

// ---------------- Messages ----------------

export type ChatRole = 'system' | 'user' | 'assistant'

export interface ChatMessage {
  role: ChatRole
  content: string
}

// ---------------- Task attribution ----------------

/**
 * Coarse task classification recorded with every LLM call for cost attribution
 * and per-task circuit breaking. Must match the `taskType` column on
 * LlmUsageRecord.
 */
export type AiTaskType =
  | 'finding_explanation'
  | 'run_summary'
  | 'business_impact'
  | 'remediation'
  | 'journey_proposal'
  | 'client_report'
  | 'semantic_grouping'
  | 'general'

// ---------------- Completion request / response ----------------

export interface CompletionRequest {
  /** Prepared messages. Untrusted content must already be delimited by caller. */
  messages: ChatMessage[]
  /** Override the configured model for this call (rare). */
  model?: string
  /** 0–2. Defaults to provider default. */
  temperature?: number
  /** Max output tokens. Defaults to provider default. */
  maxTokens?: number
  /** Per-call timeout in ms. Defaults to env.AI_TIMEOUT_MS. */
  timeoutMs?: number
  /** Required for usage attribution + circuit breaking. */
  taskType: AiTaskType
  /** Versioned prompt identifier (see prompts.ts). */
  promptVersion: string
}

export interface TokenUsage {
  promptTokens: number
  completionTokens: number
  /** Sum, convenience for budget checks. */
  totalTokens: number
}

export interface CompletionResponse {
  /** Raw text content from the model. */
  content: string
  finishReason: 'stop' | 'length' | 'content_filter' | 'tool_calls' | 'unknown'
  usage: TokenUsage
  /** The model that actually served the call (provider may rewrite). */
  model: string
  /** Provider name for audit. */
  provider: AiProviderName
}

// ---------------- Structured (JSON) output ----------------

export interface StructuredCompletionRequest extends Omit<CompletionRequest, 'messages'> {
  /**
   * Prepared messages. The system message MUST instruct the model to reply with
   * a single JSON object matching the schema. The registry does not add this
   * automatically — prompt authorship is explicit and versioned.
   */
  messages: ChatMessage[]
  /**
   * Zod schema the response must satisfy. On validation failure the call is
   * retried once with a repair nudge; if it still fails, an error is thrown
   * (never a partial/guessed object).
   */
  schema: z.ZodType<unknown>
  /** Human-readable schema name for logging (not sent to the model). */
  schemaName: string
}

export interface StructuredCompletionResponse<T> {
  data: T
  usage: TokenUsage
  model: string
  provider: AiProviderName
  /** True if a repair retry was needed. */
  repaired: boolean
}

// ---------------- Provider interface ----------------

export type AiProviderName = 'glm' | 'openai-compatible' | 'mock'

export interface AiProvider {
  readonly name: AiProviderName
  /** Whether the provider has the credentials/config needed to make real calls. */
  isConfigured(): boolean
  /** Text completion. */
  complete(req: CompletionRequest): Promise<CompletionResponse>
  /** Structured (JSON, Zod-validated) completion. */
  completeStructured<T>(
    req: StructuredCompletionRequest,
    schema: z.ZodType<T>,
  ): Promise<StructuredCompletionResponse<T>>
}

// ---------------- Errors ----------------

export type AiErrorKind =
  | 'not_configured'
  | 'timeout'
  | 'rate_limited'
  | 'invalid_response'
  | 'schema_validation'
  | 'provider_error'
  | 'budget_exceeded'
  | 'circuit_open'

export class AiError extends Error {
  readonly kind: AiErrorKind
  readonly provider: AiProviderName
  readonly retryable: boolean
  constructor(
    kind: AiErrorKind,
    message: string,
    opts: { provider?: AiProviderName; retryable?: boolean; cause?: unknown } = {},
  ) {
    super(message)
    this.name = 'AiError'
    this.kind = kind
    this.provider = opts.provider ?? 'mock'
    this.retryable = opts.retryable ?? false
    if (opts.cause !== undefined) {
      // Preserve original error for debugging without leaking it to callers.
      ;(this as { cause?: unknown }).cause = opts.cause
    }
  }
}

// ---------------- Cost estimation ----------------

/**
 * Rough per-token USD cost estimates. Used for LlmUsageRecord.estimatedCostUsd
 * and budget enforcement. Real invoices come from the provider; these are
 * conservative planning numbers.
 */
export const COST_PER_1K_TOKENS_USD: Record<string, { prompt: number; completion: number }> = {
  'glm-4.6': { prompt: 0.002, completion: 0.006 },
  'glm-4.5': { prompt: 0.002, completion: 0.006 },
  'gpt-4o': { prompt: 0.005, completion: 0.015 },
  'gpt-4o-mini': { prompt: 0.00015, completion: 0.0006 },
  mock: { prompt: 0, completion: 0 },
}

export function estimateCostUsd(
  model: string,
  usage: TokenUsage,
): number {
  const tier = COST_PER_1K_TOKENS_USD[model] ?? { prompt: 0.003, completion: 0.009 }
  return (
    (usage.promptTokens / 1000) * tier.prompt +
    (usage.completionTokens / 1000) * tier.completion
  )
}
