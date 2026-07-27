/**
 * AI provider registry — ProofPilot
 *
 * Selects the active AI provider based on env.AI_PROVIDER. If the chosen
 * provider is not configured (missing keys/config), falls back to the Mock
 * provider with a warning so the rest of the product keeps working — mirroring
 * the billing service's developer-mode fallback.
 *
 * Tests can inject a provider via `_setProviderForTest()` and reset with
 * `_resetProviderForTest()`.
 */
import { env } from '../env'
import { logger } from '../logger'
import type { AiProvider, AiProviderName } from './types'
import { MockAiProvider } from './mock-provider'
import { GlmAiProvider } from './glm-provider'
import { OpenAiCompatibleProvider } from './openai-compatible-provider'

let cached: AiProvider | null = null
let testOverride: AiProvider | null = null
let warnedAboutFallback = false

function instantiate(name: AiProviderName): AiProvider {
  switch (name) {
    case 'glm':
      return new GlmAiProvider()
    case 'openai-compatible':
      return new OpenAiCompatibleProvider()
    case 'mock':
      return new MockAiProvider()
  }
}

/**
 * Get the active AI provider. Resolves as:
 *   1. Test override (if set).
 *   2. env.AI_PROVIDER instance, IF it isConfigured().
 *   3. Mock provider (with a one-time warning).
 */
export function getAiProvider(): AiProvider {
  if (testOverride) return testOverride
  if (cached) return cached

  const wanted = env.AI_PROVIDER
  const wantedProvider = instantiate(wanted)
  if (wantedProvider.isConfigured()) {
    cached = wantedProvider
    logger.info('AI provider selected', { provider: wanted })
    return cached
  }

  if (!warnedAboutFallback) {
    warnedAboutFallback = true
    logger.warn(
      'Configured AI provider is not ready; falling back to Mock. Set AI_API_KEY/AI_BASE_URL or create .z-ai-config to enable real model calls.',
      { configuredProvider: wanted },
    )
  }
  cached = new MockAiProvider()
  return cached
}

/**
 * The provider name that was requested via env (may differ from the active
 * provider's name when the fallback kicked in). Useful for diagnostics.
 */
export function getConfiguredProviderName(): AiProviderName {
  return env.AI_PROVIDER
}

/**
 * Whether the active provider is the real configured one (vs. the Mock
 * fallback). Used by callers that want to skip AI work entirely when no real
 * model is available.
 */
export function isRealAiProviderActive(): boolean {
  return getAiProvider().name !== 'mock' || env.AI_PROVIDER === 'mock'
}

// ---------------- Test hooks ----------------

/**
 * Inject a provider for tests. Pass `null` to clear. The override bypasses the
 * cache and the configured-provider check entirely.
 */
export function _setProviderForTest(provider: AiProvider | null): void {
  testOverride = provider
  cached = null
}

/** Clear the test override and cache. */
export function _resetProviderForTest(): void {
  testOverride = null
  cached = null
  warnedAboutFallback = false
}
