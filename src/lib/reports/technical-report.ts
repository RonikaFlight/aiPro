/**
 * Technical report service — ProofPilot (Phase 9)
 *
 * Aggregates all scan data for a given ScanRun into a structured technical
 * report object. The report contains:
 *
 *   - Run metadata (status, trigger, timing, score, config)
 *   - Environment (target URL, auth mode, network restrictions)
 *   - Scan profile (project info, workspace branding)
 *   - Pages tested (URLs, titles, HTTP status, crawl depth, performance metrics)
 *   - Journeys executed (status, step outcomes, screenshots)
 *   - Findings by severity (counts, details, evidence, AI enrichments)
 *   - Performance summary (Core Web Vitals aggregated)
 *   - Accessibility summary (a11y-specific finding counts)
 *   - Runtime errors (console errors from journey steps, network errors)
 *   - Blocked checks (blocked network requests count)
 *   - Scan limitations (pages not analyzed, depth limits, auth restrictions)
 *
 * Design principles:
 *   - The report is a read-only aggregation — no mutations.
 *   - AI-generated content (aiSummary, aiExplanation, aiRemediation,
 *     aiSemanticGroupingJson, aiClientReportJson) is included when available
 *     but the report does not depend on it.
 *   - Evidence (screenshots, HAR) is referenced by artifact ID, not inlined.
 *   - The report is generated synchronously for the API endpoint; caching
 *     the full JSON on ScanRun is possible but not done initially (the data
 *     is queried on-demand since the report may be requested infrequently).
 *
 * The report structure is designed to be:
 *   1. Serializable to JSON for API responses.
 *   2. Consumable by the future PDF exporter (Phase 9).
 *   3. Transformable into a client-friendly report by stripping technical
 *      details (Phase 9, separate endpoint).
 */

import { db } from '../db'
import { NotFoundError } from '../errors'

// ---------------------------------------------------------------------------
// Types — Technical Report Structure
// ---------------------------------------------------------------------------

export interface TechnicalReport {
  /** Report generation metadata. */
  meta: ReportMeta
  /** Run details. */
  run: ReportRun
  /** Project and workspace context. */
  project: ReportProject
  /** Environment that was scanned. */
  environment: ReportEnvironment | null
  /** Scan configuration used. */
  config: ReportConfig
  /** All pages discovered + analyzed. */
  pages: ReportPage[]
  /** Journey runs executed during/after this scan. */
  journeys: ReportJourney[]
  /** Findings grouped by severity. */
  findings: ReportFindings
  /** Core Web Vitals performance summary. */
  performance: ReportPerformance
  /** Accessibility-specific summary. */
  accessibility: ReportAccessibility
  /** Runtime errors and blocked resources. */
  errors: ReportErrors
  /** Limitations and caveats. */
  limitations: string[]
}

export interface ReportMeta {
  generatedAt: string
  reportVersion: string
  runId: string
  projectId: string
  workspaceId: string
}

export interface ReportRun {
  id: string
  status: string
  trigger: string
  runMode: string
  startedAt: string | null
  completedAt: string | null
  durationMs: number | null
  score: number | null
  previousScore: number | null
  scoreDelta: number | null
  pagesDiscovered: number
  pagesAnalyzed: number
  findingsCount: number
  blockerCount: number
  failedReason: string | null
  /** AI-generated executive summary (if available). */
  aiSummary: string | null
}

export interface ReportProject {
  id: string
  name: string
  productType: string
  primaryLocale: string
  supportedLocales: string[]
  productionUrl: string
  /** Workspace branding. */
  workspace: {
    id: string
    name: string
    brandName: string | null
    brandIntro: string | null
    brandFooter: string | null
    brandContactEmail: string | null
    brandContactUrl: string | null
    customDomain: string | null
    logoUrl: string | null
    accentColor: string | null
  }
}

export interface ReportEnvironment {
  id: string
  type: string
  baseUrl: string
  authMode: string
  scanMode: string
}

export interface ReportConfig {
  maxPages: number
  maxDepth: number
  timeoutMs: number
  viewports: string[]
  locales: string[]
  browsers: string[]
  analyzers: string[] | null
  journeyIds: string[] | null
}

