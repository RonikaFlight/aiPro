/**
 * Slack integration service — ProofPilot
 *
 * Manages Slack webhook configuration stored in the Integration/IntegrationSecret
 * models. Sends notifications using Slack Block Kit format with ProofPilot branding.
 *
 * Security:
 *   - SSRF protection: validates webhook URL is HTTPS and not a private IP
 *   - Webhook URL stored encrypted via IntegrationSecret
 *   - Rate limiting: max 30 messages per workspace per hour
 *
 * See IMPLEMENTATION_CHECKLIST.md §"Slack Integration".
 */
import { db } from './db'
import { logger } from './logger'
import { AppError, NotFoundError, ValidationError, RateLimitError } from './errors'
import { recordAudit, type AuditContext } from './audit'
import { encryptToJson, decryptFromJson } from './crypto'
import { isPrivateUrl } from './ssrf-guard'

// ===========================================================
// Types
// ===========================================================

/** Supported Slack notification event types. */
export type SlackEventType =
  | 'RUN_COMPLETED'
  | 'RUN_FAILED'
  | 'FINDING_CREATED'
  | 'REPORT_SHARED'
  | 'SUBSCRIPTION_UPDATED'

/** Payload for saving Slack configuration. */
export interface SaveSlackConfigInput {
  workspaceId: string
  webhookUrl: string
  channel?: string
  events: SlackEventType[]
}

/** Returned Slack configuration (webhook URL masked). */
export interface SlackConfig {
  enabled: boolean
  channel: string | null
  events: string[]
  webhookUrlMasked: string
  createdAt: string
  updatedAt: string
}

/** Audit context subset. */
type CtxLike = Pick<AuditContext, 'ip' | 'userAgent' | 'requestId'>

// ===========================================================
// Constants
// ===========================================================

const INTEGRATION_TYPE = 'slack'
const INTEGRATION_NAME = 'Slack'
const SECRET_KEY = 'webhook_url'
const MAX_MESSAGES_PER_HOUR = 30
const WEBHOOK_TIMEOUT_MS = 10_000

const VALID_EVENTS: ReadonlySet<string> = new Set<SlackEventType>([
  'RUN_COMPLETED',
  'RUN_FAILED',
  'FINDING_CREATED',
  'REPORT_SHARED',
  'SUBSCRIPTION_UPDATED',
])

const SLACK_GREEN = '#10B981'

// ===========================================================
// In-memory rate limiter
// ===========================================================

/** Maps workspaceId → array of send timestamps within the current hour window. */
const rateLimitMap = new Map<string, number[]>()

function pruneOldEntries(timestamps: number[]): number[] {
  const cutoff = Date.now() - 60 * 60 * 1000
  return timestamps.filter((ts) => ts > cutoff)
}

function checkRateLimit(workspaceId: string): void {
  const now = Date.now()
  let entries = rateLimitMap.get(workspaceId) ?? []
  entries = pruneOldEntries(entries)
  if (entries.length >= MAX_MESSAGES_PER_HOUR) {
    throw new RateLimitError(
      Math.ceil((entries[0] + 60 * 60 * 1000 - now) / 1000),
    )
  }
  entries.push(now)
  rateLimitMap.set(workspaceId, entries)
}

// ===========================================================
// Configuration CRUD
// ===========================================================

/**
 * Get the current Slack configuration for a workspace.
 * Returns masked webhook URL, channel, and enabled events.
 */
export async function getSlackConfig(
  workspaceId: string,
): Promise<SlackConfig> {
  const integration = await db.integration.findFirst({
    where: { workspaceId, type: INTEGRATION_TYPE },
    include: { secrets: true },
  })

  if (!integration) {
    throw new NotFoundError('Slack integration')
  }

  const webhookUrl = getWebhookUrl(integration.secrets)
  const config = parseConfig(integration.config)

  return {
    enabled: integration.enabled,
    channel: config.channel ?? null,
    events: config.events ?? [],
    webhookUrlMasked: maskUrl(webhookUrl),
    createdAt: integration.createdAt.toISOString(),
    updatedAt: integration.updatedAt.toISOString(),
  }
}

/**
 * Save or update Slack integration configuration.
 *
 * Validates the webhook URL format and SSRF safety, encrypts it,
 * and stores it in IntegrationSecret. Non-secret config (channel, events)
 * goes into Integration.config as JSON.
 */
