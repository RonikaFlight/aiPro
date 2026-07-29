/**
 * GET /api/v1/projects/[projectId]/findings
 *   List findings for a project with filters and cursor pagination.
 *
 * Query params:
 *   limit          (default 25, max 100)
 *   cursor         (finding ID)
 *   sort           (lastSeenAt|firstSeenAt|severity|title) — default lastSeenAt
 *   order          (asc|desc) — default desc
 *   severity       (comma-separated: BLOCKER,CRITICAL,MAJOR,MINOR,INFO)
 *   status         (comma-separated: OPEN,ACKNOWLEDGED,IN_PROGRESS,RESOLVED,REOPENED,IGNORED,ACCEPTED_RISK,FALSE_POSITIVE)
 *   category       (comma-separated)
 *   locale, viewport, browser
 *   assignedToId   (user ID or "null" for unassigned)
 *   unassigned     (true|false)
 *   firstSeenAfter, firstSeenBefore  (ISO 8601)
 *   search         (free-text on title/description/checkId)
 *   tags           (comma-separated; findings must have ALL)
 *   suppression    (active|suppressed|all) — default all
 */
import { NextResponse, type NextRequest } from 'next/server'
import { requireWorkspaceAuth } from '@/lib/auth-context'
import { listFindings, type FindingFilters } from '@/lib/findings-service'
import {
  isSeverity,
  isStatus,
  parseTags,
  type FindingSeverity,
  type FindingStatus,
} from '@/lib/finding-severity'
import { db } from '@/lib/db'
import { problemResponse, newRequestId, ValidationError } from '@/lib/errors'

export const dynamic = 'force-dynamic'

async function resolveProjectWorkspaceId(projectId: string): Promise<string> {
  const project = await db.project.findUnique({
    where: { id: projectId },
    select: { workspaceId: true, status: true },
  })
  if (!project || project.status === 'DELETED') {
    throw new ValidationError('Project not found')
  }
  return project.workspaceId
}

function parseCommaList(value: string | null): string[] {
  if (!value) return []
  return value.split(',').map((v) => v.trim()).filter(Boolean)
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const requestId = request.headers.get('X-Request-Id') ?? newRequestId()
  const instance = new URL(request.url).pathname
  try {
    const { projectId } = await params
    const workspaceId = await resolveProjectWorkspaceId(projectId)
    await requireWorkspaceAuth(workspaceId, 'findings.read')

    const url = new URL(request.url)
    const sp = url.searchParams

    const limit = Math.min(parseInt(sp.get('limit') ?? '25', 10) || 25, 100)
    const cursor = sp.get('cursor') ?? undefined
    const sort = (sp.get('sort') as 'lastSeenAt' | 'firstSeenAt' | 'severity' | 'title' | null) ?? 'lastSeenAt'
    const order = (sp.get('order') as 'asc' | 'desc' | null) ?? 'desc'

    const severities = parseCommaList(sp.get('severity')).filter(isSeverity) as FindingSeverity[]
    const statuses = parseCommaList(sp.get('status')).filter(isStatus) as FindingStatus[]
    const categories = parseCommaList(sp.get('category'))
    const tags = parseCommaList(sp.get('tags'))
    if (tags.length) parseTags(tags.join(',')) // validate

    const assignedToIdRaw = sp.get('assignedToId')
    const unassigned = sp.get('unassigned') === 'true'

    const suppressionParam = sp.get('suppression')
    const suppression: FindingFilters['suppression'] =
      suppressionParam === 'active' || suppressionParam === 'suppressed' ? suppressionParam : 'all'

    const filters: FindingFilters = {
      projectId,
      ...(severities.length ? { severity: severities } : {}),
      ...(statuses.length ? { status: statuses } : {}),
      ...(categories.length ? { category: categories } : {}),
      ...(sp.get('locale') ? { locale: sp.get('locale')! } : {}),
      ...(sp.get('viewport') ? { viewport: sp.get('viewport')! } : {}),
      ...(sp.get('browser') ? { browser: sp.get('browser')! } : {}),
      ...(assignedToIdRaw
        ? assignedToIdRaw === 'null'
          ? { assignedToId: null }
          : { assignedToId: assignedToIdRaw }
        : {}),
      ...(unassigned ? { unassigned: true } : {}),
      ...(sp.get('firstSeenAfter') ? { firstSeenAfter: sp.get('firstSeenAfter')! } : {}),
      ...(sp.get('firstSeenBefore') ? { firstSeenBefore: sp.get('firstSeenBefore')! } : {}),
      ...(sp.get('search') ? { search: sp.get('search')!.slice(0, 200) } : {}),
      ...(tags.length ? { tags } : {}),
      suppression,
    }

    const result = await listFindings(workspaceId, filters, { limit, cursor, sort, order })
    return NextResponse.json(result, { headers: { 'X-Request-Id': requestId } })
  } catch (err) {
    return problemResponse(err, requestId, instance)
  }
}
