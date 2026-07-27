/**
 * GET /api/v1/projects/[projectId]/score
 *   Compute the project's current quality score (live, from findings table)
 *   and compare against the latest run's persisted score for trend reporting.
 */
import { NextResponse, type NextRequest } from 'next/server'
import { requireWorkspaceAuth } from '@/lib/auth-context'
import { computeProjectScore } from '@/lib/quality-score'
import { db } from '@/lib/db'
import { problemResponse, newRequestId, ValidationError } from '@/lib/errors'

export const dynamic = 'force-dynamic'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const requestId = request.headers.get('X-Request-Id') ?? newRequestId()
  const instance = new URL(request.url).pathname
  try {
    const { projectId } = await params
    const project = await db.project.findUnique({
      where: { id: projectId },
      select: { workspaceId: true, status: true },
    })
    if (!project || project.status === 'DELETED') {
      throw new ValidationError('Project not found')
    }
    await requireWorkspaceAuth(project.workspaceId, 'findings.read')

    const result = await computeProjectScore(projectId, project.workspaceId)
    return NextResponse.json(result, { headers: { 'X-Request-Id': requestId } })
  } catch (err) {
    return problemResponse(err, requestId, instance)
  }
}
