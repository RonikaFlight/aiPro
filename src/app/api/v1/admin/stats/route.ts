/**
 * GET /api/v1/admin/stats
 *   Returns platform-wide aggregate statistics.
 */
import { NextResponse } from 'next/server'
import { requirePlatformAdmin } from '@/lib/auth-context'
import { db } from '@/lib/db'
import { problemResponse, newRequestId } from '@/lib/errors'

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  const requestId = request.headers.get('X-Request-Id') ?? newRequestId()
  const instance = new URL(request.url).pathname
  try {
    await requirePlatformAdmin()

    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)

    const [
      usersTotal,
      usersActive,
      usersSuspended,
      usersAdmin,
      workspacesTotal,
      projectsTotal,
      projectsActive,
      runsTotal,
      runsCompleted,
      runsFailed,
      runsRunning,
      findingsTotal,
      findingsOpen,
      subscriptionsTotal,
      subscriptionsActive,
      llmUsage,
      recentSecurityEvents,
      queueJobsTotal,
      queueJobsActive,
      queueJobsFailed,
    ] = await Promise.all([
      db.user.count(),
      db.user.count({ where: { status: 'ACTIVE' } }),
      db.user.count({ where: { status: 'SUSPENDED' } }),
      db.user.count({ where: { platformRole: 'PLATFORM_ADMIN' } }),
      db.workspace.count(),
      db.project.count(),
      db.project.count({ where: { status: 'ACTIVE' } }),
      db.scanRun.count(),
      db.scanRun.count({ where: { status: 'COMPLETED' } }),
      db.scanRun.count({ where: { status: 'FAILED' } }),
      db.scanRun.count({ where: { status: { in: ['QUEUED', 'RUNNING', 'ANALYZING', 'SCORING'] } } }),
      db.finding.count(),
      db.finding.count({ where: { status: { in: ['OPEN', 'ACKNOWLEDGED', 'IN_PROGRESS', 'REOPENED'] } } }),
      db.subscription.count(),
      db.subscription.count({ where: { status: { in: ['TRIALING', 'ACTIVE'] } } }),
      db.llmUsageRecord.aggregate({
        _sum: {
          promptTokens: true,
          completionTokens: true,
          estimatedCostUsd: true,
        },
      }),
      db.securityEvent.count({
        where: { createdAt: { gte: sevenDaysAgo } },
      }),
      db.queueJob.count(),
      db.queueJob.count({ where: { status: { in: ['WAITING', 'ACTIVE', 'DELAYED'] } } }),
      db.queueJob.count({ where: { status: 'FAILED' } }),
    ])

    const totalLlmUsage = (llmUsage._sum.promptTokens ?? 0) + (llmUsage._sum.completionTokens ?? 0)
    const totalLlmCost = llmUsage._sum.estimatedCostUsd ?? 0

    return NextResponse.json(
      {
        totalUsers: usersTotal,
        activeUsers: usersActive,
        suspendedUsers: usersSuspended,
        adminUsers: usersAdmin,
        totalWorkspaces: workspacesTotal,
        totalProjects: projectsTotal,
        activeProjects: projectsActive,
        totalRuns: runsTotal,
        completedRuns: runsCompleted,
        failedRuns: runsFailed,
        runningRuns: runsRunning,
        totalFindings: findingsTotal,
        openFindings: findingsOpen,
        totalSubscriptions: subscriptionsTotal,
        activeSubscriptions: subscriptionsActive,
        totalLlmUsage,
        totalLlmCost,
        recentSecurityEvents,
        totalQueueJobs: queueJobsTotal,
        activeQueueJobs: queueJobsActive,
        failedQueueJobs: queueJobsFailed,
      },
      { headers: { 'X-Request-Id': requestId } },
    )
  } catch (err) {
    return problemResponse(err, requestId, instance)
  }
}
