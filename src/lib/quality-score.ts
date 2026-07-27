/**
 * Quality score service — ProofPilot (Phase 6)
 *
 * Computes a 0–100 quality score for a project (latest run) or an individual
 * run. The score reflects how "delivery-ready" the project is based on
 * outstanding findings weighted by severity.
 *
 * Design:
 *   - Start at 100.
 *   - Subtract points per finding: SEVERITY_WEIGHTS × count, capped at
 *     SEVERITY_MAX_PENALTY per severity bucket.
 *   - Any BLOCKER (in an OPEN status) caps the score at 49 (NOT_READY).
 *   - Any CRITICAL (in an OPEN status) caps the score at 74 (NEEDS_WORK).
 *   - "Fixed" findings (RESOLVED / ACCEPTED_RISK / FALSE_POSITIVE) do not
 *     reduce the score.
 *   - Suppressed findings are excluded from the penalty.
 *
 * The score is computed deterministically from the findings table; AI may
 * later *explain* the score but cannot override it. See finding-severity.ts.
 *
 * See:
 *   - SECURITY_MODEL.md §"Quality score"
 *   - IMPLEMENTATION_CHECKLIST.md Phase 6
 */
import { db } from './db'
import { logger } from './logger'
import { NotFoundError } from './errors'
import {
  SEVERITY_WEIGHTS,
  SEVERITY_MAX_PENALTY,
  type FindingSeverity,
  type FindingStatus,
  OPEN_STATUSES,
  FIXED_STATUSES,
} from './finding-severity'

export interface QualityScoreBreakdown {
  /** 0–100. */
  score: number
  /** Letter grade A–F derived from score. */
  grade: 'A' | 'B' | 'C' | 'D' | 'F'
  /** Delivery readiness bucket. */
  readiness: 'READY' | 'NEEDS_WORK' | 'NOT_READY'
  /** True if any blocker is open (forces NOT_READY). */
  hasOpenBlocker: boolean
  /** True if any critical is open (forces NEEDS_WORK or worse). */
  hasOpenCritical: boolean
  /** Total findings considered (active, non-suppressed). */
  totalFindings: number
  /** Per-severity counts of OPEN-status findings. */
  openBySeverity: Record<FindingSeverity, number>
  /** Per-status counts of all findings. */
  byStatus: Record<FindingStatus, number>
  /** Penalty contribution per severity bucket. */
  penaltyBySeverity: Record<FindingSeverity, number>
  /** Total penalty applied. */
  totalPenalty: number
  /** Suppressed findings excluded from scoring. */
  suppressedCount: number
  /** Fixed findings (resolved/accepted/false-positive). */
  fixedCount: number
}

export interface ProjectScoreResult {
  project: {
    id: string
    name: string
    workspaceId: string
  }
  latestRun: {
    id: string | null
    status: string | null
    completedAt: string | null
    score: number | null
    previousScore: number | null
  }
  current: QualityScoreBreakdown
  /** Trend vs previous run (positive = improving). */
  trend: number | null
}

// ---------------- Core computation ----------------

const DEFAULT_BY_SEVERITY: Record<FindingSeverity, number> = {
  BLOCKER: 0,
  CRITICAL: 0,
  MAJOR: 0,
  MINOR: 0,
  INFO: 0,
}

const DEFAULT_BY_STATUS: Record<FindingStatus, number> = {
  OPEN: 0,
  ACKNOWLEDGED: 0,
  IN_PROGRESS: 0,
  RESOLVED: 0,
  REOPENED: 0,
  IGNORED: 0,
  ACCEPTED_RISK: 0,
  FALSE_POSITIVE: 0,
}

const ALL_SEVERITIES: FindingSeverity[] = ['BLOCKER', 'CRITICAL', 'MAJOR', 'MINOR', 'INFO']
const ALL_STATUSES: FindingStatus[] = [
  'OPEN',
  'ACKNOWLEDGED',
  'IN_PROGRESS',
  'RESOLVED',
  'REOPENED',
  'IGNORED',
  'ACCEPTED_RISK',
  'FALSE_POSITIVE',
]

/**
 * Compute the quality score for a project based on its current findings
 * (excluding suppressed findings). This is the "live" score — it reflects
 * the current state of all findings, not just the latest run.
 *
 * @param projectId   The project to score.
 * @param workspaceId Used for tenant scoping (defense-in-depth).
 */
