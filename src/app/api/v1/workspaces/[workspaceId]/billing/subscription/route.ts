import { NextResponse } from 'next/server'
import { requireWorkspaceAuth } from '@/lib/auth-context'
import { problemResponse, newRequestId } from '@/lib/errors'
import { getSubscription, ensureSubscription } from '@/lib/billing-service'

export const dynamic = 'force-dynamic'

export async function GET(
  request: Request,
  { params }: { params: Promise<{ workspaceId: string }> },
) {
  const requestId = request.headers.get('X-Request-Id') ?? newRequestId()
  try {
    const { workspaceId } = await params
    await requireWorkspaceAuth(workspaceId, 'billing.read')
    // Ensure a subscription exists for the workspace (creates FREE trial if missing)
    const subscription = await ensureSubscription(workspaceId)
    return NextResponse.json(subscription)
  } catch (err) {
    return problemResponse(err, requestId, new URL(request.url).pathname)
  }
}
