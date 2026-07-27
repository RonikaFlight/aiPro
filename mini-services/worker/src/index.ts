/// <reference types="bun-types" />
/**
 * ProofPilot worker mini-service — entry point
 *
 * Runs on port 3003 (reachable via gateway with ?XTransformPort=3003).
 *
 * Responsibilities:
 *   - HTTP API: health checks, status, manual job trigger (admin only)
 *   - Polls the SQLite-backed queue for `scan-orchestration` and `page-analysis` jobs
 *   - Spawns hardened Playwright browser instances per scan
 *
 * The worker shares the same SQLite database + Prisma client as the Next.js
 * app (file-based DB supports concurrent read/write from separate processes).
 *
 * Run: `bun --hot src/index.ts` (auto-restart on file changes)
 */
import { db } from '../../../src/lib/db'
import { env } from '../../../src/lib/env'
import { logger } from '../../../src/lib/logger'
import {
  registerHandler,
  startWorker,
  type QueueName,
} from '../../../src/lib/queue'
import { handleScanOrchestration } from './orchestrator'
import { handlePageAnalysis } from './page-analysis'
import { handleJourneyExecution } from './journey-runner'

const PORT = env.WORKER_PORT

// ---- Register queue handlers ----
registerHandler('scan-orchestration', handleScanOrchestration as never, {
  concurrency: env.WORKER_CONCURRENCY,
})

// page-analysis handler — runs all Phase 5 analyzers (http-nav, runtime, responsive,
// accessibility, forms, performance, security, seo) on a single page.
registerHandler('page-analysis', handlePageAnalysis as never, {
  concurrency: env.WORKER_CONCURRENCY,
})

// journey-execution handler — executes journey steps in an isolated browser context
// (Phase 7). Non-retryable by design: journeys may have side effects on the target app.
registerHandler('journey-execution', handleJourneyExecution as never, {
  concurrency: 1, // journeys are heavier than page analysis — keep concurrency low
})

// Stub for other queues so they don't pile up unprocessed — Phase 8+ will replace.
const stubQueues: QueueName[] = ['artifact-processing', 'ai-enrichment', 'report-generation', 'email', 'webhooks', 'maintenance']
for (const q of stubQueues) {
  registerHandler(
    q,
    async (job) => {
      logger.debug('Queue job acknowledged (stub)', { queue: q, jobId: job.id })
    },
    { concurrency: 1 },
  )
}

// ---- HTTP server ----
const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url)
    const path = url.pathname

    // CORS + JSON headers
    const headers = {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Request-Id',
    }

    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers })
    }

    // Health: liveness
    if (path === '/health/live') {
      return Response.json({ status: 'alive', service: 'proofpilot-worker', port: PORT }, { headers })
    }

    // Health: readiness (DB ping + queue stats)
    if (path === '/health/ready') {
      try {
        await db.$queryRaw`SELECT 1`
        const waiting = await db.queueJob.count({ where: { status: 'WAITING' } })
        const active = await db.queueJob.count({ where: { status: 'ACTIVE' } })
        const failed = await db.queueJob.count({ where: { status: 'FAILED' } })
        return Response.json({
          status: 'ready',
          database: 'ok',
          queues: { waiting, active, failed },
          uptime: process.uptime(),
        }, { headers })
      } catch (err) {
        return Response.json({
          status: 'unhealthy',
          error: String(err),
        }, { status: 503, headers })
      }
    }

    // Status: detailed worker info
    if (path === '/status') {
      const queues = await db.queueJob.groupBy({
        by: ['queue', 'status'],
        _count: true,
        orderBy: { queue: 'asc' },
      })
      return Response.json({
        service: 'proofpilot-worker',
        version: '0.1.0',
        port: PORT,
        uptime: process.uptime(),
        queues: queues.map((q) => ({ queue: q.queue, status: q.status, count: q._count })),
      }, { headers })
    }

    // 404
    return Response.json(
      { error: 'Not found', path },
      { status: 404, headers },
    )
  },
  error(err) {
    logger.error('Worker HTTP server error', { error: String(err) })
    return new Response(JSON.stringify({ error: 'Internal error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  },
})

logger.info('ProofPilot worker started', {
  port: PORT,
  concurrency: env.WORKER_CONCURRENCY,
  appEnv: env.APP_ENV,
})

// ---- Start queue workers ----
const queues: QueueName[] = ['scan-orchestration', 'page-analysis', 'journey-execution']
for (const q of queues) {
  startWorker(q).catch((err) => {
    logger.error('Queue worker crashed', { queue: q, error: String(err) })
  })
}

// ---- Graceful shutdown ----
const shutdown = (signal: string) => {
  logger.info('Worker shutting down', { signal })
  server.stop()
  setTimeout(() => process.exit(0), 1000)
}
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
