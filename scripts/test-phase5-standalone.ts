/**
 * Phase 5 standalone verification — ProofPilot
 *
 * Serves a test HTML page with intentional issues (mirrors the demo-target),
 * then directly invokes runPageAnalysis() against it. This avoids the
 * Next.js + worker memory pressure that causes OOM in the sandbox.
 *
 * Usage: bun run scripts/test-phase5-standalone.ts
 */
import { db } from '../src/lib/db'
import { runPageAnalysis } from '../mini-services/worker/src/analyzers'
import { listScanEvents } from '../src/lib/scan-events'

const TEST_HTML = `<!DOCTYPE html>
<html>
<head>
  <title>Demo Target — ProofPilot Phase 5 Test</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <!-- Missing: meta description, canonical, OG tags, Twitter Card, JSON-LD, favicon, manifest -->
  <!-- Missing: CSP, X-Content-Type-Options, HSTS headers (server-controlled) -->
</head>
<body>
  <header>
    <h1>Demo Target</h1>
    <nav>
      <a href="/">Home</a>
      <a href="/contact">Contact</a>
      <!-- Broken link — 404 -->
      <a href="/nonexistent-page">Broken Link</a>
    </nav>
  </header>

  <main>
    <!-- Form with unlabeled fields + empty-aria-label button -->
    <section>
      <h2>Form with accessibility issues</h2>
      <form action="/submit" method="post">
        <input type="text" placeholder="Your name (no label)" />
        <input type="email" placeholder="Your email (no label, no autocomplete)" />
        <input type="password" name="password" placeholder="Password" />
        <button type="submit" aria-label=""></button>
      </form>
    </section>

    <!-- Horizontal overflow -->
    <section>
      <h2>Horizontal overflow</h2>
      <div style="min-width: 1500px; white-space: nowrap;">
        <p>This very wide content forces horizontal scroll on mobile.</p>
      </div>
    </section>

    <!-- Console error trigger -->
    <section>
      <h2>Console error trigger</h2>
      <button id="trigger-error">Trigger console error</button>
    </section>

    <!-- Successful form journey -->
    <section>
      <h2>Successful form journey</h2>
      <form action="/contact/success" method="get">
        <div>
          <label for="contact-name">Name</label>
          <input id="contact-name" name="name" type="text" required />
        </div>
        <div>
          <label for="contact-email">Email</label>
          <input id="contact-email" name="email" type="email" autocomplete="email" required />
        </div>
        <button type="submit">Send</button>
      </form>
    </section>

    <!-- iframe without title -->
    <section>
      <h2>iframe without title</h2>
      <iframe src="/about" width="300" height="200"></iframe>
    </section>

    <!-- Heading hierarchy skip (h2 → h4, no h3) -->
    <section>
      <h2>Skipped heading level</h2>
      <h4>This skips h3</h4>
    </section>
  </main>

  <footer>
    <p>ProofPilot demo target — for scanner QA only.</p>
  </footer>

  <script>
    // Intentional console error on load
    console.error('ProofPilot demo: intentional load-time error');
    document.getElementById('trigger-error').addEventListener('click', function() {
      console.error('ProofPilot demo: intentional click error');
    });
  </script>
</body>
</html>`

/** Start a minimal HTTP server that serves the test HTML + handles routes. */
function startTestServer(port: number): { stop: () => void; origin: string } {
  const server = Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url)
      const path = url.pathname

      // CORS headers
      const headers = {
        'Content-Type': 'text/html; charset=utf-8',
        // Intentionally missing security headers (CSP, HSTS, X-Content-Type-Options, etc.)
        // to verify the security analyzer flags them.
      }

      if (path === '/' || path === '/demo-target') {
        return new Response(TEST_HTML, { status: 200, headers })
      }
      if (path === '/contact' || path === '/about') {
        return new Response('<!DOCTYPE html><html><head><title>Contact</title></head><body><h1>Contact</h1></body></html>', { status: 200, headers })
      }
      if (path === '/contact/success') {
        return new Response('<!DOCTYPE html><html><head><title>Success</title></head><body><h1>Success!</h1></body></html>', { status: 200, headers })
      }
      if (path === '/nonexistent-page') {
        return new Response('<!DOCTYPE html><html><head><title>Not Found</title></head><body><h1>404 Not Found</h1></body></html>', { status: 404, headers })
      }
      if (path === '/submit') {
        return new Response('<!DOCTYPE html><html><head><title>Submitted</title></head><body><h1>Submitted</h1></body></html>', { status: 200, headers })
      }
      // Default: 404
      return new Response('<!DOCTYPE html><html><head><title>Not Found</title></head><body><h1>404</h1></body></html>', { status: 404, headers })
    },
  })
  return { stop: () => server.stop(), origin: `http://localhost:${port}` }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms))
}