export async function saveSlackConfig(
  input: SaveSlackConfigInput,
  actorId: string,
  ctx: CtxLike,
): Promise<SlackConfig> {
  // Validate webhook URL
  const url = normalizeSlackUrl(input.webhookUrl)
  await assertNotPrivateUrl(url)

  // Validate events
  if (!input.events || input.events.length === 0) {
    throw new ValidationError('At least one event type must be specified')
  }
  for (const event of input.events) {
    if (!VALID_EVENTS.has(event)) {
      throw new ValidationError(
        `Invalid event type: ${event}. Allowed: ${[...VALID_EVENTS].join(', ')}`,
      )
    }
  }

  // Validate channel if provided
  if (input.channel && !/^#?[A-Za-z0-9_-]{1,80}$/.test(input.channel)) {
    throw new ValidationError('Invalid Slack channel name')
  }

  const configJson = JSON.stringify({
    channel: input.channel ?? null,
    events: input.events,
  })
  const encryptedUrl = encryptToJson(url)

  // Upsert: find existing or create new
  const existing = await db.integration.findFirst({
    where: { workspaceId, type: INTEGRATION_TYPE },
    include: { secrets: true },
  })

  if (existing) {
    // Update integration config
    await db.integration.update({
      where: { id: existing.id },
      data: { config: configJson, enabled: true },
    })

    // Upsert the webhook URL secret
    const existingSecret = existing.secrets.find((s) => s.key === SECRET_KEY)
    if (existingSecret) {
      await db.integrationSecret.update({
        where: { id: existingSecret.id },
        data: { valueEncrypted: encryptedUrl },
      })
    } else {
      await db.integrationSecret.create({
        data: {
          integrationId: existing.id,
          key: SECRET_KEY,
          valueEncrypted: encryptedUrl,
        },
      })
    }

    await recordAudit(
      'INTEGRATION_UPDATE',
      { type: 'integration', id: existing.id },
      { actorType: 'USER', actorId, workspaceId: input.workspaceId, ...ctx },
      { integrationType: INTEGRATION_TYPE, events: input.events },
    )

    logger.info('Slack integration updated', {
      integrationId: existing.id,
      workspaceId: input.workspaceId,
    })
  } else {
    // Create new integration + secret
    const integration = await db.integration.create({
      data: {
        workspaceId: input.workspaceId,
        type: INTEGRATION_TYPE,
        name: INTEGRATION_NAME,
        config: configJson,
      },
    })

    await db.integrationSecret.create({
      data: {
        integrationId: integration.id,
        key: SECRET_KEY,
        valueEncrypted: encryptedUrl,
      },
    })

    await recordAudit(
      'INTEGRATION_CREATE',
      { type: 'integration', id: integration.id },
      { actorType: 'USER', actorId, workspaceId: input.workspaceId, ...ctx },
      { integrationType: INTEGRATION_TYPE, events: input.events },
    )

    logger.info('Slack integration created', {
      integrationId: integration.id,
      workspaceId: input.workspaceId,
    })
  }

  return getSlackConfig(input.workspaceId)
}

/**
 * Delete the Slack integration for a workspace.
 */
export async function deleteSlackConfig(
  workspaceId: string,
  actorId: string,
  ctx: CtxLike,
): Promise<void> {
  const integration = await db.integration.findFirst({
    where: { workspaceId, type: INTEGRATION_TYPE },
  })

  if (!integration) {
    throw new NotFoundError('Slack integration')
  }

  await db.integration.delete({ where: { id: integration.id } })

  // Clean up rate limit cache
  rateLimitMap.delete(workspaceId)

  await recordAudit(
    'INTEGRATION_DELETE',
    { type: 'integration', id: integration.id },
    { actorType: 'USER', actorId, workspaceId, ...ctx },
    { integrationType: INTEGRATION_TYPE },
  )

  logger.info('Slack integration deleted', {
    integrationId: integration.id,
    workspaceId,
  })
}

// ===========================================================
// Notification sending
// ===========================================================

/**
 * Send a Slack notification for an event.
 *
 * Looks up the workspace's Slack integration, checks if the event is enabled,
 * formats the message using Block Kit, and posts to the webhook.
 */
