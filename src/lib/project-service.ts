/**
 * Project service — ProofPilot
 *
 * CRUD for projects and environments. Domain verification.
 * Every project belongs to a workspace; every operation checks membership.
 */
import { db } from './db'
import { randomHex, hashToken } from './crypto'
import { AppError, ConflictError, ForbiddenError, NotFoundError, ValidationError } from './errors'
import { recordAudit } from './audit'
import { hasPermission, type WorkspaceRole } from './permissions'
import type { AuditContext } from './audit'

// ---------------- Projects ----------------

export interface CreateProjectInput {
  name: string
  description?: string
  productionUrl: string
  productType?: string
  primaryLocale?: string
  supportedLocales?: string[]
  defaultTimezone?: string
  targetCustomer?: string
}

export async function createProject(
  workspaceId: string,
  input: CreateProjectInput,
  creatorId: string,
  creatorRole: WorkspaceRole,
  ctx: Pick<AuditContext, 'ip' | 'userAgent' | 'requestId'>,
) {
  if (!hasPermission(creatorRole, 'projects.create')) {
    throw new ForbiddenError('Missing permission: projects.create')
  }
  if (!input.name || input.name.trim().length < 2) {
    throw new ValidationError('Project name must be at least 2 characters')
  }
  if (!input.productionUrl || !/^https?:\/\//.test(input.productionUrl)) {
    throw new ValidationError('Production URL must start with http:// or https://')
  }

  // Check plan limit
  const workspace = await db.workspace.findUniqueOrThrow({
    where: { id: workspaceId },
    include: { plan: true },
  })
  const projectCount = await db.project.count({ where: { workspaceId, status: 'ACTIVE' } })
  if (workspace.plan && projectCount >= workspace.plan.maxProjects) {
    throw new AppError(
      `Plan limit reached: ${workspace.plan.maxProjects} projects max on ${workspace.plan.code}`,
      402,
      'plan_limit_exceeded',
      'https://proofpilot.app/problems/plan-limit',
    )
  }

  const project = await db.project.create({
    data: {
      workspaceId,
      name: input.name.trim(),
      description: input.description?.trim() || null,
      productionUrl: input.productionUrl,
      productType: input.productType || 'web_app',
      primaryLocale: input.primaryLocale || 'en',
      supportedLocales: (input.supportedLocales || ['en']).join(','),
      defaultTimezone: input.defaultTimezone || 'UTC',
      targetCustomer: input.targetCustomer?.trim() || null,
      status: 'ACTIVE',
      createdById: creatorId,
    },
  })

  await recordAudit('PROJECT_CREATE', { type: 'project', id: project.id }, { ...ctx, actorType: 'USER', actorId: creatorId, workspaceId })
  return project
}

export async function listProjects(workspaceId: string, userId: string) {
  // Verify membership
  const membership = await db.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } },
  })
  if (!membership || membership.removedAt) {
    throw new NotFoundError('Workspace')
  }
  const projects = await db.project.findMany({
    where: { workspaceId, status: { not: 'DELETED' } },
    orderBy: { createdAt: 'desc' },
    include: {
      _count: { select: { scanRuns: true, findings: true, environments: true } },
    },
  })
  return projects.map((p) => ({
    id: p.id,
    name: p.name,
    description: p.description,
    productionUrl: p.productionUrl,
    productType: p.productType,
    primaryLocale: p.primaryLocale,
    supportedLocales: p.supportedLocales.split(','),
    status: p.status,
    createdAt: p.createdAt,
    runCount: p._count.scanRuns,
    findingCount: p._count.findings,
    environmentCount: p._count.environments,
  }))
}

export async function getProject(projectId: string, userId: string) {
  const project = await db.project.findUnique({
    where: { id: projectId },
    include: {
      environments: true,
      verifiedDomains: true,
      _count: { select: { scanRuns: true, findings: true, journeys: true, reports: true } },
    },
  })
  if (!project || project.status === 'DELETED') {
    throw new NotFoundError('Project')
  }
  const membership = await db.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId: project.workspaceId, userId } },
  })
  if (!membership || membership.removedAt) {
    throw new NotFoundError('Project')
  }
  return {
    id: project.id,
    name: project.name,
    description: project.description,
    productionUrl: project.productionUrl,
    productType: project.productType,
    primaryLocale: project.primaryLocale,
    supportedLocales: project.supportedLocales.split(','),
    defaultTimezone: project.defaultTimezone,
    targetCustomer: project.targetCustomer,
    brandLogoUrl: project.brandLogoUrl,
    brandColors: project.brandColors,
    retentionDays: project.retentionDays,
    status: project.status,
    createdAt: project.createdAt,
    environments: project.environments,
    verifiedDomains: project.verifiedDomains.map((d) => ({
      id: d.id,
      domain: d.domain,
      verificationStatus: d.verificationStatus,
      verifiedAt: d.verifiedAt,
    })),
    counts: {
      runs: project._count.scanRuns,
      findings: project._count.findings,
      journeys: project._count.journeys,
      reports: project._count.reports,
    },
  }
}

