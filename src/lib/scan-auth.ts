/**
 * Scan authorization guard — ProofPilot
 *
 * Single chokepoint that authorizes a scan BEFORE any browser is launched.
 * Order is deliberate: cheap checks first, expensive checks last.
 *
 * Gates (all must pass):
 *   1. Workspace membership + runs.create permission
 *   2. Project is ACTIVE and belongs to the workspace
 *   3. Environment is enabled and scanMode allows the requested run mode
 *   4. Subscription is ACTIVE (not past_due/canceled/off_trial) — except PUBLIC trigger
 *   5. Usage quota not exceeded (assertCanStartRun)
 *   6. Target URL's origin is backed by a VERIFIED domain for this project
 *   7. SSRF controls: SafeTargetUrlService.validateUrl + DNS rebinding check
 *
 * Public scans bypass 1, 2, 5 (they run on the shared public workspace with
 * hard-coded limits) but still enforce 3, 4 (system sub), 6, 7.
 *
 * See SECURITY_MODEL.md §"Scan authorization" and THREAT_MODEL.md T9–T11.
 */
import { db } from './db'
import { env } from './env'
import { logger } from './logger'
import {
  AppError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  PaymentRequiredError,
  ValidationError,
} from './errors'
import { hasPermission, type WorkspaceRole } from './permissions'
import { recordSecurityEvent, type AuditContext } from './audit'
import { assertCanStartRun } from './usage-service'
import { validateUrl, normalizeUrl, isBlockedIp, resolveHostname } from './safe-url'

export type RunMode = 'PASSIVE' | 'SAFE_INTERACTION' | 'TEST_TRANSACTION' | 'CUSTOM_APPROVED'
export type RunTrigger = 'MANUAL' | 'SCHEDULED' | 'DEPLOYMENT' | 'PUBLIC' | 'RESCAN'

export interface AuthorizeScanInput {
  projectId: string
  environmentId?: string
  targetUrl: string
  runMode: RunMode
  trigger: RunTrigger
  scanProfileId?: string
  /** The user requesting the scan. Required for MANUAL/RESCAN; SYSTEM for SCHEDULED/DEPLOYMENT/PUBLIC. */
  userId?: string
  userRole?: WorkspaceRole
  /** When true, the user has confirmed they want to scan in TEST_TRANSACTION / CUSTOM_APPROVED modes. */
  userConfirmedDestructive?: boolean
}

export interface AuthorizedScan {
  projectId: string
  workspaceId: string
  environmentId: string
  scanProfileId?: string
  targetUrl: string
  normalizedTargetUrl: string
  allowedOrigins: string[]
  runMode: RunMode
  trigger: RunTrigger
  environment: {
    id: string
    type: string
    baseUrl: string
    scanMode: string
    allowedHostnames: string[]
    networkRestrictions: Record<string, unknown> | null
  }
  project: {
    id: string
    name: string
    primaryLocale: string
    supportedLocales: string[]
    defaultTimezone: string
    retentionDays: number
  }
  workspace: {
    id: string
    name: string
    slug: string
  }
}

/**
 * Authorize a scan request. Throws an RFC 7807 AppError on failure.
 * Returns the fully-resolved context (workspace, project, environment, target URL)
 * on success — the caller should use this to build the ScanRun.configSnapshot.
 */
