/**
 * Seed system — ProofPilot
 *
 * Creates safe development seed data:
 *  - One platform admin
 *  - One agency owner
 *  - One agency workspace (FREE plan)
 *  - One client member
 *  - One demo project pointing at the local demo-target
 *  - One local demo environment
 *  - Plans (FREE / STARTER / PRO / AGENCY)
 *  - Feature flags
 *
 * Never uses production-like secrets. Prints dev credentials.
 */
import { db } from './db'
import { hashPassword, randomToken, hashToken, encryptToJson } from './crypto'
import { logger } from './logger'

async function seedPlans() {
  const plans = [
    { code: 'FREE', name: 'Free', priceMonthly: 0, maxProjects: 1, maxRunsPerMonth: 2, maxPagesPerRun: 5, browsers: 'chromium', scheduling: false, whiteLabel: false, aiEnrichment: false, journeys: false, visualBaselines: false, teamMembers: 1, retentionDays: 7, priorityQueue: false },
    { code: 'STARTER', name: 'Starter', priceMonthly: 1900, maxProjects: 3, maxRunsPerMonth: 30, maxPagesPerRun: 50, browsers: 'chromium', scheduling: true, whiteLabel: false, aiEnrichment: false, journeys: false, visualBaselines: false, teamMembers: 2, retentionDays: 30, priorityQueue: false },
    { code: 'PRO', name: 'Pro', priceMonthly: 4900, maxProjects: 10, maxRunsPerMonth: 150, maxPagesPerRun: 150, browsers: 'chromium', scheduling: true, whiteLabel: false, aiEnrichment: true, journeys: true, visualBaselines: true, teamMembers: 5, retentionDays: 60, priorityQueue: false },
    { code: 'AGENCY', name: 'Agency', priceMonthly: 14900, maxProjects: 50, maxRunsPerMonth: 500, maxPagesPerRun: 250, browsers: 'chromium,firefox,webkit', scheduling: true, whiteLabel: true, aiEnrichment: true, journeys: true, visualBaselines: true, teamMembers: 25, retentionDays: 180, priorityQueue: true },
  ]
  for (const p of plans) {
    await db.plan.upsert({
      where: { code: p.code },
      create: p,
      update: p,
    })
  }
  logger.info('Seeded plans', { count: plans.length })
}

async function seedFeatureFlags() {
  const flags = [
    { key: 'ai_enrichment', description: 'AI enrichment of findings', enabled: true },
    { key: 'public_scans', description: 'Public audit mode', enabled: true },
    { key: 'firefox_scanning', description: 'Firefox browser profile', enabled: false },
    { key: 'webkit_scanning', description: 'WebKit browser profile', enabled: false },
    { key: 'visual_regression', description: 'Visual baseline comparison', enabled: true },
    { key: 'agency_branding', description: 'White-label reports', enabled: true },
    { key: 'experimental_integrations', description: 'Experimental integration adapters', enabled: false },
  ]
  for (const f of flags) {
    await db.featureFlag.upsert({
      where: { key: f.key },
      create: f,
      update: f,
    })
  }
  logger.info('Seeded feature flags', { count: flags.length })
}

async function seedUsers() {
  // Platform admin
  const adminPassword = 'ProofPilot-Admin-2025!'
  const admin = await db.user.upsert({
    where: { emailLower: 'admin@proofpilot.local' },
    create: {
      email: 'admin@proofpilot.local',
      emailLower: 'admin@proofpilot.local',
      name: 'Platform Admin',
      passwordHash: await hashPassword(adminPassword),
      status: 'ACTIVE',
      platformRole: 'PLATFORM_ADMIN',
    },
    update: {
      passwordHash: await hashPassword(adminPassword),
      platformRole: 'PLATFORM_ADMIN',
      status: 'ACTIVE',
    },
  })

  // Agency owner
  const ownerPassword = 'ProofPilot-Owner-2025!'
  const owner = await db.user.upsert({
    where: { emailLower: 'owner@proofpilot.local' },
    create: {
      email: 'owner@proofpilot.local',
      emailLower: 'owner@proofpilot.local',
      name: 'Agency Owner',
      passwordHash: await hashPassword(ownerPassword),
      status: 'ACTIVE',
      platformRole: 'USER',
    },
    update: {
      passwordHash: await hashPassword(ownerPassword),
      status: 'ACTIVE',
    },
  })

  // Client member
  const clientPassword = 'ProofPilot-Client-2025!'
  const client = await db.user.upsert({
    where: { emailLower: 'client@proofpilot.local' },
    create: {
      email: 'client@proofpilot.local',
      emailLower: 'client@proofpilot.local',
      name: 'Client Reviewer',
      passwordHash: await hashPassword(clientPassword),
      status: 'ACTIVE',
      platformRole: 'USER',
    },
    update: {
      passwordHash: await hashPassword(clientPassword),
      status: 'ACTIVE',
    },
  })

  return { admin, owner, client, adminPassword, ownerPassword, clientPassword }
}

