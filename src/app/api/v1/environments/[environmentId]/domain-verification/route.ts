import { NextResponse } from 'next/server'
import { z } from 'zod'
import { startDomainVerification } from '@/lib/project-service'
import { requireAuth, getClientIp, getUserAgent } from '@/lib/auth-context'
import { assertCsrf } from '@/lib/csrf'
import { problemResponse, newRequestId } from '@/lib/errors'

const Body = z.object({
  domain: z.string().min(3).max(253),
  method: z.enum(['DNS_TXT', 'HTML_FILE', 'HTML_META']),
})

export const dynamic = 'force-dynamic'

export async function POST(
  request: Request,
  { params }: { params: Promise<{ environmentId: string }> },
) {
  const requestId = request.headers.get('X-Request-Id') ?? newRequestId()
  const instance = new URL(request.url).pathname
  try {
    assertCsrf(request)
    const auth = await requireAuth()
    const { environmentId } = await params
    const text = await request.text()
    const body = Body.parse(JSON.parse(text || '{}'))

    // Resolve project from environment
    const { db } = await import('@/lib/db')
    const env = await db.projectEnvironment.findUniqueOrThrow({
      where: { id: environmentId },
      select: { projectId: true },
    })

    const result = await startDomainVerification(env.projectId, body.domain, body.method, auth.userId, {
      ip: getClientIp(request),
      userAgent: getUserAgent(request),
      requestId,
    })
    return NextResponse.json(result, { status: 201 })
  } catch (err) {
    return problemResponse(err, requestId, instance)
  }
}
