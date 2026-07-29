import { NextResponse } from 'next/server'
import { requireAuth, requireWorkspaceAuth, getClientIp, getUserAgent } from '@/lib/auth-context'
import { db } from '@/lib/db'
import { retryFailedDelivery } from '@/lib/outgoing-webhook-service'
import { problemResponse, newRequestId, NotFoundError } from '@/lib/errors'

export const dynamic = 'force-dynamic'

/**
 * POST /api/v1/webhooks/[webhookId]/deliveries/[deliveryId]/retry
 * Retry a failed webhook delivery.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ webhookId: string; deliveryId: string }> },
) {
  const requestId = request.headers.get('X-Request-Id') ?? newRequestId()
  try {
    const { webhookId, deliveryId } = await params
    await requireAuth()

    const wh = await db.outgoingWebhook.findUnique({
      where: { id: webhookId },
      select: { workspaceId: true },
    })
    if (!wh) throw new NotFoundError('Webhook')

    await requireWorkspaceAuth(wh.workspaceId, 'integrations.manage')

    const result = await retryFailedDelivery(deliveryId)
    return NextResponse.json(result)
  } catch (err) {
    return problemResponse(err, requestId, new URL(request.url).pathname)
  }
}
