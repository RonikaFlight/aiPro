/**
 * GET /api/v1/runs/[runId]/shares
 *
 * List all shares for a run (both TECHNICAL and CLIENT types).
 *
 * Permission: `runs.read`
 *
 * Response 200:
 *   {
 *     "shares": [
 *       {
 *         "id": "...",
 *         "reportId": "...",
 *         "shareType": "TECHNICAL",
 *         "expiresAt": null,
 *         "emailRestriction": null,
 *         "hasPassword": false,
 *         "viewCount": 5,
 *         "lastViewedAt": "2024-01-15T10:00:00.000Z",
 *         "revokedAt": null,
 *         "createdAt": "2024-01-15T09:00:00.000Z",
 *         "createdBy": { "id": "...", "name": "John", "email": "john@example.com" }
 *       }
 *     ]
 *   }
 */
import { NextResponse, type NextRequest } from 'next/server'
import { requireWorkspaceAuth } from '@/lib/auth-context'
import { listShares } from '@/lib/reports/secure-sharing'
import { db } from '@/lib/db'
import { problemResponse, newRequestId, NotFoundError } from '@/lib/errors'

export const dynamic = 'force-dynamic'

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
      select: { workspaceId: true },
    })
    if (!run) throw new NotFoundError('Run')
    await requireWorkspaceAuth(run.workspaceId, 'runs.read')

    const result = await listShares(runId, run.workspaceId)

    return NextResponse.json(result, { headers: { 'X-Request-Id': requestId } })
  } catch (err) {
    return problemResponse(err, requestId, instance)
  }
}
