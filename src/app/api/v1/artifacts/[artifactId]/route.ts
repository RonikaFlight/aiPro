/**
 * GET /api/v1/artifacts/[artifactId]?exp=<epoch>&sig=<hex>
 *
 * Serves a private artifact by signed URL.
 * The signature is verified (HMAC-SHA256), the expiry is checked, and the
 * user must be a member of the artifact's workspace (defense-in-depth — even
 * a stolen URL can't be used by someone outside the workspace).
 *
 * Returns the raw artifact bytes with the correct Content-Type.
 */
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { problemResponse, newRequestId, NotFoundError, ForbiddenError } from '@/lib/errors'
import { verifyArtifactSignature, readArtifactBuffer, getArtifact } from '@/lib/artifact-service'
import { requireWorkspaceAuth } from '@/lib/auth-context'

export const dynamic = 'force-dynamic'

const CONTENT_TYPE_INLINE: Set<string> = new Set(['image/png', 'image/jpeg', 'image/webp', 'application/pdf'])

export async function GET(
  request: Request,
  { params }: { params: Promise<{ artifactId: string }> },
) {
  const requestId = request.headers.get('X-Request-Id') ?? newRequestId()
  const instance = new URL(request.url).pathname
  try {
    const { artifactId } = await params
    const url = new URL(request.url)
    const expStr = url.searchParams.get('exp')
    const sig = url.searchParams.get('sig')
    if (!expStr || !sig) {
      throw new ForbiddenError('Missing signature')
    }
    const exp = parseInt(expStr, 10)
    if (!verifyArtifactSignature(artifactId, exp, sig)) {
      throw new ForbiddenError('Invalid or expired signature')
    }

    // Resolve the artifact's workspace + verify membership
    const artifact = await db.artifact.findUnique({
      where: { id: artifactId },
      select: { id: true, workspaceId: true, mimeType: true, storageKey: true, type: true, sizeBytes: true },
    })
    if (!artifact) throw new NotFoundError('Artifact')
    // Defense in depth — even with a valid signature, require workspace membership
    await requireWorkspaceAuth(artifact.workspaceId, 'runs.read')

    const buffer = await readArtifactBuffer(artifact.storageKey)
    const contentType = artifact.mimeType
    const disposition = CONTENT_TYPE_INLINE.has(contentType) ? 'inline' : 'attachment'

    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        'Content-Type': contentType,
        'Content-Length': String(buffer.length),
        'Content-Disposition': `${disposition}; filename="artifact-${artifactId}"`,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        'X-Request-Id': requestId,
      },
    })
  } catch (err) {
    return problemResponse(err, requestId, instance)
  }
}
