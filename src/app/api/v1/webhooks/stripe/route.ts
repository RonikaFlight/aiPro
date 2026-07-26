import { NextResponse } from 'next/server'
import { problemResponse, newRequestId } from '@/lib/errors'
import { handleStripeWebhook } from '@/lib/billing-service'
import { env } from '@/lib/env'
import { logger } from '@/lib/logger'

export const dynamic = 'force-dynamic'

/**
 * Stripe webhook handler.
 *
 * CRITICAL: this endpoint is exempt from CSRF (signature-gated instead).
 * It must:
 *   1. Read the raw request body (not JSON-parsed — signature is over raw bytes).
 *   2. Verify the Stripe-Signature header against STRIPE_WEBHOOK_SECRET.
 *   3. Be idempotent (each event processed exactly once).
 *   4. Record every event in SubscriptionEvent for audit.
 *
 * In dev mode (STRIPE_DEV_MODE=true or no STRIPE_SECRET_KEY), the provider
 * accepts any non-empty signature for local testing.
 */
export async function POST(request: Request) {
  const requestId = request.headers.get('X-Request-Id') ?? newRequestId()
  const instance = new URL(request.url).pathname
  try {
    const rawBody = await request.text()
    const signature = request.headers.get('stripe-signature') ?? ''

    if (!rawBody) {
      return NextResponse.json(
        {
          type: 'https://proofpilot.app/problems/validation-error',
          title: 'Empty webhook payload',
          status: 422,
          detail: 'Request body is empty',
          instance,
          requestId,
          code: 'validation_error',
        },
        { status: 422, headers: { 'Content-Type': 'application/problem+json' } },
      )
    }

    // Enforce max body size (256 KB)
    if (rawBody.length > 256 * 1024) {
      return NextResponse.json(
        {
          type: 'https://proofpilot.app/problems/payload-too-large',
          title: 'Webhook payload too large',
          status: 413,
          detail: 'Payload exceeds 256 KB limit',
          instance,
          requestId,
          code: 'payload_too_large',
        },
        { status: 413, headers: { 'Content-Type': 'application/problem+json' } },
      )
    }

    // Require signature in production; in dev mode allow unsigned requests from localhost
    if (!signature && env.APP_ENV === 'production') {
      return NextResponse.json(
        {
          type: 'https://proofpilot.app/problems/invalid-webhook-signature',
          title: 'Missing Stripe signature',
          status: 401,
          detail: 'Stripe-Signature header is required',
          instance,
          requestId,
          code: 'invalid_webhook_signature',
        },
        { status: 401, headers: { 'Content-Type': 'application/problem+json' } },
      )
    }

    const result = await handleStripeWebhook(rawBody, signature)
    logger.info('Stripe webhook received', {
      eventType: result.eventType,
      eventId: result.eventId,
    })
    return NextResponse.json({ received: true, eventType: result.eventType, eventId: result.eventId })
  } catch (err) {
    return problemResponse(err, requestId, instance)
  }
}
