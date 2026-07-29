/**
 * GET /api/v1/projects/[projectId]/dashboard
 *
 * Aggregates all project dashboard data in a single call:
 * - Project metadata + workspace info
 * - Quality score breakdown + readiness
 * - Latest run summary
 * - Score trend (last N runs)
 * - Open blockers
 * - Findings grouped by severity + category
 * - Coverage: browsers, viewports, locales
 * - Journey success rate
 * - Recent reports
 */
import { NextResponse } from 'next/server'
import { requireWorkspaceAuth } from '@/lib/auth-context'
import { computeProjectScore } from '@/lib/quality-score'
import { db } from '@/lib/db'
import { problemResponse, newRequestId, NotFoundError } from '@/lib/errors'

export const dynamic = 'force-dynamic'

export async function GET(
  request: Request,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const requestId = request.headers.get('X-Request-Id') ?? newRequestId()
  const instance = new URL(request.url).pathname
  try {
    const { projectId } = await params

    // Resolve project + workspace
    const project = await db.project.findUnique({
      where: { id: projectId },
      select: {
        id: true,
        name: true,
        description: true,
        productionUrl: true,
        productType: true,
        primaryLocale: true,
        supportedLocales: true,
        status: true,
        createdAt: true,
        workspaceId: true,
        workspace: { select: { id: true, name: true, slug: true } },
        _count: { select: { scanRuns: true, findings: true, journeys: true, environments: true } },
      },
    })
    if (!project || project.status === 'DELETED') {
      throw new NotFoundError('Project not found')
    }

    await requireWorkspaceAuth(project.workspaceId, 'findings.read')

    // 1. Quality score
    const scoreData = await computeProjectScore(projectId, project.workspaceId)

    // 2. Latest run
    const latestRun = await db.scanRun.findFirst({
      where: { projectId, status: { not: 'QUEUED' } },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        status: true,
        trigger: true,
        runMode: true,
        score: true,
        previousScore: true,
        pagesDiscovered: true,
        pagesAnalyzed: true,
        findingsCount: true,
        blockerCount: true,
        aiSummary: true,
        startedAt: true,
        completedAt: true,
        createdAt: true,
        configSnapshot: true,
      },
    })

    // 3. Score trend (last 20 runs)
    const trendRuns = await db.scanRun.findMany({
      where: { projectId, status: { in: ['COMPLETED', 'COMPLETED_WITH_WARNINGS', 'FAILED'] } },
      orderBy: { createdAt: 'asc' },
      take: 20,
      select: { id: true, score: true, createdAt: true },
    })

    // 4. Open blockers
    const blockers = await db.finding.findMany({
      where: {
        projectId,
        severity: 'BLOCKER',
        status: { in: ['OPEN', 'ACKNOWLEDGED', 'IN_PROGRESS'] },
      },
      orderBy: { lastSeenAt: 'desc' },
      take: 10,
      select: {
        id: true,
        title: true,
        severity: true,
        status: true,
        category: true,
        affectedUrl: true,
        firstSeenAt: true,
        lastSeenAt: true,
      },
    })

    // 5. Findings by severity
    const findingsBySeverity = await db.finding.groupBy({
      by: ['severity'],
      where: {
        projectId,
        status: { in: ['OPEN', 'ACKNOWLEDGED', 'IN_PROGRESS'] },
      },
      _count: { id: true },
      orderBy: { _count: { id: 'desc' } },
    })

    // 6. Findings by category
    const findingsByCategory = await db.finding.groupBy({
      by: ['category'],
      where: {
        projectId,
        status: { in: ['OPEN', 'ACKNOWLEDGED', 'IN_PROGRESS'] },
      },
      _count: { id: true },
      orderBy: { _count: { id: 'desc' } },
    })

    // 7. Coverage: browsers, viewports, locales from findings
    const uniqueBrowsers = await db.finding.findMany({
      where: { projectId, browser: { not: null } },
      distinct: ['browser'],
      select: { browser: true },
    })
    const uniqueViewports = await db.finding.findMany({
      where: { projectId, viewport: { not: null } },
      distinct: ['viewport'],
      select: { viewport: true },
    })
    const uniqueLocales = await db.finding.findMany({
      where: { projectId, locale: { not: null } },
      distinct: ['locale'],
      select: { locale: true },
    })

    // Also count pages analyzed
    const totalPagesAnalyzed = await db.scanPage.count({
      where: { run: { projectId } },
    })

    // 8. Journey success rate
    const journeyStats = await db.journeyRun.groupBy({
      by: ['status'],
      where: { projectId },
      _count: { id: true },
    })

    const totalJourneyRuns = journeyStats.reduce((sum, s) => sum + s._count.id, 0)
    const completedJourneyRuns =
      journeyStats.find((s) => s.status === 'COMPLETED')?._count.id ?? 0
    const journeySuccessRate = totalJourneyRuns > 0
      ? Math.round((completedJourneyRuns / totalJourneyRuns) * 100)
      : null

    // Active journeys
    const activeJourneys = await db.journey.count({
      where: { projectId, status: 'ACTIVE' },
    })

    // 9. Recent reports
    const recentReports = await db.report.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
      take: 5,
      select: {
        id: true,
        type: true,
        status: true,
        title: true,
        score: true,
        createdAt: true,
      },
    })

    return NextResponse.json({
      project: {
        id: project.id,
        name: project.name,
        description: project.description,
        productionUrl: project.productionUrl,
        productType: project.productType,
        primaryLocale: project.primaryLocale,
        supportedLocales: project.supportedLocales,
        status: project.status,
        createdAt: project.createdAt,
        workspace: project.workspace,
        totalRuns: project._count.scanRuns,
        totalFindings: project._count.findings,
        totalJourneys: project._count.journeys,
        totalEnvironments: project._count.environments,
      },
      score: scoreData.current,
      latestRun,
      trend: trendRuns.map((r) => ({
        id: r.id,
        score: r.score,
        createdAt: r.createdAt,
      })),
      blockers,
      findingsBySeverity: findingsBySeverity.map((g) => ({
        severity: g.severity,
        count: g._count.id,
      })),
      findingsByCategory: findingsByCategory.map((g) => ({
        category: g.category,
        count: g._count.id,
      })),
      coverage: {
        browsers: uniqueBrowsers.map((b) => b.browser).filter(Boolean) as string[],
        viewports: uniqueViewports.map((v) => v.viewport).filter(Boolean) as string[],
        locales: uniqueLocales.map((l) => l.locale).filter(Boolean) as string[],
        totalPagesAnalyzed,
      },
      journeys: {
        totalRuns: totalJourneyRuns,
        completedRuns: completedJourneyRuns,
        successRate: journeySuccessRate,
        activeJourneys,
      },
      recentReports,
    }, { headers: { 'X-Request-Id': requestId } })
  } catch (err) {
    return problemResponse(err, requestId, instance)
  }
}
