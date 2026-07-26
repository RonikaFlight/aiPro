import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createProject, listProjects } from '@/lib/project-service'
import { requireWorkspaceAuth, getClientIp, getUserAgent } from '@/lib/auth-context'
import { assertCsrf } from '@/lib/csrf'
import { problemResponse, newRequestId } from '@/lib/errors'

const Body = z.object({
  name: z.string().min(2).max(100),
  description: z.string().max(2000).optional(),
  productionUrl: z.string().url(),
  productType: z.enum(['web_app', 'ecommerce', 'marketing', 'dashboard']).optional(),
  primaryLocale: z.string().min(2).max(10).optional(),
  supportedLocales: z.array(z.string()).optional(),
  defaultTimezone: z.string().optional(),
  targetCustomer: z.string().max(500).optional(),
})

export const dynamic = 'force-dynamic'

export async function GET(
  request: Request,
  { params }: { params: Promise<{ workspaceId: string }> },
) {
  const requestId = request.headers.get('X-Request-Id') ?? newRequestId()
  try {
    const { workspaceId } = await params
    const auth = await requireWorkspaceAuth(workspaceId, 'projects.read')
    const projects = await listProjects(workspaceId, auth.userId)
    return NextResponse.json({ items: projects, total: projects.length })
  } catch (err) {
    return problemResponse(err, requestId, new URL(request.url).pathname)
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ workspaceId: string }> },
) {
  const requestId = request.headers.get('X-Request-Id') ?? newRequestId()
  const instance = new URL(request.url).pathname
  try {
    assertCsrf(request)
    const { workspaceId } = await params
    const auth = await requireWorkspaceAuth(workspaceId, 'projects.create')
    const text = await request.text()
    const body = Body.parse(JSON.parse(text || '{}'))
    const project = await createProject(workspaceId, body, auth.userId, auth.workspaceRole!, {
      ip: getClientIp(request as any),
      userAgent: getUserAgent(request as any),
      requestId,
    })
    return NextResponse.json(project, { status: 201 })
  } catch (err) {
    return problemResponse(err, requestId, instance)
  }
}
