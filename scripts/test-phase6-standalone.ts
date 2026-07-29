/**
 * Phase 6 standalone verification — ProofPilot
 *
 * Exercises the findings lifecycle, suppressions, scoring, and auto-reopen
 * logic without starting the Next.js dev server (which can OOM the sandbox
 * when run alongside the worker + Chrome).
 *
 * Run with:
 *   bun run scripts/test-phase6-standalone.ts
 */
import { db } from '../src/lib/db'
import {
  transitionFinding,
  addComment,
  listComments,
  patchFinding,
  createSuppression,
  revokeSuppression,
  isFindingSuppressed,
  listFindings,
  bulkUpdateFindings,
  exportFindingsCsv,
  maybeAutoReopenFinding,
  isSuppressionActive,
} from '../src/lib/findings-service'
import {
  assertCanTransition,
  canTransition,
  resolveSeverity,
  deterministicSeverity,
  parseTags,
  parseBusinessImpacts,
  SEVERITY_WEIGHTS,
  SEVERITY_MAX_PENALTY,
  type FindingStatus,
} from '../src/lib/finding-severity'
import { computeBreakdown, computeProjectScore } from '../src/lib/quality-score'

let pass = 0
let fail = 0
const errors: string[] = []

function assert(cond: boolean, msg: string) {
  if (cond) {
    pass++
    console.log(`  ✓ ${msg}`)
  } else {
    fail++
    errors.push(msg)
    console.log(`  ✗ ${msg}`)
  }
}

function assertThrows(fn: () => void, msg: string) {
  try {
    fn()
    fail++
    errors.push(`Expected throw: ${msg}`)
    console.log(`  ✗ Expected throw: ${msg}`)
  } catch {
    pass++
    console.log(`  ✓ ${msg} (throws as expected)`)
  }
}

