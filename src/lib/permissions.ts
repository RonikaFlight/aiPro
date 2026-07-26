/**
 * Permission system — ProofPilot
 *
 * Centralized permission map. Roles → permissions.
 * All authorization decisions MUST go through `hasPermission(role, permission)`.
 * See SECURITY_MODEL.md §"Authorization".
 */

export type PlatformRole = 'USER' | 'SUPPORT' | 'PLATFORM_ADMIN'
export type WorkspaceRole = 'OWNER' | 'ADMIN' | 'MEMBER' | 'VIEWER' | 'CLIENT'

export type Permission =
  | 'workspace.read'
  | 'workspace.update'
  | 'workspace.delete'
  | 'members.read'
  | 'members.invite'
  | 'members.update'
  | 'members.remove'
  | 'projects.create'
  | 'projects.read'
  | 'projects.update'
  | 'projects.delete'
  | 'runs.create'
  | 'runs.cancel'
  | 'runs.read'
  | 'findings.read'
  | 'findings.update'
  | 'journeys.create'
  | 'journeys.update'
  | 'reports.create'
  | 'reports.publish'
  | 'billing.read'
  | 'billing.manage'
  | 'integrations.manage'
  | 'audit.read'
  | 'secrets.manage'
  | 'admin.platform'
  | 'admin.support'

const PLATFORM_PERMISSIONS: Record<PlatformRole, Permission[]> = {
  USER: [],
  SUPPORT: ['admin.support'],
  PLATFORM_ADMIN: ['admin.platform', 'admin.support'],
}

const WORKSPACE_PERMISSIONS: Record<WorkspaceRole, Permission[]> = {
  OWNER: [
    'workspace.read', 'workspace.update', 'workspace.delete',
    'members.read', 'members.invite', 'members.update', 'members.remove',
    'projects.create', 'projects.read', 'projects.update', 'projects.delete',
    'runs.create', 'runs.cancel', 'runs.read',
    'findings.read', 'findings.update',
    'journeys.create', 'journeys.update',
    'reports.create', 'reports.publish',
    'billing.read', 'billing.manage',
    'integrations.manage',
    'audit.read',
    'secrets.manage',
  ],
  ADMIN: [
    'workspace.read', 'workspace.update',
    'members.read', 'members.invite', 'members.update', 'members.remove',
    'projects.create', 'projects.read', 'projects.update', 'projects.delete',
    'runs.create', 'runs.cancel', 'runs.read',
    'findings.read', 'findings.update',
    'journeys.create', 'journeys.update',
    'reports.create', 'reports.publish',
    'billing.read',
    'integrations.manage',
    'audit.read',
    'secrets.manage',
  ],
  MEMBER: [
    'workspace.read',
    'members.read',
    'projects.create', 'projects.read', 'projects.update',
    'runs.create', 'runs.cancel', 'runs.read',
    'findings.read', 'findings.update',
    'journeys.create', 'journeys.update',
    'reports.create',
    'billing.read',
    'audit.read',
  ],
  VIEWER: [
    'workspace.read',
    'members.read',
    'projects.read',
    'runs.read',
    'findings.read',
    'billing.read',
  ],
  CLIENT: [
    'workspace.read',
    'projects.read',
    'runs.read',
    'findings.read',
    'reports.read' as Permission,
  ],
}

export function hasPermission(
  role: WorkspaceRole | PlatformRole,
  permission: Permission,
  scope: 'workspace' | 'platform' = 'workspace',
): boolean {
  if (scope === 'platform') {
    const perms = PLATFORM_PERMISSIONS[role as PlatformRole]
    return perms?.includes(permission) ?? false
  }
  const perms = WORKSPACE_PERMISSIONS[role as WorkspaceRole]
  return perms?.includes(permission) ?? false
}

export function assertPermission(
  role: WorkspaceRole | PlatformRole,
  permission: Permission,
  scope: 'workspace' | 'platform' = 'workspace',
): void {
  if (!hasPermission(role, permission, scope)) {
    throw new ForbiddenError(`Missing permission: ${permission}`)
  }
}

/** Workspace role hierarchy for elevation checks. */
export const ROLE_RANK: Record<WorkspaceRole, number> = {
  VIEWER: 0,
  CLIENT: 1,
  MEMBER: 2,
  ADMIN: 3,
  OWNER: 4,
}

export function canManageRole(actorRole: WorkspaceRole, targetRole: WorkspaceRole): boolean {
  // Cannot manage someone with equal or higher role unless you're OWNER
  if (actorRole === 'OWNER') return true
  return ROLE_RANK[actorRole] > ROLE_RANK[targetRole]
}

// Forward declaration of error class to avoid circular import.
// Defined properly in src/lib/errors.ts
class ForbiddenError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ForbiddenError'
  }
}
