/**
 * GET /api/v1/journeys/[journeyId]/runs
 *   List execution runs for a journey (cursor pagination).
 *
 * POST /api/v1/journeys/[journeyId]/runs
 *   Manually trigger a journey run (requires runs.create permission).
 */
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireAuth, getClientIp, getUserAgent } from '@/lib/auth-context'
import { createJourneyRun, listJourneyRuns } from '@/lib/journey-run-service'
import { assertCsrf } from '@/lib/csrf'
import { problemResponse, newRequestId } from '@/lib/errors'

export const dynamic = 'force-dynamic'

const listQuerySchema = z.object({
  status: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().optional(),
})

const createSchema = z.object({
  scanRunId: z.string().optional(),
  targetUrl: z.string().max(2048).optional(),
  environmentId: z.string().optional(),
  runMode: z.enum(['PASSIVE', 'SAFE_INTERACTION', 'TEST_TRANSACTION', 'CUSTOM_APPROVED']).optional(),
  trigger: z.enum(['MANUAL', 'SCAN', 'SCHEDULED']).optional(),
})

export async function GET(
  request: Request,
  { params }: { params: Promise<{ journeyId: string }> },
) {
  const requestId = request.headers.get('X-Request-Id') ?? newRequestId()
  const instance = new URL(request.url).pathname
  try {
    const { journeyId } = await params
    const auth = await requireAuth()
    const url = new URL(request.url)
    const query = listQuerySchema.parse(Object.fromEntries(url.searchParams.entries()))
    const result = await listJourneyRuns(journeyId, auth.userId, query)
    return NextResponse.json(result)
  } catch (err) {
    return problemResponse(err, requestId, instance)
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ journeyId: string }> },
) {
  const requestId = request.headers.get('X-Request-Id') ?? newRequestId()
  const instance = new URL(request.url).pathname
  try {
    assertCsrf(request)
    const { journeyId } = await params
    const auth = await requireAuth()
    const text = await request.text()
    const body = createSchema.parse(JSON.parse(text || '{}'))

    const result = await createJourneyRun(
      {
        journeyId,
        scanRunId: body.scanRunId,
        targetUrl: body.targetUrl,
        environmentId: body.environmentId,
        runMode: body.runMode,
        trigger: body.trigger,
      },
      auth.userId,
      auth.workspaceRole as 'OWNER' | 'ADMIN' | 'MEMBER' | 'VIEWER' | 'CLIENT',
      {
        ip: getClientIp(request as never),
        userAgent: getUserAgent(request as never),
        requestId,
      },
    )
    return NextResponse.json(result, { status: 201 })
  } catch (err) {
    return problemResponse(err, requestId, instance)
  }
}
