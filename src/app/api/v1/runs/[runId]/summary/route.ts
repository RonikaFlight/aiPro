/**
 * GET  /api/v1/runs/[runId]/summary
 *   Return the cached AI run summary if one has been generated.
 *   404 if no summary exists yet (client should POST to generate).
 *
 * POST /api/v1/runs/[runId]/summary
 *   Generate (or return cached) an AI summary for a completed scan run.
 *
 *   Body (optional):
 *     { "force": false }   — when true, regenerate even if a summary exists.
 *
 *   Permission: `runs.read` (any member who can view the run may request its
 *   summary — generation is an enrichment, not a state mutation, and writes
 *   only to the run's AI-cache columns).
 *
 *   Response 200 (POST):
 *     {
 *       "runId": "...",
 *       "cached": false,
 *       "skipped": false,
 *       "summary": {
 *         "executiveSummary": "...",
 *         "topIssues": [{ "category": "ACCESSIBILITY", "count": 2, "severity": "CRITICAL" }],
 *         "deliveryReadiness": "NEEDS_WORK",
 *         "recommendation": "..."
 *       },
 *       "aiSummary": "...",
 *       "aiSummaryJson": "{...json...}",
 *       "provider": "mock" | "glm" | "openai-compatible",
 *       "model": "...",
 *       "promptVersion": "1.0.0",
 *       "generatedAt": "2024-..."
 *     }
 *
 *   422 if the run is still QUEUED/RUNNING (wait for analysis to finish).
 *
 * The call is synchronous: the AI task runs inline (bounded by AI_TIMEOUT_MS,
 * default 30s). The Mock provider returns instantly; real providers may take
 * several seconds. For background generation, the worker auto-enqueues an
 * ai-enrichment job when the run's last page is analyzed (see page-analysis.ts).
 */
import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { assertCsrf } from '@/lib/csrf'
import { requireWorkspaceAuth, getClientIp, getUserAgent } from '@/lib/auth-context'
import { generateRunSummary } from '@/lib/ai/run-summaries'
import { db } from '@/lib/db'
import { problemResponse, newRequestId, NotFoundError } from '@/lib/errors'

export const dynamic = 'force-dynamic'

const bodySchema = z.object({
  force: z.boolean().optional().default(false),
})

/** Best-effort parse of the stored structured summary for the GET response. */
function parseStoredSummary(stored: string | null): {
  executiveSummary: string
  topIssues: Array<{ category: string; count: number; severity: string }>
  deliveryReadiness: string
  recommendation: string
} | null {
  if (!stored) return null
  try {
    const obj = JSON.parse(stored) as Record<string, unknown>
    if (
      typeof obj.executiveSummary === 'string' &&
      Array.isArray(obj.topIssues) &&
      typeof obj.deliveryReadiness === 'string' &&
      typeof obj.recommendation === 'string'
    ) {
      return {
        executiveSummary: obj.executiveSummary,
        topIssues: obj.topIssues as Array<{ category: string; count: number; severity: string }>,
        deliveryReadiness: obj.deliveryReadiness,
        recommendation: obj.recommendation,
      }
    }
    return null
  } catch {
    return null
  }
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ runId: string }> },
) {
  const requestId = request.headers.get('X-Request-Id') ?? newRequestId()
  const instance = new URL(request.url).pathname
  try {
    const { runId } = await params
    const run = await db.scanRun.findUnique({
      where: { id: runId },
      select: { workspaceId: true, aiSummary: true, aiSummaryJson: true },
    })
    if (!run) throw new NotFoundError('Run')
    await requireWorkspaceAuth(run.workspaceId, 'runs.read')

    const summary = parseStoredSummary(run.aiSummaryJson)
    if (!summary) {
      // No cached summary — tell the client to POST to generate one.
      return NextResponse.json(
        {
          runId,
          summary: null,
          aiSummary: null,
          generated: false,
          message: 'No AI summary has been generated yet. POST to this endpoint to generate one.',
        },
        { status: 404, headers: { 'X-Request-Id': requestId } },
      )
    }

    return NextResponse.json(
      {
        runId,
        summary,
        aiSummary: run.aiSummary,
        generated: true,
      },
      { headers: { 'X-Request-Id': requestId } },
    )
  } catch (err) {
    return problemResponse(err, requestId, instance)
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ runId: string }> },
) {
  const requestId = request.headers.get('X-Request-Id') ?? newRequestId()
  const instance = new URL(request.url).pathname
  try {
    assertCsrf(request)
    const { runId } = await params
    const run = await db.scanRun.findUnique({
      where: { id: runId },
      select: { workspaceId: true, projectId: true },
    })
    if (!run) throw new NotFoundError('Run')
    const auth = await requireWorkspaceAuth(run.workspaceId, 'runs.read')

    const text = await request.text()
    const body = bodySchema.parse(JSON.parse(text || '{}'))

    const result = await generateRunSummary(runId, {
      workspaceId: run.workspaceId,
      force: body.force,
      projectId: run.projectId,
      userId: auth.userId,
      audit: {
        ip: getClientIp(request as never),
        userAgent: getUserAgent(request as never),
        requestId,
        workspaceId: run.workspaceId,
      },
    })

    return NextResponse.json(result, { headers: { 'X-Request-Id': requestId } })
  } catch (err) {
    return problemResponse(err, requestId, instance)
  }
}