export interface ReportPage {
  id: string
  url: string
  normalizedUrl: string
  title: string | null
  httpStatus: number | null
  depth: number
  lang: string | null
  dir: string | null
  /** Core Web Vitals for this page (if analyzed). */
  metrics: {
    ttfb: number | null
    domContentLoaded: number | null
    loadEvent: number | null
    lcp: number | null
    cls: number | null
    inp: number | null
    totalBytes: number | null
    requestCount: number | null
  } | null
  analyzedAt: string | null
}

export interface ReportJourney {
  id: string
  journeyId: string
  status: string
  runMode: string
  trigger: string
  targetUrl: string
  viewport: string | null
  browser: string
  stepsTotal: number
  stepsPassed: number
  stepsFailed: number
  stepsSkipped: number
  startedAt: string | null
  completedAt: string | null
  failedReason: string | null
  /** Individual step outcomes. */
  steps: ReportJourneyStep[]
}

export interface ReportJourneyStep {
  stepIndex: number
  stepType: string
  stepLabel: string | null
  status: string
  durationMs: number
  error: string | null
  consoleErrors: number
  networkErrors: number
  /** Artifact IDs for before/after failure screenshots. */
  beforeScreenshotId: string | null
  afterScreenshotId: string | null
}

export interface ReportFindings {
  totalCount: number
  /** Counts by severity. */
  bySeverity: Record<string, number>
  /** Counts by category. */
  byCategory: Record<string, number>
  /** Counts by status. */
  byStatus: Record<string, number>
  /** Individual findings with details. */
  items: ReportFinding[]
  /** AI-generated semantic grouping (if available). */
  semanticGroups: ReportSemanticGroup[] | null
}

export interface ReportFinding {
  id: string
  checkId: string
  category: string
  severity: string
  status: string
  confidence: string
  title: string
  description: string | null
  affectedUrl: string
  normalizedUrl: string
  viewport: string | null
  locale: string | null
  browser: string | null
  /** Deterministic remediation (from check definition). */
  remediation: string | null
  /** AI-generated explanation (if available). */
  aiExplanation: string | null
  /** AI-generated remediation (if available). */
  aiRemediation: {
    summary: string | null
    steps: string[]
    estimatedEffort: string | null
  } | null
  /** Business impact categories (if available). */
  businessImpact: string | null
  /** DOM selector for the affected element. */
  domSelector: string | null
  /** Number of occurrences across viewports/locales. */
  occurrenceCount: number
  /** First occurrence evidence (JSON, if available). */
  firstOccurrenceEvidence: Record<string, unknown> | null
  firstOccurrenceScreenshotArtifactId: string | null
  firstSeenAt: string
  lastSeenAt: string
  resolvedAt: string | null
}

export interface ReportSemanticGroup {
  groupId: string
  label: string
  findingIds: string[]
  sharedRootCause: string
}

export interface ReportPerformance {
  /** Total pages with performance metrics. */
  pagesMeasured: number
  /** Aggregated Core Web Vitals across all pages. */
  avg: {
    ttfb: number | null
    domContentLoaded: number | null
    loadEvent: number | null
    lcp: number | null
    cls: number | null
    inp: number | null
    totalBytes: number | null
    requestCount: number | null
  }
  /** Worst (highest) values across all pages. */
  worst: {
    lcp: number | null
    cls: number | null
    inp: number | null
    loadEvent: number | null
  }
  /** Slowest page by loadEvent. */
  slowestPage: {
    url: string
    title: string | null
    loadEvent: number
  } | null
}

export interface ReportAccessibility {
  /** Total a11y-specific findings. */
  totalA11yFindings: number
  /** A11y findings by severity. */
  bySeverity: Record<string, number>
  /** A11y-specific categories found. */
  categories: string[]
  /** A11y finding IDs for reference. */
  findingIds: string[]
}

export interface ReportErrors {
  /** Total console errors across journey steps. */
  totalConsoleErrors: number
  /** Total network errors across journey steps. */
  totalNetworkErrors: number
  /** Blocked network requests. */
  blockedRequests: number
  /** Journey failures. */
  journeyFailures: number
}

