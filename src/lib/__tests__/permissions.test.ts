/**
 * Unit tests for src/lib/permissions.ts
 */
import { describe, test, expect } from 'bun:test'
import {
  hasPermission,
  assertPermission,
  canManageRole,
  ROLE_RANK,
  type WorkspaceRole,
  type Permission,
} from '../permissions'

// ─── hasPermission: OWNER has all workspace permissions ────────────────────

describe('hasPermission()', () => {
  test('OWNER has all workspace permissions', () => {
    const ownerPerms: Permission[] = [
      'workspace.read', 'workspace.update', 'workspace.delete',
      'members.read', 'members.invite', 'members.update', 'members.remove',
      'projects.create', 'projects.read', 'projects.update', 'projects.delete',
      'runs.create', 'runs.cancel', 'runs.read',
      'findings.read', 'findings.update',
      'journeys.create', 'journeys.update',
      'reports.create', 'reports.read', 'reports.approve', 'reports.publish',
      'billing.read', 'billing.manage',
      'integrations.manage',
      'audit.read',
      'secrets.manage',
    ]
    for (const perm of ownerPerms) {
      expect(hasPermission('OWNER', perm)).toBe(true)
    }
  })

  test('VIEWER has only read permissions', () => {
    const viewerPerms: Permission[] = [
      'workspace.read',
      'members.read',
      'projects.read',
      'runs.read',
      'findings.read',
      'reports.read',
      'billing.read',
    ]
    for (const perm of viewerPerms) {
      expect(hasPermission('VIEWER', perm)).toBe(true)
    }
    // VIEWER should NOT have write permissions
    const writePerms: Permission[] = [
      'workspace.update', 'workspace.delete',
      'members.invite', 'members.update', 'members.remove',
      'projects.create', 'projects.update', 'projects.delete',
      'runs.create', 'runs.cancel',
      'findings.update',
      'journeys.create', 'journeys.update',
      'reports.create', 'reports.approve', 'reports.publish',
      'billing.manage',
      'integrations.manage',
      'secrets.manage',
    ]
    for (const perm of writePerms) {
      expect(hasPermission('VIEWER', perm)).toBe(false)
    }
  })

  test('CLIENT has minimal permissions', () => {
    expect(hasPermission('CLIENT', 'workspace.read')).toBe(true)
    expect(hasPermission('CLIENT', 'projects.read')).toBe(true)
    expect(hasPermission('CLIENT', 'runs.read')).toBe(true)
    expect(hasPermission('CLIENT', 'findings.read')).toBe(true)
    expect(hasPermission('CLIENT', 'reports.read')).toBe(true)
    // CLIENT does NOT have billing.read or members.read (unlike VIEWER)
    expect(hasPermission('CLIENT', 'billing.read')).toBe(false)
    expect(hasPermission('CLIENT', 'members.read')).toBe(false)
  })

  test('MEMBER has create/read but not delete/billing.manage', () => {
    expect(hasPermission('MEMBER', 'projects.create')).toBe(true)
    expect(hasPermission('MEMBER', 'projects.update')).toBe(true)
    expect(hasPermission('MEMBER', 'runs.create')).toBe(true)
    expect(hasPermission('MEMBER', 'billing.read')).toBe(true)
    expect(hasPermission('MEMBER', 'projects.delete')).toBe(false)
    expect(hasPermission('MEMBER', 'billing.manage')).toBe(false)
    expect(hasPermission('MEMBER', 'integrations.manage')).toBe(false)
  })

  test('ADMIN has most permissions but not workspace.delete', () => {
    expect(hasPermission('ADMIN', 'workspace.update')).toBe(true)
    expect(hasPermission('ADMIN', 'members.remove')).toBe(true)
    expect(hasPermission('ADMIN', 'reports.publish')).toBe(true)
    expect(hasPermission('ADMIN', 'workspace.delete')).toBe(false)
    expect(hasPermission('ADMIN', 'billing.manage')).toBe(false)
  })

  // ─── Platform scope ──────────────────────────────────────────────────────

  test('USER has no platform permissions', () => {
    expect(hasPermission('USER', 'admin.platform', 'platform')).toBe(false)
    expect(hasPermission('USER', 'admin.support', 'platform')).toBe(false)
  })

  test('SUPPORT has admin.support', () => {
    expect(hasPermission('SUPPORT', 'admin.support', 'platform')).toBe(true)
    expect(hasPermission('SUPPORT', 'admin.platform', 'platform')).toBe(false)
  })

  test('PLATFORM_ADMIN has both admin.platform and admin.support', () => {
    expect(hasPermission('PLATFORM_ADMIN', 'admin.platform', 'platform')).toBe(true)
    expect(hasPermission('PLATFORM_ADMIN', 'admin.support', 'platform')).toBe(true)
  })

  test('workspace scope ignores platform roles gracefully', () => {
    // When using workspace scope with a platform role, the role won't be in WORKSPACE_PERMISSIONS
    // so it should return false (or undefined → false)
    expect(hasPermission('USER', 'workspace.read', 'workspace')).toBe(false)
    expect(hasPermission('PLATFORM_ADMIN', 'workspace.read', 'workspace')).toBe(false)
  })
})

