/**
 * POST /api/v1/journeys/[journeyId]/validate
 *   Dry-run validation of journey steps + safe-action policy + secret references.
 *   Does not persist anything. Used by the editor UI to give live feedback.
 */
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireAuth } from '@/lib/auth-context'
import { validateJourney } from '@/lib/journey-service'
import { JourneyStepSchema } from '@/lib/journey-types'
import { problemResponse, newRequestId } from '@/lib/errors'

export const dynamic = 'force-dynamic'

const validateSchema = z.object({
  steps: z.array(JourneyStepSchema).min(1).max(100),
  runMode: z.enum(['PASSIVE', 'SAFE_INTERACTION', 'TEST_TRANSACTION', 'CUSTOM_APPROVED']),
  projectId: z.string().optional(),
})

export async function POST(
  request: Request,
  { params }: { params: Promise<{ journeyId: string }> },
) {
  const requestId = request.headers.get('X-Request-Id') ?? newRequestId()
  const instance = new URL(request.url).pathname
  try {
    const { journeyId } = await params
    const auth = await requireAuth()
    const text = await request.text()
    const body = validateSchema.parse(JSON.parse(text || '{}'))

    // projectId comes from the body if not present in the URL
    // (we resolve via the journey in the service layer)
    const projectId = body.projectId ?? (await resolveJourneyProjectId(journeyId))
    const result = await validateJourney(projectId, body.steps, body.runMode, auth.userId)
    return NextResponse.json(result)
  } catch (err) {
    return problemResponse(err, requestId, instance)
  }
}

async function resolveJourneyProjectId(journeyId: string): Promise<string> {
  const { db } = await import('@/lib/db')
  const journey = await db.journey.findUnique({
    where: { id: journeyId },
    select: { projectId: true },
  })
  if (!journey) {
    throw new Error('Journey not found')
  }
  return journey.projectId
}
