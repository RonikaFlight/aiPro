/**
 * Workspace service — ProofPilot
 *
 * CRUD for workspaces, members, invitations.
 * Every workspace-owned entity must pass through this service.
 */
import { db } from './db'
import { hashToken, randomToken } from './crypto'
import { AppError, ConflictError, ForbiddenError, NotFoundError, ValidationError } from './errors'
import { recordAudit } from './audit'
import { hasPermission, canManageRole, type WorkspaceRole } from './permissions'
import { sendEmail } from './email'
import { env } from './env'
import type { AuditContext } from './audit'

export interface CreateWorkspaceInput {
  name: string
  slug?: string
}

export async function createWorkspace(
  input: CreateWorkspaceInput,
  ownerId: string,
  ctx: Pick<AuditContext, 'ip' | 'userAgent' | 'requestId'>,
) {
  if (!input.name || input.name.trim().length < 2) {
    throw new ValidationError('Workspace name must be at least 2 characters')
  }
  const slug = (input.slug || input.name).toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
  if (slug.length < 2) {
    throw new ValidationError('Workspace slug must be at least 2 characters')
  }
  const existing = await db.workspace.findUnique({ where: { slug } })
  if (existing) {
    throw new ConflictError('A workspace with this slug already exists')
  }

  const freePlan = await db.plan.findUniqueOrThrow({ where: { code: 'FREE' } })

  const workspace = await db.workspace.create({
    data: {
      name: input.name.trim(),
      slug,
      ownerId,
      planId: freePlan.id,
      retentionDays: freePlan.retentionDays,
    },
  })
  await db.workspaceMember.create({
    data: { workspaceId: workspace.id, userId: ownerId, role: 'OWNER' },
  })
  // Create trial subscription
  await db.subscription.create({
    data: {
      workspaceId: workspace.id,
      planId: freePlan.id,
      status: 'TRIALING',
      trialEndsAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
      currentPeriodStart: new Date(),
      currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    },
  })

  await recordAudit('WORKSPACE_CREATE', { type: 'workspace', id: workspace.id }, { ...ctx, actorType: 'USER', actorId: ownerId, workspaceId: workspace.id })
  return workspace
}

export async function listWorkspacesForUser(userId: string) {
  const memberships = await db.workspaceMember.findMany({
    where: { userId, removedAt: null },
    include: {
      workspace: {
        select: {
          id: true, name: true, slug: true, logoUrl: true, accentColor: true, planId: true, createdAt: true,
        },
      },
    },
    orderBy: { addedAt: 'desc' },
  })
  return memberships.map((m) => ({
    id: m.workspace.id,
    name: m.workspace.name,
    slug: m.workspace.slug,
    logoUrl: m.workspace.logoUrl,
    accentColor: m.workspace.accentColor,
    role: m.role,
    createdAt: m.workspace.createdAt,
  }))
}

export async function getWorkspace(workspaceId: string, userId: string) {
  const membership = await db.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } },
  })
  if (!membership || membership.removedAt) {
    throw new NotFoundError('Workspace')
  }
  const workspace = await db.workspace.findUniqueOrThrow({
    where: { id: workspaceId },
    include: {
      subscriptions: { orderBy: { createdAt: 'desc' }, take: 1, include: { plan: true } },
    },
  })
  const sub = workspace.subscriptions[0]
  return {
    id: workspace.id,
    name: workspace.name,
    slug: workspace.slug,
    logoUrl: workspace.logoUrl,
    accentColor: workspace.accentColor,
    brandName: workspace.brandName,
    retentionDays: workspace.retentionDays,
    plan: sub?.plan ? { code: sub.plan.code, name: sub.plan.name } : null,
    role: membership.role as WorkspaceRole,
    createdAt: workspace.createdAt,
  }
}