async function seedWorkspace(ownerId: string, clientUserId: string) {
  const freePlan = await db.plan.findUniqueOrThrow({ where: { code: 'FREE' } })
  const proPlan = await db.plan.findUniqueOrThrow({ where: { code: 'PRO' } })

  // Upgrade the demo workspace to PRO so all features are available in dev
  const workspace = await db.workspace.upsert({
    where: { slug: 'demo-agency' },
    create: {
      name: 'Demo Agency',
      slug: 'demo-agency',
      ownerId,
      planId: proPlan.id,
      retentionDays: 60,
    },
    update: {
      ownerId,
      planId: proPlan.id,
    },
  })

  await db.workspaceMember.upsert({
    where: { workspaceId_userId: { workspaceId: workspace.id, userId: ownerId } },
    create: { workspaceId: workspace.id, userId: ownerId, role: 'OWNER' },
    update: { role: 'OWNER', removedAt: null },
  })

  await db.workspaceMember.upsert({
    where: { workspaceId_userId: { workspaceId: workspace.id, userId: clientUserId } },
    create: { workspaceId: workspace.id, userId: clientUserId, role: 'CLIENT' },
    update: { role: 'CLIENT', removedAt: null },
  })

  // Seed a subscription (TRIALING)
  const existingSub = await db.subscription.findFirst({
    where: { workspaceId: workspace.id },
  })
  if (!existingSub) {
    await db.subscription.create({
      data: {
        workspaceId: workspace.id,
        planId: proPlan.id,
        status: 'TRIALING',
        stripeCustomerId: 'demo_cust_' + workspace.id.slice(-6),
        stripeSubscriptionId: 'demo_sub_' + workspace.id.slice(-6),
        currentPeriodStart: new Date(),
        currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        trialEndsAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
      },
    })
  }

  return workspace
}

async function seedDemoProject(workspaceId: string, ownerId: string) {
  const existing = await db.project.findFirst({
    where: { workspaceId, name: 'Demo Target Project' },
  })
  if (existing) return existing

  const project = await db.project.create({
    data: {
      workspaceId,
      name: 'Demo Target Project',
      description: 'Internal demo project pointing at the local demo target app.',
      productionUrl: 'http://localhost:3000/demo-target',
      productType: 'web_app',
      primaryLocale: 'en',
      supportedLocales: 'en,fa,ar,he',
      defaultTimezone: 'UTC',
      status: 'ACTIVE',
      createdById: ownerId,
    },
  })

  await db.projectEnvironment.create({
    data: {
      projectId: project.id,
      type: 'DEVELOPMENT',
      baseUrl: 'http://localhost:3000/demo-target',
      allowedHostnames: 'localhost',
      scanMode: 'PASSIVE',
      enabled: true,
    },
  })

  // Pre-verify localhost domain for the demo project (local dev only)
  await db.verifiedDomain.create({
    data: {
      projectId: project.id,
      domain: 'localhost',
      domainNormalized: 'localhost',
      verificationMethod: 'HTML_META',
      verificationStatus: 'VERIFIED',
      verifiedAt: new Date(),
      lastRevalidatedAt: new Date(),
      allowedSubdomains: false,
      initiatedById: ownerId,
    },
  })

  return project
}

async function seedDemoSecrets(workspaceId: string) {
  // Show the envelope-encryption interface works
  const integration = await db.integration.create({
    data: {
      workspaceId,
      type: 'GENERIC_WEBHOOK',
      name: 'Demo Webhook (dev)',
      config: JSON.stringify({ url: 'https://example.com/webhook' }),
      enabled: true,
    },
  })

  await db.integrationSecret.create({
    data: {
      integrationId: integration.id,
      key: 'signing_secret',
      valueEncrypted: encryptToJson('demo-signing-secret-do-not-use-in-prod'),
    },
  })
}

export async function runSeed(): Promise<void> {
  logger.info('Starting seed...')
  await seedPlans()
  await seedFeatureFlags()
  const { admin, owner, client, adminPassword, ownerPassword, clientPassword } = await seedUsers()
  const workspace = await seedWorkspace(owner.id, client.id)
  await seedDemoProject(workspace.id, owner.id)
  await seedDemoSecrets(workspace.id)

  logger.info('Seed complete.', {
    admin: { email: admin.email, password: adminPassword },
    owner: { email: owner.email, password: ownerPassword },
    client: { email: client.email, password: clientPassword },
    workspace: { slug: workspace.slug },
  })
  console.log('\n=== ProofPilot Dev Credentials (NEVER use in production) ===')
  console.log(`Admin:   ${admin.email} / ${adminPassword}`)
  console.log(`Owner:   ${owner.email} / ${ownerPassword}`)
  console.log(`Client:  ${client.email} / ${clientPassword}`)
  console.log('===========================================================\n')
}

// Allow direct execution: `bun run src/lib/seed.ts`
if (require.main === module) {
  runSeed()
    .then(() => process.exit(0))
    .catch((err) => {
      logger.error('Seed failed', { error: String(err) })
      process.exit(1)
    })
}
