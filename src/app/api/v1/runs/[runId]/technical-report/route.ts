/**
 * GET /api/v1/runs/[runId]/technical-report
 *
 * Generate and return a full technical report for a completed scan run.
 *
 * Permission: `runs.read` (any member who can view the run).
 *
 * Response 200:
 *   The full TechnicalReport JSON object (see reports/technical-report.ts).
 *
 * 404 if the run does not exist in the workspace.
 */
import { NextResponse, type NextRequest } from 'next/server'
import { requireWorkspaceAuth } from '@/lib/auth-context'
import { generateTechnicalReport } from '@/lib/reports/technical-report'
import { db } from '@/lib/db'
import { problemResponse, newRequestId, NotFoundError } from '@/lib/errors'

export const dynamic = 'force-dynamic'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ runId: string }> },
) {
  const requestId = request.headers.get('X-Request-Id') ?? newRequestId()
  const instance = new URL(request.url).pathname
  try {
    const { runId } = await params
    const run = await db.scanRun.findUnique({
      where: { id: runId },
      select: { workspaceId: true },
    })
    if (!run) throw new NotFoundError('Run')
    await requireWorkspaceAuth(run.workspaceId, 'runs.read')

    const result = await generateTechnicalReport({
      runId,
      workspaceId: run.workspaceId,
    })

    return NextResponse.json(result, { headers: { 'X-Request-Id': requestId } })
  } catch (err) {
    return problemResponse(err, requestId, instance)
  }
}
