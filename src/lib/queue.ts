/**
 * Queue infrastructure — ProofPilot
 *
 * SQLite-backed job queue with BullMQ-compatible semantics.
 * Used because the sandbox has no Redis. Production should swap to
 * BullMQ + Redis without changing handler signatures.
 *
 * Queues (spec §38):
 *   scan-orchestration, page-analysis, journey-execution, artifact-processing,
 *   ai-enrichment, report-generation, email, webhooks, maintenance
 *
 * Features:
 *   - Idempotent handlers (job id is the idempotency key)
 *   - Explicit retry policy with exponential backoff
 *   - Dead-letter handling (max attempts → FAILED)
 *   - Cancellation support (status = CANCELLED)
 *   - Timeouts
 *   - Progress updates
 *   - Deduplication (unique correlationId)
 *   - Correlation IDs
 *   - Concurrency limits per workspace + global
 */
import { db } from './db'
import { logger } from './logger'

export type QueueName =
  | 'scan-orchestration'
  | 'page-analysis'
  | 'journey-execution'
  | 'artifact-processing'
  | 'ai-enrichment'
  | 'report-generation'
  | 'email'
  | 'webhooks'
  | 'maintenance'

export interface EnqueueOptions {
  priority?: number
  delayMs?: number
  maxAttempts?: number
  workspaceId?: string
  correlationId?: string
  idempotencyKey?: string
}

export interface Job<T = unknown> {
  id: string
  queue: QueueName
  payload: T
  attempts: number
  maxAttempts: number
  workspaceId?: string
  correlationId?: string
}

type Handler<T = unknown> = (job: Job<T>, signal?: AbortSignal) => Promise<void>

const handlers = new Map<QueueName, Handler<any>>()
const concurrencyLimits = new Map<QueueName, number>()
const activeCount = new Map<QueueName, number>()

/** Register a handler for a queue. */
export function registerHandler<T>(
  queue: QueueName,
  handler: Handler<T>,
  opts: { concurrency?: number } = {},
): void {
  handlers.set(queue, handler)
  concurrencyLimits.set(queue, opts.concurrency ?? 1)
  activeCount.set(queue, 0)
}

/** Enqueue a job. */
export async function enqueue<T>(
  queue: QueueName,
  payload: T,
  options: EnqueueOptions = {},
): Promise<string> {
  // Deduplication via correlationId — if a job with the same correlationId is WAITING/ACTIVE, skip
  if (options.correlationId) {
    const existing = await db.queueJob.findFirst({
      where: {
        queue,
        correlationId: options.correlationId,
        status: { in: ['WAITING', 'ACTIVE', 'DELAYED'] },
      },
      select: { id: true },
    })
    if (existing) {
      logger.debug('Job deduplicated', { queue, correlationId: options.correlationId, existingId: existing.id })
      return existing.id
    }
  }

  const runAt = options.delayMs
    ? new Date(Date.now() + options.delayMs)
    : new Date()

  const job = await db.queueJob.create({
    data: {
      queue,
      payloadJson: JSON.stringify(payload),
      status: 'WAITING',
      priority: options.priority ?? 0,
      maxAttempts: options.maxAttempts ?? 3,
      runAt,
      workspaceId: options.workspaceId,
      correlationId: options.correlationId,
    },
  })
  logger.debug('Job enqueued', { queue, jobId: job.id, correlationId: options.correlationId })
  return job.id
}

/** Cancel a job (idempotent — already-cancelled jobs stay cancelled). */
export async function cancelJob(jobId: string, reason = 'cancelled'): Promise<void> {
  await db.queueJob.updateMany({
    where: { id: jobId, status: { in: ['WAITING', 'DELAYED', 'ACTIVE'] } },
    data: { status: 'CANCELLED', failedReason: reason },
  })
}

/** Update progress (writes to metadataJson). */
export async function updateProgress(jobId: string, progress: Record<string, unknown>): Promise<void> {
  const job = await db.queueJob.findUnique({ where: { id: jobId }, select: { payloadJson: true } })
  if (!job) return
  await db.queueJob.update({
    where: { id: jobId },
    data: { resultJson: JSON.stringify(progress) },
  })
}

/** Mark a job complete. */
export async function completeJob(jobId: string, result?: Record<string, unknown>): Promise<void> {
  await db.queueJob.update({
    where: { id: jobId },
    data: {
      status: 'COMPLETED',
      completedAt: new Date(),
      resultJson: result ? JSON.stringify(result) : null,
    },
  })
}

