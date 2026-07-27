/**
 * POST   /api/v1/findings/[findingId]/transition
 *   Transition a finding's status. Validates against the state machine.
 *
 * Body:
 *   { "toStatus": "RESOLVED", "reason": "Fixed in commit abc123" }
 */
import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { requireWorkspaceAuth, getClientIp, getUserAgent } from '@/lib/auth-context'
import { transitionFinding } from '@/lib/findings-service'
import { STATUSES, type FindingStatus } from '@/lib/finding-severity'
import { db } from '@/lib/db'
import { problemResponse, newRequestId, NotFoundError } from '@/lib/errors'

export const dynamic = 'force-dynamic'

const schema = z.object({
  toStatus: z.enum(STATUSES as [FindingStatus, ...FindingStatus[]]),
  reason: z.string().max(500).optional(),
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
    const body = schema.parse(JSON.parse(text || '{}'))

    const result = await transitionFinding(
      findingId,
      finding.workspaceId,
      body.toStatus,
      {
        userId: auth.userId,
        reason: body.reason,
        audit: {
          ip: getClientIp(request as never),
          userAgent: getUserAgent(request as never),
          requestId,
          workspaceId: finding.workspaceId,
        },
      },
    )

    return NextResponse.json(result, { headers: { 'X-Request-Id': requestId } })
  } catch (err) {
    return problemResponse(err, requestId, instance)
  }
}