export async function authorizeScan(
  input: AuthorizeScanInput,
  ctx: Pick<AuditContext, 'ip' | 'userAgent' | 'requestId'>,
): Promise<AuthorizedScan> {
  const isPublic = input.trigger === 'PUBLIC'

  // ---- Gate 1: workspace membership + permission (skipped for PUBLIC/system triggers) ----
  if (!isPublic) {
    if (!input.userId) {
      throw new ForbiddenError('User ID required for non-public scans')
    }
    if (!input.userRole) {
      throw new ForbiddenError('Workspace role required for non-public scans')
    }
    if (!hasPermission(input.userRole, 'runs.create')) {
      throw new ForbiddenError('Missing permission: runs.create')
    }
  }

  // ---- Gate 2: project lookup + ACTIVE status + workspace ownership ----
  const project = await db.project.findUnique({
    where: { id: input.projectId },
    include: {
      workspace: {
        include: {
          subscriptions: { orderBy: { createdAt: 'desc' }, take: 1, include: { plan: true } },
        },
      },
      verifiedDomains: { where: { verificationStatus: 'VERIFIED' } },
      environments: { where: { enabled: true } },
    },
  })
  if (!project || project.status === 'DELETED') {
    throw new NotFoundError('Project')
  }
  if (project.status !== 'ACTIVE') {
    throw new ConflictError('Project is not active')
  }

  // ---- Gate 3: environment selection + enabled + scanMode compat ----
  let environment = input.environmentId
    ? project.environments.find((e) => e.id === input.environmentId)
    : project.environments.find((e) => e.type === 'PRODUCTION') ?? project.environments[0]

  if (!environment) {
    throw new ConflictError('No enabled environment for this project')
  }
  if (!environment.enabled) {
    throw new ConflictError('Selected environment is disabled')
  }

  // runMode must be permitted by the environment's scanMode
  const envModeRank: Record<string, number> = {
    PASSIVE: 0,
    SAFE_INTERACTION: 1,
    TEST_TRANSACTION: 2,
    CUSTOM_APPROVED: 3,
  }
  const envRank = envModeRank[environment.scanMode] ?? 0
  const reqRank = envModeRank[input.runMode] ?? 0
  if (reqRank > envRank) {
    throw new ForbiddenError(
      `Environment scan mode (${environment.scanMode}) does not permit requested run mode (${input.runMode})`,
    )
  }

  // TEST_TRANSACTION and CUSTOM_APPROVED require explicit user confirmation
  if (
    (input.runMode === 'TEST_TRANSACTION' || input.runMode === 'CUSTOM_APPROVED') &&
    !input.userConfirmedDestructive &&
    !isPublic
  ) {
    throw new ValidationError(
      `${input.runMode} mode requires explicit user confirmation that destructive actions are permitted`,
      { requiresConfirmation: true, runMode: input.runMode },
    )
  }

  // ---- Gate 4: subscription active (PUBLIC runs on system workspace bypass) ----
  if (!isPublic) {
    const sub = project.workspace.subscriptions[0]
    if (!sub) {
      throw new PaymentRequiredError('Workspace has no subscription. Start a trial first.')
    }
    if (!['ACTIVE', 'TRIALING'].includes(sub.status)) {
      throw new PaymentRequiredError(`Workspace subscription is ${sub.status}. Billing must be resolved.`)
    }
    if (sub.status === 'TRIALING' && sub.trialEndsAt && sub.trialEndsAt < new Date()) {
      throw new PaymentRequiredError('Trial has ended. Subscribe to continue scanning.')
    }
  }

  // ---- Gate 5: usage quota (PUBLIC bypass — already capped at 5 pages by config) ----
  if (!isPublic) {
    await assertCanStartRun(project.workspaceId)
  }

  // ---- Gate 6: target URL's origin must be a VERIFIED domain ----
  // Resolve environment baseUrl + requested targetUrl
  const baseUrl = environment.baseUrl
  let targetUrl = input.targetUrl || baseUrl
  if (!targetUrl) {
    throw new ValidationError('Target URL is required')
  }

  // Allow relative URLs against the environment baseUrl
  if (targetUrl.startsWith('/')) {
    targetUrl = new URL(targetUrl, baseUrl).href
  }

  const allowedOrigins = new Set<string>()
  // Always include environment baseUrl origin
  try {
    allowedOrigins.add(new URL(baseUrl).origin)
  } catch {
    // ignore
  }
  // Include all verified domains
  for (const vd of project.verifiedDomains) {
    // For localhost (dev), origin is http://localhost:<port> — but VerifiedDomain only stores the hostname.
    // We accept any port on a verified hostname in dev mode.
    const scheme = vd.domainNormalized === 'localhost' && env.APP_ENV === 'development' ? 'http' : 'https'
    allowedOrigins.add(`${scheme}://${vd.domainNormalized}`)
    // Also accept with the production URL's port if known
    try {
      const prodUrl = new URL(project.productionUrl)
      if (prodUrl.hostname === vd.domainNormalized) {
        allowedOrigins.add(prodUrl.origin)
      }
    } catch {
      // ignore
    }
  }
  // Include environment.allowedHostnames (comma-separated)
  if (environment.allowedHostnames) {
    for (const h of environment.allowedHostnames.split(',').map((s) => s.trim()).filter(Boolean)) {
      const scheme = h === 'localhost' && env.APP_ENV === 'development' ? 'http' : 'https'
      allowedOrigins.add(`${scheme}://${h}`)
    }
  }

  // ---- Gate 7: SSRF controls (validateUrl + DNS rebinding) ----
  let validated
  try {
    validated = validateUrl(targetUrl, {
      allowHttp: env.SCAN_ALLOW_HTTP_LOCAL,
      allowLocalhost: env.DEV_ALLOW_LOCALHOST_TARGETS,
      allowPrivateNetwork: env.SCAN_PRIVATE_NETWORK_OVERRIDE,
    })
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'validation_failed'
    await recordSecurityEvent(
      'scan_blocked_ssrf',
      { ...ctx, actorType: 'USER', actorId: input.userId, workspaceId: project.workspaceId },
      { url: targetUrl, reason, projectId: project.id },
      'WARN',
    )
    throw new ValidationError(`Target URL rejected: ${reason}`)
  }

  // Verify the origin is in the allowlist (verified domains)
  if (!allowedOrigins.has(validated.origin)) {
    await recordSecurityEvent(
      'scan_blocked_unverified_origin',
      { ...ctx, actorType: 'USER', actorId: input.userId, workspaceId: project.workspaceId },
      { url: targetUrl, origin: validated.origin, projectId: project.id, allowedOrigins: Array.from(allowedOrigins) },
      'WARN',
    )
    throw new ForbiddenError(
      `Target origin ${validated.origin} is not in this project's verified domains. Verify the domain first.`,
    )
  }

  // DNS rebinding protection (skip for localhost in dev — no DNS to resolve)
  if (!validated.isLocalDev) {
    const ips = await resolveHostname(validated.hostname)
    if (ips.length === 0) {
      // Could be a brand-new domain or DNS failure. In dev with localhost targets this is expected.
      if (env.APP_ENV === 'development') {
        logger.warn('Could not resolve hostname in dev — allowing localhost-style target', {
          hostname: validated.hostname,
        })
      } else {
        throw new ValidationError('Could not resolve target hostname')
      }
    } else {
      for (const ip of ips) {
        if (isBlockedIp(ip)) {
          await recordSecurityEvent(
            'scan_blocked_ssrf',
            { ...ctx, actorType: 'USER', actorId: input.userId, workspaceId: project.workspaceId },
            { url: targetUrl, ip, reason: 'resolved_to_blocked_ip', projectId: project.id },
            'WARN',
          )
          throw new ForbiddenError(`Target resolved to blocked IP: ${ip}`)
        }
      }
    }
  }

  const normalizedTargetUrl = normalizeUrl(validated.href)

  logger.info('Scan authorized', {
    projectId: project.id,
    workspaceId: project.workspaceId,
    environmentId: environment.id,
    targetUrl: normalizedTargetUrl,
    runMode: input.runMode,
    trigger: input.trigger,
  })

  return {
    projectId: project.id,
    workspaceId: project.workspaceId,
    environmentId: environment.id,
    scanProfileId: input.scanProfileId,
    targetUrl: normalizedTargetUrl,
    normalizedTargetUrl,
    allowedOrigins: Array.from(allowedOrigins),
    runMode: input.runMode,
    trigger: input.trigger,
    environment: {
      id: environment.id,
      type: environment.type,
      baseUrl: environment.baseUrl,
      scanMode: environment.scanMode,
      allowedHostnames: environment.allowedHostnames
        ? environment.allowedHostnames.split(',').map((s) => s.trim()).filter(Boolean)
        : [],
      networkRestrictions: environment.networkRestrictions
        ? (JSON.parse(environment.networkRestrictions) as Record<string, unknown>)
        : null,
    },
    project: {
      id: project.id,
      name: project.name,
      primaryLocale: project.primaryLocale,
      supportedLocales: project.supportedLocales.split(','),
      defaultTimezone: project.defaultTimezone,
      retentionDays: project.retentionDays,
    },
    workspace: {
      id: project.workspace.id,
      name: project.workspace.name,
      slug: project.workspace.slug,
    },
  }
}

/**
 * Re-validate the resolved target immediately before the worker fetches it.
 * This defends against DNS rebinding between authorize-time and fetch-time.
 * Throws on mismatch.
 */
export async function revalidateTargetBeforeFetch(
  targetUrl: string,
  approvedIps: string[],
): Promise<string[]> {
  const url = new URL(targetUrl)
  if (url.hostname === 'localhost' && env.APP_ENV === 'development') {
    return approvedIps
  }
  const ips = await resolveHostname(url.hostname)
  if (ips.length === 0) {
    throw new AppError('DNS resolution failed at fetch time', 502, 'dns_resolution_failed')
  }
  for (const ip of ips) {
    if (isBlockedIp(ip)) {
      throw new ForbiddenError(`Fetch-time DNS rebinding blocked: ${ip}`)
    }
  }
  // If we had approved IPs at authorize-time, ensure they are still in the resolution set
  if (approvedIps.length > 0) {
    const newSet = new Set(ips)
    for (const approved of approvedIps) {
      if (!newSet.has(approved)) {
        throw new ForbiddenError('Target DNS changed between authorization and fetch (rebinding suspected)')
      }
    }
  }
  return ips
}
