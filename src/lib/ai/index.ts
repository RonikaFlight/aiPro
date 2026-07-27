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

// ---------------- Phase 8: versioned prompts + structured-output wrapper ----------------

export {
  // prompt-safety
  delimitUntrusted,
  truncateForPrompt,
  prepareUntrusted,
  redactPii,
  assertNoSecretRefs,
  containsSecretRef,
  assertMessageSafe,
  MAX_UNTRUSTED_CONTENT_CHARS,
  type DelimitedContent,
  type RedactionResult,
} from './prompt-safety'

export {
  // versioned prompt registry + co-located schemas
  getPrompt,
  getPromptVersion,
  promptVersionOf,
  listPrompts,
  isStructuredTask,
  STRUCTURED_TASK_TYPES,
  FindingExplanationSchema,
  RunSummarySchema,
  BusinessImpactSchema,
  RemediationSchema,
  JourneyProposalSchema,
  ClientReportSchema,
  SemanticGroupingSchema,
  type PromptDefinition,
  type FindingExplanation,
  type RunSummary,
  type BusinessImpactResult,
  type Remediation,
  type JourneyProposal,
  type ClientReport,
  type SemanticGrouping,
  type DeliveryReadiness,
  type AiConfidence,
  type RemediationEffort,
} from './prompts'

export {
  // structured-task wrapper
  runStructuredTask,
  runTextTask,
  runTask,
  type RunTaskBaseOptions,
  type RunStructuredTaskResult,
  type RunTextTaskResult,
} from './run-task'

// ---------------- Phase 8: finding explanations (first task-specific feature) ----------------

export {
  generateFindingExplanation,
  enqueueFindingExplanation,
  AI_ENRICHMENT_QUEUE,
  type GenerateExplanationOptions,
  type GenerateExplanationResult,
  type FindingExplanationJobPayload,
} from './finding-explanations'

// ---------------- Phase 8: run summaries ----------------

export {
  generateRunSummary,
  enqueueRunSummary,
  type GenerateRunSummaryOptions,
  type GenerateRunSummaryResult,
  type RunSummaryJobPayload,
} from './run-summaries'

// ---------------- Phase 8: business-impact categorization ----------------

export {
  generateBusinessImpacts,
  enqueueBusinessImpacts,
  type GenerateBusinessImpactsOptions,
  type GenerateBusinessImpactsResult,
  type BusinessImpactJobPayload,
} from './business-impacts'

// ---------------- Phase 8: remediation suggestions ----------------

export {
  generateRemediationSuggestion,
  enqueueRemediationSuggestion,
  type GenerateRemediationOptions,
  type GenerateRemediationResult,
  type RemediationJobPayload,
} from './remediation-suggestions'

// ---------------- Phase 8: journey proposals ----------------

export {
  generateJourneyProposal,
  enqueueJourneyProposal,
  type GenerateJourneyProposalOptions,
  type GenerateJourneyProposalResult,
  type ValidatedJourneyProposal,
  type JourneyProposalJobPayload,
} from './journey-proposals'