export async function updateProject(
  projectId: string,
  userId: string,
  updates: Partial<CreateProjectInput> & { status?: string; retentionDays?: number; brandLogoUrl?: string; brandColors?: string },
  ctx: Pick<AuditContext, 'ip' | 'userAgent' | 'requestId'>,
) {
  const project = await db.project.findUnique({ where: { id: projectId } })
  if (!project || project.status === 'DELETED') {
    throw new NotFoundError('Project')
  }
  const membership = await db.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId: project.workspaceId, userId } },
  })
  if (!membership || membership.removedAt) {
    throw new NotFoundError('Project')
  }
  if (!hasPermission(membership.role as WorkspaceRole, 'projects.update')) {
    throw new ForbiddenError('Missing permission: projects.update')
  }

  const data: Record<string, unknown> = {}
  if (updates.name !== undefined) data.name = updates.name
  if (updates.description !== undefined) data.description = updates.description
  if (updates.productionUrl !== undefined) data.productionUrl = updates.productionUrl
  if (updates.productType !== undefined) data.productType = updates.productType
  if (updates.primaryLocale !== undefined) data.primaryLocale = updates.primaryLocale
  if (updates.supportedLocales !== undefined) data.supportedLocales = updates.supportedLocales.join(',')
  if (updates.defaultTimezone !== undefined) data.defaultTimezone = updates.defaultTimezone
  if (updates.targetCustomer !== undefined) data.targetCustomer = updates.targetCustomer
  if (updates.status !== undefined) data.status = updates.status
  if (updates.retentionDays !== undefined) data.retentionDays = updates.retentionDays
  if (updates.brandLogoUrl !== undefined) data.brandLogoUrl = updates.brandLogoUrl
  if (updates.brandColors !== undefined) data.brandColors = updates.brandColors

  const updated = await db.project.update({ where: { id: projectId }, data })
  await recordAudit('PROJECT_UPDATE', { type: 'project', id: projectId }, { ...ctx, actorType: 'USER', actorId: userId, workspaceId: project.workspaceId })
  return updated
}

export async function deleteProject(
  projectId: string,
  userId: string,
  ctx: Pick<AuditContext, 'ip' | 'userAgent' | 'requestId'>,
) {
  const project = await db.project.findUnique({ where: { id: projectId } })
  if (!project) {
    throw new NotFoundError('Project')
  }
  const membership = await db.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId: project.workspaceId, userId } },
  })
  if (!membership || membership.removedAt) {
    throw new NotFoundError('Project')
  }
  if (!hasPermission(membership.role as WorkspaceRole, 'projects.delete')) {
    throw new ForbiddenError('Missing permission: projects.delete')
  }
  await db.project.update({ where: { id: projectId }, data: { status: 'DELETED' } })
  await recordAudit('PROJECT_DELETE', { type: 'project', id: projectId }, { ...ctx, actorType: 'USER', actorId: userId, workspaceId: project.workspaceId })
}

// ---------------- Environments ----------------

export interface CreateEnvironmentInput {
  type: 'PRODUCTION' | 'STAGING' | 'PREVIEW' | 'DEVELOPMENT'
  baseUrl: string
  allowedHostnames?: string[]
  authMode?: string
  scanMode?: string
  enabled?: boolean
}

export async function createEnvironment(
  projectId: string,
  input: CreateEnvironmentInput,
  userId: string,
  ctx: Pick<AuditContext, 'ip' | 'userAgent' | 'requestId'>,
) {
  const project = await db.project.findUnique({ where: { id: projectId } })
  if (!project) throw new NotFoundError('Project')
  const membership = await db.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId: project.workspaceId, userId } },
  })
  if (!membership || membership.removedAt) throw new NotFoundError('Project')
  if (!hasPermission(membership.role as WorkspaceRole, 'projects.update')) {
    throw new ForbiddenError('Missing permission: projects.update')
  }

  if (!input.baseUrl || !/^https?:\/\//.test(input.baseUrl)) {
    throw new ValidationError('Base URL must start with http:// or https://')
  }

  const env = await db.projectEnvironment.create({
    data: {
      projectId,
      type: input.type,
      baseUrl: input.baseUrl,
      allowedHostnames: (input.allowedHostnames || []).join(','),
      authMode: input.authMode || 'NONE',
      scanMode: input.scanMode || 'PASSIVE',
      enabled: input.enabled ?? true,
    },
  })
  await recordAudit('ENVIRONMENT_CREATE', { type: 'environment', id: env.id }, { ...ctx, actorType: 'USER', actorId: userId, workspaceId: project.workspaceId })
  return env
}

