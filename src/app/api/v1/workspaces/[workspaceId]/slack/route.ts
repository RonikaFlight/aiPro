import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireWorkspaceAuth, getClientIp, getUserAgent } from '@/lib/auth-context'
import { assertCsrf } from '@/lib/csrf'
import { getSlackConfig, saveSlackConfig, deleteSlackConfig } from '@/lib/slack-service'
import { problemResponse, newRequestId } from '@/lib/errors'
import type { SlackEventType } from '@/lib/slack-service'

export const dynamic = 'force-dynamic'

const VALID_EVENTS = [
  'RUN_COMPLETED',
  'RUN_FAILED',
  'FINDING_CREATED',
  'REPORT_SHARED',
  'SUBSCRIPTION_UPDATED',
] as const

const saveSlackSchema = z.object({
  webhookUrl: z
    .string()
    .min(1)
    .url()
    .refine(
      (url) => url.startsWith('https://'),
      'Webhook URL must use HTTPS',
    ),
  channel: z
    .string()
    .regex(/^#?[A-Za-z0-9_-]{1,80}$/)
    .optional(),
  events: z
    .array(z.enum(VALID_EVENTS))
    .min(1, 'At least one event is required'),
})

/**
 * GET /api/v1/workspaces/[workspaceId]/slack
 * Get current Slack integration configuration.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ workspaceId: string }> },
) {
  const requestId = request.headers.get('X-Request-Id') ?? newRequestId()
  try {
    const { workspaceId } = await params
    await requireWorkspaceAuth(workspaceId, 'integrations.manage')

    const config = await getSlackConfig(workspaceId)
    return NextResponse.json(config)
  } catch (err) {
    return problemResponse(err, requestId, new URL(request.url).pathname)
  }
}

/**
 * POST /api/v1/workspaces/[workspaceId]/slack
 * Save or update Slack integration configuration.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> },
) {
  const requestId = request.headers.get('X-Request-Id') ?? newRequestId()
  try {
    assertCsrf(request)
    const { workspaceId } = await params
    const auth = await requireWorkspaceAuth(workspaceId, 'integrations.manage')

    const body = (await request.json()) as Record<string, unknown>
    const parsed = saveSlackSchema.safeParse(body)

    if (!parsed.success) {
      return NextResponse.json(
        {
          error: 'Validation failed',
          code: 'validation_error',
          details: parsed.error.flatten().fieldErrors,
        },
        { status: 422 },
      )
    }

    const config = await saveSlackConfig(
      {
        workspaceId,
        webhookUrl: parsed.data.webhookUrl,
        channel: parsed.data.channel,
        events: parsed.data.events as SlackEventType[],
      },
      auth.userId,
      {
        ip: getClientIp(request),
        userAgent: getUserAgent(request),
        requestId,
      },
    )

    return NextResponse.json(config)
  } catch (err) {
    return problemResponse(err, requestId, new URL(request.url).pathname)
  }
}

/**
 * DELETE /api/v1/workspaces/[workspaceId]/slack
 * Remove the Slack integration for this workspace.
 */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ workspaceId: string }> },
) {
  const requestId = request.headers.get('X-Request-Id') ?? newRequestId()
  try {
    assertCsrf(request)
    const { workspaceId } = await params
    const auth = await requireWorkspaceAuth(workspaceId, 'integrations.manage')

    await deleteSlackConfig(
      workspaceId,
      auth.userId,
      {
        ip: getClientIp(request),
        userAgent: getUserAgent(request),
        requestId,
      },
    )

    return NextResponse.json({ ok: true })
  } catch (err) {
    return problemResponse(err, requestId, new URL(request.url).pathname)
  }
}
