import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createEnvironment } from '@/lib/project-service'
import { requireAuth, getClientIp, getUserAgent } from '@/lib/auth-context'
import { assertCsrf } from '@/lib/csrf'
import { problemResponse, newRequestId } from '@/lib/errors'

const Body = z.object({
  type: z.enum(['PRODUCTION', 'STAGING', 'PREVIEW', 'DEVELOPMENT']),
  baseUrl: z.string().url(),
  allowedHostnames: z.array(z.string()).optional(),
  authMode: z.enum(['NONE', 'BASIC', 'FORM', 'OAUTH']).optional(),
  scanMode: z.enum(['PASSIVE', 'SAFE_INTERACTION', 'TEST_TRANSACTION', 'CUSTOM_APPROVED']).optional(),
  enabled: z.boolean().optional(),
})

export const dynamic = 'force-dynamic'

export async function POST(
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
    const body = Body.parse(JSON.parse(text || '{}'))
    const env = await createEnvironment(projectId, body, auth.userId, {
      ip: getClientIp(request),
      userAgent: getUserAgent(request),
      requestId,
    })
    return NextResponse.json(env, { status: 201 })
  } catch (err) {
    return problemResponse(err, requestId, instance)
  }
}
