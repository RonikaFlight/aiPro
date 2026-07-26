import { NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth-context'
import { db } from '@/lib/db'
import { problemResponse, newRequestId } from '@/lib/errors'

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  const requestId = request.headers.get('X-Request-Id') ?? newRequestId()
  try {
    const auth = await requireAuth()
    const user = await db.user.findUniqueOrThrow({
      where: { id: auth.userId },
      select: {
        id: true,
        email: true,
        name: true,
        platformRole: true,
        status: true,
        locale: true,
        timezone: true,
        avatarUrl: true,
      },
    })
    const memberships = await db.workspaceMember.findMany({
      where: { userId: auth.userId, removedAt: null },
      include: {
        workspace: {
          select: { id: true, name: true, slug: true },
        },
      },
    })
    const mfaEnabled = await db.mfaFactor.findFirst({
      where: { userId: auth.userId, enabled: true },
      select: { id: true },
    })
    return NextResponse.json({
      user,
      workspaces: memberships.map((m) => ({
        id: m.workspace.id,
        name: m.workspace.name,
        slug: m.workspace.slug,
        role: m.role,
      })),
      mfaEnabled: !!mfaEnabled,
    })
  } catch (err) {
    return problemResponse(err, requestId, new URL(request.url).pathname)
  }
}
