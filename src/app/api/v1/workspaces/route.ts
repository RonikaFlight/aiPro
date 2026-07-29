import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createWorkspace, listWorkspacesForUser } from '@/lib/workspace-service'
import { requireAuth, getClientIp, getUserAgent } from '@/lib/auth-context'
import { assertCsrf } from '@/lib/csrf'
import { problemResponse, newRequestId } from '@/lib/errors'

const Body = z.object({
  name: z.string().min(2).max(100),
  slug: z.string().min(2).max(50).optional(),
})

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  const requestId = request.headers.get('X-Request-Id') ?? newRequestId()
  try {
    const auth = await requireAuth()
    const workspaces = await listWorkspacesForUser(auth.userId)
    return NextResponse.json({ items: workspaces, total: workspaces.length })
  } catch (err) {
    return problemResponse(err, requestId, new URL(request.url).pathname)
  }
}

export async function POST(request: Request) {
  const requestId = request.headers.get('X-Request-Id') ?? newRequestId()
  const instance = new URL(request.url).pathname
  try {
    assertCsrf(request)
    const auth = await requireAuth()
    const text = await request.text()
    const body = Body.parse(JSON.parse(text || '{}'))
    const workspace = await createWorkspace(body, auth.userId, {
      ip: getClientIp(request),
      userAgent: getUserAgent(request),
      requestId,
    })
    return NextResponse.json(workspace, { status: 201 })
  } catch (err) {
    return problemResponse(err, requestId, instance)
  }
}