export async function sendSlackNotification(
  workspaceId: string,
  event: SlackEventType,
  payload: Record<string, unknown>,
): Promise<{ success: boolean; error?: string }> {
  const integration = await db.integration.findFirst({
    where: { workspaceId, type: INTEGRATION_TYPE, enabled: true },
    include: { secrets: true },
  })

  if (!integration) return { success: true } // No integration — silently skip

  const config = parseConfig(integration.config)
  if (!config.events.includes(event)) {
    return { success: true } // Event not subscribed — skip
  }

  const webhookUrl = getWebhookUrl(integration.secrets)

  // Rate limit check
  try {
    checkRateLimit(workspaceId)
  } catch (err) {
    if (err instanceof RateLimitError) {
      logger.warn('Slack rate limit hit', { workspaceId, event })
      return { success: false, error: 'rate_limited' }
    }
    throw err
  }

  const blocks = formatSlackBlocks(event, payload)
  const body = JSON.stringify({ blocks })

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    })

    if (response.status === 200) {
      logger.info('Slack notification sent', { workspaceId, event })
      return { success: true }
    }

    const errorText = await response.text().catch(() => '')
    logger.warn('Slack notification failed', {
      workspaceId,
      event,
      status: response.status,
      error: errorText,
    })
    return { success: false, error: `HTTP ${response.status}` }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    logger.warn('Slack notification error', { workspaceId, event, error: msg })
    return { success: false, error: msg }
  }
}

/**
 * Send a test message to a Slack webhook URL.
 * Used to verify the webhook configuration before saving.
 */
export async function testSlackNotification(
  webhookUrl: string,
): Promise<{ success: boolean; error?: string }> {
  const url = normalizeSlackUrl(webhookUrl)
  await assertNotPrivateUrl(url)

  const blocks = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: '✅ ProofPilot Test Notification',
        emoji: true,
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: 'Your Slack integration is working correctly! You will receive notifications for the events you have selected.',
      },
    },
    {
      type: 'divider',
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `*ProofPilot*  |  Test sent at ${new Date().toISOString()}`,
        },
      ],
    },
  ]

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ blocks }),
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    })

    if (response.status === 200) {
      return { success: true }
    }

    const errorText = await response.text().catch(() => '')
    return { success: false, error: `HTTP ${response.status}: ${errorText}` }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    return { success: false, error: msg }
  }
}

// ===========================================================
// Slack Block Kit formatters
// ===========================================================

function formatSlackBlocks(
  event: SlackEventType,
  payload: Record<string, unknown>,
): SlackBlock[] {
  switch (event) {
    case 'RUN_COMPLETED':
      return formatRunCompleted(payload)
    case 'RUN_FAILED':
      return formatRunFailed(payload)
    case 'FINDING_CREATED':
      return formatFindingCreated(payload)
    case 'REPORT_SHARED':
      return formatReportShared(payload)
    case 'SUBSCRIPTION_UPDATED':
      return formatSubscriptionUpdated(payload)
    default:
      return formatGeneric(event, payload)
  }
}

function formatRunCompleted(p: Record<string, unknown>): SlackBlock[] {
  const score = typeof p.score === 'number' ? p.score : null
  const scoreText = score !== null ? `*Score: ${score}/100*` : ''

  return [
    headerBlock('✅ Run Completed'),
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Project:*\n${str(p.projectName)}` },
        ...(scoreText ? [{ type: 'mrkdwn' as const, text: `*Score:*\n${score}/100` }] : []),
        { type: 'mrkdwn', text: `*Findings:*\n${str(p.findingsCount)} issue(s)` },
        { type: 'mrkdwn', text: `*Duration:*\n${str(p.duration)}` },
      ],
    },
    ...(p.runUrl ? [linkButton('View Run', str(p.runUrl))] : []),
    dividerBlock(),
    contextBlock(),
  ]
}

function formatRunFailed(p: Record<string, unknown>): SlackBlock[] {
  return [
    headerBlock('❌ Run Failed'),
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Project:*\n${str(p.projectName)}` },
        { type: 'mrkdwn', text: `*Error:*\n${str(p.reason)}` },
      ],
    },
    ...(p.runUrl ? [linkButton('View Run', str(p.runUrl))] : []),
    dividerBlock(),
    contextBlock(),
  ]
}

function formatFindingCreated(p: Record<string, unknown>): SlackBlock[] {
  const severity = str(p.severity).toUpperCase()

  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${severityBadge(severity)} Finding: ${str(p.title)}*`,
      },
      accessory: {
        type: 'button',
        text: { type: 'plain_text', text: 'View Finding', emoji: true },
        url: str(p.findingUrl),
        action_id: 'view_finding',
      },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Category:*\n${str(p.category)}` },
        { type: 'mrkdwn', text: `*Project:*\n${str(p.projectName)}` },
      ],
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: str(p.description).slice(0, 300),
      },
    },
    dividerBlock(),
    contextBlock(),
  ]
}

