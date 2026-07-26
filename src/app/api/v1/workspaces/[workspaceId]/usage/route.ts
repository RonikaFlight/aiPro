import { NextResponse } from 'next/server'
import { requireWorkspaceAuth } from '@/lib/auth-context'
import { problemResponse, newRequestId } from '@/lib/errors'
import { getUsageSummary } from '@/lib/usage-service'

export const dynamic = 'force-dynamic'

export async function GET(
  request: Request,
  { params }: { params: Promise<{ workspaceId: string }> },
) {
  const requestId = request.headers.get('X-Request-Id') ?? newRequestId()
  try {
    const { workspaceId } = await params
    await requireWorkspaceAuth(workspaceId, 'billing.read')
    const summary = await getUsageSummary(workspaceId)
    return NextResponse.json(summary)
  } catch (err) {
    return problemResponse(err, requestId, new URL(request.url).pathname)
  }
}
