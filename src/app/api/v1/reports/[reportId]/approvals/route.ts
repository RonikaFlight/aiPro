/**
 * GET /api/v1/reports/[reportId]/approvals
 *
 * List approval decisions for a report.
 * Returns cursor-paginated list with approver name/email.
 *
 * Permission: `reports.read` (any member who can view reports).
 *
 * Query params:
 *   ?limit=20       // 1-50, default 20
 *   ?cursor=clx...   // cursor for next page
 *
 * Response 200:
 *   {
 *     "decisions": [
 *       {
 *         "id": "clx...",
 *         "approverId": "clx...",
 *         "approverName": "Jane Doe",
 *         "approverEmail": "jane@example.com",
 *         "approved": true,
 *         "comment": "Looks good",
 *         "createdAt": "2024-01-15T10:00:00.000Z"
 *       }
 *     ],
 *     "totalCount": 5,
 *     "nextCursor": "clx..." | null
 *   }
 *
 * 404 if the report does not exist in the workspace.
 */
import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { requireWorkspaceAuth } from '@/lib/auth-context'
import { listApprovals } from '@/lib/reports/approval-service'
import { db } from '@/lib/db'
import { problemResponse, newRequestId, NotFoundError } from '@/lib/errors'

export const dynamic = 'force-dynamic'

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).optional(),
  cursor: z.string().optional(),
})

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ reportId: string }> },
) {
  const requestId = request.headers.get('X-Request-Id') ?? newRequestId()
  const instance = new URL(request.url).pathname
  try {
    const { reportId } = await params

    const report = await db.report.findUnique({
      where: { id: reportId },
      select: { workspaceId: true },
    })
    if (!report) throw new NotFoundError('Report')

    const auth = await requireWorkspaceAuth(report.workspaceId, 'reports.read')

    const searchParams = Object.fromEntries(new URL(request.url).searchParams)
    const query = querySchema.parse(searchParams)

    const result = await listApprovals({
      reportId,
      workspaceId: report.workspaceId,
      limit: query.limit,
      cursor: query.cursor,
    })

    return NextResponse.json(result, { headers: { 'X-Request-Id': requestId } })
  } catch (err) {
    return problemResponse(err, requestId, instance)
  }
}
