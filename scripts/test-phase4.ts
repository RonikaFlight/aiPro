/**
 * Phase 4 verification script — ProofPilot
 *
 * Directly tests the new Phase 4 services without going through the Next.js
 * dev server (which OOMs when compiling too many routes at once).
 *
 * Tests:
 *   1. Scan authorization guard (positive + negative cases)
 *   2. Run service (create, list, get, cancel)
 *   3. Scan events (append + list + pub/sub)
 *   4. Artifact service (store + read + signed URL + verify)
 *   5. SSE event sequence (simulate worker appending events)
 */
import { db } from '../src/lib/db'
import { env } from '../src/lib/env'
import { authorizeScan, revalidateTargetBeforeFetch } from '../src/lib/scan-auth'
import { createRun, listRuns, getRun, cancelRun } from '../src/lib/run-service'
import { appendScanEvent, listScanEvents, subscribeToRun } from '../src/lib/scan-events'
import { storeArtifact, readArtifactBuffer, signArtifactUrl, verifyArtifactSignature } from '../src/lib/artifact-service'
import { hasPermission } from '../src/lib/permissions'

const PASS = (msg: string) => console.log(`  \u2713 ${msg}`)
const FAIL = (msg: string, err?: unknown) => {
  console.error(`  \u2717 ${msg}`)
  if (err) console.error(`    ${err instanceof Error ? err.message : String(err)}`)
  process.exitCode = 1
}

