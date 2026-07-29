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
 * Run: `npx tsx --watch src/index.ts` (auto-restart on file changes)
 */
import http from 'node:http'
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
import { handleAiEnrichment } from './ai-enrichment'

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

// ai-enrichment handler — Phase 8: generates AI explanations for findings
// (and future AI-driven features). Idempotent + best-effort; AI calls can be
// slow so a dedicated queue keeps them off the scan-critical path.
registerHandler('ai-enrichment', handleAiEnrichment as never, {
  concurrency: 2, // AI enrichment is I/O-bound (waiting on a provider); allow 2 in parallel
})

// Stub for other queues so they don't pile up unprocessed — Phase 9+ will replace.
const stubQueues: QueueName[] = ['artifact-processing', 'report-generation', 'email', 'webhooks', 'maintenance']
for (const q of stubQueues) {
  registerHandler(
    q,
    async (job) => {
      logger.debug('Queue job acknowledged (stub)', { queue: q, jobId: job.id })
    },
    { concurrency: 1 },
  )
}

// ---- JSON helper ----
function jsonResponse(data: unknown, status = 200, extraHeaders: Record<string, string> = {}): Buffer {
  const body = JSON.stringify(data)
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Request-Id',
    ...extraHeaders,
  }
  const headerStr = Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\r\n')
  const head = `HTTP/1.1 ${status} ${status === 200 ? 'OK' : status === 204 ? 'No Content' : status === 404 ? 'Not Found' : status === 500 ? 'Internal Server Error' : 'Error'}\r\n${headerStr}\r\n\r\n`
  return Buffer.from(head + (status === 204 ? '' : body))
}

// ---- HTTP server ----
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://localhost:${PORT}`)
    const path = url.pathname

    // CORS preflight
    if (req.method === 'OPTIONS') {
      const buf = jsonResponse(null, 204)
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, X-Request-Id',
      })
      res.end()
      return
    }

    // Health: liveness
    if (path === '/health/live') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
      res.end(JSON.stringify({ status: 'alive', service: 'proofpilot-worker', port: PORT }))
      return
    }

    // Health: readiness (DB ping + queue stats)
    if (path === '/health/ready') {
      try {
        await db.$queryRaw`SELECT 1`
        const waiting = await db.queueJob.count({ where: { status: 'WAITING' } })
        const active = await db.queueJob.count({ where: { status: 'ACTIVE' } })
        const failed = await db.queueJob.count({ where: { status: 'FAILED' } })
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
        res.end(JSON.stringify({
          status: 'ready',
          database: 'ok',
          queues: { waiting, active, failed },
          uptime: process.uptime(),
        }))
      } catch (err) {
        res.writeHead(503, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
        res.end(JSON.stringify({ status: 'unhealthy', error: String(err) }))
      }
      return
    }

    // Status: detailed worker info
    if (path === '/status') {
      const queues = await db.queueJob.groupBy({
        by: ['queue', 'status'],
        _count: true,
        orderBy: { queue: 'asc' },
      })
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
      res.end(JSON.stringify({
        service: 'proofpilot-worker',
        version: '0.1.0',
        port: PORT,
        uptime: process.uptime(),
        queues: queues.map((q) => ({ queue: q.queue, status: q.status, count: q._count })),
      }))
      return
    }

    // 404
    res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
    res.end(JSON.stringify({ error: 'Not found', path }))
  } catch (err) {
    logger.error('Worker HTTP server error', { error: String(err) })
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Internal error' }))
    }
  }
})

server.listen(PORT, () => {
  logger.info('ProofPilot worker started', {
    port: PORT,
    concurrency: env.WORKER_CONCURRENCY,
    appEnv: env.APP_ENV,
  })
})

// ---- Start queue workers ----
const queues: QueueName[] = ['scan-orchestration', 'page-analysis', 'journey-execution', 'ai-enrichment']
for (const q of queues) {
  startWorker(q).catch((err) => {
    logger.error('Queue worker crashed', { queue: q, error: String(err) })
  })
}

// ---- Graceful shutdown ----
const shutdown = (signal: string) => {
  logger.info('Worker shutting down', { signal })
  server.close(() => {
    setTimeout(() => process.exit(0), 1000)
  })
}
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
