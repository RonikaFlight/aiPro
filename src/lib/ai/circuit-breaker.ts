/**
 * Circuit breaker — ProofPilot (Phase 8 Cost Controls)
 *
 * Prevents cascading failures when an AI provider is degraded. Maintains
 * per-key circuit state in memory (sufficient for single-process Next.js +
 * single worker process).
 *
 * States:
 *   CLOSED   — Normal operation. Requests pass through. Consecutive failures
 *              increment a counter. When `failureThreshold` is reached, the
 *              circuit opens.
 *   OPEN     — All requests are immediately rejected with AiError(circuit_open).
 *              After `recoveryTimeoutMs`, the circuit transitions to HALF_OPEN.
 *   HALF_OPEN — A single probe request is allowed. If it succeeds, the circuit
 *              closes. If it fails, it re-opens.
 *
 * Thread-safety note: JavaScript is single-threaded. No locks needed. The only
 * concern is the worker mini-service running in a separate process — each
 * process has its own circuit-breaker state. This is acceptable: the worker
 * calls the provider directly, so a per-process circuit is the correct scope.
 *
 * Usage:
 *   const breaker = getCircuitBreaker(`ws:${workspaceId}`)
 *   if (!breaker.allow()) throw AiError('circuit_open', ...)
 *   try {
 *     const result = await provider.complete(...)
 *     breaker.recordSuccess()
 *     return result
 *   } catch (err) {
 *     breaker.recordFailure()
 *     throw err
 *   }
 */

import type { AiErrorKind } from './types'
import { env } from '../env'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN'

export interface CircuitBreakerConfig {
  /** Consecutive failures before opening the circuit. Default: 5 */
  failureThreshold: number
  /** Milliseconds before transitioning OPEN → HALF_OPEN. Default: 60000 (1 min) */
  recoveryTimeoutMs: number
}

export interface CircuitBreakerSnapshot {
  key: string
  state: CircuitState
  consecutiveFailures: number
  totalSuccesses: number
  totalFailures: number
  openedAt: number | null
  lastFailureAt: number | null
  lastSuccessAt: number | null
}

// ---------------------------------------------------------------------------
// CircuitBreaker class
// ---------------------------------------------------------------------------

export class CircuitBreaker {
  private _state: CircuitState = 'CLOSED'
  private _consecutiveFailures = 0
  private _totalSuccesses = 0
  private _totalFailures = 0
  private _openedAt: number | null = null
  private _lastFailureAt: number | null = null
  private _lastSuccessAt: number | null = null
  private _halfOpenProbeInFlight = false

  constructor(
    public readonly key: string,
    private readonly config: CircuitBreakerConfig,
  ) {}

  // ---- Public state ----

  get state(): CircuitState {
    this._maybeTransitionToHalfOpen()
    return this._state
  }

  get consecutiveFailures(): number {
    return this._consecutiveFailures
  }

  // ---- Core operations ----

  /**
   * Whether a request is allowed to proceed.
   *
   * In CLOSED state: always allows.
   * In OPEN state: rejects (unless recovery timeout has elapsed, which triggers
   *   HALF_OPEN automatically).
   * In HALF_OPEN state: allows exactly one probe request.
   */
  allow(): boolean {
    const currentState = this.state // triggers _maybeTransitionToHalfOpen

    if (currentState === 'CLOSED') {
      return true
    }

    if (currentState === 'OPEN') {
      return false
    }

    // HALF_OPEN: allow a single probe
    if (this._halfOpenProbeInFlight) {
      return false
    }
    this._halfOpenProbeInFlight = true
    return true
  }

  /**
   * Record a successful request. Closes the circuit (or keeps it closed).
   * Resets the consecutive failure counter.
   */
  recordSuccess(): void {
    this._totalSuccesses++
    this._lastSuccessAt = Date.now()
    this._halfOpenProbeInFlight = false

    if (this._state === 'HALF_OPEN') {
      // Probe succeeded — close the circuit
      this._state = 'CLOSED'
      this._openedAt = null
    }

    this._consecutiveFailures = 0
  }

