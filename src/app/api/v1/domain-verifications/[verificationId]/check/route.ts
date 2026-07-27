import { NextResponse } from 'next/server'
import { checkDomainVerification } from '@/lib/project-service'
import { requireAuth, getClientIp, getUserAgent } from '@/lib/auth-context'
import { problemResponse, newRequestId } from '@/lib/errors'

export const dynamic = 'force-dynamic'

export async function POST(
  request: Request,
  { params }: { params: Promise<{ verificationId: string }> },
) {
  const requestId = request.headers.get('X-Request-Id') ?? newRequestId()
  try {
    const auth = await requireAuth()
    const { verificationId } = await params
    const result = await checkDomainVerification(verificationId, auth.userId, {
      ip: getClientIp(request as any),
      userAgent: getUserAgent(request as any),
      requestId,
    })
    return NextResponse.json(result)
  } catch (err) {
    return problemResponse(err, requestId, new URL(request.url).pathname)
  }
}
