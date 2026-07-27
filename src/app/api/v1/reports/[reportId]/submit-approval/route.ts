/**
 * POST /api/v1/reports/[reportId]/submit-approval
 *
 * Submit a report for approval.
 * Transitions report from DRAFT or READY → PENDING_APPROVAL.
 *
 * Permission: `reports.create` (any member who can create reports can submit).
 *
 * Response 200:
 *   {
 *     "reportId": "clx...",
 *     "status": "PENDING_APPROVAL"
 *   }
 *
 * 404 if the report does not exist in the workspace.
 * 422 if the report is not in a submittable status.
 */
import { NextResponse, type NextRequest } from 'next/server'
import { assertCsrf } from '@/lib/csrf'
import { requireWorkspaceAuth, getClientIp, getUserAgent } from '@/lib/auth-context'
import { submitForApproval } from '@/lib/reports/approval-service'
import { db } from '@/lib/db'
import { problemResponse, newRequestId, NotFoundError } from '@/lib/errors'

export const dynamic = 'force-dynamic'

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

    const auth = await requireWorkspaceAuth(report.workspaceId, 'reports.create')

    const result = await submitForApproval({
      reportId,
      workspaceId: report.workspaceId,
      userId: auth.userId,
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
