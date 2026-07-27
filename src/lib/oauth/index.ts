/**
 * OAuth provider registry — ProofPilot
 *
 * Looks up the adapter for a provider name and exposes the list of
 * configured providers so the UI can render the appropriate buttons.
 */
import { googleProvider } from './google'
import { githubProvider } from './github'
import { type OAuthProvider, type OAuthProviderName, isValidProviderName } from './types'

const REGISTRY: Record<OAuthProviderName, OAuthProvider> = {
  google: googleProvider,
  github: githubProvider,
}

/** Get the adapter for a provider name. Throws on unknown provider. */
export function getOAuthProvider(name: string): OAuthProvider {
  if (!isValidProviderName(name)) {
    throw new Error(`Unknown OAuth provider: ${name}`)
  }
  return REGISTRY[name]
}

/**
 * Test-only: override a provider adapter with a mock implementation.
 * Returns a restore function. NOT for production use.
 */
export function _setProviderForTest(name: OAuthProviderName, provider: OAuthProvider): () => void {
  const original = REGISTRY[name]
  REGISTRY[name] = provider
  return () => {
    REGISTRY[name] = original
  }
}

/** Get the adapter for a provider name, or null if the name is invalid. */
export function tryGetOAuthProvider(name: string | null | undefined): OAuthProvider | null {
  if (!isValidProviderName(name)) return null
  return REGISTRY[name]
}

/** List of providers that have been configured (client ID + secret + redirect URL). */
export function listConfiguredProviders(): OAuthProvider[] {
  return Object.values(REGISTRY).filter((p) => p.isConfigured())
}

/** Whether at least one provider is configured. */
export function hasConfiguredProvider(): boolean {
  return listConfiguredProviders().length > 0
}

/** All known provider names (regardless of configuration). */
export function ALL_PROVIDER_NAMES(): OAuthProviderName[] {
  return ['google', 'github']
}

export type {
  OAuthProvider,
  OAuthProviderName,
  OAuthProviderContext,
  OAuthProfile,
  OAuthTokens,
  OAuthAuthorizationRequest,
} from './types'
export {
  generateCodeVerifier,
  generateCodeChallenge,
  generateState,
  isValidStateShape,
  isValidProviderName,
  assertProviderOk,
} from './types'