// ---------------------------------------------------------------------------
// Service Functions
// ---------------------------------------------------------------------------

export interface GenerateTechnicalReportOptions {
  runId: string
  workspaceId: string
}

export interface GenerateTechnicalReportResult {
  report: TechnicalReport
  generatedAt: string
}

/**
 * Generate a full technical report for a scan run.
 * Loads all related data and assembles into the structured report object.
 */
export async function generateTechnicalReport(
  opts: GenerateTechnicalReportOptions,
): Promise<GenerateTechnicalReportResult> {
  const { runId, workspaceId } = opts

  // ---- Load run ----

  const run = await db.scanRun.findFirst({
    where: { id: runId, workspaceId },
    include: {
      project: {
        include: {
          workspace: {
            select: {
              id: true,
              name: true,
              brandName: true,
              brandIntro: true,
              brandFooter: true,
              brandContactEmail: true,
              brandContactUrl: true,
              customDomain: true,
              logoUrl: true,
              accentColor: true,
            },
          },
        },
      },
      environment: {
        select: {
          id: true,
          type: true,
          baseUrl: true,
          authMode: true,
          scanMode: true,
        },
      },
    },
  })

  if (!run) {
    throw new NotFoundError(`Scan run ${runId} not found in workspace ${workspaceId}`)
  }

  // Parse config snapshot
  let config: ReportConfig = {
    maxPages: 20,
    maxDepth: 3,
    timeoutMs: 60000,
    viewports: [],
    locales: [],
    browsers: [],
    analyzers: null,
    journeyIds: null,
  }
  try {
    const parsed = JSON.parse(run.configSnapshot) as Partial<ReportConfig>
    config = { ...config, ...parsed }
  } catch {
    // config snapshot is malformed — use defaults
  }

  const durationMs =
    run.startedAt && run.completedAt
      ? run.completedAt.getTime() - run.startedAt.getTime()
      : null

  const scoreDelta =
    run.score !== null && run.previousScore !== null
      ? run.score - run.previousScore
      : null

  // ---- Load pages + metrics ----

  const pages = await db.scanPage.findMany({
    where: { runId },
    orderBy: [{ depth: 'asc' }, { url: 'asc' }],
    include: {
      metrics: true,
    },
  })

  const reportPages: ReportPage[] = pages.map((p) => ({
    id: p.id,
    url: p.url,
    normalizedUrl: p.normalizedUrl,
    title: p.title,
    httpStatus: p.httpStatus,
    depth: p.depth,
    lang: p.lang,
    dir: p.dir,
    metrics: p.metrics
      ? {
          ttfb: p.metrics.ttfb,
          domContentLoaded: p.metrics.domContentLoaded,
          loadEvent: p.metrics.loadEvent,
          lcp: p.metrics.lcp,
          cls: p.metrics.cls,
          inp: p.metrics.inp,
          totalBytes: p.metrics.totalBytes,
          requestCount: p.metrics.requestCount,
        }
      : null,
    analyzedAt: p.analyzedAt?.toISOString() ?? null,
  }))

  // ---- Load findings ----

  const findings = await db.finding.findMany({
    where: { runId, workspaceId },
    orderBy: [
      { severity: 'desc' }, // CRITICAL first
      { firstSeenAt: 'asc' },
    ],
  })

  // Count aggregations
  const bySeverity: Record<string, number> = {}
  const byCategory: Record<string, number> = {}
  const byStatus: Record<string, number> = {}
  const a11yCategories = new Set<string>()
  const a11yFindingIds: string[] = []
  const a11yBySeverity: Record<string, number> = {}

  for (const f of findings) {
    bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1
    byCategory[f.category] = (byCategory[f.category] ?? 0) + 1
    byStatus[f.status] = (byStatus[f.status] ?? 0) + 1

    if (isAccessibilityCategory(f.category)) {
      a11yCategories.add(f.category)
      a11yFindingIds.push(f.id)
      a11yBySeverity[f.severity] = (a11yBySeverity[f.severity] ?? 0) + 1
    }
  }

  // Load occurrences for findings
  const findingIds = findings.map((f) => f.id)
  const occurrences = findingIds.length > 0
    ? await db.findingOccurrence.findMany({
        where: { findingId: { in: findingIds } },
        orderBy: { occurredAt: 'asc' },
      })
    : []

  // Map first occurrence per finding
  const firstOccurrenceMap = new Map<string, (typeof occurrences)[number]>()
  for (const occ of occurrences) {
    if (!firstOccurrenceMap.has(occ.findingId)) {
      firstOccurrenceMap.set(occ.findingId, occ)
    }
  }

  // Parse AI remediation safely
  function parseAiRemediation(raw: string | null): ReportFinding['aiRemediation'] {
    if (!raw) return null
    try {
      const parsed = JSON.parse(raw) as { summary?: string; steps?: string[]; estimatedEffort?: string }
      return {
        summary: parsed.summary ?? null,
        steps: Array.isArray(parsed.steps) ? parsed.steps : [],
        estimatedEffort: parsed.estimatedEffort ?? null,
      }
    } catch {
      return null
    }
  }

  const reportFindings: ReportFinding[] = findings.map((f) => {
    const firstOcc = firstOccurrenceMap.get(f.id)
    let firstOccEvidence: Record<string, unknown> | null = null
    let firstOccScreenshotId: string | null = null

    if (firstOcc) {
      firstOccScreenshotId = firstOcc.screenshotArtifactId ?? null
      if (firstOcc.evidence) {
        try {
          firstOccEvidence = JSON.parse(firstOcc.evidence) as Record<string, unknown>
        } catch {
          firstOccEvidence = null
        }
      }
    }

    // Count occurrences for this finding
    const occCount = occurrences.filter((o) => o.findingId === f.id).length

    return {
      id: f.id,
      checkId: f.checkId,
      category: f.category,
      severity: f.severity,
      status: f.status,
      confidence: f.confidence,
      title: f.title,
      description: f.description,
      affectedUrl: f.affectedUrl,
      normalizedUrl: f.normalizedUrl,
      viewport: f.viewport,
      locale: f.locale,
      browser: f.browser,
      remediation: f.remediation,
      aiExplanation: f.aiExplanation,
      aiRemediation: parseAiRemediation(f.aiRemediation),
      businessImpact: f.businessImpact,
      domSelector: f.domSelector,
      occurrenceCount: occCount,
      firstOccurrenceEvidence: firstOccEvidence,
      firstOccurrenceScreenshotArtifactId: firstOccScreenshotId,
      firstSeenAt: f.firstSeenAt.toISOString(),
      lastSeenAt: f.lastSeenAt.toISOString(),
      resolvedAt: f.resolvedAt?.toISOString() ?? null,
    }
  })

  // Parse semantic grouping
  let semanticGroups: ReportSemanticGroup[] | null = null
  if (run.aiSemanticGroupingJson) {
    try {
      const parsed = JSON.parse(run.aiSemanticGroupingJson) as {
        groups?: { groupId: string; label: string; findingIds: string[]; sharedRootCause: string }[]
      }
      semanticGroups = parsed.groups?.map((g) => ({
        groupId: g.groupId,
        label: g.label,
        findingIds: g.findingIds,
        sharedRootCause: g.sharedRootCause,
      })) ?? null
    } catch {
      // malformed — skip
    }
  }

  // ---- Load journey runs ----

  const journeyRuns = await db.journeyRun.findMany({
    where: { scanRunId: runId, workspaceId },
    orderBy: { createdAt: 'asc' },
  })

  const journeyRunIds = journeyRuns.map((jr) => jr.id)

  // Load step results for all journey runs
  const stepResults = journeyRunIds.length > 0
    ? await db.journeyStepResult.findMany({
        where: { journeyRunId: { in: journeyRunIds } },
        orderBy: { stepIndex: 'asc' },
      })
    : []

  // Group step results by journey run ID
  const stepsByRun = new Map<string, typeof stepResults>()
  for (const sr of stepResults) {
    const existing = stepsByRun.get(sr.journeyRunId) ?? []
    existing.push(sr)
    stepsByRun.set(sr.journeyRunId, existing)
  }

  const reportJourneys: ReportJourney[] = journeyRuns.map((jr) => {
    const steps = (stepsByRun.get(jr.id) ?? []).map((sr) => ({
      stepIndex: sr.stepIndex,
      stepType: sr.stepType,
      stepLabel: sr.stepLabel,
      status: sr.status,
      durationMs: sr.durationMs,
      error: sr.error,
      consoleErrors: sr.consoleErrors,
      networkErrors: sr.networkErrors,
      beforeScreenshotId: sr.beforeScreenshotId ?? null,
      afterScreenshotId: sr.afterScreenshotId ?? null,
    }))

    return {
      id: jr.id,
      journeyId: jr.journeyId,
      status: jr.status,
      runMode: jr.runMode,
      trigger: jr.trigger,
      targetUrl: jr.targetUrl,
      viewport: jr.viewport,
      browser: jr.browser,
      stepsTotal: jr.stepsTotal,
      stepsPassed: jr.stepsPassed,
      stepsFailed: jr.stepsFailed,
      stepsSkipped: jr.stepsSkipped,
      startedAt: jr.startedAt?.toISOString() ?? null,
      completedAt: jr.completedAt?.toISOString() ?? null,
      failedReason: jr.failedReason,
      steps,
    }
  })

  // ---- Performance summary ----

  const pagesWithMetrics = pages.filter((p) => p.metrics !== null)
  const perfAvg = computeAverageMetrics(pagesWithMetrics.map((p) => p.metrics!))
  const perfWorst = computeWorstMetrics(pagesWithMetrics.map((p) => p.metrics!))

  let slowestPage: ReportPerformance['slowestPage'] = null
  for (const p of pagesWithMetrics) {
    if (p.metrics && p.metrics.loadEvent !== null) {
      if (!slowestPage || p.metrics.loadEvent > slowestPage.loadEvent) {
        slowestPage = {
          url: p.url,
          title: p.title,
          loadEvent: p.metrics.loadEvent,
        }
      }
    }
  }

  // ---- Error counts ----

  let totalConsoleErrors = 0
  let totalNetworkErrors = 0
  let journeyFailures = 0

  for (const jr of journeyRuns) {
    if (jr.status === 'FAILED') journeyFailures++
  }
  for (const sr of stepResults) {
    totalConsoleErrors += sr.consoleErrors
    totalNetworkErrors += sr.networkErrors
  }

  // Blocked requests
  const blockedRequestCount = await db.networkRequest.count({
    where: { runId, blocked: true },
  })

  // ---- Limitations ----

  const limitations: string[] = []

  if (run.pagesDiscovered > 0 && run.pagesAnalyzed < run.pagesDiscovered) {
    limitations.push(
      `Only ${run.pagesAnalyzed} of ${run.pagesDiscovered} discovered pages were analyzed (maxPages=${config.maxPages}).`,
    )
  }

  if (run.environment?.authMode && run.environment.authMode !== 'NONE') {
    limitations.push(
      `Scan was executed with ${run.environment.authMode} authentication. Some areas behind login may not be fully tested.`,
    )
  }

  if (config.browsers.length === 1 && config.browsers[0] === 'chromium') {
    limitations.push(
      'Only Chromium browser was tested. Firefox and WebKit results may differ.',
    )
  }

  if (!config.locales.includes('fa') && run.project.primaryLocale === 'fa') {
    limitations.push(
      'RTL layout testing was not included in this scan configuration.',
    )
  }

  if (journeyRuns.length === 0) {
    limitations.push(
      'No user journeys were executed. Interactive flows were not tested.',
    )
  }

  if (run.status === 'CANCELLED') {
    limitations.push('The scan was cancelled before completion. Results are partial.')
  }

  if (run.status === 'FAILED') {
    limitations.push(
      `The scan failed: ${run.failedReason ?? 'unknown reason'}. Results are partial.`,
    )
  }

  // ---- Assemble report ----

  const report: TechnicalReport = {
    meta: {
      generatedAt: new Date().toISOString(),
      reportVersion: '1.0.0',
      runId: run.id,
      projectId: run.project.id,
      workspaceId: run.workspaceId,
    },
    run: {
      id: run.id,
      status: run.status,
      trigger: run.trigger,
      runMode: run.runMode,
      startedAt: run.startedAt?.toISOString() ?? null,
      completedAt: run.completedAt?.toISOString() ?? null,
      durationMs,
      score: run.score,
      previousScore: run.previousScore,
      scoreDelta,
      pagesDiscovered: run.pagesDiscovered,
      pagesAnalyzed: run.pagesAnalyzed,
      findingsCount: run.findingsCount,
      blockerCount: run.blockerCount,
      failedReason: run.failedReason,
      aiSummary: run.aiSummary,
    },
    project: {
      id: run.project.id,
      name: run.project.name,
      productType: run.project.productType,
      primaryLocale: run.project.primaryLocale,
      supportedLocales: run.project.supportedLocales.split(',').filter(Boolean),
      productionUrl: run.project.productionUrl,
      workspace: run.project.workspace,
    },
    environment: run.environment
      ? {
          id: run.environment.id,
          type: run.environment.type,
          baseUrl: run.environment.baseUrl,
          authMode: run.environment.authMode,
          scanMode: run.environment.scanMode,
        }
      : null,
    config,
    pages: reportPages,
    journeys: reportJourneys,
    findings: {
      totalCount: findings.length,
      bySeverity,
      byCategory,
      byStatus,
      items: reportFindings,
      semanticGroups,
    },
    performance: {
      pagesMeasured: pagesWithMetrics.length,
      avg: perfAvg,
      worst: perfWorst,
      slowestPage,
    },
    accessibility: {
      totalA11yFindings: a11yFindingIds.length,
      bySeverity: a11yBySeverity,
      categories: Array.from(a11yCategories).sort(),
      findingIds: a11yFindingIds,
    },
    errors: {
      totalConsoleErrors,
      totalNetworkErrors,
      blockedRequests: blockedRequestCount,
      journeyFailures,
    },
    limitations,
  }

  return {
    report,
    generatedAt: report.meta.generatedAt,
  }
}

