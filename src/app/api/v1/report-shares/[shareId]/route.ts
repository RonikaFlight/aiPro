/**
 * DELETE /api/v1/report-shares/[shareId]
 *
 * Revoke a share link. The share still exists in the database for audit
 * purposes but access is immediately denied.
 *
 * Permission: `runs.read` (member of the share's workspace).
 *
 * Response 200:
 *   { "success": true, "revokedAt": "2024-01-15T10:00:00.000Z" }
 *
 * 404 if the share does not exist or is not in the workspace.
 * 422 if the share is already revoked.
 */
import { NextResponse, type NextRequest } from 'next/server'
import { assertCsrf } from '@/lib/csrf'
import { requireWorkspaceAuth, getClientIp, getUserAgent } from '@/lib/auth-context'
import { revokeShare } from '@/lib/reports/secure-sharing'
import { db } from '@/lib/db'
import { problemResponse, newRequestId, NotFoundError } from '@/lib/errors'

export const dynamic = 'force-dynamic'

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ shareId: string }> },
) {
  const requestId = request.headers.get('X-Request-Id') ?? newRequestId()
  const instance = new URL(request.url).pathname
  try {
    assertCsrf(request)
    const { shareId } = await params

    // Look up share to find the workspace
    const share = await db.reportShare.findUnique({
      where: { id: shareId },
      include: {
        report: { select: { workspaceId: true } },
      },
    })
    if (!share) throw new NotFoundError('Share')

    const auth = await requireWorkspaceAuth(share.report.workspaceId, 'runs.read')

    await revokeShare(shareId, share.report.workspaceId, auth.userId, {
      ip: getClientIp(request as never),
      userAgent: getUserAgent(request as never),
      requestId,
      actorId: auth.userId,
      workspaceId: share.report.workspaceId,
    })

    return NextResponse.json(
      { success: true, revokedAt: new Date().toISOString() },
      { headers: { 'X-Request-Id': requestId } },
    )
  } catch (err) {
    return problemResponse(err, requestId, instance)
  }
}
