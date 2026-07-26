/**
 * Billing service — ProofPilot
 *
 * Stripe abstraction with developer-mode fallback.
 *
 * - If STRIPE_SECRET_KEY is set and STRIPE_DEV_MODE=false: live Stripe calls.
 * - If STRIPE_SECRET_KEY is absent or STRIPE_DEV_MODE=true: "developer mode"
 *   returns synthetic checkout/portal responses so the rest of the product
 *   works end-to-end without a real Stripe account.
 *
 * All webhook events are idempotent (unique by event ID) and recorded in
 * SubscriptionEvent for audit.
 *
 * See API_DESIGN.md §"Billing" and SECURITY_MODEL.md §"Webhooks".
 */
import { createHmac } from 'crypto'
import { db } from './db'
import { env } from './env'
import { AppError, ConflictError, NotFoundError, ValidationError } from './errors'
import { recordAudit, type AuditContext } from './audit'
import { logger } from './logger'
import { randomHex, sha256, timingSafeEqual } from './crypto'

// ---------------- Provider abstraction ----------------

export interface CheckoutSession {
  id: string
  url: string
  mode: 'payment' | 'subscription'
  planCode: string
  workspaceId: string
}

export interface PortalSession {
  id: string
  url: string
  workspaceId: string
}

export interface PaymentProvider {
  readonly name: 'stripe' | 'developer'
  createCheckoutSession(input: {
    workspaceId: string
    planCode: string
    successUrl: string
    cancelUrl: string
    customerEmail?: string
  }): Promise<CheckoutSession>
  createPortalSession(input: {
    workspaceId: string
    customerId: string
    returnUrl: string
  }): Promise<PortalSession>
  /** Verify a webhook signature. Returns the parsed payload or throws. */
  verifyWebhookSignature(payload: string, signature: string): Promise<Record<string, unknown>>
}

// ---------------- Developer-mode provider ----------------

class DeveloperPaymentProvider implements PaymentProvider {
  readonly name = 'developer' as const

  async createCheckoutSession(input: {
    workspaceId: string
    planCode: string
    successUrl: string
    cancelUrl: string
  }): Promise<CheckoutSession> {
    const id = 'dev_cs_' + randomHex(12)
    // In dev mode we redirect to the success URL with a synthetic session ID
    const url = new URL(input.successUrl)
    url.searchParams.set('checkout_session', id)
    url.searchParams.set('dev_mode', '1')
    url.searchParams.set('plan', input.planCode)
    logger.info('Dev-mode checkout session created', {
      workspaceId: input.workspaceId,
      planCode: input.planCode,
      sessionId: id,
    })
    return {
      id,
      url: url.toString(),
      mode: 'subscription',
      planCode: input.planCode,
      workspaceId: input.workspaceId,
    }
  }

  async createPortalSession(input: {
    workspaceId: string
    returnUrl: string
  }): Promise<PortalSession> {
    const id = 'dev_ps_' + randomHex(12)
    const url = new URL(input.returnUrl)
    url.searchParams.set('portal_session', id)
    url.searchParams.set('dev_mode', '1')
    logger.info('Dev-mode portal session created', {
      workspaceId: input.workspaceId,
      sessionId: id,
    })
    return {
      id,
      url: url.toString(),
      workspaceId: input.workspaceId,
    }
  }

  async verifyWebhookSignature(
    payload: string,
    signature: string,
  ): Promise<Record<string, unknown>> {
    // In dev mode we accept any non-empty signature and parse the payload as JSON.
    if (!signature) {
      throw new ValidationError('Missing webhook signature')
    }
    try {
      return JSON.parse(payload) as Record<string, unknown>
    } catch {
      throw new ValidationError('Malformed webhook payload')
    }
  }
}

// ---------------- Live Stripe provider ----------------

class StripePaymentProvider implements PaymentProvider {
  readonly name = 'stripe' as const
  private apiKey: string
  private webhookSecret: string

  constructor(apiKey: string, webhookSecret: string) {
    this.apiKey = apiKey
    this.webhookSecret = webhookSecret
  }

