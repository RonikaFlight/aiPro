import { NextRequest, NextResponse } from 'next/server'
import { requireWorkspaceAuth, getClientIp, getUserAgent } from '@/lib/auth-context'
import { createWebhook, listWebhooks } from '@/lib/outgoing-webhook-service'
import { problemResponse, newRequestId } from '@/lib/errors'
import type { WebhookEventType } from '@/lib/outgoing-webhook-service'

export const dynamic = 'force-dynamic'

/**
 * GET /api/v1/workspaces/[workspaceId]/webhooks
 * List all outgoing webhooks for a workspace.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ workspaceId: string }> },
) {
  const requestId = request.headers.get('X-Request-Id') ?? newRequestId()
  try {
    const { workspaceId } = await params
    await requireWorkspaceAuth(workspaceId, 'integrations.manage')

    const webhooks = await listWebhooks(workspaceId)
    return NextResponse.json({ webhooks })
  } catch (err) {
    return problemResponse(err, requestId, new URL(request.url).pathname)
  }
}

/**
 * POST /api/v1/workspaces/[workspaceId]/webhooks
 * Create a new outgoing webhook.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> },
) {
  const requestId = request.headers.get('X-Request-Id') ?? newRequestId()
  try {
    const { workspaceId } = await params
    const auth = await requireWorkspaceAuth(workspaceId, 'integrations.manage')

    const body = (await request.json()) as {
      name?: string
      url?: string
      events?: WebhookEventType[]
      secret?: string
    }

    if (!body.name) {
      return NextResponse.json(
        { error: 'name is required', code: 'validation_error' },
        { status: 422 },
      )
    }
    if (!body.url) {
      return NextResponse.json(
        { error: 'url is required', code: 'validation_error' },
        { status: 422 },
      )
    }
    if (!body.events || !Array.isArray(body.events) || body.events.length === 0) {
      return NextResponse.json(
        { error: 'events is required and must be a non-empty array', code: 'validation_error' },
        { status: 422 },
      )
    }

    const result = await createWebhook(
      {
        workspaceId,
        name: body.name,
        url: body.url,
        events: body.events,
        secret: body.secret,
      },
      auth.userId,
      {
        ip: getClientIp(request),
        userAgent: getUserAgent(request),
        requestId,
      },
    )

    return NextResponse.json(result, { status: 201 })
  } catch (err) {
    return problemResponse(err, requestId, new URL(request.url).pathname)
  }
}