// ─── assertPermission ─────────────────────────────────────────────────────────

describe('assertPermission()', () => {
  test('does not throw for valid permission', () => {
    expect(() => assertPermission('OWNER', 'workspace.read')).not.toThrow()
  })

  test('throws ForbiddenError for missing permission', () => {
    expect(() => assertPermission('VIEWER', 'workspace.update')).toThrow('Missing permission: workspace.update')
  })

  test('throws with correct message', () => {
    try {
      assertPermission('CLIENT', 'members.invite')
      expect(true).toBe(false) // should not reach here
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(Error)
      expect((err as Error).message).toContain('Missing permission: members.invite')
      expect((err as Error).name).toBe('ForbiddenError')
    }
  })
})

// ─── canManageRole ───────────────────────────────────────────────────────────

describe('canManageRole()', () => {
  test('OWNER can manage all roles', () => {
    const allRoles: WorkspaceRole[] = ['OWNER', 'ADMIN', 'MEMBER', 'VIEWER', 'CLIENT']
    for (const target of allRoles) {
      expect(canManageRole('OWNER', target)).toBe(true)
    }
  })

  test('ADMIN can manage MEMBER, VIEWER, CLIENT but not OWNER or ADMIN', () => {
    expect(canManageRole('ADMIN', 'MEMBER')).toBe(true)
    expect(canManageRole('ADMIN', 'VIEWER')).toBe(true)
    expect(canManageRole('ADMIN', 'CLIENT')).toBe(true)
    expect(canManageRole('ADMIN', 'OWNER')).toBe(false)
    expect(canManageRole('ADMIN', 'ADMIN')).toBe(false)
  })

  test('MEMBER can manage VIEWER and CLIENT but not ADMIN or OWNER', () => {
    expect(canManageRole('MEMBER', 'VIEWER')).toBe(true)
    expect(canManageRole('MEMBER', 'CLIENT')).toBe(true)
    expect(canManageRole('MEMBER', 'MEMBER')).toBe(false)
    expect(canManageRole('MEMBER', 'ADMIN')).toBe(false)
    expect(canManageRole('MEMBER', 'OWNER')).toBe(false)
  })

  test('VIEWER cannot manage any role (rank 0, lowest)', () => {
    // VIEWER rank=0, cannot manage anyone since no rank is < 0
    const allRoles: WorkspaceRole[] = ['OWNER', 'ADMIN', 'MEMBER', 'VIEWER', 'CLIENT']
    for (const target of allRoles) {
      expect(canManageRole('VIEWER', target)).toBe(false)
    }
  })

  test('CLIENT can manage VIEWER but nothing else', () => {
    expect(canManageRole('CLIENT', 'VIEWER')).toBe(true) // rank 1 > 0
    expect(canManageRole('CLIENT', 'CLIENT')).toBe(false)
    expect(canManageRole('CLIENT', 'MEMBER')).toBe(false)
    expect(canManageRole('CLIENT', 'ADMIN')).toBe(false)
    expect(canManageRole('CLIENT', 'OWNER')).toBe(false)
  })
})

// ─── ROLE_RANK ──────────────────────────────────────────────────────────────

describe('ROLE_RANK', () => {
  test('ranks are in expected order', () => {
    expect(ROLE_RANK.VIEWER).toBeLessThan(ROLE_RANK.CLIENT)
    expect(ROLE_RANK.CLIENT).toBeLessThan(ROLE_RANK.MEMBER)
    expect(ROLE_RANK.MEMBER).toBeLessThan(ROLE_RANK.ADMIN)
    expect(ROLE_RANK.ADMIN).toBeLessThan(ROLE_RANK.OWNER)
  })
})