  private async stripeRequest(path: string, init: RequestInit = {}): Promise<unknown> {
    const res = await fetch(`https://api.stripe.com/v1${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        ...init.headers,
      },
    })
    if (!res.ok) {
      const body = await res.text()
      throw new AppError(
        `Stripe API error ${res.status}`,
        502,
        'stripe_api_error',
        'https://proofpilot.app/problems/stripe-api-error',
        { status: res.status, body: body.slice(0, 500) },
      )
    }
    return res.json()
  }

  async createCheckoutSession(input: {
    workspaceId: string
    planCode: string
    successUrl: string
    cancelUrl: string
    customerEmail?: string
  }): Promise<CheckoutSession> {
    const priceId = this.priceIdForPlan(input.planCode)
    if (!priceId) {
      throw new ValidationError(`No Stripe price configured for plan ${input.planCode}`)
    }
    const params = new URLSearchParams({
      mode: 'subscription',
      'line_items[0][price]': priceId,
      'line_items[0][quantity]': '1',
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      client_reference_id: input.workspaceId,
      metadata_workspace_id: input.workspaceId,
      metadata_plan_code: input.planCode,
    })
    if (input.customerEmail) params.set('customer_email', input.customerEmail)

    const session = (await this.stripeRequest('/checkout/sessions', {
      method: 'POST',
      body: params,
    })) as { id: string; url: string }

    return {
      id: session.id,
      url: session.url,
      mode: 'subscription',
      planCode: input.planCode,
      workspaceId: input.workspaceId,
    }
  }

  async createPortalSession(input: {
    workspaceId: string
    customerId: string
    returnUrl: string
  }): Promise<PortalSession> {
    const params = new URLSearchParams({
      customer: input.customerId,
      return_url: input.returnUrl,
    })
    const session = (await this.stripeRequest('/billing_portal/sessions', {
      method: 'POST',
      body: params,
    })) as { id: string; url: string }
    return {
      id: session.id,
      url: session.url,
      workspaceId: input.workspaceId,
    }
  }

  async verifyWebhookSignature(
    payload: string,
    signature: string,
  ): Promise<Record<string, unknown>> {
    // Stripe signs with HMAC-SHA256 over `${t}.${payload}` and sends as `t=...,v1=...`
    if (!this.webhookSecret) {
      throw new AppError(
        'STRIPE_WEBHOOK_SECRET not configured',
        500,
        'webhook_secret_missing',
        'https://proofpilot.app/problems/webhook-misconfigured',
      )
    }
    const parts = signature.split(',').map((s) => s.trim())
    const tPart = parts.find((p) => p.startsWith('t='))
    const v1Part = parts.find((p) => p.startsWith('v1='))
    if (!tPart || !v1Part) {
      throw new ValidationError('Malformed Stripe signature header')
    }
    const t = tPart.slice(2)
    const v1 = v1Part.slice(3)
    const signedPayload = `${t}.${payload}`
    const expected = this.computeSignature(this.webhookSecret, signedPayload)
    if (!timingSafeEqual(v1, expected)) {
      throw new AppError(
        'Invalid Stripe webhook signature',
        401,
        'invalid_webhook_signature',
        'https://proofpilot.app/problems/invalid-webhook-signature',
      )
    }
    // Tolerance: 5 minutes
    const ageMs = Math.abs(Date.now() - parseInt(t, 10) * 1000)
    if (ageMs > 5 * 60 * 1000) {
      throw new AppError(
        'Stripe webhook timestamp out of tolerance',
        401,
        'webhook_timestamp_skew',
        'https://proofpilot.app/problems/webhook-timestamp-skew',
      )
    }
    try {
      return JSON.parse(payload) as Record<string, unknown>
    } catch {
      throw new ValidationError('Malformed webhook payload')
    }
  }

  private computeSignature(secret: string, payload: string): string {
    // HMAC-SHA256 hex
    return createHmac('sha256', secret).update(payload).digest('hex')
  }

  private priceIdForPlan(planCode: string): string | null {
    switch (planCode) {
      case 'FREE':
        return env.STRIPE_PRICE_FREE || null
      case 'STARTER':
        return env.STRIPE_PRICE_STARTER || null
      case 'PRO':
        return env.STRIPE_PRICE_PRO || null
      case 'AGENCY':
        return env.STRIPE_PRICE_AGENCY || null
      default:
        return null
    }
  }
}

// ---------------- Provider selection ----------------

let cachedProvider: PaymentProvider | null = null

export function getPaymentProvider(): PaymentProvider {
  if (cachedProvider) return cachedProvider
  const useLive =
    env.STRIPE_SECRET_KEY &&
    !env.STRIPE_DEV_MODE &&
    env.APP_ENV === 'production'
  if (useLive) {
    cachedProvider = new StripePaymentProvider(env.STRIPE_SECRET_KEY, env.STRIPE_WEBHOOK_SECRET)
  } else {
    cachedProvider = new DeveloperPaymentProvider()
  }
  return cachedProvider
}

// ---------------- Subscription management ----------------

export interface SubscriptionInfo {
  id: string
  workspaceId: string
  status: string
  plan: {
    code: string
    name: string
    priceMonthly: number
    maxProjects: number
    maxRunsPerMonth: number
    maxPagesPerRun: number
    aiEnrichment: boolean
    scheduling: boolean
    whiteLabel: boolean
    journeys: boolean
    teamMembers: number
    retentionDays: number
    priorityQueue: boolean
  }
  stripeCustomerId: string | null
  stripeSubscriptionId: string | null
  currentPeriodStart: string | null
  currentPeriodEnd: string | null
  cancelAtPeriodEnd: boolean
  trialEndsAt: string | null
}

export async function getSubscription(
  workspaceId: string,
): Promise<SubscriptionInfo | null> {
  const sub = await db.subscription.findFirst({
    where: { workspaceId },
    orderBy: { createdAt: 'desc' },
    include: { plan: true },
  })
  if (!sub) return null
  return {
    id: sub.id,
    workspaceId: sub.workspaceId,
    status: sub.status,
    plan: {
      code: sub.plan.code,
      name: sub.plan.name,
      priceMonthly: sub.plan.priceMonthly,
      maxProjects: sub.plan.maxProjects,
      maxRunsPerMonth: sub.plan.maxRunsPerMonth,
      maxPagesPerRun: sub.plan.maxPagesPerRun,
      aiEnrichment: sub.plan.aiEnrichment,
      scheduling: sub.plan.scheduling,
      whiteLabel: sub.plan.whiteLabel,
      journeys: sub.plan.journeys,
      teamMembers: sub.plan.teamMembers,
      retentionDays: sub.plan.retentionDays,
      priorityQueue: sub.plan.priorityQueue,
    },
    stripeCustomerId: sub.stripeCustomerId,
    stripeSubscriptionId: sub.stripeSubscriptionId,
    currentPeriodStart: sub.currentPeriodStart?.toISOString() ?? null,
    currentPeriodEnd: sub.currentPeriodEnd?.toISOString() ?? null,
    cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
    trialEndsAt: sub.trialEndsAt?.toISOString() ?? null,
  }
}

/** Ensure a workspace has a subscription; create a TRIALING one on FREE if missing. */
export async function ensureSubscription(
  workspaceId: string,
  defaultPlanCode = 'FREE',
): Promise<SubscriptionInfo> {
  const existing = await getSubscription(workspaceId)
  if (existing) return existing

  const plan = await db.plan.findUnique({ where: { code: defaultPlanCode } })
  if (!plan) throw new NotFoundError('Plan ' + defaultPlanCode)

  const now = new Date()
  const trialEnd = new Date(now)
  trialEnd.setDate(trialEnd.getDate() + 14) // 14-day trial

  await db.subscription.create({
    data: {
      workspaceId,
      planId: plan.id,
      status: 'TRIALING',
      trialEndsAt: trialEnd,
      currentPeriodStart: now,
      currentPeriodEnd: trialEnd,
    },
  })
  return (await getSubscription(workspaceId))!
}

export interface CreateCheckoutInput {
  workspaceId: string
  planCode: string
  successUrl: string
  cancelUrl: string
  customerEmail?: string
  userId: string
  ctx: Pick<AuditContext, 'ip' | 'userAgent' | 'requestId'>
}

export async function createCheckoutSession(
  input: CreateCheckoutInput,
): Promise<CheckoutSession> {
  const plan = await db.plan.findUnique({ where: { code: input.planCode } })
  if (!plan) throw new NotFoundError('Plan')
  if (input.planCode === 'FREE') {
    throw new ValidationError('Cannot create a checkout session for the FREE plan')
  }

  const provider = getPaymentProvider()
  const session = await provider.createCheckoutSession({
    workspaceId: input.workspaceId,
    planCode: input.planCode,
    successUrl: input.successUrl,
    cancelUrl: input.cancelUrl,
    customerEmail: input.customerEmail,
  })

  await recordAudit(
    'BILLING_CHECKOUT_CREATED',
    { type: 'subscription', id: input.workspaceId },
    { ...input.ctx, actorType: 'USER', actorId: input.userId, workspaceId: input.workspaceId },
    { planCode: input.planCode, provider: provider.name, sessionId: session.id },
  )
  return session
}

export interface CreatePortalInput {
  workspaceId: string
  returnUrl: string
  userId: string
  ctx: Pick<AuditContext, 'ip' | 'userAgent' | 'requestId'>
}

export async function createPortalSession(
  input: CreatePortalInput,
): Promise<PortalSession> {
  const sub = await getSubscription(input.workspaceId)
  if (!sub) throw new NotFoundError('Subscription')
  const provider = getPaymentProvider()

  if (provider.name === 'developer') {
    const session = await provider.createPortalSession({
      workspaceId: input.workspaceId,
      customerId: 'dev_customer',
      returnUrl: input.returnUrl,
    })
    await recordAudit(
      'BILLING_PORTAL_CREATED',
      { type: 'subscription', id: input.workspaceId },
      { ...input.ctx, actorType: 'USER', actorId: input.userId, workspaceId: input.workspaceId },
      { provider: provider.name, sessionId: session.id },
    )
    return session
  }

  if (!sub.stripeCustomerId) {
    throw new AppError(
      'No Stripe customer ID for this subscription',
      409,
      'no_stripe_customer',
      'https://proofpilot.app/problems/no-stripe-customer',
    )
  }
  const session = await provider.createPortalSession({
    workspaceId: input.workspaceId,
    customerId: sub.stripeCustomerId,
    returnUrl: input.returnUrl,
  })
  await recordAudit(
    'BILLING_PORTAL_CREATED',
    { type: 'subscription', id: input.workspaceId },
    { ...input.ctx, actorType: 'USER', actorId: input.userId, workspaceId: input.workspaceId },
    { provider: provider.name, sessionId: session.id },
  )
  return session
}

/**
 * Handle an incoming Stripe webhook. Idempotent: each event is processed once.
 *
 * Verifies the signature, then records a SubscriptionEvent row (unique on
 * Stripe event ID) before dispatching to a handler.
 */
export async function handleStripeWebhook(payload: string, signature: string): Promise<{
  received: boolean
  eventType: string
  eventId: string | null
}> {
  const provider = getPaymentProvider()
  const event = await provider.verifyWebhookSignature(payload, signature)
  const eventType = String(event.type ?? 'unknown')
  const eventId = String(event.id ?? '')
  const created = Number(event.created ?? Math.floor(Date.now() / 1000))
  const data = (event.data as { object?: Record<string, unknown> } | undefined)?.object ?? {}

  if (!eventId) {
    logger.warn('Stripe webhook missing event ID', { eventType })
  }

  // Idempotency: SubscriptionEvent has a unique constraint on payloadJson hash? No —
  // we use a deterministic synthetic key based on eventId.
  const eventIdKey = eventId || 'no_event_id_' + sha256(payload).slice(0, 32)

  // Look up by event id (stored as eventType suffix on subscriptionEvent)
  // We persist rows keyed by (subscriptionId, eventType+eventId). To avoid a schema
  // change we use payloadJson to store {eventId} and rely on application-level dedup.
  const existing = await db.subscriptionEvent.findFirst({
    where: { eventType: `stripe:${eventIdKey}` },
  })
  if (existing) {
    logger.debug('Stripe webhook already processed (idempotent)', { eventId, eventType })
    return { received: true, eventType, eventId: eventId || null }
  }

  // Find the subscription by customer or subscription id from the payload
  const customerId = String(data.customer ?? '')
  const subscriptionId = String(
    data.id ?? (event.data as { object?: { subscription?: string } } | undefined)?.object?.subscription ?? '',
  )
  const orClauses: Array<{ stripeCustomerId?: string } | { stripeSubscriptionId?: string }> = []
  if (customerId) orClauses.push({ stripeCustomerId: customerId })
  if (subscriptionId) orClauses.push({ stripeSubscriptionId: subscriptionId })
  let subscription = orClauses.length > 0
    ? await db.subscription.findFirst({ where: { OR: orClauses } })
    : null

  // If no subscription yet and this is a checkout.session.completed, create one
  if (!subscription && eventType === 'checkout.session.completed') {
    const workspaceId = String(data.client_reference_id ?? '')
    const planCode = String(
      (data.metadata as Record<string, unknown> | undefined)?.plan_code ?? '',
    )
    if (workspaceId && planCode) {
      const plan = await db.plan.findUnique({ where: { code: planCode } })
      if (plan) {
        subscription = await db.subscription.create({
          data: {
            workspaceId,
            planId: plan.id,
            status: 'ACTIVE',
            stripeCustomerId: customerId || null,
            stripeSubscriptionId: subscriptionId || null,
            currentPeriodStart: new Date(created * 1000),
            currentPeriodEnd: new Date(created * 1000 + 30 * 24 * 60 * 60 * 1000),
          },
        })
      }
    }
  }

  if (!subscription) {
    // No matching subscription — record this in the audit log via logger and exit.
    // (SubscriptionEvent has a FK to Subscription, so we can't insert orphan events.)
    logger.warn('Stripe webhook: no matching subscription', { eventId, eventType, customerId, subscriptionId })
    return { received: true, eventType, eventId: eventId || null }
  }

  // Record the event for audit/idempotency (FK to subscription required)
  await db.subscriptionEvent.create({
    data: {
      subscriptionId: subscription.id,
      eventType: `stripe:${eventIdKey}`,
      payloadJson: JSON.stringify({ eventId, eventType, created, data }),
    },
  })

  // Apply state transitions
  switch (eventType) {
    case 'checkout.session.completed':
      await db.subscription.update({
        where: { id: subscription.id },
        data: {
          status: 'ACTIVE',
          stripeCustomerId: customerId || subscription.stripeCustomerId,
          stripeSubscriptionId: subscriptionId || subscription.stripeSubscriptionId,
        },
      })
      break
    case 'customer.subscription.updated':
    case 'customer.subscription.created': {
      const status = String(data.status ?? 'ACTIVE').toUpperCase()
      const periodStart = data.current_period_start
        ? new Date(Number(data.current_period_start) * 1000)
        : undefined
      const periodEnd = data.current_period_end
        ? new Date(Number(data.current_period_end) * 1000)
        : undefined
      const cancelAtPeriodEnd = Boolean(data.cancel_at_period_end)
      await db.subscription.update({
        where: { id: subscription.id },
        data: {
          status,
          stripeSubscriptionId: subscriptionId || subscription.stripeSubscriptionId,
          currentPeriodStart: periodStart,
          currentPeriodEnd: periodEnd,
          cancelAtPeriodEnd,
        },
      })
      break
    }
    case 'customer.subscription.deleted':
      await db.subscription.update({
        where: { id: subscription.id },
        data: { status: 'CANCELED', cancelAtPeriodEnd: false },
      })
      break
    case 'invoice.payment_failed':
      await db.subscription.update({
        where: { id: subscription.id },
        data: { status: 'PAST_DUE' },
      })
      break
    case 'invoice.paid':
      // Mark as active and refresh period
      await db.subscription.update({
        where: { id: subscription.id },
        data: { status: 'ACTIVE' },
      })
      break
    default:
      // Other events are recorded but don't change subscription state
      break
  }

  logger.info('Stripe webhook processed', { eventId, eventType, subscriptionId: subscription.id })
  return { received: true, eventType, eventId: eventId || null }
}

/**
 * Admin / support action: change a workspace's plan directly. Used by the
 * platform admin UI for refunds, plan corrections, etc. Audit-logged.
 */
export async function adminChangePlan(
  workspaceId: string,
  planCode: string,
  actorId: string,
  ctx: Pick<AuditContext, 'ip' | 'userAgent' | 'requestId'>,
): Promise<SubscriptionInfo> {
  const plan = await db.plan.findUnique({ where: { code: planCode } })
  if (!plan) throw new NotFoundError('Plan')

  const existing = await db.subscription.findFirst({
    where: { workspaceId },
    orderBy: { createdAt: 'desc' },
  })

  if (existing) {
    await db.subscription.update({
      where: { id: existing.id },
      data: { planId: plan.id, status: 'ACTIVE' },
    })
  } else {
    await db.subscription.create({
      data: {
        workspaceId,
        planId: plan.id,
        status: 'ACTIVE',
        currentPeriodStart: new Date(),
        currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      },
    })
  }

  await recordAudit(
    'BILLING_PLAN_CHANGED',
    { type: 'subscription', id: workspaceId },
    { ...ctx, actorType: 'SUPPORT', actorId, workspaceId },
    { planCode, action: 'admin_change' },
  )

  return (await getSubscription(workspaceId))!
}