export async function updateWorkspace(
  workspaceId: string,
  userId: string,
  updates: {
    name?: string
    logoUrl?: string
    accentColor?: string
    brandName?: string
    brandIntro?: string
    brandFooter?: string
    retentionDays?: number
  },
  ctx: Pick<AuditContext, 'ip' | 'userAgent' | 'requestId'>,
) {
  const membership = await db.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } },
  })
  if (!membership || membership.removedAt) {
    throw new NotFoundError('Workspace')
  }
  if (!hasPermission(membership.role as WorkspaceRole, 'workspace.update')) {
    throw new ForbiddenError('Missing permission: workspace.update')
  }

  const data: Record<string, unknown> = {}
  if (updates.name !== undefined) data.name = updates.name
  if (updates.logoUrl !== undefined) data.logoUrl = updates.logoUrl
  if (updates.accentColor !== undefined) data.accentColor = updates.accentColor
  if (updates.brandName !== undefined) data.brandName = updates.brandName
  if (updates.brandIntro !== undefined) data.brandIntro = updates.brandIntro
  if (updates.brandFooter !== undefined) data.brandFooter = updates.brandFooter
  if (updates.retentionDays !== undefined) data.retentionDays = updates.retentionDays

  const workspace = await db.workspace.update({ where: { id: workspaceId }, data })
  await recordAudit('WORKSPACE_UPDATE', { type: 'workspace', id: workspaceId }, { ...ctx, actorType: 'USER', actorId: userId, workspaceId })
  return workspace
}

// ---------------- Members ----------------

export async function listMembers(workspaceId: string, userId: string) {
  const membership = await db.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } },
  })
  if (!membership || membership.removedAt) {
    throw new NotFoundError('Workspace')
  }
  if (!hasPermission(membership.role as WorkspaceRole, 'members.read')) {
    throw new ForbiddenError('Missing permission: members.read')
  }
  const members = await db.workspaceMember.findMany({
    where: { workspaceId, removedAt: null },
    include: { user: { select: { id: true, email: true, name: true, avatarUrl: true } } },
    orderBy: { addedAt: 'asc' },
  })
  return members.map((m) => ({
    id: m.id,
    userId: m.user.id,
    email: m.user.email,
    name: m.user.name,
    avatarUrl: m.user.avatarUrl,
    role: m.role as WorkspaceRole,
    addedAt: m.addedAt,
  }))
}

export async function inviteMember(
  workspaceId: string,
  inviterId: string,
  inviterRole: WorkspaceRole,
  input: { email: string; role: WorkspaceRole },
  ctx: Pick<AuditContext, 'ip' | 'userAgent' | 'requestId'>,
) {
  if (!hasPermission(inviterRole, 'members.invite')) {
    throw new ForbiddenError('Missing permission: members.invite')
  }
  // Can only invite to roles below your own (unless OWNER)
  if (!canManageRole(inviterRole, input.role)) {
    throw new ForbiddenError('Cannot invite a member with equal or higher role')
  }
  const email = input.email.trim().toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new ValidationError('Invalid email address')
  }

  const workspace = await db.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { name: true } })
  const inviter = await db.user.findUniqueOrThrow({ where: { id: inviterId }, select: { name: true, email: true } })

  // Check if already a member
  const existingMember = await db.user.findUnique({
    where: { emailLower: email },
    select: { id: true, name: true },
  })
  if (existingMember) {
    const existingMembership = await db.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId: existingMember.id } },
    })
    if (existingMembership && !existingMembership.removedAt) {
      throw new ConflictError('User is already a member of this workspace')
    }
  }

  // Invalidate any previous pending invitations for this email
  await db.workspaceInvitation.updateMany({
    where: { workspaceId, emailLower: email, acceptedAt: null, revokedAt: null },
    data: { revokedAt: new Date() },
  })

  const rawToken = randomToken(32)
  const tokenHash = hashToken(rawToken)

  const invitation = await db.workspaceInvitation.create({
    data: {
      workspaceId,
      email,
      emailLower: email,
      role: input.role,
      tokenHash,
      invitedById: inviterId,
      inviteeId: existingMember?.id,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
    },
  })

  await sendEmail('workspace_invitation', {
    email,
    workspaceName: workspace.name,
    inviterName: inviter.name || inviter.email,
    role: input.role,
    token: rawToken,
  })

  await recordAudit('MEMBER_INVITE', { type: 'invitation', id: invitation.id }, { ...ctx, actorType: 'USER', actorId: inviterId, workspaceId }, { email, role: input.role })
  return { invitationId: invitation.id, expiresAt: invitation.expiresAt }
}

