import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getWorkspace, updateWorkspace } from '@/lib/workspace-service'
import { requireAuth, getClientIp, getUserAgent } from '@/lib/auth-context'
import { assertCsrf } from '@/lib/csrf'
import { problemResponse, newRequestId } from '@/lib/errors'

const Body = z.object({
  name: z.string().min(2).max(100).optional(),
  logoUrl: z.string().url().optional(),
  accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  brandName: z.string().max(100).optional(),
  brandIntro: z.string().max(2000).optional(),
  brandFooter: z.string().max(500).optional(),
  retentionDays: z.number().int().min(1).max(365).optional(),
})

export const dynamic = 'force-dynamic'

export async function GET(
  request: Request,
  { params }: { params: Promise<{ workspaceId: string }> },
) {
  const requestId = request.headers.get('X-Request-Id') ?? newRequestId()
  try {
    const auth = await requireAuth()
    const { workspaceId } = await params
    const workspace = await getWorkspace(workspaceId, auth.userId)
    return NextResponse.json(workspace)
  } catch (err) {
    return problemResponse(err, requestId, new URL(request.url).pathname)
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ workspaceId: string }> },
) {
  const requestId = request.headers.get('X-Request-Id') ?? newRequestId()
  const instance = new URL(request.url).pathname
  try {
    assertCsrf(request)
    const auth = await requireAuth()
    const { workspaceId } = await params
    const text = await request.text()
    const body = Body.parse(JSON.parse(text || '{}'))
    const workspace = await updateWorkspace(workspaceId, auth.userId, body, {
      ip: getClientIp(request as any),
      userAgent: getUserAgent(request as any),
      requestId,
    })
    return NextResponse.json(workspace)
  } catch (err) {
    return problemResponse(err, requestId, instance)
  }
}
