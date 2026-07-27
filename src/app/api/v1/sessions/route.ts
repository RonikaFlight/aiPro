import { NextResponse } from 'next/server'
import { listSessions } from '@/lib/auth-service'
import { requireAuth } from '@/lib/auth-context'
import { problemResponse, newRequestId } from '@/lib/errors'

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  const requestId = request.headers.get('X-Request-Id') ?? newRequestId()
  const instance = new URL(request.url).pathname
  try {
    const auth = await requireAuth()
    const sessions = await listSessions(auth.userId)
    return NextResponse.json({ items: sessions, total: sessions.length })
  } catch (err) {
    return problemResponse(err, requestId, instance)
  }
}
