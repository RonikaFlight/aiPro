/**
 * GET /api/v1/journeys/[journeyId]
 *   Get a journey with its current version's steps.
 *
 * PATCH /api/v1/journeys/[journeyId]
 *   Update a journey (name, description, entryUrl, personaId, status, steps).
 *   When steps are changed, a new version is created.
 *
 * DELETE /api/v1/journeys/[journeyId]
 *   Soft-delete a journey (status = DELETED). Versions are retained for audit.
 */
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireAuth, getClientIp, getUserAgent } from '@/lib/auth-context'
import { getJourney, updateJourney, deleteJourney } from '@/lib/journey-service'
import { assertCsrf } from '@/lib/csrf'
import { JourneyStepSchema } from '@/lib/journey-types'
import { problemResponse, newRequestId } from '@/lib/errors'

export const dynamic = 'force-dynamic'

const patchSchema = z.object({
  name: z.string().min(2).max(200).optional(),
  description: z.string().max(2000).optional(),
  entryUrl: z.string().max(2048).nullable().optional(),
  personaId: z.string().nullable().optional(),
  status: z.enum(['DRAFT', 'ACTIVE', 'ARCHIVED']).optional(),
  steps: z.array(JourneyStepSchema).min(1).max(100).optional(),
  changeLog: z.string().max(500).optional(),
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
    const journey = await getJourney(journeyId, auth.userId)
    return NextResponse.json(journey)
  } catch (err) {
    return problemResponse(err, requestId, instance)
  }
}

export async function PATCH(
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
    const body = patchSchema.parse(JSON.parse(text || '{}'))

    const journey = await updateJourney(
      journeyId,
      body,
      auth.userId,
      auth.workspaceRole as 'OWNER' | 'ADMIN' | 'MEMBER' | 'VIEWER' | 'CLIENT',
      {
        ip: getClientIp(request as never),
        userAgent: getUserAgent(request as never),
        requestId,
      },
    )
    return NextResponse.json(journey)
  } catch (err) {
    return problemResponse(err, requestId, instance)
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ journeyId: string }> },
) {
  const requestId = request.headers.get('X-Request-Id') ?? newRequestId()
  const instance = new URL(request.url).pathname
  try {
    assertCsrf(request)
    const { journeyId } = await params
    const auth = await requireAuth()
    await deleteJourney(
      journeyId,
      auth.userId,
      auth.workspaceRole as 'OWNER' | 'ADMIN' | 'MEMBER' | 'VIEWER' | 'CLIENT',
      {
        ip: getClientIp(request as never),
        userAgent: getUserAgent(request as never),
        requestId,
      },
    )
    return new NextResponse(null, { status: 204 })
  } catch (err) {
    return problemResponse(err, requestId, instance)
  }
}
