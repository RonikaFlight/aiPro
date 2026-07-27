import { NextResponse } from 'next/server'
import { z } from 'zod'
import { listMembers, inviteMember, changeMemberRole, removeMember } from '@/lib/workspace-service'
import { requireAuth, getClientIp, getUserAgent } from '@/lib/auth-context'
import { assertCsrf } from '@/lib/csrf'
import { problemResponse, newRequestId } from '@/lib/errors'
import type { WorkspaceRole } from '@/lib/permissions'

const InviteBody = z.object({
  email: z.string().email(),
  role: z.enum(['ADMIN', 'MEMBER', 'VIEWER', 'CLIENT']),
})

const PatchBody = z.object({
  role: z.enum(['ADMIN', 'MEMBER', 'VIEWER', 'CLIENT']),
})

export const dynamic = 'force-dynamic'

export async function GET(
  request: Request,
  { params }: { params: Promise<{ workspaceId: string }> },
) {
  const requestId = request.headers.get('X-Request-Id') ?? newRequestId()
  try {
    const auth = await requireAuth()
    const { workspaceId } = await params
    const members = await listMembers(workspaceId, auth.userId)
    return NextResponse.json({ items: members, total: members.length })
  } catch (err) {
    return problemResponse(err, requestId, new URL(request.url).pathname)
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ workspaceId: string }> },
) {
  const requestId = request.headers.get('X-Request-Id') ?? newRequestId()
  const instance = new URL(request.url).pathname
  try {
    assertCsrf(request)
    const auth = await requireAuth()
    const { workspaceId } = await params
    const text = await request.text()
    const body = InviteBody.parse(JSON.parse(text || '{}'))

    // Resolve actor's role
    const membership = await requireWorkspaceMembership(workspaceId, auth.userId, 'members.invite')

    const result = await inviteMember(
      workspaceId,
      auth.userId,
      membership.workspaceRole as WorkspaceRole,
      { email: body.email, role: body.role as WorkspaceRole },
      { ip: getClientIp(request as any), userAgent: getUserAgent(request as any), requestId },
    )
    return NextResponse.json(result, { status: 201 })
  } catch (err) {
    return problemResponse(err, requestId, instance)
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ workspaceId: string }> },
) {
  const requestId = request.headers.get('X-Request-Id') ?? newRequestId()
  const instance = new URL(request.url).pathname
  try {
    assertCsrf(request)
    const auth = await requireAuth()
    const { workspaceId } = await params
    const text = await request.text()
    const body = PatchBody.parse(JSON.parse(text || '{}'))
    const { targetUserId } = Object.fromEntries(new URL(request.url).searchParams.entries())

    const membership = await requireWorkspaceMembership(workspaceId, auth.userId, 'members.update')

    await changeMemberRole(
      workspaceId,
      auth.userId,
      membership.workspaceRole as WorkspaceRole,
      targetUserId,
      body.role as WorkspaceRole,
      { ip: getClientIp(request as any), userAgent: getUserAgent(request as any), requestId },
    )
    return NextResponse.json({ ok: true })
  } catch (err) {
    return problemResponse(err, requestId, instance)
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ workspaceId: string }> },
) {
  const requestId = request.headers.get('X-Request-Id') ?? newRequestId()
  const instance = new URL(request.url).pathname
  try {
    assertCsrf(request)
    const auth = await requireAuth()
    const { workspaceId } = await params
    const { targetUserId } = Object.fromEntries(new URL(request.url).searchParams.entries())

    const membership = await requireWorkspaceMembership(workspaceId, auth.userId, 'members.remove')

    await removeMember(
      workspaceId,
      auth.userId,
      membership.workspaceRole as WorkspaceRole,
      targetUserId,
      { ip: getClientIp(request as any), userAgent: getUserAgent(request as any), requestId },
    )
    return NextResponse.json({ ok: true })
  } catch (err) {
    return problemResponse(err, requestId, instance)
  }
}

async function requireWorkspaceMembership(workspaceId: string, userId: string, permission: import('@/lib/permissions').Permission) {
  const { requireWorkspaceAuth } = await import('@/lib/auth-context')
  return requireWorkspaceAuth(workspaceId, permission)
}
