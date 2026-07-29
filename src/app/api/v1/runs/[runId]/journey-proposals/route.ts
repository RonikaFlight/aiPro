/**
 * POST /api/v1/runs/[runId]/journey-proposals
 *
 * Generate (or return cached) an AI-proposed safe user journey for a completed
 * scan run. The proposal is validated against the same JourneyStepsSchema and
 * safe-action policy as hand-authored journeys. The user must explicitly
 * accept the proposal to create a Journey.
 *
 * Body (optional):
 *   { "force": false }   — when true, regenerate even if a proposal exists.
 *
 * Permission: `runs.read` (any workspace member).
 *
 * Response 200:
 *   {
 *     "runId": "...",
 *     "cached": false,
 *     "skipped": false,
 *     "proposal": {
 *       "name": "Homepage to Contact Form",
 *       "entryUrl": "https://example.com",
 *       "steps": [...],
 *       "rationale": "Tests the primary user flow from landing to form submission.",
 *       "policyValid": true,
 *       "stepsValid": true,
 *       "suggestedRunMode": "SAFE_INTERACTION"
 *     },
 *     "aiJourneyProposalJson": "{...json...}",
 *     "provider": "mock" | "glm" | "openai-compatible",
 *     "model": "...",
 *     "promptVersion": "1.0.0",
 *     "generatedAt": "2024-..."
 *   }
 */
import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { requireWorkspaceAuth, getClientIp, getUserAgent } from '@/lib/auth-context'
import { generateJourneyProposal } from '@/lib/ai/journey-proposals'
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

    const result = await generateJourneyProposal(runId, {
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
