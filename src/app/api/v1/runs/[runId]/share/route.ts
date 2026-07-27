/**
 * POST /api/v1/runs/[runId]/share
 *
 * Create a secure share link for a run's report.
 *
 * Permission: `runs.read` (any member who can view the run can create a share).
 *
 * Body:
 *   {
 *     "shareType": "TECHNICAL" | "CLIENT",      // required
 *     "password": "string?",                    // optional, min 8 chars
 *     "expiresAt": "ISO-8601 datetime?",         // optional, must be future
 *     "emailRestriction": "email?",             // optional, valid email
 *   }
 *
 * Response 200:
 *   {
 *     "shareId": "clx...",
 *     "token": "base64url-encoded-256-bit-token",
 *     "expiresAt": "2024-12-31T23:59:59.000Z" | null,
 *     "emailRestriction": "client@example.com" | null,
 *     "hasPassword": false,
 *     "createdAt": "2024-01-15T10:00:00.000Z"
 *   }
 *
 * IMPORTANT: The `token` field is returned ONLY at creation time.
 * It cannot be recovered later. Store it securely.
 *
 * 404 if the run does not exist in the workspace.
 * 422 if validation fails.
 */
import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { assertCsrf } from '@/lib/csrf'
import { requireWorkspaceAuth, getClientIp, getUserAgent } from '@/lib/auth-context'
import { createShare, type ShareType } from '@/lib/reports/secure-sharing'
import { db } from '@/lib/db'
import { problemResponse, newRequestId, NotFoundError } from '@/lib/errors'

export const dynamic = 'force-dynamic'

const createShareSchema = z.object({
  shareType: z.enum(['TECHNICAL', 'CLIENT']),
  password: z.string().min(8).max(128).optional(),
  expiresAt: z.string().datetime().optional(),
  emailRestriction: z.string().email().max(254).optional(),
})

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ runId: string }> },
) {
  const requestId = request.headers.get('X-Request-Id') ?? newRequestId()
  const instance = new URL(request.url).pathname
  try {
    assertCsrf(request)
    const { runId } = await params
    const run = await db.scanRun.findUnique({
      where: { id: runId },
      select: { workspaceId: true },
    })
    if (!run) throw new NotFoundError('Run')
    const auth = await requireWorkspaceAuth(run.workspaceId, 'runs.read')

    const text = await request.text()
    const body = createShareSchema.parse(JSON.parse(text || '{}'))

    const result = await createShare({
      runId,
      workspaceId: run.workspaceId,
      userId: auth.userId,
      shareType: body.shareType as ShareType,
      password: body.password,
      expiresAt: body.expiresAt ? new Date(body.expiresAt) : undefined,
      emailRestriction: body.emailRestriction,
      auditCtx: {
        ip: getClientIp(request as never),
        userAgent: getUserAgent(request as never),
        requestId,
        actorId: auth.userId,
        workspaceId: run.workspaceId,
      },
    })

    return NextResponse.json(result, { headers: { 'X-Request-Id': requestId } })
  } catch (err) {
    return problemResponse(err, requestId, instance)
  }
}
