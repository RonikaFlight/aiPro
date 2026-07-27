import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getProject, updateProject, deleteProject } from '@/lib/project-service'
import { requireAuth, getClientIp, getUserAgent } from '@/lib/auth-context'
import { assertCsrf } from '@/lib/csrf'
import { problemResponse, newRequestId } from '@/lib/errors'

const PatchBody = z.object({
  name: z.string().min(2).max(100).optional(),
  description: z.string().max(2000).optional(),
  productionUrl: z.string().url().optional(),
  productType: z.enum(['web_app', 'ecommerce', 'marketing', 'dashboard']).optional(),
  primaryLocale: z.string().min(2).max(10).optional(),
  supportedLocales: z.array(z.string()).optional(),
  defaultTimezone: z.string().optional(),
  targetCustomer: z.string().max(500).optional(),
  status: z.enum(['ACTIVE', 'ARCHIVED', 'DELETED']).optional(),
  retentionDays: z.number().int().min(1).max(365).optional(),
  brandLogoUrl: z.string().url().optional(),
  brandColors: z.string().optional(),
})

export const dynamic = 'force-dynamic'

export async function GET(
  request: Request,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const requestId = request.headers.get('X-Request-Id') ?? newRequestId()
  try {
    const auth = await requireAuth()
    const { projectId } = await params
    const project = await getProject(projectId, auth.userId)
    return NextResponse.json(project)
  } catch (err) {
    return problemResponse(err, requestId, new URL(request.url).pathname)
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const requestId = request.headers.get('X-Request-Id') ?? newRequestId()
  const instance = new URL(request.url).pathname
  try {
    assertCsrf(request)
    const auth = await requireAuth()
    const { projectId } = await params
    const text = await request.text()
    const body = PatchBody.parse(JSON.parse(text || '{}'))
    const project = await updateProject(projectId, auth.userId, body, {
      ip: getClientIp(request as any),
      userAgent: getUserAgent(request as any),
      requestId,
    })
    return NextResponse.json(project)
  } catch (err) {
    return problemResponse(err, requestId, instance)
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const requestId = request.headers.get('X-Request-Id') ?? newRequestId()
  const instance = new URL(request.url).pathname
  try {
    assertCsrf(request)
    const auth = await requireAuth()
    const { projectId } = await params
    await deleteProject(projectId, auth.userId, {
      ip: getClientIp(request as any),
      userAgent: getUserAgent(request as any),
      requestId,
    })
    return NextResponse.json({ ok: true })
  } catch (err) {
    return problemResponse(err, requestId, instance)
  }
}
