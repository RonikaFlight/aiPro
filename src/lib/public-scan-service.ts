/**
 * Public audit mode — ProofPilot
 *
 * Lets unauthenticated users run a *very limited* scan against a publicly
 * reachable URL: max 5 pages, single viewport, single locale, passive mode only.
 * Rate-limited per IP. No auth, no workspace context.
 *
 * The scan is enqueued as a ScanRun on a special "public" workspace
 * (auto-created if missing). Real-time progress is available via the public
 * run-status endpoint (NOT SSE — public SSE would be a DoS vector).
 *
 * See API_DESIGN.md §"Public audit mode" and SECURITY_MODEL.md §"Public scans".
 */
import { db } from './db'
import { env } from './env'
import { AppError, ForbiddenError, NotFoundError, RateLimitError, ValidationError } from './errors'
import { validateUrl, normalizeUrl } from './safe-url'
import { checkRateLimit, POLICIES } from './rate-limit'
import { recordAudit, recordSecurityEvent, type AuditContext } from './audit'
import { randomHex } from './crypto'
import { logger } from './logger'
import { enqueue } from './queue'

const PUBLIC_PAGE_LIMIT = 5
const PUBLIC_VIEWPORT = 'desktop:1280x800'
const PUBLIC_LOCALE = 'en'

/** Resolve (or lazily create) the shared "public audit" workspace + project. */
async function getPublicContext() {
  // The public workspace slug is fixed. Looked up once and cached in module scope.
  const slug = 'public-audit'
  let workspace = await db.workspace.findUnique({ where: { slug } })
  if (!workspace) {
    const plan = await db.plan.findUnique({ where: { code: 'AGENCY' } })
    const ownerEmail = 'system@proofpilot.local'
    const owner = await db.user.findFirst({ where: { email: ownerEmail } })
    const actualOwner =
      owner ??
      (await db.user.create({
        data: {
          email: ownerEmail,
          emailLower: ownerEmail,
          name: 'ProofPilot System',
          passwordHash: '!', // invalid hash — cannot log in
          platformRole: 'PLATFORM_ADMIN',
          status: 'ACTIVE',
        },
      }))
    workspace = await db.workspace.create({
      data: {
        name: 'Public Audit (system)',
        slug,
        ownerId: actualOwner.id,
        planId: plan?.id,
      },
    })
    await db.workspaceMember.create({
      data: {
        workspaceId: workspace.id,
        userId: actualOwner.id,
        role: 'OWNER',
      },
    })
  }

  let project = await db.project.findFirst({
    where: { workspaceId: workspace.id, name: 'Public Audits' },
  })
  if (!project) {
    project = await db.project.create({
      data: {
        workspaceId: workspace.id,
        name: 'Public Audits',
        description: 'Container for unauthenticated public scans. Rate-limited, capped at 5 pages.',
        productionUrl: 'https://example.com',
        productType: 'web_app',
        primaryLocale: 'en',
        supportedLocales: 'en',
        status: 'ACTIVE',
      },
    })
    // Pre-verify localhost for dev auto-verify
    await db.verifiedDomain.create({
      data: {
        projectId: project.id,
        domain: 'localhost',
        domainNormalized: 'localhost',
        verificationMethod: 'DNS_TXT',
        verificationStatus: 'VERIFIED',
        verifiedAt: new Date(),
        lastRevalidatedAt: new Date(),
      },
    }).catch(() => {
      // ignore — may already exist
    })
  }

  return { workspace, project }
}

export interface PublicScanRequest {
  url: string
  email?: string
}

export interface PublicScanResponse {
  runId: string
  status: string
  pagesLimit: number
  estimatedSeconds: number
  statusUrl: string
  message: string
}

/**
 * Validate a public scan request, rate-limit by IP, create a ScanRun on the
 * shared public workspace, and enqueue the scan-orchestration job.
 *
 * SSRF controls are enforced by SafeTargetUrlService before any fetch happens.
 */