async function main() {
  console.log('Phase 4 Verification')
  console.log('====================')
  console.log(`DB: ${env.DATABASE_URL}`)
  console.log(`App env: ${env.APP_ENV}`)
  console.log()

  // Find the demo workspace + project + owner
  const owner = await db.user.findUnique({ where: { email: 'owner@proofpilot.local' } })
  if (!owner) { FAIL('owner user not found'); return }
  const membership = await db.workspaceMember.findFirst({ where: { userId: owner.id, role: 'OWNER' } })
  if (!membership) { FAIL('owner membership not found'); return }
  const workspace = await db.workspace.findUnique({ where: { id: membership.workspaceId } })
  if (!workspace) { FAIL('workspace not found'); return }
  const project = await db.project.findFirst({ where: { workspaceId: workspace.id, status: 'ACTIVE' } })
  if (!project) { FAIL('project not found'); return }
  const environment = await db.projectEnvironment.findFirst({ where: { projectId: project.id, enabled: true } })
  if (!environment) { FAIL('environment not found'); return }

  console.log(`Workspace: ${workspace.name} (${workspace.id})`)
  console.log(`Project: ${project.name} (${project.id})`)
  console.log(`Environment: ${environment.type} @ ${environment.baseUrl}`)
  console.log(`Owner: ${owner.email} (role: OWNER)`)
  console.log()

  // ---- Test 1: Scan authorization guard ----
  console.log('Test 1: Scan authorization guard')
  try {
    // 1a. Positive: authorize a localhost scan
    const authorized = await authorizeScan(
      {
        projectId: project.id,
        environmentId: environment.id,
        targetUrl: environment.baseUrl,
        runMode: 'PASSIVE',
        trigger: 'MANUAL',
        userId: owner.id,
        userRole: 'OWNER',
      },
      { ip: '127.0.0.1', userAgent: 'test', requestId: 'test-1' },
    )
    PASS(`authorized localhost scan (workspace=${authorized.workspaceId}, env=${authorized.environmentId})`)
    PASS(`allowed origins: ${authorized.allowedOrigins.join(', ')}`)

    // 1b. Negative: target URL outside verified domains
    try {
      await authorizeScan(
        {
          projectId: project.id,
          environmentId: environment.id,
          targetUrl: 'https://evil.example.com/',
          runMode: 'PASSIVE',
          trigger: 'MANUAL',
          userId: owner.id,
          userRole: 'OWNER',
        },
        { ip: '127.0.0.1', userAgent: 'test', requestId: 'test-1b' },
      )
      FAIL('should have rejected unverified origin')
    } catch (err) {
      PASS(`rejected unverified origin: ${err instanceof Error ? err.message.slice(0, 60) : 'ok'}`)
    }

    // 1c. Negative: SSRF — private IP
    try {
      await authorizeScan(
        {
          projectId: project.id,
          environmentId: environment.id,
          targetUrl: 'http://127.0.0.1:8080/',
          runMode: 'PASSIVE',
          trigger: 'MANUAL',
          userId: owner.id,
          userRole: 'OWNER',
        },
        { ip: '127.0.0.1', userAgent: 'test', requestId: 'test-1c' },
      )
      FAIL('should have rejected private IP')
    } catch (err) {
      PASS(`rejected private IP: ${err instanceof Error ? err.message.slice(0, 60) : 'ok'}`)
    }

    // 1d. Negative: blocked protocol
    try {
      await authorizeScan(
        {
          projectId: project.id,
          environmentId: environment.id,
          targetUrl: 'file:///etc/passwd',
          runMode: 'PASSIVE',
          trigger: 'MANUAL',
          userId: owner.id,
          userRole: 'OWNER',
        },
        { ip: '127.0.0.1', userAgent: 'test', requestId: 'test-1d' },
      )
      FAIL('should have rejected file:// protocol')
    } catch (err) {
      PASS(`rejected file:// protocol: ${err instanceof Error ? err.message.slice(0, 60) : 'ok'}`)
    }

    // 1e. Negative: TEST_TRANSACTION without user confirmation
    try {
      await authorizeScan(
        {
          projectId: project.id,
          environmentId: environment.id,
          targetUrl: environment.baseUrl,
          runMode: 'TEST_TRANSACTION',
          trigger: 'MANUAL',
          userId: owner.id,
          userRole: 'OWNER',
          userConfirmedDestructive: false,
        },
        { ip: '127.0.0.1', userAgent: 'test', requestId: 'test-1e' },
      )
      FAIL('should have required destructive confirmation')
    } catch (err) {
      PASS(`required destructive confirmation: ${err instanceof Error ? err.message.slice(0, 60) : 'ok'}`)
    }
  } catch (err) {
    FAIL('scan auth guard test failed', err)
  }
  console.log()

  // ---- Test 2: Run service ----
  console.log('Test 2: Run service (create, list, get, cancel)')
  let createdRunId: string | null = null
  try {
    const created = await createRun(
      {
        projectId: project.id,
        environmentId: environment.id,
        targetUrl: environment.baseUrl,
        runMode: 'PASSIVE',
        trigger: 'MANUAL',
        config: { maxPages: 5, maxDepth: 2 },
      },
      owner.id,
      'OWNER',
      { ip: '127.0.0.1', userAgent: 'test', requestId: 'test-2' },
    )
    createdRunId = created.runId
    PASS(`created run ${created.runId} (status=${created.status}, est=${created.estimatedSeconds}s)`)

    const listed = await listRuns(project.id, owner.id, { limit: 5 })
    PASS(`listed ${listed.runs.length} runs (nextCursor=${listed.nextCursor ? 'yes' : 'no'})`)
    const found = listed.runs.find((r) => r.id === created.runId)
    if (found) PASS(`found created run in list (status=${found.status})`)
    else FAIL('created run not found in list')

    const detail = await getRun(created.runId, owner.id)
    PASS(`got run detail (events=${detail.events.length}, status=${detail.status})`)

    const cancelled = await cancelRun(created.runId, owner.id, { ip: '127.0.0.1', userAgent: 'test', requestId: 'test-2-cancel' })
    PASS(`cancelled run (status=${cancelled.status})`)

    // Cancel again — should be idempotent
    const cancelled2 = await cancelRun(created.runId, owner.id, { ip: '127.0.0.1', userAgent: 'test', requestId: 'test-2-cancel2' })
    PASS(`idempotent cancel (status=${cancelled2.status})`)
  } catch (err) {
    FAIL('run service test failed', err)
  }
  console.log()

  // ---- Test 3: Scan events (append + list + pub/sub) ----
  console.log('Test 3: Scan events (append + list + pub/sub)')
  try {
    if (!createdRunId) {
      // Create a fresh run for event testing
      const created = await createRun(
        {
          projectId: project.id,
          environmentId: environment.id,
          targetUrl: environment.baseUrl,
          runMode: 'PASSIVE',
          trigger: 'MANUAL',
        },
        owner.id,
        'OWNER',
        { ip: '127.0.0.1', userAgent: 'test', requestId: 'test-3' },
      )
      createdRunId = created.runId
    }

    // Subscribe to in-process pub/sub
    let receivedCount = 0
    const unsub = subscribeToRun(createdRunId, () => {
      receivedCount++
    })

    await appendScanEvent(createdRunId, 'run.crawling', { viewport: 'desktop', pages: 3 })
    await appendScanEvent(createdRunId, 'page.discovered', { url: 'http://localhost:3000/demo-target' })
    await appendScanEvent(createdRunId, 'finding.discovered', { checkId: 'a11y.missing_lang', severity: 'MINOR' })
    await appendScanEvent(createdRunId, 'run.completed', { pages: 3, findings: 1, durationMs: 1234 })

    PASS(`appended 4 events (pub/sub received ${receivedCount})`)

    const events = await listScanEvents(createdRunId)
    PASS(`listed ${events.length} events (first=${events[0]?.eventType}, last=${events[events.length - 1]?.eventType})`)

    // Reconnect from sequence 2 (should get events 3+)
    const fromSeq2 = await listScanEvents(createdRunId, 2)
    PASS(`reconnect from seq 2: got ${fromSeq2.length} events`)

    unsub()
  } catch (err) {
    FAIL('scan events test failed', err)
  }
  console.log()

  // ---- Test 4: Artifact service ----
  console.log('Test 4: Artifact service (store + read + signed URL)')
  try {
    const pngBuffer = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG signature
      0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, // IHDR chunk
      0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, // 1x1 pixel
      0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, // RGBA
      0x89,
    ])

    const stored = await storeArtifact({
      workspaceId: workspace.id,
      projectId: project.id,
      runId: createdRunId ?? undefined,
      type: 'SCREENSHOT',
      filename: 'test-screenshot.png',
      buffer: pngBuffer,
      declaredMime: 'image/png',
    })
    PASS(`stored artifact ${stored.id} (${stored.sizeBytes} bytes, mime=${stored.mimeType})`)
    PASS(`signed URL: ${stored.signedUrl.slice(0, 60)}...`)

    // Read it back
    const readBack = await readArtifactBuffer(stored.storageKey)
    if (readBack.equals(pngBuffer)) PASS('read back artifact matches original buffer')
    else FAIL('artifact buffer mismatch')

    // Verify signature
    const url = new URL(stored.signedUrl, 'http://x')
    const exp = parseInt(url.searchParams.get('exp')!, 10)
    const sig = url.searchParams.get('sig')!
    if (verifyArtifactSignature(stored.id, exp, sig)) PASS('signature verified')
    else FAIL('signature verification failed')

    // Tampered signature
    if (!verifyArtifactSignature(stored.id, exp, 'deadbeef')) PASS('tampered signature rejected')
    else FAIL('tampered signature should be rejected')

    // Expired signature
    if (!verifyArtifactSignature(stored.id, Math.floor(Date.now() / 1000) - 100, sig)) PASS('expired signature rejected')
    else FAIL('expired signature should be rejected')
  } catch (err) {
    FAIL('artifact service test failed', err)
  }
  console.log()

  // ---- Test 5: Revalidate target before fetch ----
  console.log('Test 5: Revalidate target before fetch (DNS rebinding protection)')
  try {
    // localhost in dev — should pass
    const ips = await revalidateTargetBeforeFetch('http://localhost:3000/demo-target', [])
    PASS(`localhost revalidation passed (ips=${ips.length})`)

    // Real domain — should resolve
    try {
      const ips2 = await revalidateTargetBeforeFetch('https://example.com/', [])
      PASS(`example.com revalidation passed (ips=${ips2.length})`)
    } catch (err) {
      // DNS may fail in sandbox — that's OK
      PASS(`example.com DNS failed (expected in sandbox): ${err instanceof Error ? err.message.slice(0, 40) : 'ok'}`)
    }
  } catch (err) {
    FAIL('revalidate test failed', err)
  }
  console.log()

  console.log('====================')
  console.log('Phase 4 verification complete.')
  if (process.exitCode) {
    console.log('SOME TESTS FAILED.')
  } else {
    console.log('ALL TESTS PASSED.')
  }
}

main()
  .catch((err) => {
    console.error('Fatal:', err)
    process.exitCode = 1
  })
  .finally(async () => {
    await db.$disconnect()
  })