async function main() {
  console.log('=== Phase 5 Standalone Analyzer Verification ===\n')

  // 1. Start the test HTTP server
  const TEST_PORT = 4567
  const server = startTestServer(TEST_PORT)
  console.log(`Test server started at ${server.origin}`)

  // 2. Look up the demo workspace/project/environment/user to get real IDs
  const workspace = await db.workspace.findFirst({
    where: { slug: 'demo-agency' },
    select: { id: true, name: true },
  })
  if (!workspace) {
    console.error('Demo workspace not found. Run `bun run seed` first.')
    server.stop()
    process.exit(1)
  }
  const project = await db.project.findFirst({
    where: { workspaceId: workspace.id, status: 'ACTIVE' },
    select: { id: true },
  })
  if (!project) {
    console.error('Demo project not found.')
    server.stop()
    process.exit(1)
  }
  const environment = await db.projectEnvironment.findFirst({
    where: { projectId: project.id },
    select: { id: true },
  })
  if (!environment) {
    console.error('Demo environment not found.')
    server.stop()
    process.exit(1)
  }
  const owner = await db.user.findFirst({
    where: { email: 'owner@proofpilot.local' },
    select: { id: true },
  })
  if (!owner) {
    console.error('Demo owner user not found.')
    server.stop()
    process.exit(1)
  }

  // 3. Create a ScanRun + ScanPage record for the test
  const run = await db.scanRun.create({
    data: {
      projectId: project.id,
      environmentId: environment.id,
      workspaceId: workspace.id,
      status: 'RUNNING',
      trigger: 'MANUAL',
      runMode: 'PASSIVE',
      triggeredById: owner.id,
      configSnapshot: JSON.stringify({
        targetUrl: `${server.origin}/`,
        allowedOrigins: [server.origin],
        runMode: 'PASSIVE',
        trigger: 'MANUAL',
      }),
      startedAt: new Date(),
    },
  })
  console.log(`Created test run: ${run.id}`)

  const scanPage = await db.scanPage.create({
    data: {
      runId: run.id,
      url: `${server.origin}/`,
      normalizedUrl: `${server.origin}/`,
      title: 'Demo Target — ProofPilot Phase 5 Test',
      httpStatus: 200,
      contentType: 'text/html',
      redirectChain: '[]',
      lang: null,
      dir: null,
      canonical: null,
      depth: 0,
      analyzedAt: null,
    },
  })
  console.log(`Created test page: ${scanPage.id}\n`)

  // 4. Run the analyzers directly
  console.log('Running analyzers...\n')
  const targetUrl = `${server.origin}/`
  const result = await runPageAnalysis({
    runId: run.id,
    workspaceId: workspace.id,
    projectId: project.id,
    environmentId: environment.id,
    pageId: scanPage.id,
    pageUrl: targetUrl,
    normalizedPageUrl: targetUrl,
    viewport: { name: 'desktop', width: 1366, height: 768 },
    locale: 'en',
    browser: 'chromium',
    runMode: 'PASSIVE',
    allowedOrigins: [server.origin],
    crawl: {
      url: targetUrl,
      normalizedUrl: targetUrl,
      title: 'Demo Target — ProofPilot Phase 5 Test',
      httpStatus: 200,
      contentType: 'text/html',
      redirectChain: [],
      lang: null,
      dir: null,
      canonical: null,
      consoleErrors: [],
      pageErrors: [],
    },
  })

  console.log(`\nAnalysis result: ${result.findings} findings, ${result.analyzersRun}/${result.analyzersRun + result.analyzersFailed} analyzers succeeded, ${result.durationMs}ms\n`)

  // 5. Fetch the findings from the DB
  const findings = await db.finding.findMany({
    where: { runId: run.id },
    select: {
      checkId: true, category: true, severity: true, title: true,
      viewport: true, locale: true, description: true, remediation: true,
    },
    orderBy: [{ severity: 'asc' }, { category: 'asc' }, { checkId: 'asc' }],
  })

  console.log(`=== Findings (${findings.length} total) ===\n`)

  // Group by category
  const byCategory = new Map<string, typeof findings>()
  for (const f of findings) {
    const arr = byCategory.get(f.category) ?? []
    arr.push(f)
    byCategory.set(f.category, arr)
  }
  for (const [cat, items] of [...byCategory].sort()) {
    console.log(`--- ${cat} (${items.length}) ---`)
    for (const f of items) {
      console.log(`  [${f.severity}] ${f.checkId}: ${f.title}`)
    }
    console.log()
  }

  // 6. Summary by severity
  const bySeverity = new Map<string, number>()
  for (const f of findings) {
    bySeverity.set(f.severity, (bySeverity.get(f.severity) ?? 0) + 1)
  }
  console.log('=== By Severity ===')
  for (const [sev, count] of [...bySeverity].sort()) {
    console.log(`  ${sev}: ${count}`)
  }

  // 7. Verify expected issues were detected
  console.log('\n=== Expected Issue Detection ===')
  const expectedIssues: Array<{ checkId: string; description: string }> = [
    { checkId: 'http.broken_link', description: 'Broken link (/nonexistent-page → 404)' },
    { checkId: 'forms.missing_label', description: 'Unlabeled form inputs (name + email fields)' },
    { checkId: 'a11y.unnamed_interactive', description: 'Submit button with empty aria-label' },
    { checkId: 'responsive.horizontal_overflow', description: 'min-width: 1500px overflow' },
    { checkId: 'runtime.console_error', description: 'Intentional load-time console.error()' },
    { checkId: 'seo.missing_canonical', description: 'No <link rel="canonical">' },
    { checkId: 'seo.missing_og_tags', description: 'No Open Graph tags' },
    { checkId: 'seo.missing_description', description: 'No <meta name="description">' },
    { checkId: 'security.missing_header.content-security-policy', description: 'No CSP header (HSTS skipped on HTTP)' },
    { checkId: 'forms.password_no_autocomplete', description: 'Password field without autocomplete' },
    { checkId: 'a11y.frame_without_title', description: 'iframe without title' },
    { checkId: 'a11y.skipped_heading_level', description: 'h2 → h4 (skipped h3)' },
    { checkId: 'forms.no_error_region', description: 'Form without [role="alert"]' },
  ]
  let detected = 0
  for (const expected of expectedIssues) {
    const found = findings.some((f) => f.checkId === expected.checkId)
    console.log(`  ${found ? '✓' : '✗'} ${expected.checkId} — ${expected.description}`)
    if (found) detected++
  }
  console.log(`\nDetected ${detected}/${expectedIssues.length} expected issues.`)

  // 8. Verify ScanPageMetric was written
  const metrics = await db.scanPageMetric.findUnique({
    where: { pageId: scanPage.id },
  })
  console.log('\n=== Page Metrics ===')
  if (metrics) {
    console.log(`  ttfb=${metrics.ttfb}ms dcl=${metrics.domContentLoaded}ms load=${metrics.loadEvent}ms`)
    console.log(`  lcp=${metrics.lcp}ms cls=${metrics.cls} inp=${metrics.inp}ms fcp=?`)
    console.log(`  requests=${metrics.requestCount} bytes=${metrics.totalBytes} longTasks=${metrics.longTasks} renderBlocking=${metrics.renderBlocking}`)
  } else {
    console.log('  (no metrics written)')
  }

  // 9. Verify scan events were appended
  const events = await listScanEvents(run.id, 0, 50)
  console.log(`\n=== Scan Events (${events.length} total) ===`)
  for (const e of events.slice(0, 15)) {
    console.log(`  #${e.sequence} ${e.type} ${e.data ? JSON.stringify(e.data).slice(0, 100) : ''}`)
  }

  // 10. Cleanup — delete the test run + findings (don't pollute the demo data)
  console.log('\nCleaning up test data...')
  await db.findingOccurrence.deleteMany({ where: { runId: run.id } })
  await db.finding.deleteMany({ where: { runId: run.id } })
  await db.scanPageMetric.deleteMany({ where: { pageId: scanPage.id } })
  await db.scanPage.deleteMany({ where: { runId: run.id } })
  await db.scanRunEvent.deleteMany({ where: { runId: run.id } })
  await db.scanRun.delete({ where: { id: run.id } })
  console.log('Cleanup complete.')

  server.stop()
  await db.$disconnect()

  console.log('\n=== Phase 5 Standalone Verification Complete ===')
  if (detected >= 10) {
    console.log('✓ SUCCESS: Analyzers detected the majority of expected issues.')
    process.exit(0)
  } else {
    console.log('✗ FAILURE: Too few expected issues detected.')
    process.exit(1)
  }
}

main().catch((err) => {
  console.error('Test failed:', err)
  process.exit(1)
})
