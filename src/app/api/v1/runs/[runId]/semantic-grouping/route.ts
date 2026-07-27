/**
 * POST /api/v1/runs/[runId]/semantic-grouping
 *
 * Generate (or return cached) AI semantic grouping for a completed scan run.
 * Groups related findings by shared root cause so the report can present
 * "one underlying issue" instead of listing every duplicate individually.
 *
 * Body (optional):
 *   { "force": false }   — when true, regenerate even if a grouping exists.
 *
 * Permission: `runs.read` (any workspace member).
 *
 * Response 200:
 *   {
 *     "runId": "...",
 *     "cached": false,
 *     "skipped": false,
 *     "grouping": {
 *       "groups": [
 *         {
 *           "groupId": "a11y-missing-labels",
 *           "label": "Missing form labels",
 *           "findingIds": ["clx..."],
 *           "sharedRootCause": "All form controls lack associated labels"
 *         }
 *       ]
 *     },
 *     "aiSemanticGroupingJson": "{...json...}",
 *     "provider": "mock" | "glm" | "openai-compatible",
 *     "model": "...",
 *     "promptVersion": "1.0.0",
 *     "generatedAt": "2024-..."
 *   }
 */
import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { requireWorkspaceAuth, getClientIp, getUserAgent } from '@/lib/auth-context'
import { generateSemanticGrouping } from '@/lib/ai/semantic-grouping'
import { db } from '@/lib/db'
import { problemResponse, newRequestId, NotFoundError } from '@/lib/errors'

export const dynamic = 'force-dynamic'

const bodySchema = z.object({
  force: z.boolean().optional().default(false),
})

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ runId: string }> },
) {
  const requestId = request.headers.get('X-Request-Id') ?? newRequestId()
  const instance = new URL(request.url).pathname
  try {
    const { runId } = await params
    const run = await db.scanRun.findUnique({
      where: { id: runId },
      select: { workspaceId: true },
    })
    if (!run) {
      throw new NotFoundError('Run')
    }
    const auth = await requireWorkspaceAuth(run.workspaceId, 'runs.read')

    const text = await request.text()
    const body = bodySchema.parse(JSON.parse(text || '{}'))

    const result = await generateSemanticGrouping(runId, {
      workspaceId: run.workspaceId,
      force: body.force,
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
