import { NextResponse } from 'next/server'
import { issueCsrfToken } from '@/lib/csrf'
import { getOptionalAuth } from '@/lib/auth-context'
import { env } from '@/lib/env'
import { problemResponse, newRequestId } from '@/lib/errors'

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  const requestId = request.headers.get('X-Request-Id') ?? newRequestId()
  try {
    const { token } = issueCsrfToken()
    const auth = await getOptionalAuth()
    const isProd = env.APP_ENV === 'production'

    const res = NextResponse.json({
      csrfToken: token,
      authenticated: !!auth,
      user: auth ? { id: auth.userId, email: auth.email, name: auth.name, platformRole: auth.platformRole } : null,
    })

    // Also ensure session cookie persists (rolling expiration handled in requireAuth)
    return res
  } catch (err) {
    return problemResponse(err, requestId, new URL(request.url).pathname)
  }
}
