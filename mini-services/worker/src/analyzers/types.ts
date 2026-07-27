/**
 * Analyzer shared types — ProofPilot worker (Phase 5)
 *
 * Every analyzer receives an `AnalyzerContext` and returns a list of
 * `FindingCandidate`s. The runner is responsible for writing them to the DB
 * (dedup, fingerprinting, scan events).
 *
 * Analyzers must be:
 *   - Pure: no DB writes, no global state mutation.
 *   - Safe: never execute untrusted content, never follow off-origin links,
 *     never log secrets.
 *   - Deterministic: same page → same findings (severity may be augmented by
 *     AI later, but the underlying detection must be rule-based).
 */
import type { Page } from 'playwright'

/** Categories — must match the strings used in prisma/schema.prisma Finding.category. */
export type FindingCategory =
  | 'HTTP_NAVIGATION'
  | 'RUNTIME'
  | 'RESPONSIVE'
  | 'ACCESSIBILITY'
  | 'FORMS'
  | 'PERFORMANCE'
  | 'SECURITY'
  | 'SEO'
  | 'LOCALIZATION'
  | 'JOURNEY'

/** Severities — must match Finding.severity values. */
export type FindingSeverity = 'BLOCKER' | 'CRITICAL' | 'MAJOR' | 'MINOR' | 'INFO'

/** Confidence — must match Finding.confidence values. */
export type FindingConfidence = 'HIGH' | 'MEDIUM' | 'LOW'

/** A single finding produced by an analyzer. The runner writes it to the DB. */
export interface FindingCandidate {
  checkId: string
  category: FindingCategory
  severity: FindingSeverity
  confidence?: FindingConfidence
  title: string
  description: string
  remediation?: string
  /** CSS selector or XPath identifying the affected element (if applicable). */
  selector?: string
  /** Additional evidence (JSON-serializable). */
  evidence?: Record<string, unknown>
  /** Stable message key for fingerprinting (e.g. "missing-label" not the full text). */
  messageKey: string
}

/** Data captured during the crawl pass that analyzers can reuse. */
export interface CrawlData {
  url: string
  normalizedUrl: string
  title: string | null
  httpStatus: number | null
  contentType: string | null
  redirectChain: string[]
  lang: string | null
  dir: string | null
  canonical: string | null
  consoleErrors: Array<{ type: string; text: string; url?: string; line?: number; column?: number }>
  pageErrors: string[]
  /** HTML snapshot captured during crawl (may be truncated). */
  html?: string
}

/** Network responses observed during the analysis navigation. */
export interface ObservedResponse {
  url: string
  status: number
  method: string
  contentType: string
  headers: Record<string, string>
  fromCache: boolean
  redirected: boolean
  redirectedTo?: string
  failed: boolean
  failureReason?: string
  durationMs?: number
  sizeBytes?: number
}

/** Console events captured during the analysis navigation. */
export interface ObservedConsoleEvent {
  type: string
  text: string
  url?: string
  line?: number
  column?: number
  stackTrace?: string
}

/** Performance metrics captured during analysis. */
export interface PerfMetrics {
  ttfb?: number
  domContentLoaded?: number
  loadEvent?: number
  lcp?: number
  cls?: number
  inp?: number
  fcp?: number
  totalBytes?: number
  requestCount?: number
  largestResources?: Array<{ url: string; sizeBytes: number; type: string }>
  longTasks?: number
  renderBlocking?: number
}

/** Context passed to every analyzer. */
export interface AnalyzerContext {
  runId: string
  workspaceId: string
  projectId: string
  environmentId: string
  pageId: string
  pageUrl: string
  normalizedPageUrl: string
  viewport: { name: string; width: number; height: number }
  locale: string
  browser: string
  /** The Playwright Page already navigated to pageUrl. */
  page: Page
  /** Data captured during crawl (do not re-fetch — reuse). */
  crawl: CrawlData
  /** Network responses observed during this analysis navigation. */
  responses: ObservedResponse[]
  /** Console events observed during this analysis navigation. */
  consoleEvents: ObservedConsoleEvent[]
  /** Performance metrics collected via the Performance Timeline. */
  perf: PerfMetrics
  /** The final response object for the main document navigation (if any). */
  documentResponse?: ObservedResponse
  /** Run mode — analyzers must not perform non-safe actions when PASSIVE. */
  runMode: string
  /** Abort signal — analyzers should check periodically. */
  abortSignal?: AbortSignal
}

/** An analyzer is a function from AnalyzerContext → FindingCandidate[]. */
export type Analyzer = {
  id: string
  category: FindingCategory
  run: (ctx: AnalyzerContext) => Promise<FindingCandidate[]>
}