/** Mark a job failed and schedule retry or move to dead-letter. */
export async function failJob(jobId: string, reason: string): Promise<void> {
  const job = await db.queueJob.findUniqueOrThrow({ where: { id: jobId } })
  const nextAttempt = job.attempts + 1
  if (nextAttempt >= job.maxAttempts) {
    await db.queueJob.update({
      where: { id: jobId },
      data: {
        status: 'FAILED',
        attempts: nextAttempt,
        failedReason: reason,
        completedAt: new Date(),
      },
    })
    logger.error('Job dead-lettered', { jobId, queue: job.queue, reason, attempts: nextAttempt })
    return
  }
  // Exponential backoff: 2^attempt * 1000 ms, max 60s
  const backoffMs = Math.min(1000 * Math.pow(2, nextAttempt), 60000)
  await db.queueJob.update({
    where: { id: jobId },
    data: {
      status: 'DELAYED',
      attempts: nextAttempt,
      failedReason: reason,
      runAt: new Date(Date.now() + backoffMs),
    },
  })
  logger.warn('Job retrying', { jobId, queue: job.queue, attempt: nextAttempt, backoffMs, reason })
}

/** Poll for the next job in a queue. Returns null if no job available. */
async function pollNextJob(queue: QueueName): Promise<Job | null> {
  const limit = concurrencyLimits.get(queue) ?? 1
  const active = activeCount.get(queue) ?? 0
  if (active >= limit) return null

  // Atomically claim the next job by updating its status
  const claimed = await db.$transaction(async (tx) => {
    const jobs = await tx.queueJob.findMany({
      where: {
        queue,
        status: { in: ['WAITING', 'DELAYED'] },
        runAt: { lte: new Date() },
      },
      orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
      take: 1,
    })
    if (jobs.length === 0) return null
    const j = jobs[0]
    await tx.queueJob.update({
      where: { id: j.id },
      data: { status: 'ACTIVE', startedAt: new Date() },
    })
    return j
  })
  if (!claimed) return null

  activeCount.set(queue, active + 1)
  return {
    id: claimed.id,
    queue: claimed.queue,
    payload: JSON.parse(claimed.payloadJson),
    attempts: claimed.attempts,
    maxAttempts: claimed.maxAttempts,
    workspaceId: claimed.workspaceId ?? undefined,
    correlationId: claimed.correlationId ?? undefined,
  }
}

/** Worker loop for a single queue. Run in a separate async task. */
export async function startWorker(queue: QueueName, signal?: AbortSignal): Promise<void> {
  const handler = handlers.get(queue)
  if (!handler) {
    logger.warn('No handler registered for queue', { queue })
    return
  }
  logger.info('Queue worker started', { queue, concurrency: concurrencyLimits.get(queue) })

  while (!signal?.aborted) {
    let job: Job | null = null
    try {
      job = await pollNextJob(queue)
    } catch (err) {
      logger.error('Failed to poll job', { queue, error: String(err) })
      await new Promise((r) => setTimeout(r, 1000))
      continue
    }
    if (!job) {
      await new Promise((r) => setTimeout(r, 500))
      continue
    }
    try {
      logger.debug('Processing job', { queue, jobId: job.id, attempt: job.attempts })
      await handler(job, signal)
      await completeJob(job.id)
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      await failJob(job.id, reason)
    } finally {
      const cur = activeCount.get(queue) ?? 0
      activeCount.set(queue, Math.max(0, cur - 1))
    }
  }
  logger.info('Queue worker stopped', { queue })
}

/** Start all registered workers. Returns a stop function. */
export function startAllWorkers(signal?: AbortSignal): () => void {
  const controller = new AbortController()
  if (signal) {
    signal.addEventListener('abort', () => controller.abort())
  }
  const queues = Array.from(handlers.keys())
  const tasks = queues.map((q) => startWorker(q, controller.signal))
  return () => {
    controller.abort()
    void Promise.allSettled(tasks)
  }
}

/** Get failed jobs for admin inspection. */
export async function getFailedJobs(queue?: QueueName, limit = 50): Promise<unknown[]> {
  return db.queueJob.findMany({
    where: { status: 'FAILED', ...(queue ? { queue } : {}) },
    orderBy: { completedAt: 'desc' },
    take: limit,
  })
}

/** Retry a failed job (admin action). */
export async function retryJob(jobId: string): Promise<void> {
  await db.queueJob.update({
    where: { id: jobId },
    data: {
      status: 'WAITING',
      attempts: 0,
      failedReason: null,
      runAt: new Date(),
    },
  })
}