export async function acceptInvitation(
  rawToken: string,
  userId: string,
  userEmail: string,
  ctx: Pick<AuditContext, 'ip' | 'userAgent' | 'requestId'>,
) {
  const tokenHash = hashToken(rawToken)
  const invitation = await db.workspaceInvitation.findUnique({
    where: { tokenHash },
    include: { workspace: { select: { id: true, name: true } } },
  })
  if (!invitation) {
    throw new NotFoundError('Invitation')
  }
  if (invitation.acceptedAt || invitation.revokedAt) {
    throw new AppError('Invitation no longer valid', 410, 'invitation_invalid')
  }
  if (invitation.expiresAt < new Date()) {
    throw new AppError('Invitation expired', 410, 'invitation_expired')
  }
  if (invitation.emailLower !== userEmail.toLowerCase()) {
    throw new ForbiddenError('This invitation was sent to a different email address')
  }

  // Create or restore membership
  const existing = await db.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId: invitation.workspaceId, userId } },
  })
  if (existing) {
    await db.workspaceMember.update({
      where: { id: existing.id },
      data: { role: invitation.role, removedAt: null },
    })
  } else {
    await db.workspaceMember.create({
      data: { workspaceId: invitation.workspaceId, userId, role: invitation.role },
    })
  }

  await db.workspaceInvitation.update({
    where: { id: invitation.id },
    data: { acceptedAt: new Date(), inviteeId: userId },
  })

  await recordAudit('MEMBER_INVITE_ACCEPT', { type: 'workspace', id: invitation.workspaceId }, { ...ctx, actorType: 'USER', actorId: userId, workspaceId: invitation.workspaceId })
  return { workspaceId: invitation.workspaceId, workspaceName: invitation.workspace.name, role: invitation.role }
}

export async function changeMemberRole(
  workspaceId: string,
  actorId: string,
  actorRole: WorkspaceRole,
  targetUserId: string,
  newRole: WorkspaceRole,
  ctx: Pick<AuditContext, 'ip' | 'userAgent' | 'requestId'>,
) {
  if (!hasPermission(actorRole, 'members.update')) {
    throw new ForbiddenError('Missing permission: members.update')
  }
  const target = await db.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId: targetUserId } },
  })
  if (!target || target.removedAt) {
    throw new NotFoundError('Member')
  }
  if (!canManageRole(actorRole, target.role as WorkspaceRole)) {
    throw new ForbiddenError('Cannot modify a member with equal or higher role')
  }
  if (!canManageRole(actorRole, newRole)) {
    throw new ForbiddenError('Cannot assign a role equal to or higher than your own')
  }
  // Prevent OWNER from demoting themselves if they're the only owner
  if (target.role === 'OWNER' && newRole !== 'OWNER') {
    const ownerCount = await db.workspaceMember.count({
      where: { workspaceId, role: 'OWNER', removedAt: null },
    })
    if (ownerCount <= 1) {
      throw new AppError('Cannot demote the last owner', 400, 'last_owner')
    }
  }

  await db.workspaceMember.update({
    where: { id: target.id },
    data: { role: newRole },
  })
  await recordAudit('ROLE_CHANGE', { type: 'user', id: targetUserId }, { ...ctx, actorType: 'USER', actorId: actorId, workspaceId }, { from: target.role, to: newRole })
}

export async function removeMember(
  workspaceId: string,
  actorId: string,
  actorRole: WorkspaceRole,
  targetUserId: string,
  ctx: Pick<AuditContext, 'ip' | 'userAgent' | 'requestId'>,
) {
  if (!hasPermission(actorRole, 'members.remove')) {
    throw new ForbiddenError('Missing permission: members.remove')
  }
  const target = await db.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId: targetUserId } },
  })
  if (!target || target.removedAt) {
    throw new NotFoundError('Member')
  }
  if (!canManageRole(actorRole, target.role as WorkspaceRole)) {
    throw new ForbiddenError('Cannot remove a member with equal or higher role')
  }
  if (target.role === 'OWNER') {
    const ownerCount = await db.workspaceMember.count({
      where: { workspaceId, role: 'OWNER', removedAt: null },
    })
    if (ownerCount <= 1) {
      throw new AppError('Cannot remove the last owner', 400, 'last_owner')
    }
  }

  await db.workspaceMember.update({
    where: { id: target.id },
    data: { removedAt: new Date() },
  })
  // Revoke all sessions for this user (immediate access loss)
  // (Sessions are global, not workspace-scoped — they remain valid for other workspaces)

  await recordAudit('MEMBER_REMOVE', { type: 'user', id: targetUserId }, { ...ctx, actorType: 'USER', actorId: actorId, workspaceId })
}
