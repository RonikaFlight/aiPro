/**
 * POST /api/v1/reports/[reportId]/approve
 *
 * Approve a report that is pending approval.
 * Transitions report from PENDING_APPROVAL → READY.
 *
 * Permission: `reports.approve` (OWNER, ADMIN only).
 *
 * Body:
 *   {
 *     "comment": "string?"   // optional, max 2000 chars
 *   }
 *
 * Response 200:
 *   {
 *     "approvalId": "clx...",
 *     "reportId": "clx...",
 *     "status": "READY",
 *     "approved": true,
 *     "comment": "Looks good" | null
 *   }
 *
 * 404 if the report does not exist in the workspace.
 * 403 if the user lacks reports.approve permission.
 * 422 if the report is not in PENDING_APPROVAL status or user already voted.
 */
import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { assertCsrf } from '@/lib/csrf'
import { requireWorkspaceAuth, getClientIp, getUserAgent } from '@/lib/auth-context'
import { approveReport } from '@/lib/reports/approval-service'
import { db } from '@/lib/db'
import { problemResponse, newRequestId, NotFoundError } from '@/lib/errors'

export const dynamic = 'force-dynamic'

const approveSchema = z.object({
  comment: z.string().max(2000).optional(),
})

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ reportId: string }> },
) {
  const requestId = request.headers.get('X-Request-Id') ?? newRequestId()
  const instance = new URL(request.url).pathname
  try {
    assertCsrf(request)
    const { reportId } = await params

    const report = await db.report.findUnique({
      where: { id: reportId },
      select: { workspaceId: true },
    })
    if (!report) throw new NotFoundError('Report')

    const auth = await requireWorkspaceAuth(report.workspaceId, 'reports.approve')

    const text = await request.text()
    const body = approveSchema.parse(JSON.parse(text || '{}'))

    const result = await approveReport({
      reportId,
      workspaceId: report.workspaceId,
      userId: auth.userId,
      comment: body.comment,
      auditCtx: {
        ip: getClientIp(request as never),
        userAgent: getUserAgent(request as never),
        requestId,
        actorId: auth.userId,
        workspaceId: report.workspaceId,
      },
    })

    return NextResponse.json(result, { headers: { 'X-Request-Id': requestId } })
  } catch (err) {
    return problemResponse(err, requestId, instance)
  }
}
