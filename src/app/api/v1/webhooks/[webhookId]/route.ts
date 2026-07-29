import { NextRequest, NextResponse } from 'next/server'
import { requireAuth, requireWorkspaceAuth, getClientIp, getUserAgent } from '@/lib/auth-context'
import { db } from '@/lib/db'
import {
  getWebhook,
  updateWebhook,
  deleteWebhook,
} from '@/lib/outgoing-webhook-service'
import { problemResponse, newRequestId, NotFoundError } from '@/lib/errors'
import type { WebhookEventType } from '@/lib/outgoing-webhook-service'

export const dynamic = 'force-dynamic'

/**
 * GET /api/v1/webhooks/[webhookId]
 * Get a single outgoing webhook.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ webhookId: string }> },
) {
  const requestId = request.headers.get('X-Request-Id') ?? newRequestId()
  try {
    const { webhookId } = await params
    await requireAuth()

    const wh = await db.outgoingWebhook.findUnique({
      where: { id: webhookId },
      select: { workspaceId: true },
    })
    if (!wh) throw new NotFoundError('Webhook')

    await requireWorkspaceAuth(wh.workspaceId, 'integrations.manage')
    const webhook = await getWebhook(webhookId, wh.workspaceId)

    return NextResponse.json(webhook)
  } catch (err) {
    return problemResponse(err, requestId, new URL(request.url).pathname)
  }
}

/**
 * PUT /api/v1/webhooks/[webhookId]
 * Update a webhook's configuration.
 */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ webhookId: string }> },
) {
  const requestId = request.headers.get('X-Request-Id') ?? newRequestId()
  try {
    const { webhookId } = await params
    const auth = await requireAuth()

    const wh = await db.outgoingWebhook.findUnique({
      where: { id: webhookId },
      select: { workspaceId: true },
    })
    if (!wh) throw new NotFoundError('Webhook')

    await requireWorkspaceAuth(wh.workspaceId, 'integrations.manage')

    const body = (await request.json()) as {
      name?: string
      url?: string
      events?: WebhookEventType[]
      enabled?: boolean
    }

    const updated = await updateWebhook(
      webhookId,
      wh.workspaceId,
      {
        name: body.name,
        url: body.url,
        events: body.events,
        enabled: body.enabled,
      },
      auth.userId,
      {
        ip: getClientIp(request),
        userAgent: getUserAgent(request),
        requestId,
      },
    )

    return NextResponse.json(updated)
  } catch (err) {
    return problemResponse(err, requestId, new URL(request.url).pathname)
  }
}

/**
 * DELETE /api/v1/webhooks/[webhookId]
 * Delete an outgoing webhook.
 */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ webhookId: string }> },
) {
  const requestId = request.headers.get('X-Request-Id') ?? newRequestId()
  try {
    const { webhookId } = await params
    const auth = await requireAuth()

    const wh = await db.outgoingWebhook.findUnique({
      where: { id: webhookId },
      select: { workspaceId: true },
    })
    if (!wh) throw new NotFoundError('Webhook')

    await requireWorkspaceAuth(wh.workspaceId, 'integrations.manage')

    await deleteWebhook(
      webhookId,
      wh.workspaceId,
      auth.userId,
      {
        ip: getClientIp(request),
        userAgent: getUserAgent(request),
        requestId,
      },
    )

    return NextResponse.json({ deleted: true })
  } catch (err) {
    return problemResponse(err, requestId, new URL(request.url).pathname)
  }
}