async function main() {
  console.log('\n=== Phase 6 — Findings standalone verification ===\n')

  // Resolve a real seeded user ID for FK references in audit/history tables.
  const systemUser = await db.user.findFirst({
    where: { email: 'owner@proofpilot.local' },
    select: { id: true },
  })
  if (!systemUser) {
    console.error('Seed data missing — run `bun run db:seed` first.')
    process.exit(1)
  }
  const SYSTEM_USER_ID = systemUser.id

  // -------------------------------------------------------
  console.log('1. Severity & status types')
  // -------------------------------------------------------
  {
    assert(deterministicSeverity('HTTP_NAVIGATION', 'server_error_5xx') === 'CRITICAL',
      'deterministic severity for 5xx = CRITICAL')
    assert(deterministicSeverity('SECURITY', 'secret_in_dom') === 'BLOCKER',
      'deterministic severity for secret_in_dom = BLOCKER')
    assert(deterministicSeverity('SEO', 'missing_favicon') === 'INFO',
      'deterministic severity for missing_favicon = INFO')
    assert(deterministicSeverity('UNKNOWN_CAT', 'unknown_check') === null,
      'unknown (cat,check) returns null')

    const r = resolveSeverity('HTTP_NAVIGATION', 'server_error_5xx', 'MAJOR', 'MINOR')
    assert(r.severity === 'CRITICAL' && r.overridden === true,
      'resolveSeverity overrides AI proposal (MINOR→CRITICAL), marks overridden=true')

    const r2 = resolveSeverity('UNKNOWN_CAT', 'unknown_check', 'MAJOR')
    assert(r2.severity === 'MAJOR' && r2.overridden === false,
      'resolveSeverity falls back to analyzer severity when no deterministic rule')

    assert(SEVERITY_WEIGHTS.BLOCKER === 25, 'BLOCKER weight = 25')
    assert(SEVERITY_MAX_PENALTY.BLOCKER === 35, 'BLOCKER max penalty = 35')
    assert(SEVERITY_WEIGHTS.INFO === 0, 'INFO weight = 0')

    assert(canTransition('OPEN', 'RESOLVED') === true, 'OPEN → RESOLVED allowed')
    assert(canTransition('RESOLVED', 'REOPENED') === true, 'RESOLVED → REOPENED allowed')
    assert(canTransition('RESOLVED', 'OPEN') === false, 'RESOLVED → OPEN blocked (must go via REOPENED)')
    assert(canTransition('OPEN', 'OPEN') === false, 'OPEN → OPEN not a transition')
    assert(canTransition('FALSE_POSITIVE', 'REOPENED') === true, 'FALSE_POSITIVE → REOPENED allowed')
    assert(canTransition('ACCEPTED_RISK', 'OPEN') === true, 'ACCEPTED_RISK → OPEN allowed')
    assert(canTransition('IGNORED', 'RESOLVED') === false, 'IGNORED → RESOLVED blocked')
    assertThrows(() => assertCanTransition('OPEN', 'OPEN'),
      'assertCanTransition(OPEN→OPEN)')

    const tags = parseTags('bug, P1, bug, needs-review')
    assert(tags.length === 3, 'parseTags dedupes case-insensitively (4→3)')
    assert(tags[0] === 'bug' && tags[1] === 'P1', 'parseTags preserves order')

    const impacts = parseBusinessImpacts('REVENUE_LOSS, BRAND_DAMAGE, fake_one, REVENUE_LOSS')
    assert(impacts.length === 2, 'parseBusinessImpacts filters invalid + dedupes (4→2)')
    assert(impacts[0] === 'REVENUE_LOSS' && impacts[1] === 'BRAND_DAMAGE',
      'parseBusinessImpacts preserves order')
  }

  // -------------------------------------------------------
  console.log('\n2. Quality score (pure computation)')
  // -------------------------------------------------------
  {
    // No findings → 100, READY.
    const empty = computeBreakdown([])
    assert(empty.score === 100, 'No findings → score 100')
    assert(empty.readiness === 'READY', 'No findings → READY')
    assert(empty.grade === 'A', 'No findings → grade A')

    // 1 INFO finding (open) → still 100 (INFO has weight 0).
    const oneInfo = computeBreakdown([
      { severity: 'INFO', status: 'OPEN', suppressions: [] },
    ])
    assert(oneInfo.score === 100, '1 open INFO → score 100 (no penalty)')
    assert(oneInfo.openBySeverity.INFO === 1, '1 open INFO counted')

    // 1 open MINOR → 100 - 2 = 98, READY.
    const oneMinor = computeBreakdown([
      { severity: 'MINOR', status: 'OPEN', suppressions: [] },
    ])
    assert(oneMinor.score === 98, '1 open MINOR → score 98')
    assert(oneMinor.readiness === 'READY', '1 open MINOR → READY (>= 80)')

    // 1 open MAJOR → 100 - 5 = 95, READY.
    const oneMajor = computeBreakdown([
      { severity: 'MAJOR', status: 'OPEN', suppressions: [] },
    ])
    assert(oneMajor.score === 95, '1 open MAJOR → score 95')

    // 1 open CRITICAL → 100 - 12 = 88, capped at 74, NEEDS_WORK.
    const oneCritical = computeBreakdown([
      { severity: 'CRITICAL', status: 'OPEN', suppressions: [] },
    ])
    assert(oneCritical.score === 74, '1 open CRITICAL → capped at 74')
    assert(oneCritical.readiness === 'NEEDS_WORK', '1 open CRITICAL → NEEDS_WORK')
    assert(oneCritical.hasOpenCritical === true, 'hasOpenCritical = true')

    // 1 open BLOCKER → capped at 49, NOT_READY.
    const oneBlocker = computeBreakdown([
      { severity: 'BLOCKER', status: 'OPEN', suppressions: [] },
    ])
    assert(oneBlocker.score === 49, '1 open BLOCKER → capped at 49')
    assert(oneBlocker.readiness === 'NOT_READY', '1 open BLOCKER → NOT_READY')
    assert(oneBlocker.hasOpenBlocker === true, 'hasOpenBlocker = true')

    // 5 open BLOCKER → 100 - 125 → capped at 35 (max penalty), then capped at 49.
    const fiveBlockers = computeBreakdown([
      { severity: 'BLOCKER', status: 'OPEN', suppressions: [] },
      { severity: 'BLOCKER', status: 'OPEN', suppressions: [] },
      { severity: 'BLOCKER', status: 'OPEN', suppressions: [] },
      { severity: 'BLOCKER', status: 'OPEN', suppressions: [] },
      { severity: 'BLOCKER', status: 'OPEN', suppressions: [] },
    ])
    assert(fiveBlockers.score === 49, '5 open BLOCKER → still 49 (blocker cap)')
    assert(fiveBlockers.penaltyBySeverity.BLOCKER === 35, '5 BLOCKER penalty capped at 35')

    // Resolved finding → no penalty.
    const resolved = computeBreakdown([
      { severity: 'BLOCKER', status: 'RESOLVED', suppressions: [] },
    ])
    assert(resolved.score === 100, '1 RESOLVED BLOCKER → score 100 (no penalty)')
    assert(resolved.fixedCount === 1, 'RESOLVED counted as fixed')

    // Suppressed finding → no penalty.
    const suppressed = computeBreakdown([
      { severity: 'BLOCKER', status: 'OPEN', suppressions: [{ id: 'x' }] },
    ])
    assert(suppressed.score === 100, '1 suppressed BLOCKER → score 100')
    assert(suppressed.suppressedCount === 1, 'suppressed counted')

    // Mixed: 1 BLOCKER + 1 CRITICAL + 1 RESOLVED + 1 suppressed.
    const mixed = computeBreakdown([
      { severity: 'BLOCKER', status: 'OPEN', suppressions: [] },
      { severity: 'CRITICAL', status: 'OPEN', suppressions: [] },
      { severity: 'MAJOR', status: 'RESOLVED', suppressions: [] },
      { severity: 'MAJOR', status: 'OPEN', suppressions: [{ id: 'x' }] },
    ])
    assert(mixed.score === 49, 'Mixed → capped at 49 (blocker)')
    assert(mixed.totalFindings === 4, 'Mixed total = 4')
    assert(mixed.fixedCount === 1, 'Mixed fixed = 1')
    assert(mixed.suppressedCount === 1, 'Mixed suppressed = 1')
  }

  // -------------------------------------------------------
  console.log('\n3. isSuppressionActive helper')
  // -------------------------------------------------------
  {
    assert(isSuppressionActive({ revokedAt: null, expiresAt: null }) === true,
      'no revoke, no expiry → active')
    assert(isSuppressionActive({ revokedAt: new Date(), expiresAt: null }) === false,
      'revoked → inactive')
    assert(isSuppressionActive({ revokedAt: null, expiresAt: new Date(Date.now() - 1000) }) === false,
      'expired → inactive')
    assert(isSuppressionActive({ revokedAt: null, expiresAt: new Date(Date.now() + 60000) }) === true,
      'future expiry → active')
  }

  // -------------------------------------------------------
  console.log('\n4. Lifecycle integration (requires DB)')
  // -------------------------------------------------------
  {
    // Find or create a test workspace + project + finding.
    let workspace = await db.workspace.findFirst({
      where: { slug: 'phase6-test' },
      select: { id: true, slug: true },
    })
    if (!workspace) {
      const owner = await db.user.findFirst({
        where: { email: 'owner@proofpilot.local' },
        select: { id: true },
      })
      workspace = await db.workspace.create({
        data: {
          name: 'Phase 6 Test',
          slug: 'phase6-test',
          ownerId: owner!.id,
        },
        select: { id: true, slug: true },
      })
      await db.workspaceMember.create({
        data: {
          workspaceId: workspace.id,
          userId: owner!.id,
          role: 'OWNER',
        },
      }).catch(() => { /* may already exist */ })
    }

    let project = await db.project.findFirst({
      where: { workspaceId: workspace.id, name: 'Phase 6 Test Project' },
      select: { id: true, workspaceId: true },
    })
    if (!project) {
      project = await db.project.create({
        data: {
          workspaceId: workspace.id,
          name: 'Phase 6 Test Project',
          productionUrl: 'https://example.test',
          productType: 'web_app',
          status: 'ACTIVE',
        },
        select: { id: true, workspaceId: true },
      })
    }

    // Clean up any lingering suppressions from previous test runs so the
    // isFindingSuppressed assertions aren't affected by stale data.
    await db.findingSuppression.deleteMany({
      where: {
        OR: [
          { workspaceId: workspace.id, projectId: project.id },
          { workspaceId: workspace.id, checkId: 'test_check' },
        ],
      },
    })

    // Create a test finding via direct DB insert.
    const finding = await db.finding.create({
      data: {
        workspaceId: workspace.id,
        projectId: project.id,
        checkId: 'test_check',
        category: 'HTTP_NAVIGATION',
        severity: 'MAJOR',
        status: 'OPEN',
        confidence: 'HIGH',
        title: 'Test finding (Phase 6)',
        description: 'Standalone test finding',
        remediation: 'Fix it',
        fingerprint: `phase6-test-${Date.now()}`,
        affectedUrl: 'https://example.test/page',
        normalizedUrl: 'https://example.test/page',
        viewport: 'desktop',
        locale: 'en',
        browser: 'chromium',
        tags: 'bug,p1',
        businessImpact: 'USER_EXPERIENCE',
      },
      select: { id: true, fingerprint: true, workspaceId: true },
    })

    try {
      // 4a. Transition OPEN → ACKNOWLEDGED → IN_PROGRESS → RESOLVED
      const t1 = await transitionFinding(finding.id, workspace.id, 'ACKNOWLEDGED', {
        userId: SYSTEM_USER_ID,
        audit: { workspaceId: workspace.id },
        reason: 'Acknowledged in test',
      })
      assert(t1.newStatus === 'ACKNOWLEDGED', 'OPEN → ACKNOWLEDGED')

      const t2 = await transitionFinding(finding.id, workspace.id, 'IN_PROGRESS', {
        userId: SYSTEM_USER_ID,
        audit: { workspaceId: workspace.id },
      })
      assert(t2.newStatus === 'IN_PROGRESS', 'ACKNOWLEDGED → IN_PROGRESS')

      const t3 = await transitionFinding(finding.id, workspace.id, 'RESOLVED', {
        userId: SYSTEM_USER_ID,
        audit: { workspaceId: workspace.id },
        reason: 'Fixed in commit abc',
      })
      assert(t3.newStatus === 'RESOLVED', 'IN_PROGRESS → RESOLVED')

      const afterResolve = await db.finding.findUnique({
        where: { id: finding.id },
        select: { status: true, resolvedAt: true },
      })
      assert(afterResolve?.resolvedAt !== null, 'resolvedAt set after RESOLVED')

      // 4b. Invalid transition: RESOLVED → OPEN should fail.
      try {
        await transitionFinding(finding.id, workspace.id, 'OPEN', {
          userId: SYSTEM_USER_ID,
          audit: { workspaceId: workspace.id },
        })
        assert(false, 'RESOLVED → OPEN should have failed')
      } catch {
        assert(true, 'RESOLVED → OPEN rejected by state machine')
      }

      // 4c. Auto-reopen: maybeAutoReopenFinding should transition RESOLVED → REOPENED.
      const reopened = await maybeAutoReopenFinding(finding.id, null, { requestId: 'test' })
      assert(reopened === true, 'maybeAutoReopenFinding returns true for RESOLVED finding')

      const afterReopen = await db.finding.findUnique({
        where: { id: finding.id },
        select: { status: true, resolvedAt: true },
      })
      assert(afterReopen?.status === 'REOPENED', 'Status is REOPENED after auto-reopen')
      assert(afterReopen?.resolvedAt === null, 'resolvedAt cleared after REOPENED')

      // 4d. Idempotent: re-calling maybeAutoReopenFinding on REOPENED should return false.
      const reopened2 = await maybeAutoReopenFinding(finding.id, null, { requestId: 'test' })
      assert(reopened2 === false, 'maybeAutoReopenFinding returns false for non-RESOLVED finding')

      // 4e. Status history was recorded.
      const history = await db.findingStatusHistory.findMany({
        where: { findingId: finding.id },
        orderBy: { changedAt: 'asc' },
      })
      assert(history.length >= 4, `Status history has ${history.length} entries (≥4)`)
      assert(history[0].fromStatus === 'OPEN' && history[0].toStatus === 'ACKNOWLEDGED',
        'First history entry: OPEN → ACKNOWLEDGED')
      const lastEntry = history[history.length - 1]
      assert(lastEntry.fromStatus === 'RESOLVED' && lastEntry.toStatus === 'REOPENED',
        'Last history entry: RESOLVED → REOPENED (auto)')

      // 4f. Comment lifecycle.
      const comment = await addComment(finding.id, workspace.id, SYSTEM_USER_ID,
        'Investigating — looks like a real issue.', { workspaceId: workspace.id })
      assert(comment.body.length > 0, 'addComment returns the comment')

      const listed = await listComments(finding.id, workspace.id)
      assert(listed.items.length === 1, 'listComments returns 1 comment')

      // 4g. Patch (assign + tags + business impact).
      const patched = await patchFinding(finding.id, workspace.id, {
        tags: ['bug', 'p1', 'needs-review'],
        businessImpact: ['USER_EXPERIENCE', 'CONVERSION_LOSS'],
      }, { userId: SYSTEM_USER_ID, audit: { workspaceId: workspace.id } })
      assert(patched.tags.length === 3, 'patched tags = 3')
      assert(patched.businessImpact.includes('CONVERSION_LOSS'),
        'patched businessImpact includes CONVERSION_LOSS')

      // 4h. Suppression lifecycle.
      const suppression = await createSuppression(workspace.id, {
        findingId: finding.id,
        reason: 'Not applicable in production — test fixture only.',
        scope: undefined as never,
      }, { userId: SYSTEM_USER_ID, audit: { workspaceId: workspace.id }, isOwnerOrAdmin: false })
      assert(suppression.isActive === true, 'New suppression is active')

      const isSup = await isFindingSuppressed(finding.fingerprint, workspace.id, {
        checkId: 'test_check',
        projectId: project.id,
      })
      assert(isSup === true, 'isFindingSuppressed returns true after createSuppression')

      const revoked = await revokeSuppression(suppression.id, workspace.id, {
        userId: SYSTEM_USER_ID,
        audit: { workspaceId: workspace.id },
      })
      assert(revoked.isActive === false, 'Suppression inactive after revoke')

      const isSup2 = await isFindingSuppressed(finding.fingerprint, workspace.id, {
        checkId: 'test_check',
        projectId: project.id,
      })
      assert(isSup2 === false, 'isFindingSuppressed returns false after revoke')

      // 4i. Idempotent revoke.
      const revoked2 = await revokeSuppression(suppression.id, workspace.id, {
        userId: SYSTEM_USER_ID,
        audit: { workspaceId: workspace.id },
      })
      assert(revoked2.isActive === false, 'Idempotent revoke returns inactive')

      // 4j. Project score (live).
      const score = await computeProjectScore(project.id, workspace.id)
      assert(score.project.id === project.id, 'computeProjectScore returns the project')
      assert(score.current.totalFindings >= 1, 'computeProjectScore counts findings')
      assert(score.current.openBySeverity.MAJOR >= 1, 'openBySeverity.MAJOR >= 1')
      assert(score.current.score <= 95, `Score <= 95 (got ${score.current.score})`)
      assert(score.current.readiness === 'NEEDS_WORK' || score.current.readiness === 'READY',
        `Readiness is NEEDS_WORK or READY (got ${score.current.readiness})`)

      // 4k. List findings with filters.
      const listedFindings = await listFindings(workspace.id, {
        projectId: project.id,
        severity: 'MAJOR',
      }, { limit: 10 })
      assert(listedFindings.items.length >= 1, 'listFindings severity=MAJOR returns ≥1')

      const byStatus = await listFindings(workspace.id, {
        projectId: project.id,
        status: 'REOPENED',
      }, { limit: 10 })
      assert(byStatus.items.length >= 1, 'listFindings status=REOPENED returns ≥1')

      // 4l. Bulk update — transition all REOPENED → RESOLVED.
      const bulk = await bulkUpdateFindings(workspace.id, {
        filter: { projectId: project.id, status: 'REOPENED' },
        action: { type: 'transition', toStatus: 'RESOLVED', reason: 'Bulk resolve' },
      }, { userId: SYSTEM_USER_ID, audit: { workspaceId: workspace.id } })
      assert(bulk.updated >= 1, `Bulk update affected ${bulk.updated} findings (≥1)`)
      assert(bulk.errors.length === 0, `Bulk update had ${bulk.errors.length} errors (0 expected)`)

      // 4m. CSV export.
      const csv = await exportFindingsCsv(workspace.id, { projectId: project.id })
      assert(csv.includes('title,category,severity'), 'CSV has header row')
      assert(csv.includes('Test finding (Phase 6)'), 'CSV contains the finding title')

      // 4n. Suppression scope: project-wide (projectId only, no checkId) requires owner/admin.
      try {
        await createSuppression(workspace.id, {
          projectId: project.id,
          reason: 'Should fail without owner role — too broad',
        }, { userId: SYSTEM_USER_ID, audit: { workspaceId: workspace.id }, isOwnerOrAdmin: false })
        assert(false, 'project-wide suppression (no checkId) should require owner/admin')
      } catch {
        assert(true, 'project-wide suppression without owner/admin throws')
      }

      // 4o. project-wide scope WITH owner/admin succeeds.
      const projectWideSup = await createSuppression(workspace.id, {
        projectId: project.id,
        reason: 'Project-wide suppression (approved by owner)',
      }, { userId: SYSTEM_USER_ID, audit: { workspaceId: workspace.id }, isOwnerOrAdmin: true })
      assert(projectWideSup.isActive === true, 'project-wide suppression with owner/admin succeeds')
      // Clean up.
      await revokeSuppression(projectWideSup.id, workspace.id, {
        userId: SYSTEM_USER_ID,
        audit: { workspaceId: workspace.id },
      })

      // 4p. project_check scope (projectId + checkId) is allowed for any member
      // (targeted enough not to require owner/admin).
      const projectCheckSup = await createSuppression(workspace.id, {
        projectId: project.id,
        checkId: 'test_check',
        reason: 'Check-level suppression (any member)',
      }, { userId: SYSTEM_USER_ID, audit: { workspaceId: workspace.id }, isOwnerOrAdmin: false })
      assert(projectCheckSup.isActive === true, 'project_check scope allowed for any member')
      await revokeSuppression(projectCheckSup.id, workspace.id, {
        userId: SYSTEM_USER_ID,
        audit: { workspaceId: workspace.id },
      })

    } finally {
      // Clean up the test finding + history + comments + suppressions.
      await db.findingStatusHistory.deleteMany({ where: { findingId: finding.id } })
      await db.findingComment.deleteMany({ where: { findingId: finding.id } })
      await db.findingOccurrence.deleteMany({ where: { findingId: finding.id } })
      // Include project-wide and check-level suppressions created during the test.
      await db.findingSuppression.deleteMany({
        where: {
          OR: [
            { findingId: finding.id },
            { workspaceId: workspace.id, projectId: project.id },
            { workspaceId: workspace.id, checkId: 'test_check' },
            { workspaceId: workspace.id, fingerprint: finding.fingerprint },
          ],
        },
      })
      await db.finding.delete({ where: { id: finding.id } })
    }
  }

  // -------------------------------------------------------
  console.log('\n=== Summary ===')
  console.log(`  Passed: ${pass}`)
  console.log(`  Failed: ${fail}`)
  if (fail > 0) {
    console.log('\nFailed assertions:')
    for (const e of errors) console.log(`  - ${e}`)
    process.exit(1)
  } else {
    console.log('\n✅ All Phase 6 verification checks passed.')
    process.exit(0)
  }
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