  /**
   * Record a failed request. Increments the consecutive failure counter.
   * Opens the circuit if threshold is reached. Re-opens if already HALF_OPEN.
   */
  recordFailure(): void {
    this._totalFailures++
    this._lastFailureAt = Date.now()
    this._halfOpenProbeInFlight = false

    this._consecutiveFailures++

    if (this._state === 'HALF_OPEN') {
      // Probe failed — re-open immediately
      this._state = 'OPEN'
      this._openedAt = Date.now()
      this._consecutiveFailures = this.config.failureThreshold // keep high to stay open
      return
    }

    // CLOSED → check threshold
    if (this._consecutiveFailures >= this.config.failureThreshold) {
      this._state = 'OPEN'
      this._openedAt = Date.now()
    }
  }

  /**
   * Force-reset the circuit to CLOSED. Used by admin endpoints or tests.
   */
  reset(): void {
    this._state = 'CLOSED'
    this._consecutiveFailures = 0
    this._openedAt = null
    this._halfOpenProbeInFlight = false
  }

  // ---- Snapshot / diagnostics ----

  snapshot(): CircuitBreakerSnapshot {
    return {
      key: this.key,
      state: this.state,
      consecutiveFailures: this._consecutiveFailures,
      totalSuccesses: this._totalSuccesses,
      totalFailures: this._totalFailures,
      openedAt: this._openedAt,
      lastFailureAt: this._lastFailureAt,
      lastSuccessAt: this._lastSuccessAt,
    }
  }

  // ---- Internal ----

  /**
   * If OPEN and recovery timeout has elapsed, transition to HALF_OPEN.
   */
  private _maybeTransitionToHalfOpen(): void {
    if (
      this._state === 'OPEN' &&
      this._openedAt !== null &&
      Date.now() - this._openedAt >= this.config.recoveryTimeoutMs
    ) {
      this._state = 'HALF_OPEN'
    }
  }
}

// ---------------------------------------------------------------------------
// Registry (in-memory, keyed by string)
// ---------------------------------------------------------------------------

const registry = new Map<string, CircuitBreaker>()

/**
 * Get or create a circuit breaker for the given key. Keys are typically
 * `workspace:${workspaceId}` for per-workspace isolation, or `global` for a
 * platform-wide breaker.
 */
export function getCircuitBreaker(
  key: string,
  config?: CircuitBreakerConfig,
): CircuitBreaker {
  let breaker = registry.get(key)
  if (!breaker) {
    breaker = new CircuitBreaker(
      key,
      config ?? defaultCircuitBreakerConfig(),
    )
    registry.set(key, breaker)
  }
  return breaker
}

/**
 * Reset a specific circuit breaker. Returns true if it existed.
 */
export function resetCircuitBreaker(key: string): boolean {
  const breaker = registry.get(key)
  if (!breaker) return false
  breaker.reset()
  return true
}

/**
 * Reset all circuit breakers. Used by tests.
 */
export function resetAllCircuitBreakers(): void {
  for (const breaker of registry.values()) {
    breaker.reset()
  }
}

/**
 * Get snapshots of all circuit breakers for diagnostics.
 */
export function getAllCircuitBreakerSnapshots(): CircuitBreakerSnapshot[] {
  return Array.from(registry.values()).map((b) => b.snapshot())
}

/**
 * Get snapshot of a single circuit breaker, or null if it doesn't exist.
 */
export function getCircuitBreakerSnapshot(key: string): CircuitBreakerSnapshot | null {
  const breaker = registry.get(key)
  return breaker?.snapshot() ?? null
}

// ---------------------------------------------------------------------------
// Config defaults (read from env once, then cached)
// ---------------------------------------------------------------------------

let _cachedConfig: CircuitBreakerConfig | null = null

export function defaultCircuitBreakerConfig(): CircuitBreakerConfig {
  if (_cachedConfig) return _cachedConfig

  _cachedConfig = {
    failureThreshold: env.AI_CIRCUIT_BREAKER_FAILURE_THRESHOLD,
    recoveryTimeoutMs: env.AI_CIRCUIT_BREAKER_RECOVERY_TIMEOUT_MS,
  }
  return _cachedConfig
}