// ---------------------------------------------------------------------------
// Client-friendly report builder
// ---------------------------------------------------------------------------

export interface GenerateClientFacingReportOptions {
  runId: string
  workspaceId: string
}

export interface ClientFacingReport {
  meta: ReportMeta
  /** Branding and customer context. */
  branding: ClientBranding
  /** High-level summary. */
  executive: ClientExecutive
  /** Quality metrics. */
  quality: ClientQuality
  /** Issues organized for client consumption. */
  issues: ClientIssues
  /** Limitations (client-safe language). */
  limitations: string[]
}

export interface ClientBranding {
  /** Workspace brand name or workspace.name fallback. */
  brandName: string
  /** Workspace logo URL or null. */
  logoUrl: string | null
  /** Workspace accent color or null. */
  accentColor: string | null
  /** Custom intro paragraph or null. */
  customIntro: string | null
  /** Custom footer or null. */
  customFooter: string | null
  /** Contact email or null. */
  brandContactEmail: string | null
  /** Contact URL or null. */
  brandContactUrl: string | null
}

export interface ClientExecutive {
  /** AI-generated client summary (or null). */
  summary: string | null
  /** Delivery readiness (from AI client report). */
  deliveryReadiness: string | null
  /** Positive notes (from AI client report). */
  positiveNotes: string[]
  /** Attention items (from AI client report). */
  attentionItems: string[]
}

