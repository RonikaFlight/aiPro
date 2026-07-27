/**
 * GET /api/v1/auth/oauth/providers
 *
 * Returns the list of configured OAuth providers so the login/register UI
 * can show/hide the "Continue with X" buttons. Public endpoint.
 */
import { NextResponse } from 'next/server'
import { listConfiguredProviders } from '@/lib/oauth'
import { newRequestId } from '@/lib/errors'

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  const requestId = request.headers.get('X-Request-Id') ?? newRequestId()
  try {
    const providers = listConfiguredProviders().map((p) => ({
      name: p.name,
      label: p.label,
    }))
    return NextResponse.json({ providers }, { headers: { 'X-Request-Id': requestId } })
  } catch (err) {
    return NextResponse.json(
      {
        type: 'https://proofpilot.app/problems/internal-error',
        title: 'Internal error',
        status: 500,
        detail: String(err),
        instance: '/api/v1/auth/oauth/providers',
        requestId,
      },
      { status: 500, headers: { 'X-Request-Id': requestId } },
    )
  }
}
