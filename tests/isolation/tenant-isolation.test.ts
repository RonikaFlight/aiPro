/**
 * Tenant-isolation tests — ProofPilot
 *
 * Verifies that multi-tenant data isolation is enforced at every layer:
 *   1. Workspace membership gating (requireWorkspaceAuth)
 *   2. Service-layer membership checks (getWorkspace, listProjects, getProject, etc.)
 *   3. assertWorkspaceOwned prevents cross-workspace resource access
 *   4. Permission-based isolation (CLIENT/VIEWER/MEMBER blocked from admin actions)
 *   5. Removed members lose all access
 *   6. workspaceWhere always includes workspaceId in queries
 *   7. Scan authorization is workspace-scoped
 *   8. Findings/Reports/Journeys scoped to their owning workspace
 *
 * Uses bun test runner. Seeds two workspaces with separate data, then
 * verifies cross-workspace access is denied at every entry point.
 *
 * Phase 12 checklist item.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { db, workspaceWhere, assertWorkspaceOwned } from '@/lib/db'
import { hashPassword } from '@/lib/crypto'
import {
  hasPermission,
  assertPermission,
  canManageRole,
  type WorkspaceRole,
  type PlatformRole,
} from '@/lib/permissions'
import { getWorkspace, listWorkspacesForUser } from '@/lib/workspace-service'
import {
  getProject,
  listProjects,
  createProject,
  updateProject,
  deleteProject,
} from '@/lib/project-service'
import { getRun, cancelRun } from '@/lib/run-service'
import { ForbiddenError, NotFoundError } from '@/lib/errors'

// ---------------------------------------------------------------------------
// Test data fixtures
// ---------------------------------------------------------------------------

interface TestWorkspace {
  id: string
  name: string
  slug: string
}

interface TestUser {
  id: string
  email: string
  name: string
}

interface TestProject {
  id: string
  workspaceId: string
}

interface TestRun {
  id: string
  workspaceId: string
  projectId: string
}

interface TestFinding {
  id: string
  workspaceId: string
  projectId: string
}

interface TestReport {
  id: string
  workspaceId: string
  projectId: string
}

interface TestJourney {
  id: string
  projectId: string
}

let ws1: TestWorkspace
let ws2: TestWorkspace

let user1Owner: TestUser       // ws1 OWNER
let user1Member: TestUser     // ws1 MEMBER
let user1Client: TestUser      // ws1 CLIENT
let user1Viewer: TestUser      // ws1 VIEWER

let user2Owner: TestUser       // ws2 OWNER
let user2Member: TestUser      // ws2 MEMBER

let project1: TestProject      // ws1 project
let project2: TestProject      // ws2 project

let run1: TestRun              // ws1 run
let run2: TestRun              // ws2 run

let finding1: TestFinding      // ws1 finding
let finding2: TestFinding      // ws2 finding

let report1: TestReport       // ws1 report
let report2: TestReport       // ws2 report

let journey1: TestJourney      // ws1 journey
let journey2: TestJourney      // ws2 journey

let removedUser: TestUser      // user removed from ws1

// ---------------------------------------------------------------------------
// Seed helper — creates two isolated workspaces with full test data
// ---------------------------------------------------------------------------

async function seedTestData() {
  // Clean up any existing test data
  await db.finding.deleteMany({ where: {} })
  await db.scanPage.deleteMany({ where: {} })
  await db.artifact.deleteMany({ where: {} })
  await db.report.deleteMany({ where: {} })
  await db.journeyRun.deleteMany({ where: {} })
  await db.journey.deleteMany({ where: {} })
  await db.scanRun.deleteMany({ where: {} })
  await db.projectEnvironment.deleteMany({ where: {} })
  await db.verifiedDomain.deleteMany({ where: {} })
  await db.project.deleteMany({ where: {} })
  await db.workspaceMember.deleteMany({ where: {} })
  await db.workspaceInvitation.deleteMany({ where: {} })
  await db.subscription.deleteMany({ where: {} })
  await db.workspace.deleteMany({ where: {} })
  await db.session.deleteMany({ where: {} })
  await db.user.deleteMany({ where: {} })

  // Create plans
  const freePlan = await db.plan.upsert({
    where: { code: 'FREE' },
    create: {
      code: 'FREE', name: 'Free', priceMonthly: 0,
      maxProjects: 10, maxRunsPerMonth: 100, maxPagesPerRun: 50,
      browsers: 'chromium', scheduling: false, whiteLabel: false,
      aiEnrichment: false, journeys: false, visualBaselines: false,
      teamMembers: 10, retentionDays: 30, priorityQueue: false,
    },
    update: {},
  })

  // Create users
  user1Owner = await db.user.create({
    data: {
      email: 'ws1-owner@test.local', emailLower: 'ws1-owner@test.local',
      name: 'WS1 Owner', passwordHash: await hashPassword('TestPass123!ws1'),
      status: 'ACTIVE', platformRole: 'USER',
    },
  })
  user1Member = await db.user.create({
    data: {
      email: 'ws1-member@test.local', emailLower: 'ws1-member@test.local',
      name: 'WS1 Member', passwordHash: await hashPassword('TestPass123!ws1'),
      status: 'ACTIVE', platformRole: 'USER',
    },
  })
  user1Client = await db.user.create({
    data: {
      email: 'ws1-client@test.local', emailLower: 'ws1-client@test.local',
      name: 'WS1 Client', passwordHash: await hashPassword('TestPass123!ws1'),
      status: 'ACTIVE', platformRole: 'USER',
    },
  })
  user1Viewer = await db.user.create({
    data: {
      email: 'ws1-viewer@test.local', emailLower: 'ws1-viewer@test.local',
      name: 'WS1 Viewer', passwordHash: await hashPassword('TestPass123!ws1'),
      status: 'ACTIVE', platformRole: 'USER',
    },
  })

  user2Owner = await db.user.create({
    data: {
      email: 'ws2-owner@test.local', emailLower: 'ws2-owner@test.local',
      name: 'WS2 Owner', passwordHash: await hashPassword('TestPass123!ws2'),
      status: 'ACTIVE', platformRole: 'USER',
    },
  })
  user2Member = await db.user.create({
    data: {
      email: 'ws2-member@test.local', emailLower: 'ws2-member@test.local',
      name: 'WS2 Member', passwordHash: await hashPassword('TestPass123!ws2'),
      status: 'ACTIVE', platformRole: 'USER',
    },
  })

  removedUser = await db.user.create({
    data: {
      email: 'removed@test.local', emailLower: 'removed@test.local',
      name: 'Removed User', passwordHash: await hashPassword('TestPass123!rm'),
      status: 'ACTIVE', platformRole: 'USER',
    },
  })

  // Create workspace 1
  ws1 = await db.workspace.create({
    data: {
      name: 'Test Workspace Alpha',
      slug: 'test-ws-alpha',
      ownerId: user1Owner.id,
      planId: freePlan.id,
      retentionDays: 30,
    },
  })

  // Create workspace 2
  ws2 = await db.workspace.create({
    data: {
      name: 'Test Workspace Beta',
      slug: 'test-ws-beta',
      ownerId: user2Owner.id,
      planId: freePlan.id,
      retentionDays: 30,
    },
  })

  // Workspace 1 members
  await db.workspaceMember.create({
    data: { workspaceId: ws1.id, userId: user1Owner.id, role: 'OWNER' },
  })
  await db.workspaceMember.create({
    data: { workspaceId: ws1.id, userId: user1Member.id, role: 'MEMBER' },
  })
  await db.workspaceMember.create({
    data: { workspaceId: ws1.id, userId: user1Client.id, role: 'CLIENT' },
  })
  await db.workspaceMember.create({
    data: { workspaceId: ws1.id, userId: user1Viewer.id, role: 'VIEWER' },
  })
  // Removed member (was in ws1, now removed)
  await db.workspaceMember.create({
    data: {
      workspaceId: ws1.id, userId: removedUser.id, role: 'MEMBER',
      removedAt: new Date(),
    },
  })

  // Workspace 2 members
  await db.workspaceMember.create({
    data: { workspaceId: ws2.id, userId: user2Owner.id, role: 'OWNER' },
  })
  await db.workspaceMember.create({
    data: { workspaceId: ws2.id, userId: user2Member.id, role: 'MEMBER' },
  })

  // Subscriptions (TRIALING)
  await db.subscription.create({
    data: {
      workspaceId: ws1.id, planId: freePlan.id, status: 'TRIALING',
      stripeCustomerId: 'test_ws1', stripeSubscriptionId: 'test_sub_ws1',
      currentPeriodStart: new Date(),
      currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      trialEndsAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
    },
  })
  await db.subscription.create({
    data: {
      workspaceId: ws2.id, planId: freePlan.id, status: 'TRIALING',
      stripeCustomerId: 'test_ws2', stripeSubscriptionId: 'test_sub_ws2',
      currentPeriodStart: new Date(),
      currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      trialEndsAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
    },
  })

  // Projects
  project1 = await db.project.create({
    data: {
      workspaceId: ws1.id, name: 'WS1 Project', status: 'ACTIVE',
      productionUrl: 'http://localhost:3000/ws1', productType: 'web_app',
      primaryLocale: 'en', supportedLocales: 'en',
      defaultTimezone: 'UTC', createdById: user1Owner.id,
    },
  })
  project2 = await db.project.create({
    data: {
      workspaceId: ws2.id, name: 'WS2 Project', status: 'ACTIVE',
      productionUrl: 'http://localhost:3000/ws2', productType: 'web_app',
      primaryLocale: 'en', supportedLocales: 'en',
      defaultTimezone: 'UTC', createdById: user2Owner.id,
    },
  })

  // Environments
  await db.projectEnvironment.create({
    data: {
      projectId: project1.id, type: 'PRODUCTION',
      baseUrl: 'http://localhost:3000/ws1',
      allowedHostnames: 'localhost', scanMode: 'PASSIVE', enabled: true,
    },
  })
  await db.projectEnvironment.create({
    data: {
      projectId: project2.id, type: 'PRODUCTION',
      baseUrl: 'http://localhost:3000/ws2',
      allowedHostnames: 'localhost', scanMode: 'PASSIVE', enabled: true,
    },
  })

  // Runs
  run1 = await db.scanRun.create({
    data: {
      workspaceId: ws1.id, projectId: project1.id,
      environmentId: null, triggeredById: null,
      status: 'COMPLETED', trigger: 'MANUAL', runMode: 'PASSIVE',
      configSnapshot: JSON.stringify({ targetUrl: 'http://localhost:3000/ws1' }),
      pagesAnalyzed: 5, findingsCount: 3,
      score: 82, startedAt: new Date(),
      completedAt: new Date(),
    },
  })
  run2 = await db.scanRun.create({
    data: {
      workspaceId: ws2.id, projectId: project2.id,
      environmentId: null, triggeredById: null,
      status: 'COMPLETED', trigger: 'MANUAL', runMode: 'PASSIVE',
      configSnapshot: JSON.stringify({ targetUrl: 'http://localhost:3000/ws2' }),
      pagesAnalyzed: 3, findingsCount: 1,
      score: 95, startedAt: new Date(),
      completedAt: new Date(),
    },
  })

  // Findings
  finding1 = await db.finding.create({
    data: {
      workspaceId: ws1.id, projectId: project1.id, runId: run1.id,
      title: 'WS1 Finding', severity: 'MAJOR', status: 'OPEN',
      category: 'accessibility',
      affectedUrl: 'http://localhost:3000/ws1',
      normalizedUrl: 'http://localhost:3000/ws1',
      fingerprint: 'ws1-finding-001',
      checkId: 'a11y-contrast', description: 'Low contrast on heading',
    },
  })
  finding2 = await db.finding.create({
    data: {
      workspaceId: ws2.id, projectId: project2.id, runId: run2.id,
      title: 'WS2 Finding', severity: 'MINOR', status: 'OPEN',
      category: 'responsive',
      affectedUrl: 'http://localhost:3000/ws2',
      normalizedUrl: 'http://localhost:3000/ws2',
      fingerprint: 'ws2-finding-001',
      checkId: 'resp-overflow', description: 'Horizontal overflow',
    },
  })

  // Reports
  report1 = await db.report.create({
    data: {
      workspaceId: ws1.id, projectId: project1.id, runId: run1.id,
      type: 'TECHNICAL', status: 'DRAFT',
      title: 'WS1 Report', sectionsJson: '[]',
      createdById: user1Owner.id,
    },
  })
  report2 = await db.report.create({
    data: {
      workspaceId: ws2.id, projectId: project2.id, runId: run2.id,
      type: 'TECHNICAL', status: 'DRAFT',
      title: 'WS2 Report', sectionsJson: '[]',
      createdById: user2Owner.id,
    },
  })

  // Journeys
  journey1 = await db.journey.create({
    data: {
      projectId: project1.id,
      name: 'WS1 Journey', status: 'ACTIVE',
      createdById: user1Owner.id,
    },
  })
  journey2 = await db.journey.create({
    data: {
      projectId: project2.id,
      name: 'WS2 Journey', status: 'ACTIVE',
      createdById: user2Owner.id,
    },
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Tenant Isolation — Phase 12', () => {
  beforeAll(async () => {
    await seedTestData()
  })

  afterAll(async () => {
    // Clean up test data
    await db.finding.deleteMany({ where: {} })
    await db.scanPage.deleteMany({ where: {} })
    await db.artifact.deleteMany({ where: {} })
    await db.report.deleteMany({ where: {} })
    await db.journeyRun.deleteMany({ where: {} })
    await db.journey.deleteMany({ where: {} })
    await db.scanRun.deleteMany({ where: {} })
    await db.projectEnvironment.deleteMany({ where: {} })
    await db.verifiedDomain.deleteMany({ where: {} })
    await db.project.deleteMany({ where: {} })
    await db.workspaceMember.deleteMany({ where: {} })
    await db.workspaceInvitation.deleteMany({ where: {} })
    await db.subscription.deleteMany({ where: {} })
    await db.workspace.deleteMany({ where: {} })
    await db.session.deleteMany({ where: {} })
    await db.user.deleteMany({ where: {} })
  })

  // ========================================================================
  // 1. Permission system isolation
  // ========================================================================
  describe('Permission system — role boundaries', () => {
    test('CLIENT cannot create projects', () => {
      expect(hasPermission('CLIENT', 'projects.create')).toBe(false)
    })

    test('CLIENT cannot update projects', () => {
      expect(hasPermission('CLIENT', 'projects.update')).toBe(false)
    })

    test('CLIENT cannot delete projects', () => {
      expect(hasPermission('CLIENT', 'projects.delete')).toBe(false)
    })

    test('CLIENT cannot create runs', () => {
      expect(hasPermission('CLIENT', 'runs.create')).toBe(false)
    })

    test('CLIENT can read findings', () => {
      expect(hasPermission('CLIENT', 'findings.read')).toBe(true)
    })

    test('CLIENT cannot update findings', () => {
      expect(hasPermission('CLIENT', 'findings.update')).toBe(false)
    })

    test('VIEWER cannot create runs', () => {
      expect(hasPermission('VIEWER', 'runs.create')).toBe(false)
    })

    test('VIEWER cannot manage members', () => {
      expect(hasPermission('VIEWER', 'members.invite')).toBe(false)
    })

    test('VIEWER cannot update workspace', () => {
      expect(hasPermission('VIEWER', 'workspace.update')).toBe(false)
    })

    test('MEMBER cannot delete workspace', () => {
      expect(hasPermission('MEMBER', 'workspace.delete')).toBe(false)
    })

    test('MEMBER cannot manage billing', () => {
      expect(hasPermission('MEMBER', 'billing.manage')).toBe(false)
    })

    test('MEMBER can create runs', () => {
      expect(hasPermission('MEMBER', 'runs.create')).toBe(true)
    })

    test('OWNER has all workspace permissions', () => {
      const ownerPerms = [
        'workspace.read', 'workspace.update', 'workspace.delete',
        'members.read', 'members.invite', 'members.update', 'members.remove',
        'projects.create', 'projects.read', 'projects.update', 'projects.delete',
        'runs.create', 'runs.cancel', 'runs.read',
        'findings.read', 'findings.update',
        'journeys.create', 'journeys.update',
        'reports.create', 'reports.read', 'reports.approve', 'reports.publish',
        'billing.read', 'billing.manage',
        'integrations.manage', 'audit.read', 'secrets.manage',
      ]
      for (const perm of ownerPerms) {
        expect(hasPermission('OWNER', perm)).toBe(true)
      }
    })

    test('ADMIN cannot delete workspace (only OWNER can)', () => {
      expect(hasPermission('ADMIN', 'workspace.delete')).toBe(false)
    })

    test('ADMIN cannot manage billing', () => {
      expect(hasPermission('ADMIN', 'billing.manage')).toBe(false)
    })

    test('assertPermission throws error for missing permission', () => {
      expect(() => assertPermission('CLIENT', 'projects.create')).toThrow()
    })

    test('assertPermission does not throw for valid permission', () => {
      expect(() => assertPermission('OWNER', 'projects.create')).not.toThrow()
    })

    test('canManageRole — OWNER can manage all roles', () => {
      expect(canManageRole('OWNER', 'OWNER')).toBe(true)
      expect(canManageRole('OWNER', 'ADMIN')).toBe(true)
      expect(canManageRole('OWNER', 'MEMBER')).toBe(true)
      expect(canManageRole('OWNER', 'VIEWER')).toBe(true)
      expect(canManageRole('OWNER', 'CLIENT')).toBe(true)
    })

    test('canManageRole — ADMIN can manage VIEWER/CLIENT/MEMBER but not OWNER/ADMIN', () => {
      expect(canManageRole('ADMIN', 'OWNER')).toBe(false)
      expect(canManageRole('ADMIN', 'ADMIN')).toBe(false)
      expect(canManageRole('ADMIN', 'MEMBER')).toBe(true)
      expect(canManageRole('ADMIN', 'VIEWER')).toBe(true)
      expect(canManageRole('ADMIN', 'CLIENT')).toBe(true)
    })

    test('canManageRole — MEMBER can manage VIEWER/CLIENT but not ADMIN/OWNER', () => {
      expect(canManageRole('MEMBER', 'OWNER')).toBe(false)
      expect(canManageRole('MEMBER', 'ADMIN')).toBe(false)
      expect(canManageRole('MEMBER', 'MEMBER')).toBe(false)
      expect(canManageRole('MEMBER', 'VIEWER')).toBe(true)
      expect(canManageRole('MEMBER', 'CLIENT')).toBe(true)
    })

    test('canManageRole — VIEWER cannot manage anyone (rank 0)', () => {
      // VIEWER rank = 0, so can only manage roles with rank < 0 (none exist)
      expect(canManageRole('VIEWER', 'OWNER')).toBe(false)
      expect(canManageRole('VIEWER', 'ADMIN')).toBe(false)
      expect(canManageRole('VIEWER', 'MEMBER')).toBe(false)
      expect(canManageRole('VIEWER', 'VIEWER')).toBe(false)
      expect(canManageRole('VIEWER', 'CLIENT')).toBe(false)
    })

    test('canManageRole — CLIENT can manage VIEWER but not themselves or higher', () => {
      // CLIENT rank = 1
      expect(canManageRole('CLIENT', 'OWNER')).toBe(false)
      expect(canManageRole('CLIENT', 'ADMIN')).toBe(false)
      expect(canManageRole('CLIENT', 'MEMBER')).toBe(false)
      expect(canManageRole('CLIENT', 'CLIENT')).toBe(false)
      expect(canManageRole('CLIENT', 'VIEWER')).toBe(true) // rank 1 > rank 0
    })

    test('Platform roles are separate from workspace roles', () => {
      expect(hasPermission('USER' as WorkspaceRole, 'admin.platform', 'platform')).toBe(false)
      expect(hasPermission('PLATFORM_ADMIN', 'admin.platform', 'platform')).toBe(true)
      expect(hasPermission('SUPPORT', 'admin.support', 'platform')).toBe(true)
      expect(hasPermission('SUPPORT', 'admin.platform', 'platform')).toBe(false)
    })
  })

  // ========================================================================
  // 2. workspaceWhere — always includes workspaceId
  // ========================================================================
  describe('workspaceWhere — query scoping', () => {
    test('workspaceWhere always includes workspaceId', () => {
      const where = workspaceWhere('ws-123')
      expect(where.workspaceId).toBe('ws-123')
    })

    test('workspaceWhere merges extra filters', () => {
      const where = workspaceWhere('ws-123', { status: 'ACTIVE' } as never)
      expect(where.workspaceId).toBe('ws-123')
      expect(where.status).toBe('ACTIVE')
    })

    test('workspaceWhere with empty extras returns only workspaceId', () => {
      const where = workspaceWhere('ws-123')
      expect(Object.keys(where).length).toBe(1)
      expect(Object.keys(where)).toContain('workspaceId')
    })
  })

  // ========================================================================
  // 3. assertWorkspaceOwned — cross-workspace resource access blocked
  // ========================================================================
  describe('assertWorkspaceOwned — resource ownership verification', () => {
    test('allows access when resource belongs to correct workspace', async () => {
      await expect(assertWorkspaceOwned('project', project1.id, ws1.id)).resolves.toBe(true)
      await expect(assertWorkspaceOwned('project', project2.id, ws2.id)).resolves.toBe(true)
    })

    test('blocks access when resource belongs to different workspace', async () => {
      await expect(assertWorkspaceOwned('project', project1.id, ws2.id)).rejects.toThrow(NotFoundError)
      await expect(assertWorkspaceOwned('project', project2.id, ws1.id)).rejects.toThrow(NotFoundError)
    })

    test('blocks access for non-existent resource', async () => {
      await expect(assertWorkspaceOwned('project', 'non-existent-id', ws1.id)).rejects.toThrow(NotFoundError)
    })

    test('blocks access for run resources across workspaces', async () => {
      await expect(assertWorkspaceOwned('scanRun', run1.id, ws2.id)).rejects.toThrow(NotFoundError)
      await expect(assertWorkspaceOwned('scanRun', run2.id, ws1.id)).rejects.toThrow(NotFoundError)
    })

    test('blocks access for finding resources across workspaces', async () => {
      await expect(assertWorkspaceOwned('finding', finding1.id, ws2.id)).rejects.toThrow(NotFoundError)
      await expect(assertWorkspaceOwned('finding', finding2.id, ws1.id)).rejects.toThrow(NotFoundError)
    })

    test('blocks access for report resources across workspaces', async () => {
      await expect(assertWorkspaceOwned('report', report1.id, ws2.id)).rejects.toThrow(NotFoundError)
      await expect(assertWorkspaceOwned('report', report2.id, ws1.id)).rejects.toThrow(NotFoundError)
    })

    // Note: Journey model does not have a direct workspaceId field (accessed via project),
    // so assertWorkspaceOwned with 'journey' model is tested via project ownership.
  })

  // ========================================================================
  // 4. Service-layer workspace isolation
  // ========================================================================
  describe('Workspace service — membership isolation', () => {
    test('listWorkspacesForUser returns only workspaces the user belongs to', async () => {
      const ws1List = await listWorkspacesForUser(user1Owner.id)
      const ws2List = await listWorkspacesForUser(user2Owner.id)

      // WS1 owner should see ws1 but not ws2
      expect(ws1List.some((w) => w.id === ws1.id)).toBe(true)
      expect(ws1List.some((w) => w.id === ws2.id)).toBe(false)

      // WS2 owner should see ws2 but not ws1
      expect(ws2List.some((w) => w.id === ws2.id)).toBe(true)
      expect(ws2List.some((w) => w.id === ws1.id)).toBe(false)
    })

    test('user with membership in both workspaces sees both', async () => {
      // Add user1Member to ws2 temporarily
      await db.workspaceMember.create({
        data: { workspaceId: ws2.id, userId: user1Member.id, role: 'MEMBER' },
      })

      try {
        const list = await listWorkspacesForUser(user1Member.id)
        expect(list.some((w) => w.id === ws1.id)).toBe(true)
        expect(list.some((w) => w.id === ws2.id)).toBe(true)
      } finally {
        // Always clean up the temporary membership
        const m = await db.workspaceMember.findFirst({
          where: { workspaceId: ws2.id, userId: user1Member.id },
        })
        if (m) {
          await db.workspaceMember.delete({ where: { id: m.id } })
        }
      }
    })

    test('removed member sees no workspaces', async () => {
      const list = await listWorkspacesForUser(removedUser.id)
      expect(list).toHaveLength(0)
    })

    test('getWorkspace succeeds for workspace member', async () => {
      const ws = await getWorkspace(ws1.id, user1Owner.id)
      expect(ws.id).toBe(ws1.id)
    })

    test('getWorkspace rejects non-member (throws NotFoundError)', async () => {
      await expect(getWorkspace(ws1.id, user2Owner.id)).rejects.toThrow(NotFoundError)
      await expect(getWorkspace(ws2.id, user1Owner.id)).rejects.toThrow(NotFoundError)
    })

    test('getWorkspace rejects removed member', async () => {
      await expect(getWorkspace(ws1.id, removedUser.id)).rejects.toThrow(NotFoundError)
    })

    test('user not in any workspace cannot access either', async () => {
      const stranger = await db.user.create({
        data: {
          email: 'stranger@test.local', emailLower: 'stranger@test.local',
          name: 'Stranger', passwordHash: await hashPassword('Stranger123!'),
          status: 'ACTIVE', platformRole: 'USER',
        },
      })
      await expect(getWorkspace(ws1.id, stranger.id)).rejects.toThrow(NotFoundError)
      await expect(getWorkspace(ws2.id, stranger.id)).rejects.toThrow(NotFoundError)
      await db.user.delete({ where: { id: stranger.id } })
    })
  })

  // ========================================================================
  // 5. Project service isolation
  // ========================================================================
  describe('Project service — workspace scoping', () => {
    test('listProjects returns only projects in the user\'s workspace', async () => {
      // user1Owner can list ws1 projects
      const ws1Projects = await listProjects(ws1.id, user1Owner.id)
      expect(ws1Projects.some((p) => p.id === project1.id)).toBe(true)
      expect(ws1Projects.some((p) => p.id === project2.id)).toBe(false)

      // user2Owner can list ws2 projects
      const ws2Projects = await listProjects(ws2.id, user2Owner.id)
      expect(ws2Projects.some((p) => p.id === project2.id)).toBe(true)
      expect(ws2Projects.some((p) => p.id === project1.id)).toBe(false)
    })

    test('listProjects rejects non-member', async () => {
      await expect(listProjects(ws1.id, user2Owner.id)).rejects.toThrow(NotFoundError)
      await expect(listProjects(ws2.id, user1Owner.id)).rejects.toThrow(NotFoundError)
    })

    test('getProject succeeds for project in user\'s workspace', async () => {
      const p = await getProject(project1.id, user1Owner.id)
      expect(p.id).toBe(project1.id)
    })

    test('getProject rejects when project belongs to different workspace', async () => {
      // user2Owner tries to access ws1's project
      await expect(getProject(project1.id, user2Owner.id)).rejects.toThrow(NotFoundError)
      // user1Owner tries to access ws2's project
      await expect(getProject(project2.id, user1Owner.id)).rejects.toThrow(NotFoundError)
    })

    test('CLIENT role can read projects in their workspace', async () => {
      // user1Client is CLIENT in ws1 — should be able to read ws1 projects
      await expect(getProject(project1.id, user1Client.id)).resolves.toBeDefined()
    })

    test('VIEWER role can read projects in their workspace', async () => {
      // user1Viewer is VIEWER in ws1 — should be able to read ws1 projects
      await expect(getProject(project1.id, user1Viewer.id)).resolves.toBeDefined()
    })

    test('CLIENT cannot create projects (permission check in service)', async () => {
      await expect(
        createProject(
          ws1.id,
          { name: 'Test', productionUrl: 'http://localhost:3000/test' },
          user1Client.id,
          'CLIENT',
          { ip: '127.0.0.1', userAgent: 'test', requestId: 'test' },
        ),
      ).rejects.toThrow(ForbiddenError)
    })

    test('VIEWER cannot create projects (permission check in service)', async () => {
      await expect(
        createProject(
          ws1.id,
          { name: 'Test', productionUrl: 'http://localhost:3000/test' },
          user1Viewer.id,
          'VIEWER',
          { ip: '127.0.0.1', userAgent: 'test', requestId: 'test' },
        ),
      ).rejects.toThrow(ForbiddenError)
    })

    test('MEMBER cannot delete projects (service checks workspace ownership)', async () => {
      await expect(
        deleteProject(project1.id, user1Member.id, {
          ip: '127.0.0.1', userAgent: 'test', requestId: 'test',
        }),
      ).rejects.toThrow()
    })
  })

  // ========================================================================
  // 6. Run service isolation
  // ========================================================================
  describe('Run service — workspace scoping', () => {
    test('getRun returns run for workspace member', async () => {
      const run = await getRun(run1.id, user1Owner.id)
      expect(run.id).toBe(run1.id)
    })

    test('getRun rejects when run belongs to different workspace', async () => {
      // user2Owner tries to access ws1's run
      await expect(getRun(run1.id, user2Owner.id)).rejects.toThrow(NotFoundError)
      // user1Owner tries to access ws2's run
      await expect(getRun(run2.id, user1Owner.id)).rejects.toThrow(NotFoundError)
    })

    test('cancelRun rejects non-member trying to cancel', async () => {
      // user2Owner tries to cancel ws1's run
      await expect(
        cancelRun(run1.id, user2Owner.id, {
          ip: '127.0.0.1', userAgent: 'test', requestId: 'test',
        }),
      ).rejects.toThrow()
    })

    test('CLIENT cannot cancel runs (permission check)', async () => {
      // Create a QUEUED run for this test
      const queuedRun = await db.scanRun.create({
        data: {
          workspaceId: ws1.id, projectId: project1.id,
          status: 'QUEUED', trigger: 'MANUAL', runMode: 'PASSIVE',
          configSnapshot: '{}',
        },
      })
      await expect(
        cancelRun(queuedRun.id, user1Client.id, {
          ip: '127.0.0.1', userAgent: 'test', requestId: 'test',
        }),
      ).rejects.toThrow()
      await db.scanRun.delete({ where: { id: queuedRun.id } })
    })
  })

  // ========================================================================
  // 7. Direct database query isolation
  // ========================================================================
  describe('Direct DB queries — workspace scoping verification', () => {
    test('findings in ws1 are not visible in ws2 queries', async () => {
      const ws1Findings = await db.finding.findMany({ where: { workspaceId: ws1.id } })
      const ws2Findings = await db.finding.findMany({ where: { workspaceId: ws2.id } })

      expect(ws1Findings.some((f) => f.id === finding1.id)).toBe(true)
      expect(ws1Findings.some((f) => f.id === finding2.id)).toBe(false)

      expect(ws2Findings.some((f) => f.id === finding2.id)).toBe(true)
      expect(ws2Findings.some((f) => f.id === finding1.id)).toBe(false)
    })

    test('runs in ws1 are not visible in ws2 queries', async () => {
      const ws1Runs = await db.scanRun.findMany({ where: { workspaceId: ws1.id } })
      const ws2Runs = await db.scanRun.findMany({ where: { workspaceId: ws2.id } })

      expect(ws1Runs.some((r) => r.id === run1.id)).toBe(true)
      expect(ws1Runs.some((r) => r.id === run2.id)).toBe(false)

      expect(ws2Runs.some((r) => r.id === run2.id)).toBe(true)
      expect(ws2Runs.some((r) => r.id === run1.id)).toBe(false)
    })

    test('reports in ws1 are not visible in ws2 queries', async () => {
      const ws1Reports = await db.report.findMany({ where: { workspaceId: ws1.id } })
      const ws2Reports = await db.report.findMany({ where: { workspaceId: ws2.id } })

      expect(ws1Reports.some((r) => r.id === report1.id)).toBe(true)
      expect(ws1Reports.some((r) => r.id === report2.id)).toBe(false)

      expect(ws2Reports.some((r) => r.id === report2.id)).toBe(true)
      expect(ws2Reports.some((r) => r.id === report1.id)).toBe(false)
    })

    test('journeys in ws1 are not visible in ws2 queries (scoped via project)', async () => {
      const ws1Journeys = await db.journey.findMany({
        where: { projectId: project1.id },
      })
      const ws2Journeys = await db.journey.findMany({
        where: { projectId: project2.id },
      })

      expect(ws1Journeys.some((j) => j.id === journey1.id)).toBe(true)
      expect(ws1Journeys.some((j) => j.id === journey2.id)).toBe(false)

      expect(ws2Journeys.some((j) => j.id === journey2.id)).toBe(true)
      expect(ws2Journeys.some((j) => j.id === journey1.id)).toBe(false)
    })

    test('projects in ws1 are not visible in ws2 queries', async () => {
      const ws1Projects = await db.project.findMany({ where: { workspaceId: ws1.id } })
      const ws2Projects = await db.project.findMany({ where: { workspaceId: ws2.id } })

      expect(ws1Projects.some((p) => p.id === project1.id)).toBe(true)
      expect(ws1Projects.some((p) => p.id === project2.id)).toBe(false)

      expect(ws2Projects.some((p) => p.id === project2.id)).toBe(true)
      expect(ws2Projects.some((p) => p.id === project1.id)).toBe(false)
    })

    test('workspaceWhere prevents unscoped queries', async () => {
      // Without workspaceWhere, a query could return all projects
      const allProjects = await db.project.findMany()
      expect(allProjects.length).toBeGreaterThanOrEqual(2)

      // With workspaceWhere, only ws1 projects
      const ws1Only = await db.project.findMany({ where: workspaceWhere(ws1.id) })
      expect(ws1Only.every((p) => p.workspaceId === ws1.id)).toBe(true)

      // With workspaceWhere, only ws2 projects
      const ws2Only = await db.project.findMany({ where: workspaceWhere(ws2.id) })
      expect(ws2Only.every((p) => p.workspaceId === ws2.id)).toBe(true)

      // No overlap
      expect(ws1Only.some((p) => p.id === project2.id)).toBe(false)
      expect(ws2Only.some((p) => p.id === project1.id)).toBe(false)
    })

    test('findings with workspaceWhere + extra filters are scoped', async () => {
      const majorFindings = await db.finding.findMany({
        where: workspaceWhere(ws1.id, { severity: 'MAJOR' } as never),
      })
      expect(majorFindings.every((f) => f.workspaceId === ws1.id && f.severity === 'MAJOR')).toBe(true)
    })
  })

  // ========================================================================
  // 8. Workspace membership edge cases
  // ========================================================================
  describe('Workspace membership edge cases', () => {
    test('removing a member then querying workspace returns NotFoundError', async () => {
      // Create a fresh user and add to ws1
      const tempUser = await db.user.create({
        data: {
          email: 'temp-member@test.local', emailLower: 'temp-member@test.local',
          name: 'Temp Member', passwordHash: await hashPassword('TempPass123!'),
          status: 'ACTIVE', platformRole: 'USER',
        },
      })
      await db.workspaceMember.create({
        data: { workspaceId: ws1.id, userId: tempUser.id, role: 'MEMBER' },
      })

      // Should work initially
      await expect(getWorkspace(ws1.id, tempUser.id)).resolves.toBeDefined()

      // Remove the member
      await db.workspaceMember.update({
        where: { workspaceId_userId: { workspaceId: ws1.id, userId: tempUser.id } },
        data: { removedAt: new Date() },
      })

      // Should now fail
      await expect(getWorkspace(ws1.id, tempUser.id)).rejects.toThrow(NotFoundError)

      // Clean up
      await db.user.delete({ where: { id: tempUser.id } })
    })

    test('re-adding a removed member restores access', async () => {
      // removedUser was removed from ws1 — try re-adding
      await db.workspaceMember.update({
        where: { workspaceId_userId: { workspaceId: ws1.id, userId: removedUser.id } },
        data: { removedAt: null, role: 'MEMBER' },
      })

      // Should now work
      await expect(getWorkspace(ws1.id, removedUser.id)).resolves.toBeDefined()

      // Re-remove for other tests
      await db.workspaceMember.update({
        where: { workspaceId_userId: { workspaceId: ws1.id, userId: removedUser.id } },
        data: { removedAt: new Date() },
      })
    })

    test('member of ws2 cannot access ws1 project through getProject', async () => {
      // user2Member is only in ws2
      await expect(getProject(project1.id, user2Member.id)).rejects.toThrow(NotFoundError)
    })

    test('member of ws1 cannot access ws2 project through getProject', async () => {
      // user1Member is only in ws1
      await expect(getProject(project2.id, user1Member.id)).rejects.toThrow(NotFoundError)
    })
  })

  // ========================================================================
  // 9. Cross-workspace data count isolation
  // ========================================================================
  describe('Cross-workspace data count isolation', () => {
    test('total findings count is correct per workspace', async () => {
      const ws1Count = await db.finding.count({ where: { workspaceId: ws1.id } })
      const ws2Count = await db.finding.count({ where: { workspaceId: ws2.id } })

      expect(ws1Count).toBeGreaterThanOrEqual(1)
      expect(ws2Count).toBeGreaterThanOrEqual(1)

      // Each workspace's count should not include the other's findings
      const ws1FindingIds = (await db.finding.findMany({ where: { workspaceId: ws1.id }, select: { id: true } })).map((f) => f.id)
      const ws2FindingIds = (await db.finding.findMany({ where: { workspaceId: ws2.id }, select: { id: true } })).map((f) => f.id)

      // No intersection
      const intersection = ws1FindingIds.filter((id) => ws2FindingIds.includes(id))
      expect(intersection).toHaveLength(0)
    })

    test('total runs count is correct per workspace', async () => {
      const ws1Count = await db.scanRun.count({ where: { workspaceId: ws1.id } })
      const ws2Count = await db.scanRun.count({ where: { workspaceId: ws2.id } })

      expect(ws1Count).toBeGreaterThanOrEqual(1)
      expect(ws2Count).toBeGreaterThanOrEqual(1)

      const ws1RunIds = (await db.scanRun.findMany({ where: { workspaceId: ws1.id }, select: { id: true } })).map((r) => r.id)
      const ws2RunIds = (await db.scanRun.findMany({ where: { workspaceId: ws2.id }, select: { id: true } })).map((r) => r.id)

      const intersection = ws1RunIds.filter((id) => ws2RunIds.includes(id))
      expect(intersection).toHaveLength(0)
    })
  })

  // ========================================================================
  // 10. Membership lookup isolation
  // ========================================================================
  describe('Membership lookup isolation', () => {
    test('workspace membership lookup is scoped to userId + workspaceId', async () => {
      // user1Owner in ws1
      const member1 = await db.workspaceMember.findUnique({
        where: { workspaceId_userId: { workspaceId: ws1.id, userId: user1Owner.id } },
      })
      expect(member1).not.toBeNull()
      expect(member1!.role).toBe('OWNER')

      // user1Owner NOT in ws2
      const member2 = await db.workspaceMember.findUnique({
        where: { workspaceId_userId: { workspaceId: ws2.id, userId: user1Owner.id } },
      })
      expect(member2).toBeNull()
    })

    test('removed membership is excluded from active queries', async () => {
      // removedUser's membership exists but has removedAt set
      const removedMembership = await db.workspaceMember.findUnique({
        where: { workspaceId_userId: { workspaceId: ws1.id, userId: removedUser.id } },
      })
      expect(removedMembership).not.toBeNull()
      expect(removedMembership!.removedAt).not.toBeNull()

      // Active-only query should not return removed member
      const activeMembers = await db.workspaceMember.findMany({
        where: { workspaceId: ws1.id, removedAt: null },
      })
      expect(activeMembers.some((m) => m.userId === removedUser.id)).toBe(false)
    })
  })

  // ========================================================================
  // 11. Consistency — all resources have correct workspaceId
  // ========================================================================
  describe('Data consistency — workspaceId integrity', () => {
    test('all findings have correct workspaceId matching their project', async () => {
      const allFindings = await db.finding.findMany({
        include: { project: { select: { workspaceId: true } } },
      })
      for (const f of allFindings) {
        expect(f.workspaceId).toBe(f.project.workspaceId)
      }
    })

    test('all runs have correct workspaceId matching their project', async () => {
      const allRuns = await db.scanRun.findMany({
        include: { project: { select: { workspaceId: true } } },
      })
      for (const r of allRuns) {
        expect(r.workspaceId).toBe(r.project.workspaceId)
      }
    })

    test('all reports have correct workspaceId matching their project', async () => {
      const allReports = await db.report.findMany({
        include: { project: { select: { workspaceId: true } } },
      })
      for (const r of allReports) {
        expect(r.workspaceId).toBe(r.project.workspaceId)
      }
    })

    test('all journeys belong to the correct workspace via their project', async () => {
      const allJourneys = await db.journey.findMany({
        include: { project: { select: { workspaceId: true } } },
      })
      for (const j of allJourneys) {
        // journey1 should belong to ws1 project, journey2 to ws2 project
        if (j.id === journey1.id) {
          expect(j.project.workspaceId).toBe(ws1.id)
        } else if (j.id === journey2.id) {
          expect(j.project.workspaceId).toBe(ws2.id)
        }
      }
    })
  })
})