export interface ClientQuality {
  score: number | null
  previousScore: number | null
  scoreDelta: number | null
  testsCompleted: number
  pagesTested: number
  journeysExecuted: number
}

export interface ClientIssues {
  criticalCount: number
  resolvedCount: number
  remainingRisks: number
  /** Top critical issues (client-friendly descriptions). */
  criticalIssues: ClientIssue[]
}

export interface ClientIssue {
  id: string
  title: string
  /** AI-generated explanation in client-friendly language. */
  clientDescription: string | null
  /** Human impact description (from AI explanation). */
  userImpact: string | null
  affectedUrl: string
  severity: string
  status: string
}

/**
 * Generate a client-facing report for a scan run.
 * Reuses the technical report data but strips internal details.
 */
export async function generateClientFacingReport(
  opts: GenerateClientFacingReportOptions,
): Promise<ClientFacingReport> {
  const techResult = await generateTechnicalReport(opts)
  const { report } = techResult

  // Parse AI client report for executive section
  let deliveryReadiness: string | null = null
  let positiveNotes: string[] = []
  let attentionItems: string[] = []

  // Load the aiClientReportJson from the ScanRun (not part of ReportRun type)
  const scanRun = await db.scanRun.findUnique({
    where: { id: runId },
    select: { aiClientReportJson: true },
  })

  if (scanRun?.aiClientReportJson) {
    try {
      const parsed = JSON.parse(scanRun.aiClientReportJson) as {
        deliveryReadiness?: string
        positiveNotes?: string[]
        attentionItems?: string[]
      }
      deliveryReadiness = parsed.deliveryReadiness ?? null
      positiveNotes = Array.isArray(parsed.positiveNotes) ? parsed.positiveNotes : []
      attentionItems = Array.isArray(parsed.attentionItems) ? parsed.attentionItems : []
    } catch {
      // malformed — skip
    }
  }

  // Extract critical issues with client-friendly details
  const criticalFindings = report.findings.items.filter(
    (f) => f.severity === 'CRITICAL' && f.status === 'OPEN',
  )
  const resolvedFindings = report.findings.items.filter(
    (f) => f.status === 'RESOLVED',
  )
  const remainingRisks = report.findings.items.filter(
    (f) => ['OPEN', 'ACCEPTED_RISK'].includes(f.status),
  )

  const criticalIssues: ClientIssue[] = criticalFindings.slice(0, 20).map((f) => ({
    id: f.id,
    title: f.title,
    clientDescription: f.aiExplanation,
    userImpact: null, // Could be extracted from aiExplanation JSON
    affectedUrl: f.affectedUrl,
    severity: f.severity,
    status: f.status,
  }))

  // Try to extract userImpact from aiExplanation if it's JSON
  for (let i = 0; i < criticalIssues.length; i++) {
    const finding = criticalFindings[i]
    if (finding.aiExplanation) {
      try {
        const parsed = JSON.parse(finding.aiExplanation) as {
          userImpact?: string
          explanation?: string
        }
        if (parsed.userImpact) {
          criticalIssues[i].userImpact = parsed.userImpact
        }
        if (parsed.explanation && !criticalIssues[i].clientDescription) {
          criticalIssues[i].clientDescription = parsed.explanation
        }
      } catch {
        // aiExplanation is plain text — already used as clientDescription
      }
    }
  }

  // Client-safe limitations (no internal check IDs, no selector syntax)
  const clientLimitations: string[] = []

  if (report.run.pagesAnalyzed < report.run.pagesDiscovered) {
    clientLimitations.push(
      `Not all pages could be tested within the configured limits (${report.run.pagesAnalyzed} of ${report.run.pagesDiscovered} pages).`,
    )
  }

  if (report.journeys.length === 0) {
    clientLimitations.push(
      'Automated user journeys were not included in this test.',
    )
  }

  if (report.config.browsers.length === 1) {
    clientLimitations.push(
      'Testing was performed on a single browser. Results may vary on other browsers.',
    )
  }

  if (report.run.status === 'CANCELLED' || report.run.status === 'FAILED') {
    clientLimitations.push(
      'This test was not fully completed. Results may be incomplete.',
    )
  }

  clientLimitations.push(
    'This report reflects automated testing results at the time of the scan. Manual testing and edge cases may reveal additional issues.',
  )

  return {
    meta: report.meta,
    branding: {
      brandName: report.project.workspace.brandName ?? report.project.workspace.name,
      logoUrl: report.project.workspace.logoUrl,
      accentColor: report.project.workspace.accentColor,
      customIntro: report.project.workspace.brandIntro,
      customFooter: report.project.workspace.brandFooter,
      brandContactEmail: report.project.workspace.brandContactEmail,
      brandContactUrl: report.project.workspace.brandContactUrl,
    },
    executive: {
      summary: report.run.aiSummary,
      deliveryReadiness,
      positiveNotes,
      attentionItems,
    },
    quality: {
      score: report.run.score,
      previousScore: report.run.previousScore,
      scoreDelta: report.run.scoreDelta,
      testsCompleted: report.run.findingsCount,
      pagesTested: report.run.pagesAnalyzed,
      journeysExecuted: report.journeys.length,
    },
    issues: {
      criticalCount: criticalFindings.length,
      resolvedCount: resolvedFindings.length,
      remainingRisks: remainingRisks.length,
      criticalIssues,
    },
    limitations: clientLimitations,
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const ACCESSIBILITY_CATEGORIES = new Set([
  'ACCESSIBILITY',
  'A11Y',
  'WCAG',
  'ARIA',
  'SCREEN_READER',
  'COLOR_CONTRAST',
  'KEYBOARD_NAV',
  'FOCUS_MANAGEMENT',
  'SEMANTIC_HTML',
  'ALT_TEXT',
  'FORM_LABELS',
  'LANDMARKS',
])

function isAccessibilityCategory(category: string): boolean {
  // Direct match or starts with A11Y_/ACCESSIBILITY_
  if (ACCESSIBILITY_CATEGORIES.has(category)) return true
  const upper = category.toUpperCase()
  return upper.startsWith('A11Y_') || upper.startsWith('ACCESSIBILITY_')
}

interface PageMetrics {
  ttfb: number | null
  domContentLoaded: number | null
  loadEvent: number | null
  lcp: number | null
  cls: number | null
  inp: number | null
  totalBytes: number | null
  requestCount: number | null
}

function computeAverageMetrics(pages: PageMetrics[]): ReportPerformance['avg'] {
  if (pages.length === 0) {
    return {
      ttfb: null, domContentLoaded: null, loadEvent: null,
      lcp: null, cls: null, inp: null,
      totalBytes: null, requestCount: null,
    }
  }

  const sum = {
    ttfb: 0, domContentLoaded: 0, loadEvent: 0,
    lcp: 0, cls: 0, inp: 0,
    totalBytes: 0, requestCount: 0,
  }
  const counts = {
    ttfb: 0, domContentLoaded: 0, loadEvent: 0,
    lcp: 0, cls: 0, inp: 0,
    totalBytes: 0, requestCount: 0,
  }

  for (const p of pages) {
    for (const key of Object.keys(sum) as (keyof typeof sum)[]) {
      const val = p[key]
      if (val !== null && val !== undefined) {
        sum[key] += val as number
        counts[key]++
      }
    }
  }

  const avg = (key: keyof typeof sum): number | null => {
    return counts[key] > 0 ? Math.round(sum[key] / counts[key]) : null
  }

  return {
    ttfb: avg('ttfb'),
    domContentLoaded: avg('domContentLoaded'),
    loadEvent: avg('loadEvent'),
    lcp: avg('lcp'),
    cls: counts.cls > 0 ? Math.round((sum.cls / counts.cls) * 100) / 100 : null,
    inp: avg('inp'),
    totalBytes: avg('totalBytes'),
    requestCount: avg('requestCount'),
  }
}

function computeWorstMetrics(pages: PageMetrics[]): ReportPerformance['worst'] {
  let worstLcp: number | null = null
  let worstCls: number | null = null
  let worstInp: number | null = null
  let worstLoad: number | null = null

  for (const p of pages) {
    if (p.lcp !== null && (worstLcp === null || p.lcp > worstLcp)) worstLcp = p.lcp
    if (p.cls !== null && (worstCls === null || p.cls > worstCls)) worstCls = p.cls
    if (p.inp !== null && (worstInp === null || p.inp > worstInp)) worstInp = p.inp
    if (p.loadEvent !== null && (worstLoad === null || p.loadEvent > worstLoad)) worstLoad = p.loadEvent
  }

  return {
    lcp: worstLcp,
    cls: worstCls !== null ? Math.round(worstCls * 100) / 100 : null,
    inp: worstInp,
    loadEvent: worstLoad,
  }
}
