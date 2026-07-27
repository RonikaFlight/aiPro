/**
 * POST   /api/v1/findings/[findingId]/suppress
 *   Create a suppression scoped to this finding (and optionally to its
 *   fingerprint or checkId for cross-run coverage).
 *
 * Body:
 *   {
 *     "reason": "Not applicable to this project — false positive due to test fixture.",
 *     "scope": "finding" | "fingerprint" | "checkId" | "project_check",
 *     "expiresAt": "2025-12-31T00:00:00Z"   // optional
 *   }
 *
 * DELETE /api/v1/findings/[findingId]/suppress
 *   Revoke the finding's active suppression. (If multiple active suppressions
 *   exist, revokes the most recent one.)
 */
import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { requireWorkspaceAuth, getClientIp, getUserAgent } from '@/lib/auth-context'
import { createSuppression, revokeSuppression } from '@/lib/findings-service'
import { db } from '@/lib/db'
import { problemResponse, newRequestId, NotFoundError, ValidationError } from '@/lib/errors'

export const dynamic = 'force-dynamic'

const createSchema = z.object({
  reason: z.string().min(3).max(500),
  scope: z.enum(['finding', 'fingerprint', 'checkId', 'project_check']).default('finding'),
  expiresAt: z.string().datetime().optional(),
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
      select: { id: true, workspaceId: true, projectId: true, checkId: true, fingerprint: true },
    })
    if (!finding) {
      throw new NotFoundError('Finding')
    }
    const auth = await requireWorkspaceAuth(finding.workspaceId, 'findings.update')

    const text = await request.text()
    const body = createSchema.parse(JSON.parse(text || '{}'))

    // Map the requested scope to the suppression input.
    const isOwnerOrAdmin = auth.workspaceRole === 'OWNER' || auth.workspaceRole === 'ADMIN'

    // project_check scope (project-wide check suppression) requires owner/admin.
    if (body.scope === 'project_check' && !isOwnerOrAdmin) {
      throw new ValidationError('Project-wide check suppression requires OWNER or ADMIN role', {
        scope: ['Insufficient role'],
      })
    }

    const result = await createSuppression(
      finding.workspaceId,
      {
        // For 'finding' scope, only the findingId is set.
        // For 'fingerprint' scope, only the fingerprint is set.
        // For 'checkId' scope, findingId + checkId are set (so the
        //   suppression follows this finding's check across reopens).
        // For 'project_check' scope, projectId + checkId are set.
        findingId: body.scope === 'project_check' ? undefined : finding.id,
        projectId: body.scope === 'project_check' ? finding.projectId : undefined,
        checkId: body.scope === 'checkId' || body.scope === 'project_check' ? finding.checkId : undefined,
        fingerprint: body.scope === 'fingerprint' ? finding.fingerprint : undefined,
        reason: body.reason,
        expiresAt: body.expiresAt ?? null,
      },
      {
        userId: auth.userId,
        isOwnerOrAdmin,
        audit: {
          ip: getClientIp(request as never),
          userAgent: getUserAgent(request as never),
          requestId,
          workspaceId: finding.workspaceId,
        },
      },
    )

    return NextResponse.json({ suppression: result }, { status: 201, headers: { 'X-Request-Id': requestId } })
  } catch (err) {
    return problemResponse(err, requestId, instance)
  }
}

export async function DELETE(
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

    // Find the most recent active suppression for this finding.
    const active = await db.findingSuppression.findFirst({
      where: {
        findingId,
        revokedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    })
    if (!active) {
      throw new NotFoundError('Active suppression')
    }

    const result = await revokeSuppression(active.id, finding.workspaceId, {
      userId: auth.userId,
      audit: {
        ip: getClientIp(request as never),
        userAgent: getUserAgent(request as never),
        requestId,
        workspaceId: finding.workspaceId,
      },
    })

    return NextResponse.json({ suppression: result }, { headers: { 'X-Request-Id': requestId } })
  } catch (err) {
    return problemResponse(err, requestId, instance)
  }
}
