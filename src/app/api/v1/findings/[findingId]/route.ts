/**
 * GET  /api/v1/findings/[findingId]    Get finding detail (with comments, history, suppressions, occurrences).
 * PATCH /api/v1/findings/[findingId]   Update finding (status, severity, confidence, assignedToId, tags,
 *                                      businessImpact, aiExplanation, aiSummary). Validates transitions.
 * DELETE /api/v1/findings/[findingId]  Soft-delete (transitions to IGNORED). Hard deletes are admin-only via DB.
 */
import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { requireWorkspaceAuth, getClientIp, getUserAgent } from '@/lib/auth-context'
import { getFinding, patchFinding } from '@/lib/findings-service'
import {
  SEVERITIES,
  STATUSES,
  BUSINESS_IMPACTS,
  CONFIDENCES,
  parseTags,
  type FindingSeverity,
  type FindingStatus,
  type BusinessImpact,
  type FindingConfidence,
} from '@/lib/finding-severity'
import { db } from '@/lib/db'
import { problemResponse, newRequestId, NotFoundError } from '@/lib/errors'

export const dynamic = 'force-dynamic'

const patchSchema = z.object({
  status: z.enum(STATUSES as [FindingStatus, ...FindingStatus[]]).optional(),
  severity: z.enum(SEVERITIES as [FindingSeverity, ...FindingSeverity[]]).optional(),
  confidence: z.enum(CONFIDENCES as [FindingConfidence, ...FindingConfidence[]]).optional(),
  assignedToId: z.string().nullable().optional(),
  tags: z.array(z.string()).optional(),
  businessImpact: z.array(z.enum(BUSINESS_IMPACTS as [BusinessImpact, ...BusinessImpact[]])).optional(),
  aiExplanation: z.string().max(8000).optional(),
  aiSummary: z.string().max(2000).optional(),
  reason: z.string().max(500).optional(),
})

async function resolveFindingWorkspaceId(findingId: string): Promise<string> {
  const finding = await db.finding.findUnique({
    where: { id: findingId },
    select: { workspaceId: true },
  })
  if (!finding) {
    throw new NotFoundError('Finding')
  }
  return finding.workspaceId
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ findingId: string }> },
) {
  const requestId = request.headers.get('X-Request-Id') ?? newRequestId()
  const instance = new URL(request.url).pathname
  try {
    const { findingId } = await params
    const workspaceId = await resolveFindingWorkspaceId(findingId)
    await requireWorkspaceAuth(workspaceId, 'findings.read')

    const result = await getFinding(findingId, workspaceId)
    return NextResponse.json(result, { headers: { 'X-Request-Id': requestId } })
  } catch (err) {
    return problemResponse(err, requestId, instance)
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ findingId: string }> },
) {
  const requestId = request.headers.get('X-Request-Id') ?? newRequestId()
  const instance = new URL(request.url).pathname
  try {
    const { findingId } = await params
    const workspaceId = await resolveFindingWorkspaceId(findingId)
    const auth = await requireWorkspaceAuth(workspaceId, 'findings.update')

    const text = await request.text()
    const body = patchSchema.parse(JSON.parse(text || '{}'))

    // Normalize tags via the parser (dedup + validate).
    const patch: Parameters<typeof patchFinding>[2] = {}
    if (body.status !== undefined) patch.status = body.status
    if (body.severity !== undefined) patch.severity = body.severity
    if (body.confidence !== undefined) patch.confidence = body.confidence
    if (body.assignedToId !== undefined) patch.assignedToId = body.assignedToId
    if (body.tags !== undefined) patch.tags = parseTags(body.tags.join(','))
    if (body.businessImpact !== undefined) patch.businessImpact = body.businessImpact
    if (body.aiExplanation !== undefined) patch.aiExplanation = body.aiExplanation
    if (body.aiSummary !== undefined) patch.aiSummary = body.aiSummary
    if (body.reason !== undefined) patch.reason = body.reason

    const result = await patchFinding(findingId, workspaceId, patch, {
      userId: auth.userId,
      audit: {
        ip: getClientIp(request as never),
        userAgent: getUserAgent(request as never),
        requestId,
      },
    })

    return NextResponse.json({ finding: result }, { headers: { 'X-Request-Id': requestId } })
  } catch (err) {
    return problemResponse(err, requestId, instance)
  }
}