export async function createPublicScan(
  input: PublicScanRequest,
  ctx: Pick<AuditContext, 'ip' | 'userAgent' | 'requestId'>,
): Promise<PublicScanResponse> {
  if (!env.FEATURE_PUBLIC_SCANS) {
    throw new ForbiddenError('Public scans are disabled on this instance')
  }

  // Rate limit per IP
  try {
    checkRateLimit('publicScan', ctx.ip ?? 'unknown')
  } catch (err) {
    if (err instanceof RateLimitError) {
      await recordSecurityEvent(
        'rate_limit_exceeded',
        { ...ctx, actorType: 'USER' },
        { endpoint: 'public_scan', ip: ctx.ip },
        'WARN',
      )
    }
    throw err
  }

  // Validate URL with full SSRF controls
  if (!input.url || typeof input.url !== 'string') {
    throw new ValidationError('URL is required')
  }
  let validated
  try {
    validated = validateUrl(input.url, {
      allowHttp: env.SCAN_ALLOW_HTTP_LOCAL,
      allowLocalhost: env.DEV_ALLOW_LOCALHOST_TARGETS,
      allowPrivateNetwork: env.SCAN_PRIVATE_NETWORK_OVERRIDE,
    })
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'validation_failed'
    await recordSecurityEvent(
      'public_scan_blocked',
      { ...ctx, actorType: 'USER' },
      { url: input.url, reason },
      'INFO',
    )
    throw new ValidationError(`URL rejected: ${reason}`, { reason })
  }
  const normalizedTargetUrl = normalizeUrl(validated.href)

  // Resolve public workspace + project
  const { workspace, project } = await getPublicContext()

  // Create environment if missing (single PRODUCTION env)
  let env_ = await db.projectEnvironment.findFirst({
    where: { projectId: project.id, type: 'PRODUCTION' },
  })
  if (!env_) {
    env_ = await db.projectEnvironment.create({
      data: {
        projectId: project.id,
        type: 'PRODUCTION',
        baseUrl: normalizedTargetUrl,
        allowedHostnames: '',
        authMode: 'NONE',
        scanMode: 'PASSIVE',
        enabled: true,
      },
    })
  }

  // Snapshot the config for immutability
  const configSnapshot = JSON.stringify({
    source: 'public',
    maxPages: PUBLIC_PAGE_LIMIT,
    maxDepth: 2,
    viewport: PUBLIC_VIEWPORT,
    locale: PUBLIC_LOCALE,
    browsers: ['chromium'],
    mode: 'PASSIVE',
    targetUrl: validated.normalizedUrl,
    requesterEmail: input.email?.trim() || null,
    requesterIpHash: ctx.ip,
    createdAt: new Date().toISOString(),
  })

  // Create the run
  const run = await db.scanRun.create({
    data: {
      projectId: project.id,
      environmentId: env_.id,
      workspaceId: workspace.id,
      status: 'QUEUED',
      trigger: 'PUBLIC',
      runMode: 'PASSIVE',
      configSnapshot,
    },
  })

  // Append the initial event
  await db.scanRunEvent.create({
    data: {
      runId: run.id,
      eventType: 'run.queued',
      payloadJson: JSON.stringify({ source: 'public', target: normalizedTargetUrl }),
      sequence: 1,
    },
  })

  // Enqueue for the worker (Phase 4 will pick this up)
  await enqueue(
    'scan-orchestration',
    {
      runId: run.id,
      workspaceId: workspace.id,
      projectId: project.id,
      targetUrl: normalizedTargetUrl,
      maxPages: PUBLIC_PAGE_LIMIT,
      maxDepth: 2,
      viewport: PUBLIC_VIEWPORT,
      locale: PUBLIC_LOCALE,
      browsers: ['chromium'],
      mode: 'PASSIVE',
      source: 'public',
    },
    {
      correlationId: run.id,
      priority: 1, // low priority — paid workspaces first
    },
  )

  await recordAudit(
    'PUBLIC_SCAN_REQUESTED',
    { type: 'scan_run', id: run.id },
    { ...ctx, actorType: 'USER', workspaceId: workspace.id },
    { targetUrl: normalizedTargetUrl, runId: run.id, email: input.email ?? null },
  )

  logger.info('Public scan enqueued', {
    runId: run.id,
    targetUrl: normalizedTargetUrl,
    ip: ctx.ip,
  })

  return {
    runId: run.id,
    status: 'QUEUED',
    pagesLimit: PUBLIC_PAGE_LIMIT,
    estimatedSeconds: 60,
    statusUrl: `/api/v1/public/runs/${run.id}`,
    message: 'Scan queued. Use the status URL to poll for results.',
  }
}

export interface PublicRunStatus {
  runId: string
  status: string
  pagesDiscovered: number
  pagesAnalyzed: number
  findingsCount: number
  blockerCount: number
  score: number | null
  startedAt: string | null
  completedAt: string | null
  failedReason: string | null
  /** True if the run is still in progress. */
  inProgress: boolean
  /** Findings summary by severity (only available after completion). */
  findingsBySeverity?: Record<string, number>
}

/** Look up the status of a public run. Does NOT require auth, but only returns
 * runs whose trigger === 'PUBLIC'. */
export async function getPublicRunStatus(runId: string): Promise<PublicRunStatus> {
  const run = await db.scanRun.findUnique({
    where: { id: runId },
    include: {
      findings: { select: { severity: true } },
    },
  })
  if (!run) throw new NotFoundError('Run')
  if (run.trigger !== 'PUBLIC') {
    // Don't leak info about private runs
    throw new NotFoundError('Run')
  }

  const findingsBySeverity: Record<string, number> = {}
  for (const f of run.findings) {
    findingsBySeverity[f.severity] = (findingsBySeverity[f.severity] ?? 0) + 1
  }

  const inProgress = ['QUEUED', 'RUNNING', 'VALIDATING'].includes(run.status)
  return {
    runId: run.id,
    status: run.status,
    pagesDiscovered: run.pagesDiscovered,
    pagesAnalyzed: run.pagesAnalyzed,
    findingsCount: run.findingsCount,
    blockerCount: run.blockerCount,
    score: run.score,
    startedAt: run.startedAt?.toISOString() ?? null,
    completedAt: run.completedAt?.toISOString() ?? null,
    failedReason: run.failedReason,
    inProgress,
    findingsBySeverity: inProgress ? undefined : findingsBySeverity,
  }
}
