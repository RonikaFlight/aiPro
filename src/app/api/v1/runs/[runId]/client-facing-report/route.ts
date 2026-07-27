/**
 * GET /api/v1/runs/[runId]/client-facing-report
 *
 * Generate and return a client-facing delivery report for a completed scan run.
 * Strips internal technical details, check IDs, selector syntax, and console
 * output. Uses AI-generated client report language when available.
 *
 * Permission: `runs.read` (any member who can view the run).
 *
 * Response 200:
 *   The full ClientFacingReport JSON object (see reports/technical-report.ts).
 *
 * 404 if the run does not exist in the workspace.
 */
import { NextResponse, type NextRequest } from 'next/server'
import { requireWorkspaceAuth } from '@/lib/auth-context'
import { generateClientFacingReport } from '@/lib/reports/technical-report'
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

    const report = await generateClientFacingReport({
      runId,
      workspaceId: run.workspaceId,
    })

    return NextResponse.json(report, { headers: { 'X-Request-Id': requestId } })
  } catch (err) {
    return problemResponse(err, requestId, instance)
  }
}
