/**
 * POST /api/v1/findings/[findingId]/explanation
 *
 * Generate (or return cached) an AI explanation for a single finding.
 *
 * Body (optional):
 *   { "force": false }   — when true, regenerate even if an explanation exists.
 *
 * Permission: `findings.update` (OWNER / ADMIN / MEMBER). VIEWER / CLIENT can
 * read the cached explanation via GET /api/v1/findings/[findingId] but cannot
 * trigger generation.
 *
 * Response 200:
 *   {
 *     "findingId": "...",
 *     "cached": false,
 *     "skipped": false,
 *     "explanation": { "explanation": "...", "userImpact": "...", "rootCause": "..." },
 *     "aiSummary": "...",
 *     "aiExplanation": "{...json...}",
 *     "provider": "mock" | "glm" | "openai-compatible",
 *     "model": "...",
 *     "promptVersion": "1.0.0",
 *     "generatedAt": "2024-..."
 *   }
 *
 * The call is synchronous: the AI task runs inline (bounded by AI_TIMEOUT_MS,
 * default 30s). The Mock provider returns instantly; real providers may take
 * several seconds. For background generation, the worker auto-enqueues an
 * ai-enrichment job when a finding is first recorded (see finding-writer.ts).
 */
import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { requireWorkspaceAuth, getClientIp, getUserAgent } from '@/lib/auth-context'
import { generateFindingExplanation } from '@/lib/ai/finding-explanations'
import { db } from '@/lib/db'
import { problemResponse, newRequestId, NotFoundError } from '@/lib/errors'

export const dynamic = 'force-dynamic'

const bodySchema = z.object({
  force: z.boolean().optional().default(false),
})

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ findingId: string }> },
) {
  const requestId = request.headers.get('X-Request-Id') ?? newRequestId()
  const instance = new URL(request.url).pathname
  try {
    const { findingId } = await params
    const finding = await db.finding.findUnique({
      where: { id: findingId },
      select: { workspaceId: true },
    })
    if (!finding) {
      throw new NotFoundError('Finding')
    }
    const auth = await requireWorkspaceAuth(finding.workspaceId, 'findings.update')

    const text = await request.text()
    const body = bodySchema.parse(JSON.parse(text || '{}'))

    const result = await generateFindingExplanation(findingId, {
      workspaceId: finding.workspaceId,
      force: body.force,
      userId: auth.userId,
      audit: {
        ip: getClientIp(request as never),
        userAgent: getUserAgent(request as never),
        requestId,
        workspaceId: finding.workspaceId,
      },
    })

    return NextResponse.json(result, { headers: { 'X-Request-Id': requestId } })
  } catch (err) {
    return problemResponse(err, requestId, instance)
  }
}
