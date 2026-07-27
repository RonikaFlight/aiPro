/**
 * AI module barrel — ProofPilot
 *
 * Public surface for the provider abstraction. Internal provider classes are
 * re-exported for tests; production code should go through `getAiProvider()`.
 */
export type {
  AiProvider,
  AiProviderName,
  AiTaskType,
  ChatMessage,
  ChatRole,
  CompletionRequest,
  CompletionResponse,
  StructuredCompletionRequest,
  StructuredCompletionResponse,
  TokenUsage,
} from './types'
export { AiError } from './types'
export type { AiErrorKind } from './types'
export { estimateCostUsd, COST_PER_1K_TOKENS_USD } from './types'

export { getAiProvider, getConfiguredProviderName, isRealAiProviderActive } from './registry'
export { _setProviderForTest, _resetProviderForTest } from './registry'

export { MockAiProvider } from './mock-provider'
export { GlmAiProvider } from './glm-provider'
export { OpenAiCompatibleProvider } from './openai-compatible-provider'

export {
  recordLlmUsage,
  recordFromResponse,
  getRunTokenUsage,
  getWorkspaceDailyTokenUsage,
} from './usage'

export { extractJsonObject, estimateTokens } from './shared'
