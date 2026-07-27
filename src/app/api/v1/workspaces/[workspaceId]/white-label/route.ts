/**
 * GET /api/v1/workspaces/[workspaceId]/white-label
 *
 * Get the white-label branding settings for a workspace.
 * Returns current settings + whether white-label is enabled by the plan.
 *
 * Permission: `workspace.update` (same as write — members can view what
 * they could potentially edit).
 *
 * Response 200:
 *   {
 *     "logoUrl": null,
 *     "accentColor": "#ff6600",
 *     "brandName": "Acme Agency",
 *     "brandIntro": "Trusted QA partner since 2024.",
 *     "brandFooter": "© 2024 Acme Agency. All rights reserved.",
 *     "brandContactEmail": "qa@acme.com",
 *     "brandContactUrl": "https://acme.com/contact",
 *     "customDomain": null,
 *     "whiteLabelEnabled": true
 *   }
 *
 * PATCH /api/v1/workspaces/[workspaceId]/white-label
 *
 * Update white-label settings. Only plan members with `workspace.update`
 * permission and on a plan where `whiteLabel: true` (AGENCY) can persist.
 * On other plans, PATCH returns 403.
 *
 * Body (all fields optional):
 *   {
 *     "logoUrl": "https://cdn.example.com/logo.png",
 *     "accentColor": "#ff6600",
 *     "brandName": "Acme Agency",
 *     "brandIntro": "Custom intro text...",
 *     "brandFooter": "Custom footer text...",
 *     "brandContactEmail": "qa@acme.com",
 *     "brandContactUrl": "https://acme.com/contact",
 *     "customDomain": "reports.acme.com"
 *   }
 *
 * Null values clear the field.
 *
 * Response 200:
 *   { "settings": {...}, "updatedFields": ["brandName", "accentColor"] }
 *
 * 403 if the plan does not allow white-label.
 * 422 if validation fails.
 */
import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { assertCsrf } from '@/lib/csrf'
import { requireWorkspaceAuth, getClientIp, getUserAgent } from '@/lib/auth-context'
import {
  getWhiteLabelSettings,
  updateWhiteLabelSettings,
} from '@/lib/reports/white-label'
import { problemResponse, newRequestId } from '@/lib/errors'

export const dynamic = 'force-dynamic'

const patchSchema = z.object({
  logoUrl: z.string().nullable().optional(),
  accentColor: z.string().max(20).nullable().optional(),
  brandName: z.string().nullable().optional(),
  brandIntro: z.string().max(2000).nullable().optional(),
  brandFooter: z.string().max(2000).nullable().optional(),
  brandContactEmail: z.string().max(254).nullable().optional(),
  brandContactUrl: z.string().max(2048).nullable().optional(),
  customDomain: z.string().max(253).nullable().optional(),
})

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> },
) {
  const requestId = request.headers.get('X-Request-Id') ?? newRequestId()
  const instance = new URL(request.url).pathname
  try {
    const { workspaceId } = await params
    const auth = await requireWorkspaceAuth(workspaceId, 'workspace.update')

    const settings = await getWhiteLabelSettings(workspaceId)

    return NextResponse.json(settings, { headers: { 'X-Request-Id': requestId } })
  } catch (err) {
    return problemResponse(err, requestId, instance)
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> },
) {
  const requestId = request.headers.get('X-Request-Id') ?? newRequestId()
  const instance = new URL(request.url).pathname
  try {
    assertCsrf(request)
    const { workspaceId } = await params
    const auth = await requireWorkspaceAuth(workspaceId, 'workspace.update')

    const text = await request.text()
    const body = patchSchema.parse(JSON.parse(text || '{}'))

    const result = await updateWhiteLabelSettings(
      workspaceId,
      auth.role,
      body,
      {
        ip: getClientIp(request as never),
        userAgent: getUserAgent(request as never),
        requestId,
        actorId: auth.userId,
      },
    )

    return NextResponse.json(result, { headers: { 'X-Request-Id': requestId } })
  } catch (err) {
    return problemResponse(err, requestId, instance)
  }
}