export async function computeProjectScore(
  projectId: string,
  workspaceId: string,
): Promise<ProjectScoreResult> {
  // Verify project belongs to workspace.
  const project = await db.project.findUnique({
    where: { id: projectId },
    select: { id: true, name: true, workspaceId: true, status: true },
  })
  if (!project || project.workspaceId !== workspaceId || project.status === 'DELETED') {
    throw new NotFoundError('Project')
  }

  // Fetch latest completed run for trend comparison.
  const latestRun = await db.scanRun.findFirst({
    where: { projectId, status: { in: ['COMPLETED', 'PARTIAL', 'CANCELLED', 'FAILED'] } },
    orderBy: { createdAt: 'desc' },
    select: { id: true, status: true, completedAt: true, score: true, previousScore: true },
  })

  // Aggregate all findings for this project (active = non-suppressed).
  // We fetch raw rows because Prisma's groupBy doesn't support the
  // "suppressions none" filter combined with multiple groupBy fields easily.
  const findings = await db.finding.findMany({
    where: { projectId, workspaceId },
    select: {
      id: true,
      severity: true,
      status: true,
      suppressions: {
        where: { revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
        select: { id: true },
      },
    },
  })

  const breakdown = computeBreakdown(findings)

  return {
    project: { id: project.id, name: project.name, workspaceId: project.workspaceId },
    latestRun: {
      id: latestRun?.id ?? null,
      status: latestRun?.status ?? null,
      completedAt: latestRun?.completedAt?.toISOString() ?? null,
      score: latestRun?.score ?? null,
      previousScore: latestRun?.previousScore ?? null,
    },
    current: breakdown,
    trend: latestRun?.score !== null && latestRun?.score !== undefined
      ? breakdown.score - latestRun.score
      : null,
  }
}

/**
 * Compute the score for a single run, based on findings attributed to that run.
 * Also persists the score to ScanRun.score (and stashes the previous value in
 * `previousScore`).
 */
export async function computeAndPersistRunScore(
  runId: string,
  workspaceId: string,
): Promise<QualityScoreBreakdown & { persistedScore: number | null; previousScore: number | null }> {
  const run = await db.scanRun.findUnique({
    where: { id: runId },
    select: {
      id: true,
      projectId: true,
      workspaceId: true,
      score: true,
      previousScore: true,
    },
  })
  if (!run || run.workspaceId !== workspaceId) {
    throw new NotFoundError('Run')
  }

  // Findings for this run — both runId-matched and fingerprints last-seen in this run.
  // For simplicity, score only findings whose `runId === runId`. (Fingerprints that
  // existed before but re-appeared in this run are also counted because their
  // `runId` is updated by the finding-writer on each scan.)
  const findings = await db.finding.findMany({
    where: { runId, workspaceId },
    select: {
      id: true,
      severity: true,
      status: true,
      suppressions: {
        where: { revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
        select: { id: true },
      },
    },
  })

  const breakdown = computeBreakdown(findings)

  // Persist score + previous.
  const previousScore = run.score
  await db.scanRun.update({
    where: { id: runId },
    data: {
      score: breakdown.score,
      previousScore: previousScore ?? null,
      blockerCount: breakdown.openBySeverity.BLOCKER,
    },
  }).catch((err) => {
    logger.warn('Failed to persist run score', { runId, error: String(err) })
  })

  return {
    ...breakdown,
    persistedScore: breakdown.score,
    previousScore: previousScore ?? null,
  }
}

// ---------------- Pure computation ----------------

interface FindingRowForScore {
  severity: string
  status: string
  suppressions: Array<{ id: string }>
}

/**
 * Pure function that turns a list of finding rows into a score breakdown.
 * Exported for unit testing.
 */
export function computeBreakdown(findings: FindingRowForScore[]): QualityScoreBreakdown {
  const openBySeverity = { ...DEFAULT_BY_SEVERITY }
  const byStatus = { ...DEFAULT_BY_STATUS }
  let suppressedCount = 0
  let fixedCount = 0
  let totalFindings = 0

  for (const f of findings) {
    totalFindings++
    const status = f.status as FindingStatus
    if (ALL_STATUSES.includes(status)) {
      byStatus[status]++
    }
    const isSuppressed = f.suppressions.length > 0
    if (isSuppressed) {
      suppressedCount++
      continue
    }
    if (FIXED_STATUSES.includes(status)) {
      fixedCount++
      continue
    }
    if (OPEN_STATUSES.includes(status)) {
      const sev = f.severity as FindingSeverity
      if (ALL_SEVERITIES.includes(sev)) {
        openBySeverity[sev]++
      }
    }
  }

  // Compute penalty per severity bucket, capped.
  const penaltyBySeverity: Record<FindingSeverity, number> = { ...DEFAULT_BY_SEVERITY }
  for (const sev of ALL_SEVERITIES) {
    const count = openBySeverity[sev]
    const uncapped = count * SEVERITY_WEIGHTS[sev]
    penaltyBySeverity[sev] = Math.min(uncapped, SEVERITY_MAX_PENALTY[sev])
  }

  const totalPenalty = ALL_SEVERITIES.reduce((sum, s) => sum + penaltyBySeverity[s], 0)

  const hasOpenBlocker = openBySeverity.BLOCKER > 0
  const hasOpenCritical = openBySeverity.CRITICAL > 0

  let score = 100 - totalPenalty
  // Hard caps: open blocker → max 49; open critical → max 74.
  if (hasOpenBlocker) score = Math.min(score, 49)
  else if (hasOpenCritical) score = Math.min(score, 74)

  score = Math.max(0, Math.min(100, Math.round(score)))

  const grade = scoreToGrade(score)
  const readiness = scoreToReadiness(score, hasOpenBlocker, hasOpenCritical)

  return {
    score,
    grade,
    readiness,
    hasOpenBlocker,
    hasOpenCritical,
    totalFindings,
    openBySeverity,
    byStatus,
    penaltyBySeverity,
    totalPenalty,
    suppressedCount,
    fixedCount,
  }
}

function scoreToGrade(score: number): 'A' | 'B' | 'C' | 'D' | 'F' {
  if (score >= 90) return 'A'
  if (score >= 80) return 'B'
  if (score >= 70) return 'C'
  if (score >= 50) return 'D'
  return 'F'
}

function scoreToReadiness(
  score: number,
  hasOpenBlocker: boolean,
  hasOpenCritical: boolean,
): 'READY' | 'NEEDS_WORK' | 'NOT_READY' {
  if (hasOpenBlocker) return 'NOT_READY'
  if (hasOpenCritical || score < 80) return 'NEEDS_WORK'
  return 'READY'
}

// (NotFoundError is imported from ./errors at the top of the file.)
