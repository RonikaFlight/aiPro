/**
 * GET /api/v1/auth/oauth
 *
 * For the authenticated user: returns the list of provider identities linked
 * to their account + the list of configured providers (so the settings UI can
 * show "Link Google" / "Link GitHub" buttons only for configured providers).
 *
 * CSRF: GET request, no state change — Origin/Referer not enforced for GET.
 */
import { NextResponse } from 'next/server'
import { listLinkedAccounts } from '@/lib/oauth-service'
import { listConfiguredProviders, ALL_PROVIDER_NAMES } from '@/lib/oauth'
import { requireAuth } from '@/lib/auth-context'
import { problemResponse, newRequestId } from '@/lib/errors'

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  const requestId = request.headers.get('X-Request-Id') ?? newRequestId()
  const instance = new URL(request.url).pathname
  try {
    const auth = await requireAuth()
    const [linked, configured] = await Promise.all([
      listLinkedAccounts(auth.userId),
      Promise.resolve(listConfiguredProviders()),
    ])

    const allNames = ALL_PROVIDER_NAMES()
    const linkedNames = new Set(linked.map((l) => l.provider))

    return NextResponse.json(
      {
        linked: linked.map((l) => ({
          provider: l.provider,
          providerUserId: l.providerUserId,
          linkedAt: l.createdAt,
        })),
        // All known providers with their configured + linked status.
        providers: allNames.map((name) => {
          const c = configured.find((p) => p.name === name)
          return {
            name,
            label: c?.label ?? name,
            configured: !!c,
            linked: linkedNames.has(name),
          }
        }),
      },
      { status: 200, headers: { 'X-Request-Id': requestId } },
    )
  } catch (err) {
    return problemResponse(err, requestId, instance)
  }
}
