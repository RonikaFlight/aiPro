/**
 * Phase 5 verification — runs a real scan on the demo-target and verifies
 * that the analyzers produce findings across multiple categories.
 *
 * Usage: bun run scripts/test-phase5.ts
 */
import { db } from '../src/lib/db'
import { createRun } from '../src/lib/run-service'
import { listScanEvents } from '../src/lib/scan-events'

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms))
}

async function main() {
  console.log('=== Phase 5 Analyzer Verification ===\n')

  // 1. Look up the demo owner + workspace + project + environment
  const owner = await db.user.findUnique({ where: { email: 'owner@proofpilot.local' } })
  if (!owner) {
    console.error('Owner user not found. Run `bun run seed` first.')
    process.exit(1)
  }
  const membership = await db.workspaceMember.findFirst({ where: { userId: owner.id, role: 'OWNER' } })
  if (!membership) {
    console.error('Owner membership not found.')
    process.exit(1)
  }
  const workspace = await db.workspace.findUnique({ where: { id: membership.workspaceId } })
  if (!workspace) {
    console.error('Workspace not found.')
    process.exit(1)
  }
  console.log(`Workspace: ${workspace.name} (${workspace.id})`)

  const project = await db.project.findFirst({ where: { workspaceId: workspace.id, status: 'ACTIVE' } })
  if (!project) {
    console.error('Demo project not found.')
    process.exit(1)
  }
  console.log(`Project: ${project.name} (${project.id})`)

  const environment = await db.projectEnvironment.findFirst({ where: { projectId: project.id, enabled: true } })
  if (!environment) {
    console.error('Demo environment not found.')
    process.exit(1)
  }
  console.log(`Environment: ${environment.name} (${environment.id}) — baseUrl=${environment.baseUrl}, scanMode=${environment.scanMode}\n`)

  // 2. Create a scan run targeting the demo-target
  console.log('Creating scan run...')
  const created = await createRun(
    {
      projectId: project.id,
      environmentId: environment.id,
      targetUrl: environment.baseUrl,
      runMode: 'PASSIVE',
      trigger: 'MANUAL',
      config: {
        maxPages: 5,
        maxDepth: 2,
        timeoutMs: 30000,
        viewports: ['desktop:1366x768'],
        locales: ['en'],
        browsers: ['chromium'],
      },
    },
    owner.id,
    'OWNER',
    { ip: '127.0.0.1', userAgent: 'test-phase5', requestId: 'test-phase5' },
  )

  console.log(`Run created: ${created.runId} (status=${created.status})`)
  console.log(`Target: ${environment.baseUrl}\n`)

  // 3. Poll for orchestrator completion
  console.log('Waiting for scan orchestrator to complete...')
  let attempts = 0
  const maxAttempts = 60
  let runStatus = created.status
  while (runStatus !== 'COMPLETED' && runStatus !== 'FAILED' && runStatus !== 'CANCELLED' && attempts < maxAttempts) {
    await sleep(3000)
    const updated = await db.scanRun.findUnique({
      where: { id: created.runId },
      select: { status: true, pagesDiscovered: true, pagesAnalyzed: true, findingsCount: true, failedReason: true },
    })
    if (!updated) break
    runStatus = updated.status
    attempts++
    console.log(`  [${attempts}/${maxAttempts}] status=${updated.status} pages=${updated.pagesDiscovered}/${updated.pagesAnalyzed} findings=${updated.findingsCount}`)
  }

  if (runStatus === 'FAILED') {
    const failed = await db.scanRun.findUnique({ where: { id: created.runId }, select: { failedReason: true } })
    console.error(`\nRun FAILED: ${failed?.failedReason}`)
    process.exit(1)
  }

  // 4. Wait for page-analysis jobs to finish (they run async after the orchestrator completes)
  console.log('\nOrchestrator complete. Waiting for page-analysis jobs to finish...')
  for (let i = 0; i < 24; i++) {
    await sleep(5000)
    const updated = await db.scanRun.findUnique({
      where: { id: created.runId },
      select: { pagesAnalyzed: true, findingsCount: true },
    })
    const pendingJobs = await db.queueJob.count({
      where: {
        queue: 'page-analysis',
        status: { in: ['WAITING', 'ACTIVE'] },
        payload: { path: ['runId'], equals: created.runId },
      },
    }).catch(() => 0)
    console.log(`  [${i + 1}/24] pagesAnalyzed=${updated?.pagesAnalyzed} findings=${updated?.findingsCount} pendingJobs=${pendingJobs}`)
    if (updated && updated.pagesAnalyzed > 0 && pendingJobs === 0) {
      console.log('  All page-analysis jobs complete.')
      break
    }
  }

  // 5. Get the final results
  const finalRun = await db.scanRun.findUnique({
    where: { id: created.runId },
    select: {
      id: true, status: true, pagesDiscovered: true, pagesAnalyzed: true,
      findingsCount: true, blockerCount: true, startedAt: true, completedAt: true,
      failedReason: true,
    },
  })
  console.log('\n=== Final Run State ===')
  console.log(JSON.stringify(finalRun, null, 2))

  // 6. Get findings grouped by category + severity
  const findings = await db.finding.findMany({
    where: { runId: created.runId },
    select: { checkId: true, category: true, severity: true, title: true, viewport: true, locale: true },
    orderBy: [{ severity: 'asc' }, { category: 'asc' }],
  })

  console.log(`\n=== Findings (${findings.length} total) ===`)
  const byCategory = new Map<string, number>()
  const bySeverity = new Map<string, number>()
  const byCheck = new Map<string, number>()
  for (const f of findings) {
    byCategory.set(f.category, (byCategory.get(f.category) ?? 0) + 1)
    bySeverity.set(f.severity, (bySeverity.get(f.severity) ?? 0) + 1)
    byCheck.set(f.checkId, (byCheck.get(f.checkId) ?? 0) + 1)
  }
  console.log('\nBy category:')
  for (const [cat, count] of [...byCategory].sort()) {
    console.log(`  ${cat}: ${count}`)
  }
  console.log('\nBy severity:')
  for (const [sev, count] of [...bySeverity].sort()) {
    console.log(`  ${sev}: ${count}`)
  }
  console.log('\nBy check ID:')
  for (const [check, count] of [...byCheck].sort()) {
    console.log(`  ${check}: ${count}`)
  }

  // 7. Verify the demo-target's intentional issues were detected
  console.log('\n=== Demo-target Issue Detection ===')
  const expectedIssues = [
    { checkId: 'http.broken_link', description: 'Broken link (/demo-target/nonexistent-page → 404)' },
    { checkId: 'forms.missing_label', description: 'Unlabeled form inputs' },
    { checkId: 'a11y.unnamed_interactive', description: 'Button with empty aria-label' },
    { checkId: 'responsive.horizontal_overflow', description: 'min-width: 1500px overflow' },
    { checkId: 'runtime.console_error', description: 'Intentional console errors' },
    { checkId: 'seo.missing_canonical', description: 'No canonical link' },
    { checkId: 'seo.missing_og_tags', description: 'No Open Graph tags' },
    { checkId: 'security.missing_header.content-security-policy', description: 'No CSP header' },
  ]
  let detected = 0
  for (const expected of expectedIssues) {
    const found = findings.some((f) => f.checkId === expected.checkId)
    console.log(`  ${found ? '✓' : '✗'} ${expected.checkId} — ${expected.description}`)
    if (found) detected++
  }
  console.log(`\nDetected ${detected}/${expectedIssues.length} expected demo-target issues.`)

  // 8. Get scan events for the timeline
  const events = await listScanEvents(created.runId, 0, 50)
  console.log(`\n=== Scan Events (${events.length} total, showing first 25) ===`)
  for (const e of events.slice(0, 25)) {
    console.log(`  #${e.sequence} ${e.type} ${e.data ? JSON.stringify(e.data).slice(0, 120) : ''}`)
  }

  // 9. Verify ScanPageMetric was written
  const metrics = await db.scanPageMetric.findMany({
    where: { page: { runId: created.runId } },
    include: { page: { select: { url: true } } },
  })
  console.log(`\n=== Page Metrics (${metrics.length} pages) ===`)
  for (const m of metrics) {
    console.log(`  ${m.page.url}: ttfb=${m.ttfb}ms dcl=${m.domContentLoaded}ms lcp=${m.lcp}ms cls=${m.cls} requests=${m.requestCount} bytes=${m.totalBytes}`)
  }

  console.log('\n=== Phase 5 Verification Complete ===')
  await db.$disconnect()
}

main().catch((err) => {
  console.error('Test failed:', err)
  process.exit(1)
})
