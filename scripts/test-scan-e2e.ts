/**
 * Phase 4 end-to-end scan test — ProofPilot
 *
 * Triggers a real scan via run-service, then polls the run status until
 * the worker completes it. Prints the discovered pages + findings.
 */
import { db } from '../src/lib/db'
import { createRun } from '../src/lib/run-service'
import { getRun } from '../src/lib/run-service'
import { listScanEvents } from '../src/lib/scan-events'

async function main() {
  console.log('Phase 4 End-to-End Scan Test')
  console.log('============================')

  const owner = await db.user.findUnique({ where: { email: 'owner@proofpilot.local' } })
  if (!owner) throw new Error('owner not found')
  const membership = await db.workspaceMember.findFirst({ where: { userId: owner.id, role: 'OWNER' } })
  if (!membership) throw new Error('membership not found')
  const project = await db.project.findFirst({ where: { workspaceId: membership.workspaceId, status: 'ACTIVE' } })
  if (!project) throw new Error('project not found')
  const environment = await db.projectEnvironment.findFirst({ where: { projectId: project.id, enabled: true } })
  if (!environment) throw new Error('environment not found')

  console.log(`Triggering scan of ${environment.baseUrl}...`)

  const created = await createRun(
    {
      projectId: project.id,
      environmentId: environment.id,
      targetUrl: environment.baseUrl,
      runMode: 'PASSIVE',
      trigger: 'MANUAL',
      config: { maxPages: 5, maxDepth: 2, timeoutMs: 15000 },
    },
    owner.id,
    'OWNER',
    { ip: '127.0.0.1', userAgent: 'test-e2e', requestId: 'test-e2e' },
  )

  console.log(`Run created: ${created.runId}`)
  console.log(`Status: ${created.status}`)
  console.log(`Estimated: ${created.estimatedSeconds}s`)
  console.log()

  // Poll until terminal
  const startTime = Date.now()
  const maxWaitMs = 120_000 // 2 minutes
  let lastStatus = created.status
  let lastEventSeq = 0

  while (Date.now() - startTime < maxWaitMs) {
    await new Promise((r) => setTimeout(r, 2000))

    const run = await getRun(created.runId, owner.id)
    if (run.status !== lastStatus) {
      console.log(`[${((Date.now() - startTime) / 1000).toFixed(1)}s] status: ${lastStatus} → ${run.status}`)
      lastStatus = run.status
    }

    // Print new events
    const events = await listScanEvents(created.runId, lastEventSeq)
    for (const e of events) {
      console.log(`[${((Date.now() - startTime) / 1000).toFixed(1)}s] event #${e.sequence} ${e.eventType}: ${JSON.stringify(e.payload).slice(0, 120)}`)
      lastEventSeq = e.sequence
    }

    if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(run.status)) {
      console.log()
      console.log('==== Final ====')
      console.log(`Status: ${run.status}`)
      console.log(`Pages discovered: ${run.pagesDiscovered}`)
      console.log(`Pages analyzed: ${run.pagesAnalyzed}`)
      console.log(`Findings: ${run.findingsCount}`)
      console.log(`Blockers: ${run.blockerCount}`)
      console.log(`Failed reason: ${run.failedReason ?? 'none'}`)
      if (run.startedAt) console.log(`Started: ${run.startedAt}`)
      if (run.completedAt) console.log(`Completed: ${run.completedAt}`)

      // List pages
      const pages = await db.scanPage.findMany({ where: { runId: created.runId }, orderBy: { depth: 'asc' } })
      console.log()
      console.log(`Pages (${pages.length}):`)
      for (const p of pages) {
        console.log(`  [depth=${p.depth}] ${p.httpStatus ?? '?'} ${p.title ?? '(no title)'} — ${p.normalizedUrl}`)
      }

      // List findings
      const findings = await db.finding.findMany({ where: { runId: created.runId }, orderBy: { severity: 'asc' } })
      console.log()
      console.log(`Findings (${findings.length}):`)
      for (const f of findings) {
        console.log(`  [${f.severity}] ${f.checkId}: ${f.title} — ${f.affectedUrl}`)
      }

      // List artifacts
      const artifacts = await db.artifact.findMany({ where: { runId: created.runId } })
      console.log()
      console.log(`Artifacts (${artifacts.length}):`)
      for (const a of artifacts) {
        console.log(`  ${a.type} ${a.mimeType} ${a.sizeBytes}b — ${a.storageKey}`)
      }

      break
    }
  }

  if (!['COMPLETED', 'FAILED', 'CANCELLED'].includes(lastStatus)) {
    console.log('TIMEOUT — run did not complete within 2 minutes')
  }

  await db.$disconnect()
}

main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
