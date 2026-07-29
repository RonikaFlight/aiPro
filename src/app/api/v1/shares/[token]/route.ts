/**
 * GET /api/v1/shares/[token]
 *
 * Public endpoint — NO authentication required.
 * Access a shared report using the share token.
 *
 * The token is the high-entropy value returned when the share was created.
 * It is hashed before lookup (token never stored in plaintext).
 *
 * Query parameters:
 *   - password: string (required if share is password-protected)
 *   - email: string (required if share has email restriction)
 *
 * Response 200 (success):
 *   {
 *     "share": {
 *       "shareId": "...",
 *       "shareType": "CLIENT",
 *       "expiresAt": null,
 *       "emailRestriction": null,
 *       "viewCount": 6
 *     },
 *     "report": { ... full TechnicalReport or ClientFacingReport ... }
 *   }
 *
 * Response 403 (access denied):
 *   {
 *     "status": "REVOKED" | "EXPIRED" | "PASSWORD_REQUIRED" | "PASSWORD_INCORRECT" | "EMAIL_RESTRICTED",
 *     "shareId": "...",
 *     "message": "..."
 *   }
 *
 * Response 404 if the token does not match any share.
 *
 * Security:
 *   - Token is high-entropy (256 bits), stored as SHA-256 hash
 *   - Optional password (Argon2id hashed) and email restriction
 *   - Optional expiration
 *   - View count incremented on each successful access
 *   - Response includes X-Robots-Tag: noindex to prevent search engine indexing
 *   - No workspace navigation is exposed
 */
import { NextResponse, type NextRequest } from 'next/server'
import { verifyShareAccess, type ShareAccessDenied } from '@/lib/reports/secure-sharing'
import { problemResponse, newRequestId } from '@/lib/errors'

export const dynamic = 'force-dynamic'

const ACCESS_DENIED_MESSAGES: Record<string, string> = {
  REVOKED: 'This share link has been revoked',
  EXPIRED: 'This share link has expired',
  PASSWORD_REQUIRED: 'This report requires a password',
  PASSWORD_INCORRECT: 'Incorrect password',
  EMAIL_RESTRICTED: 'This report is restricted to a specific email address',
  NOT_FOUND: 'Share not found',
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const requestId = request.headers.get('X-Request-Id') ?? newRequestId()
  const instance = new URL(request.url).pathname

  // Prevent search engine indexing
  const headers: Record<string, string> = {
    'X-Request-Id': requestId,
    'X-Robots-Tag': 'noindex, nofollow',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
  }

  try {
    const { token } = await params
    const url = new URL(request.url)
    const password = url.searchParams.get('password') ?? undefined
    const viewerEmail = url.searchParams.get('email') ?? undefined

    const result = await verifyShareAccess(token, {
      password,
      viewerEmail,
    })

    if ('status' in result && result.status !== 'VALID') {
      const denied = result as ShareAccessDenied
      return NextResponse.json(
        {
          status: denied.status,
          shareId: denied.shareId ?? undefined,
          message: ACCESS_DENIED_MESSAGES[denied.status] ?? 'Access denied',
        },
        {
          status: denied.status === 'NOT_FOUND' ? 404 : 403,
          headers,
        },
      )
    }

    // Successful access
    const accessResult = result as Exclude<typeof result, ShareAccessDenied>
    return NextResponse.json(
      {
        share: {
          shareId: accessResult.shareId,
          shareType: accessResult.shareType,
          expiresAt: accessResult.expiresAt,
          emailRestriction: accessResult.emailRestriction,
          viewCount: accessResult.viewCount,
        },
        report: accessResult.report,
      },
      { headers },
    )
  } catch (err) {
    return problemResponse(err, requestId, instance)
  }
}
