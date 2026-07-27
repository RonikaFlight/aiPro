/**
 * Scan run events — ProofPilot
 *
 * Persistent event log (ScanRunEvent) with an in-process pub/sub layer
 * so SSE consumers in the SAME Next.js process can subscribe without polling.
 * Cross-process consumers (separate worker) fall back to DB polling.
 *
 * Each event gets a monotonic per-run sequence number for SSE Last-Event-ID support.
 */
import { db } from './db'
import { logger } from './logger'

export type ScanEventType =
  | 'run.queued'
  | 'run.validating'
  | 'run.authorized'
  | 'run.crawling'
  | 'run.analyzing'
  | 'run.generating_report'
  | 'run.completed'
  | 'run.failed'
  | 'run.cancelled'
  | 'run.scored'
  | 'run.summarized'
  | 'page.discovered'
  | 'page.analyzing'
  | 'page.analyzed'
  | 'page.analysis_completed'
  | 'page.analysis_failed'
  | 'page.failed'
  | 'finding.discovered'
  | 'finding.reopened'
  | 'finding.transition'
  | 'finding.comment_added'
  | 'finding.suppressed'
  | 'finding.unsuppressed'
  | 'finding.explained'
  | 'finding.categorized'
  | 'analyzer.failed'
  | 'journey.queued'
  | 'journey.started'
  | 'journey.step'
  | 'journey.step.passed'
  | 'journey.step.failed'
  | 'journey.step.skipped'
  | 'journey.completed'
  | 'journey.failed'
  | 'journey.cancelled'
  | 'artifact.created'
  | 'progress'

export interface ScanEventPayload {
  [key: string]: unknown
}

type Subscriber = (event: { runId: string; sequence: number; eventType: ScanEventType; payload: ScanEventPayload; createdAt: Date }) => void

const subscribers = new Map<string /* runId */, Set<Subscriber>>()

/** Subscribe to live events for a run. Returns an unsubscribe function. */
export function subscribeToRun(runId: string, fn: Subscriber): () => void {
  let set = subscribers.get(runId)
  if (!set) {
    set = new Set()
    subscribers.set(runId, set)
  }
  set.add(fn)
  return () => {
    const s = subscribers.get(runId)
    if (s) {
      s.delete(fn)
      if (s.size === 0) subscribers.delete(runId)
    }
  }
}

/**
 * Append a scan event. Persists to DB (always) and broadcasts to in-process
 * subscribers (so SSE consumers in the same process get push notifications).
 *
 * Sequence numbers are monotonic per-run, starting at 1.
 */
export async function appendScanEvent(
  runId: string,
  eventType: ScanEventType,
  payload: ScanEventPayload = {},
): Promise<{ runId: string; sequence: number; eventType: ScanEventType; payload: ScanEventPayload; createdAt: Date }> {
  // Compute next sequence atomically
  const last = await db.scanRunEvent.findFirst({
    where: { runId },
    orderBy: { sequence: 'desc' },
    select: { sequence: true },
  })
  const sequence = (last?.sequence ?? 0) + 1

  const created = await db.scanRunEvent.create({
    data: {
      runId,
      eventType,
      payloadJson: JSON.stringify(payload),
      sequence,
    },
  })

  const event = {
    runId,
    sequence,
    eventType,
    payload,
    createdAt: created.createdAt,
  }

  // Broadcast to in-process subscribers (best-effort — no await)
  const set = subscribers.get(runId)
  if (set) {
    for (const fn of set) {
      try {
        fn(event)
      } catch (err) {
        logger.warn('Scan event subscriber threw', { runId, error: String(err) })
      }
    }
  }

  return event
}

/** List events for a run, optionally starting after a given sequence (for SSE reconnect). */
export async function listScanEvents(
  runId: string,
  afterSequence = 0,
  limit = 500,
): Promise<Array<{ runId: string; sequence: number; eventType: ScanEventType; payload: ScanEventPayload; createdAt: Date }>> {
  const rows = await db.scanRunEvent.findMany({
    where: { runId, sequence: { gt: afterSequence } },
    orderBy: { sequence: 'asc' },
    take: Math.min(limit, 1000),
  })
  return rows.map((r) => ({
    runId: r.runId,
    sequence: r.sequence,
    eventType: r.eventType as ScanEventType,
    payload: JSON.parse(r.payloadJson) as ScanEventPayload,
    createdAt: r.createdAt,
  }))
}
