import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireWorkspaceAuth, getClientIp, getUserAgent } from '@/lib/auth-context'
import { assertCsrf } from '@/lib/csrf'
import { problemResponse, newRequestId } from '@/lib/errors'
import { createCheckoutSession } from '@/lib/billing-service'
import { env } from '@/lib/env'

const Body = z.object({
  planCode: z.enum(['STARTER', 'PRO', 'AGENCY']),
  successUrl: z.string().url().optional(),
  cancelUrl: z.string().url().optional(),
})

export const dynamic = 'force-dynamic'

export async function POST(
  request: Request,
  { params }: { params: Promise<{ workspaceId: string }> },
) {
  const requestId = request.headers.get('X-Request-Id') ?? newRequestId()
  const instance = new URL(request.url).pathname
  try {
    assertCsrf(request)
    const { workspaceId } = await params
    const auth = await requireWorkspaceAuth(workspaceId, 'billing.manage')
    const text = await request.text()
    const body = Body.parse(JSON.parse(text || '{}'))

    // Validate success/cancel URLs are on our own origin to prevent open redirect
    const appOrigin = new URL(env.APP_URL).origin
    const successUrl = body.successUrl ?? `${appOrigin}/app/workspaces/${workspaceId}/billing?status=success`
    const cancelUrl = body.cancelUrl ?? `${appOrigin}/app/workspaces/${workspaceId}/billing?status=cancelled`
    for (const u of [successUrl, cancelUrl]) {
      const parsed = new URL(u)
      if (parsed.origin !== appOrigin) {
        return NextResponse.json(
          {
            type: 'https://proofpilot.app/problems/validation-error',
            title: 'successUrl and cancelUrl must be on the application origin',
            status: 422,
            detail: `Expected origin ${appOrigin}, got ${parsed.origin}`,
            instance,
            requestId,
            code: 'validation_error',
          },
          { status: 422, headers: { 'Content-Type': 'application/problem+json' } },
        )
      }
    }

    const session = await createCheckoutSession({
      workspaceId,
      planCode: body.planCode,
      successUrl,
      cancelUrl,
      customerEmail: auth.email,
      userId: auth.userId,
      ctx: {
        ip: getClientIp(request as unknown as Parameters<typeof getClientIp>[0]),
        userAgent: getUserAgent(request as unknown as Parameters<typeof getUserAgent>[0]),
        requestId,
      },
    })
    return NextResponse.json(session, { status: 201 })
  } catch (err) {
    return problemResponse(err, requestId, instance)
  }
}
