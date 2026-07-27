/**
 * GET /api/v1/runs/[runId]/events
 *
 * Server-Sent Events stream of scan run events.
 *
 * Features:
 *   - Auth required (workspace member with runs.read).
 *   - Heartbeat comment every 15 seconds (keeps connection alive).
 *   - Reconnect with Last-Event-ID header: server replays events with sequence > Last-Event-ID.
 *   - Closes when run reaches a terminal state (COMPLETED, FAILED, CANCELLED).
 *   - In-process pub/sub delivers events instantly when the worker is in the same process;
 *     cross-process workers (separate Bun process) fall back to DB polling every 1s.
 *
 * Response format: standard SSE (`text/event-stream`).
 *   id: <sequence>
 *   event: <eventType>
 *   data: <json payload>
 */
import { db } from '@/lib/db'
import { problemResponse, newRequestId, NotFoundError } from '@/lib/errors'
import { listScanEvents, subscribeToRun, type ScanEventType } from '@/lib/scan-events'
import { requireWorkspaceAuth } from '@/lib/auth-context'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const HEARTBEAT_MS = 15_000
const POLL_INTERVAL_MS = 1_000
const MAX_LIFETIME_MS = 30 * 60 * 1000 // 30 minutes max per connection

interface SSEEvent {
  sequence: number
  eventType: ScanEventType
  payload: Record<string, unknown>
  createdAt: Date
}

function formatSSE(event: SSEEvent): string {
  const data = JSON.stringify({
    ...event.payload,
    _meta: {
      sequence: event.sequence,
      eventType: event.eventType,
      createdAt: event.createdAt.toISOString(),
    },
  })
  return `id: ${event.sequence}\nevent: ${event.eventType}\ndata: ${data}\n\n`
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ runId: string }> },
) {
  const requestId = request.headers.get('X-Request-Id') ?? newRequestId()
  const instance = new URL(request.url).pathname
  try {
    const { runId } = await params

    // Verify the run exists + the user can read it
    const run = await db.scanRun.findUnique({
      where: { id: runId },
      select: { id: true, workspaceId: true, status: true },
    })
    if (!run) throw new NotFoundError('Run')
    await requireWorkspaceAuth(run.workspaceId, 'runs.read')

    // Parse Last-Event-ID for reconnect
    const lastEventIdHeader = request.headers.get('Last-Event-ID')
    let lastSequence = 0
    if (lastEventIdHeader) {
      const parsed = parseInt(lastEventIdHeader, 10)
      if (Number.isInteger(parsed) && parsed >= 0) {
        lastSequence = parsed
      }
    }

    const encoder = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let closed = false
        const enqueue = (chunk: string) => {
          if (closed) return
          try {
            controller.enqueue(encoder.encode(chunk))
          } catch {
            closed = true
          }
        }

        // Send initial retry hint + replay missed events
        enqueue(`retry: 3000\n\n`)
        const startedAt = Date.now()
        let isTerminal = ['COMPLETED', 'FAILED', 'CANCELLED'].includes(run.status)

        // Replay any events since lastSequence
        ;(async () => {
          try {
            const replayed = await listScanEvents(runId, lastSequence)
            for (const e of replayed) {
              enqueue(formatSSE(e))
              lastSequence = e.sequence
            }
            // If the run is already terminal and we've sent all events, close after sending a final marker
            if (isTerminal) {
              enqueue(`event: stream.end\ndata: ${JSON.stringify({ runId, status: run.status })}\n\n`)
              controller.close()
              closed = true
              return
            }
          } catch (err) {
            enqueue(`event: stream.error\ndata: ${JSON.stringify({ error: String(err) })}\n\n`)
            controller.close()
            closed = true
            return
          }

          // Subscribe to in-process pub/sub (instant delivery if worker is same process)
          const unsubscribe = subscribeToRun(runId, (event) => {
            if (event.sequence <= lastSequence) return
            lastSequence = event.sequence
            enqueue(formatSSE(event))
            // Check if this is a terminal event
            if (['run.completed', 'run.failed', 'run.cancelled'].includes(event.eventType)) {
              enqueue(`event: stream.end\ndata: ${JSON.stringify({ runId, eventType: event.eventType })}\n\n`)
              controller.close()
              closed = true
            }
          })

          // Heartbeat
          const heartbeatTimer = setInterval(() => {
            if (closed) return
            enqueue(`:heartbeat ${Date.now()}\n\n`)
          }, HEARTBEAT_MS)

          // DB polling fallback (for cross-process worker)
          const pollTimer = setInterval(async () => {
            if (closed) return
            if (Date.now() - startedAt > MAX_LIFETIME_MS) {
              enqueue(`event: stream.timeout\ndata: ${JSON.stringify({ reason: 'max_lifetime_exceeded' })}\n\n`)
              controller.close()
              closed = true
              return
            }
            try {
              const newEvents = await listScanEvents(runId, lastSequence)
              for (const e of newEvents) {
                if (e.sequence <= lastSequence) continue
                lastSequence = e.sequence
                enqueue(formatSSE(e))
                if (['run.completed', 'run.failed', 'run.cancelled'].includes(e.eventType)) {
                  enqueue(`event: stream.end\ndata: ${JSON.stringify({ runId, eventType: e.eventType })}\n\n`)
                  controller.close()
                  closed = true
                  break
                }
              }
            } catch {
              // ignore transient poll errors
            }
          }, POLL_INTERVAL_MS)

          // Cleanup on cancel
          request.signal?.addEventListener('abort', () => {
            if (closed) return
            closed = true
            clearInterval(heartbeatTimer)
            clearInterval(pollTimer)
            unsubscribe()
            try {
              controller.close()
            } catch {
              // already closed
            }
          })
        })()
      },
    })

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
        'X-Request-Id': requestId,
      },
    })
  } catch (err) {
    return problemResponse(err, requestId, instance)
  }
}
