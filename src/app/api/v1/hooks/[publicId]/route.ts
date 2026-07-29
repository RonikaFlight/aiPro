/**
 * POST /api/v1/hooks/[publicId]
 *   Incoming deployment webhook endpoint (PUBLIC — no auth required).
 *
 * Verification is done via HMAC-SHA256 signature in the
 * X-ProofPilot-Signature header instead of session auth.
 *
 * Flow:
 *   1. Look up hook by publicId
 *   2. Rate-limit per publicId (10 req/min)
 *   3. Verify HMAC-SHA256 signature
 *   4. Parse + validate payload
 *   5. Process hook (branch filter, idempotency, scan trigger)
 *   6. Return success/failure
 */
import { NextResponse } from 'next/server'
import { z } from 'zod'
import {
  getDeploymentHook,
  verifyDeploymentHookSignature,
  processDeploymentHook,
  type DeploymentHookPayload,
} from '@/lib/deployment-hook-service'
import { checkRateLimit } from '@/lib/rate-limit'
import { newRequestId, problemResponse, ValidationError, AppError } from '@/lib/errors'
import { getClientIp, getUserAgent } from '@/lib/auth-context'
import { recordSecurityEvent } from '@/lib/audit'
import { logger } from '@/lib/logger'

export const dynamic = 'force-dynamic'

const payloadSchema = z.object({
  branch: z.string().max(300).optional(),
  commit: z.string().max(100).optional(),
  timestamp: z.union([z.string(), z.number()]).optional(),
  environment: z.string().max(100).optional(),
  url: z.string().url().optional(),
})

export async function POST(
  request: Request,
  { params }: { params: Promise<{ publicId: string }> },
) {
  const requestId = request.headers.get('X-Request-Id') ?? newRequestId()
  const instance = new URL(request.url).pathname

  try {
    const { publicId } = await params

    // 1. Look up hook by publicId
    const hook = await getDeploymentHook(publicId)
    if (!hook) {
      throw new ValidationError('Unknown deployment hook')
    }

    // 2. Rate-limit per publicId (max 10 per minute)
    const ip = getClientIp(request)
    const identifier = `${publicId}:${ip}`
    checkRateLimit({ max: 10, windowSeconds: 60, keyPrefix: 'deployhook' }, identifier)

    // 3. Read raw body for signature verification
    const rawBody = await request.text()
    if (!rawBody || rawBody.length === 0) {
      throw new ValidationError('Empty request body')
    }

    // 4. Verify HMAC-SHA256 signature
    const signature = request.headers.get('X-ProofPilot-Signature')
    if (!signature) {
      await recordSecurityEvent('DEPLOYMENT_HOOK_MISSING_SIGNATURE', {
        actorType: 'SYSTEM',
        workspaceId: hook.workspaceId,
        ip,
        userAgent: getUserAgent(request),
        requestId,
      }, { publicId }, 'WARN')
      throw new AppError(
        'Missing X-ProofPilot-Signature header',
        401,
        'missing_signature',
      )
    }

    const valid = verifyDeploymentHookSignature(rawBody, signature, hook.secretHash)
    if (!valid) {
      await recordSecurityEvent('DEPLOYMENT_HOOK_INVALID_SIGNATURE', {
        actorType: 'SYSTEM',
        workspaceId: hook.workspaceId,
        ip,
        userAgent: getUserAgent(request),
        requestId,
      }, { publicId }, 'WARN')
      throw new AppError(
        'Invalid signature',
        401,
        'invalid_signature',
      )
    }

    // 5. Parse and validate payload
    const payload = payloadSchema.parse(JSON.parse(rawBody)) as DeploymentHookPayload

    // 6. Process the hook
    const result = await processDeploymentHook(hook, payload, {
      ip,
      userAgent: getUserAgent(request),
      requestId,
    })

    if (!result.accepted) {
      return NextResponse.json(
        { accepted: false, reason: result.reason },
        { status: 202, headers: { 'X-Request-Id': requestId } },
      )
    }

    return NextResponse.json(
      {
        accepted: true,
        message: 'Deployment hook processed successfully',
        scanRunId: result.scanRunId ?? undefined,
      },
      { status: 200, headers: { 'X-Request-Id': requestId } },
    )
  } catch (err) {
    // Log but don't leak details for security-sensitive errors
    if (err instanceof AppError && err.status === 401) {
      logger.warn('Deployment hook auth failure', {
        requestId,
        instance,
        error: err.message,
      })
    }
    return problemResponse(err, requestId, instance)
  }
}
