/**
 * GET /api/v1/admin/system-health
 *   System health check: database, queue, security events, uptime, memory, LLM usage.
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

    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000)
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)

    const [dbHealth, queueWaiting, queueActive, queueFailed, recentErrors, llmUsage] =
      await Promise.all([
        // Database health: simple count query
        db.user
          .count({ take: 1 })
          .then((count) => ({ status: 'healthy' as const, userCount: count }))
          .catch(() => ({ status: 'unhealthy' as const, userCount: 0 })),
        db.queueJob.count({ where: { status: 'WAITING' } }),
        db.queueJob.count({ where: { status: 'ACTIVE' } }),
        db.queueJob.count({ where: { status: 'FAILED' } }),
        db.securityEvent.groupBy({
          by: ['severity'],
          where: { createdAt: { gte: twentyFourHoursAgo } },
          _count: { id: true },
        }),
        db.llmUsageRecord.aggregate({
          where: { createdAt: { gte: sevenDaysAgo } },
          _sum: {
            promptTokens: true,
            completionTokens: true,
            estimatedCostUsd: true,
          },
        }),
      ])

    // Aggregate queue counts by queue name
    const queueCounts = await db.queueJob.groupBy({
      by: ['queue', 'status'],
      _count: { id: true },
    })

    const memory = process.memoryUsage()
    const uptimeSeconds = process.uptime()

    const recentErrorsBySeverity: Record<string, number> = {}
    for (const row of recentErrors) {
      recentErrorsBySeverity[row.severity] = row._count.id
    }

    const totalLlmTokens =
      (llmUsage._sum.promptTokens ?? 0) +
      (llmUsage._sum.completionTokens ?? 0)
    const totalLlmCost = llmUsage._sum.estimatedCostUsd ?? 0

    return NextResponse.json(
      {
        database: dbHealth,
        queue: {
          waiting: queueWaiting,
          active: queueActive,
          failed: queueFailed,
          byQueueAndStatus: queueCounts.map((r) => ({
            queue: r.queue,
            status: r.status,
            count: r._count.id,
          })),
        },
        recentErrorsBySeverity,
        uptime: {
          seconds: Math.floor(uptimeSeconds),
          formatted: formatUptime(uptimeSeconds),
        },
        memory: {
          rssBytes: memory.rss,
          heapUsedBytes: memory.heapUsed,
          heapTotalBytes: memory.heapTotal,
          externalBytes: memory.external,
          rssFormatted: formatBytes(memory.rss),
          heapUsedFormatted: formatBytes(memory.heapUsed),
        },
        llmUsageLast7Days: {
          totalTokens: totalLlmTokens,
          totalCost: totalLlmCost,
        },
        timestamp: new Date().toISOString(),
      },
      { headers: { 'X-Request-Id': requestId } },
    )
  } catch (err) {
    return problemResponse(err, requestId, instance)
  }
}

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400)
  const hrs = Math.floor((seconds % 86400) / 3600)
  const mins = Math.floor((seconds % 3600) / 60)
  const parts: string[] = []
  if (days > 0) parts.push(`${days}d`)
  if (hrs > 0) parts.push(`${hrs}h`)
  parts.push(`${mins}m`)
  return parts.join(' ')
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}
