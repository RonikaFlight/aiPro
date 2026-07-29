/**
 * POST /api/v1/projects/[projectId]/findings/bulk
 *   Apply a bulk action to findings matching a filter.
 *
 * Body:
 *   {
 *     "filter": { ...same filters as GET list... },
 *     "action": {
 *       "type": "transition" | "assign" | "add_tags" | "remove_tags" | "set_business_impact",
 *       ...action-specific fields...
 *     }
 *   }
 *
 * Hard cap: 500 findings per operation.
 */
import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { requireWorkspaceAuth, getClientIp, getUserAgent } from '@/lib/auth-context'
import { bulkUpdateFindings, type FindingFilters, type BulkUpdateInput } from '@/lib/findings-service'
import {
  SEVERITIES,
  STATUSES,
  BUSINESS_IMPACTS,
  parseTags,
  type FindingSeverity,
  type FindingStatus,
  type BusinessImpact,
} from '@/lib/finding-severity'
import { db } from '@/lib/db'
import { problemResponse, newRequestId, ValidationError } from '@/lib/errors'

export const dynamic = 'force-dynamic'

const filterSchema = z.object({
  projectId: z.string().optional(),
  runId: z.string().optional(),
  severity: z.array(z.enum(SEVERITIES as [FindingSeverity, ...FindingSeverity[]])).optional(),
  status: z.array(z.enum(STATUSES as [FindingStatus, ...FindingStatus[]])).optional(),
  category: z.array(z.string()).optional(),
  locale: z.string().optional(),
  viewport: z.string().optional(),
  browser: z.string().optional(),
  assignedToId: z.string().nullable().optional(),
  unassigned: z.boolean().optional(),
  firstSeenAfter: z.string().optional(),
  firstSeenBefore: z.string().optional(),
  search: z.string().max(200).optional(),
  tags: z.array(z.string()).optional(),
  suppression: z.enum(['active', 'suppressed', 'all']).optional(),
})

const actionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('transition'),
    toStatus: z.enum(STATUSES as [FindingStatus, ...FindingStatus[]]),
    reason: z.string().max(500).optional(),
  }),
  z.object({
    type: z.literal('assign'),
    assignedToId: z.string().nullable(),
  }),
  z.object({
    type: z.literal('add_tags'),
    tags: z.array(z.string()),
  }),
  z.object({
    type: z.literal('remove_tags'),
    tags: z.array(z.string()),
  }),
  z.object({
    type: z.literal('set_business_impact'),
    impacts: z.array(z.enum(BUSINESS_IMPACTS as [BusinessImpact, ...BusinessImpact[]])),
  }),
])

const bodySchema = z.object({
  filter: filterSchema,
  action: actionSchema,
})

export async function POST(
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
    const auth = await requireWorkspaceAuth(project.workspaceId, 'findings.update')

    const text = await request.text()
    const body = bodySchema.parse(JSON.parse(text || '{}'))

    // Force projectId filter to the route's project for safety.
    const filter: FindingFilters = { ...body.filter, projectId }

    // Validate tags up front so we fail fast.
    if (body.action.type === 'add_tags' || body.action.type === 'remove_tags') {
      parseTags(body.action.tags.join(','))
    }

    const input: BulkUpdateInput = {
      filter,
      action: body.action,
    }

    const result = await bulkUpdateFindings(project.workspaceId, input, {
      userId: auth.userId,
      audit: {
        ip: getClientIp(request as never),
        userAgent: getUserAgent(request as never),
        requestId,
      },
    })

    return NextResponse.json(result, { headers: { 'X-Request-Id': requestId } })
  } catch (err) {
    return problemResponse(err, requestId, instance)
  }
}