function formatReportShared(p: Record<string, unknown>): SlackBlock[] {
  return [
    headerBlock('📊 Report Shared'),
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Project:*\n${str(p.projectName)}` },
        { type: 'mrkdwn', text: `*Type:*\n${str(p.reportType)}` },
      ],
    },
    ...(p.shareUrl ? [linkButton('Open Report', str(p.shareUrl))] : []),
    dividerBlock(),
    contextBlock(),
  ]
}

function formatSubscriptionUpdated(p: Record<string, unknown>): SlackBlock[] {
  return [
    headerBlock('💳 Subscription Updated'),
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Plan Change:*\n${str(p.fromPlan)} → ${str(p.toPlan)}` },
        { type: 'mrkdwn', text: `*Effective:*\n${str(p.effectiveDate)}` },
      ],
    },
    dividerBlock(),
    contextBlock(),
  ]
}

function formatGeneric(event: string, p: Record<string, unknown>): SlackBlock[] {
  return [
    headerBlock(`🔔 ${event}`),
    {
      type: 'section',
      text: { type: 'mrkdwn', text: JSON.stringify(p, null, 2).slice(0, 1000) },
    },
    dividerBlock(),
    contextBlock(),
  ]
}

// ===========================================================
// Block Kit helpers
// ===========================================================

type SlackBlock = Record<string, unknown>

function headerBlock(text: string): SlackBlock {
  return {
    type: 'header',
    text: { type: 'plain_text', text, emoji: true },
  }
}

function dividerBlock(): SlackBlock {
  return { type: 'divider' }
}

function linkButton(text: string, url: string): SlackBlock {
  return {
    type: 'actions',
    elements: [
      {
        type: 'button',
        text: { type: 'plain_text', text, emoji: true },
        url,
        action_id: `link_${Date.now()}`,
      },
    ],
  }
}

function contextBlock(): SlackBlock {
  return {
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text: `*ProofPilot*  |  <https://proofpilot.app|Open Dashboard>`,
      },
    ],
  }
}

function severityBadge(severity: string): string {
  switch (severity) {
    case 'CRITICAL':
    case 'HIGH':
      return '🔴'
    case 'MEDIUM':
      return '🟡'
    case 'LOW':
    case 'INFO':
      return '🟢'
    default:
      return '⚪'
  }
}

function severityColor(severity: string): string {
  switch (severity) {
    case 'CRITICAL':
      return '#EF4444'
    case 'HIGH':
      return '#F97316'
    case 'MEDIUM':
      return '#F59E0B'
    default:
      return SLACK_GREEN
  }
}

// ===========================================================
// Internal helpers
// ===========================================================

interface SlackConfigData {
  channel: string | null
  events: string[]
}

function parseConfig(configJson: string | null): SlackConfigData {
  if (!configJson) return { channel: null, events: [] }
  try {
    const data = JSON.parse(configJson) as Partial<SlackConfigData>
    return {
      channel: data.channel ?? null,
      events: Array.isArray(data.events) ? data.events : [],
    }
  } catch {
    return { channel: null, events: [] }
  }
}

function getWebhookUrl(
  secrets: Array<{ key: string; valueEncrypted: string }>,
): string {
  const secret = secrets.find((s) => s.key === SECRET_KEY)
  if (!secret) {
    throw new AppError(
      'Slack webhook URL secret not found',
      500,
      'slack_config_error',
    )
  }
  return decryptFromJson(secret.valueEncrypted)
}

/** Normalize and validate a Slack webhook URL. Must be HTTPS. */
function normalizeSlackUrl(url: string): string {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:') {
      throw new ValidationError('Slack webhook URL must use HTTPS')
    }
    // Slack webhook URLs should be from hooks.slack.com or custom domains
    return parsed.origin + parsed.pathname.replace(/\/+$/, '') + parsed.search
  } catch (err) {
    if (err instanceof ValidationError) throw err
    throw new ValidationError('Invalid Slack webhook URL')
  }
}

/** SSRF check — reject private/internal IPs. */
async function assertNotPrivateUrl(url: string): Promise<void> {
  const parsed = new URL(url)
  if (await isPrivateUrl(parsed.hostname)) {
    throw new ValidationError(
      'Webhook URL must not point to a private or internal IP address',
    )
  }
}

/** Mask webhook URL for safe display (show first 8 and last 4 chars). */
function maskUrl(url: string): string {
  if (url.length <= 16) return '****'
  return url.slice(0, 8) + '****' + url.slice(-4)
}

/** Safe string coercion. */
function str(val: unknown): string {
  return typeof val === 'string' ? val : String(val ?? '')
}
