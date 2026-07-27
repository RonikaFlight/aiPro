/**
 * GET /api/v1/projects/[projectId]/findings/export
 *   Export findings matching the filter as CSV.
 *
 * Accepts the same query params as the list endpoint.
 * Hard cap: 5000 rows per export.
 */
import { NextResponse, type NextRequest } from 'next/server'
import { requireWorkspaceAuth } from '@/lib/auth-context'
import { exportFindingsCsv, type FindingFilters } from '@/lib/findings-service'
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
    const project = await db.project.findUnique({
      where: { id: projectId },
      select: { workspaceId: true, name: true, status: true },
    })
    if (!project || project.status === 'DELETED') {
      throw new ValidationError('Project not found')
    }
    await requireWorkspaceAuth(project.workspaceId, 'findings.read')

    const url = new URL(request.url)
    const sp = url.searchParams

    const severities = parseCommaList(sp.get('severity')).filter(isSeverity) as FindingSeverity[]
    const statuses = parseCommaList(sp.get('status')).filter(isStatus) as FindingStatus[]
    const categories = parseCommaList(sp.get('category'))
    const tags = parseCommaList(sp.get('tags'))
    if (tags.length) parseTags(tags.join(','))

    const assignedToIdRaw = sp.get('assignedToId')
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
      ...(sp.get('firstSeenAfter') ? { firstSeenAfter: sp.get('firstSeenAfter')! } : {}),
      ...(sp.get('firstSeenBefore') ? { firstSeenBefore: sp.get('firstSeenBefore')! } : {}),
      ...(sp.get('search') ? { search: sp.get('search')!.slice(0, 200) } : {}),
      ...(tags.length ? { tags } : {}),
      suppression,
    }

    const csv = await exportFindingsCsv(project.workspaceId, filters)
    const safeName = project.name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40)
    const date = new Date().toISOString().slice(0, 10)
    return new NextResponse(csv, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${safeName}-findings-${date}.csv"`,
        'X-Request-Id': requestId,
      },
    })
  } catch (err) {
    return problemResponse(err, requestId, instance)
  }
}