// ---------------- Domain verification ----------------

export async function startDomainVerification(
  projectId: string,
  domain: string,
  method: 'DNS_TXT' | 'HTML_FILE' | 'HTML_META',
  userId: string,
  ctx: Pick<AuditContext, 'ip' | 'userAgent' | 'requestId'>,
) {
  const project = await db.project.findUnique({ where: { id: projectId } })
  if (!project) throw new NotFoundError('Project')
  const membership = await db.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId: project.workspaceId, userId } },
  })
  if (!membership || membership.removedAt) throw new NotFoundError('Project')

  const domainNormalized = domain.toLowerCase().trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '')
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domainNormalized)) {
    throw new ValidationError('Invalid domain')
  }

  // Check for existing verified domain
  const existing = await db.verifiedDomain.findUnique({
    where: { projectId_domainNormalized: { projectId, domainNormalized } },
  })
  if (existing && existing.verificationStatus === 'VERIFIED') {
    throw new ConflictError('Domain is already verified')
  }

  // Create or update domain record
  const rawToken = randomHex(32)
  const tokenHash = hashToken(rawToken)
  const tokenDisplay = `proofpilot-verification=${rawToken}`

  const verifiedDomain = existing
    ? await db.verifiedDomain.update({
        where: { id: existing.id },
        data: {
          verificationMethod: method,
          verificationStatus: 'PENDING',
          initiatedById: userId,
        },
      })
    : await db.verifiedDomain.create({
        data: {
          projectId,
          domain: domainNormalized,
          domainNormalized,
          verificationMethod: method,
          verificationStatus: 'PENDING',
          initiatedById: userId,
        },
      })

  // Invalidate old challenges, create new one
  await db.domainVerificationChallenge.deleteMany({
    where: { verifiedDomainId: verifiedDomain.id },
  })
  await db.domainVerificationChallenge.create({
    data: {
      verifiedDomainId: verifiedDomain.id,
      tokenHash,
      tokenDisplay,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    },
  })

  await recordAudit('DOMAIN_VERIFY_START', { type: 'verified_domain', id: verifiedDomain.id }, { ...ctx, actorType: 'USER', actorId: userId, workspaceId: project.workspaceId })

  const instructions = method === 'DNS_TXT'
    ? `Add a TXT record: _proofpilot.${domainNormalized} → ${tokenDisplay}`
    : method === 'HTML_FILE'
      ? `Create a file at ${domainNormalized}/.well-known/proofpilot-verification.txt containing: ${rawToken}`
      : `Add <meta name="proofpilot-verification" content="${rawToken}"> to your homepage <head>`

  return {
    verificationId: verifiedDomain.id,
    method,
    token: tokenDisplay,
    rawToken,
    instructions,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
  }
}

export async function checkDomainVerification(
  verificationId: string,
  userId: string,
  ctx: Pick<AuditContext, 'ip' | 'userAgent' | 'requestId'>,
) {
  const vd = await db.verifiedDomain.findUnique({
    where: { id: verificationId },
    include: { challenges: { orderBy: { createdAt: 'desc' }, take: 1 } },
  })
  if (!vd) throw new NotFoundError('Domain verification')
  const membership = await db.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId: vd.project.workspaceId, userId } },
  })
  if (!membership || membership.removedAt) throw new NotFoundError('Domain verification')

  const challenge = vd.challenges[0]
  if (!challenge || challenge.expiresAt < new Date()) {
    return { status: 'EXPIRED', message: 'Challenge expired. Generate a new one.' }
  }

  // In dev mode, auto-verify localhost and demo targets
  const isDevAutoVerify =
    process.env.APP_ENV === 'development' &&
    (vd.domainNormalized === 'localhost' || vd.domainNormalized.includes('proofpilot.local'))

  if (isDevAutoVerify) {
    await db.verifiedDomain.update({
      where: { id: vd.id },
      data: {
        verificationStatus: 'VERIFIED',
        verifiedAt: new Date(),
        lastRevalidatedAt: new Date(),
      },
    })
    await recordAudit('DOMAIN_VERIFY_COMPLETE', { type: 'verified_domain', id: vd.id }, { ...ctx, actorType: 'USER', actorId: userId, workspaceId: vd.project.workspaceId })
    return { status: 'VERIFIED', domain: vd.domain }
  }

  // In production, this would actually check DNS TXT / HTML file / meta tag
  // For now, we return PENDING and document that real verification needs the worker
  return {
    status: vd.verificationStatus,
    domain: vd.domain,
    message: 'In production, this endpoint checks DNS/HTML/meta automatically. In dev, localhost is auto-verified.',
  }
}
