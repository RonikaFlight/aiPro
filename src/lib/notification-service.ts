/**
 * Notification service — ProofPilot (Phase 11)
 *
 * In-app notification lifecycle: creation, listing (cursor-paginated),
 * marking read (single/bulk), unread count, and soft-delete.
 *
 * All notifications are scoped to a userId. Workspace-scoped notifications
 * optionally carry a workspaceId for filtering.
 *
 * See IMPLEMENTATION_CHECKLIST.md Phase 11 §"Notifications".
 */
import { db } from './db'
import { logger } from './logger'
import { NotFoundError, ValidationError } from './errors'
import { recordAudit, type AuditContext } from './audit'

// ===========================================================
// Types
// ===========================================================

/** Supported notification event types. */
export type NotificationType =
  | 'FINDING_CREATED'
  | 'FINDING_RESOLVED'
  | 'RUN_COMPLETED'
  | 'RUN_FAILED'
  | 'JOURNEY_COMPLETED'
  | 'REPORT_SHARED'
  | 'INVITATION_ACCEPTED'
  | 'MEMBER_REMOVED'
  | 'SUBSCRIPTION_UPDATED'

/** Payload for creating a notification. */
export interface CreateNotificationInput {
  workspaceId?: string
  userId: string
  type: NotificationType
  title: string
  body?: string
  link?: string
  data?: Record<string, unknown>
}

/** A notification row returned from queries. */
export interface NotificationItem {
  id: string
  workspaceId: string | null
  type: string
  title: string
  body: string | null
  link: string | null
  metadataJson: string | null
  readAt: string | null
  createdAt: string
}

/** Cursor-paginated list response. */
export interface NotificationListResult {
  items: NotificationItem[]
  nextCursor: string | null
  hasMore: boolean
}

/** Options for listing notifications. */
export interface ListNotificationsOptions {
  cursor?: string
  limit?: number
  unreadOnly?: boolean
  type?: NotificationType | NotificationType[]
}

/** Audit context subset used by internal callers. */
type CtxLike = Pick<AuditContext, 'ip' | 'userAgent' | 'requestId'>

// ===========================================================
// Valid notification types (allowlist)
// ===========================================================

const VALID_TYPES: ReadonlySet<string> = new Set<NotificationType>([
  'FINDING_CREATED',
  'FINDING_RESOLVED',
  'RUN_COMPLETED',
  'RUN_FAILED',
  'JOURNEY_COMPLETED',
  'REPORT_SHARED',
  'INVITATION_ACCEPTED',
  'MEMBER_REMOVED',
  'SUBSCRIPTION_UPDATED',
])

function assertNotificationType(type: string): void {
  if (!VALID_TYPES.has(type)) {
    throw new ValidationError(
      `Invalid notification type: ${type}. Allowed: ${[...VALID_TYPES].join(', ')}`,
    )
  }
}

// ===========================================================
// Service functions
// ===========================================================

/**
 * Create a notification for a user.
 *
 * If `data` is provided it is serialized as JSON into `metadataJson`.
 * Does not record an audit log (notifications are informational, not mutations).
 */
export async function createNotification(
  input: CreateNotificationInput,
): Promise<NotificationItem> {
  assertNotificationType(input.type)

  const notification = await db.notification.create({
    data: {
      userId: input.userId,
      workspaceId: input.workspaceId ?? null,
      type: input.type,
      title: input.title,
      body: input.body ?? null,
      link: input.link ?? null,
      metadataJson: input.data ? JSON.stringify(input.data) : null,
    },
  })

  logger.debug('Notification created', {
    notificationId: notification.id,
    userId: input.userId,
    type: input.type,
  })

  return mapNotification(notification)
}

/**
 * List notifications for a user, most-recent-first, with cursor pagination.
 *
 * If `unreadOnly` is true, only returns notifications where `readAt` is null.
 * If `type` is provided, filters by one or more notification types.
 */
export async function listNotifications(
  userId: string,
  options: ListNotificationsOptions = {},
): Promise<NotificationListResult> {
  const limit = Math.min(options.limit ?? 20, 100)

  const where: Record<string, unknown> = {
    userId,
    deletedAt: null,
  }

  if (options.unreadOnly) {
    where.readAt = null
  }

  if (options.type) {
    const types = Array.isArray(options.type) ? options.type : [options.type]
    where.type = { in: types }
  }

  if (options.cursor) {
    // Cursor is the createdAt ISO string of the last item in the previous page
    where.createdAt = { lt: new Date(options.cursor) }
  }

  const notifications = await db.notification.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: limit + 1, // Fetch one extra to determine hasMore
  })

  const hasMore = notifications.length > limit
  const items = notifications.slice(0, limit).map(mapNotification)
  const nextCursor = hasMore
    ? items[items.length - 1]?.createdAt ?? null
    : null

  return { items, nextCursor, hasMore }
}

/**
 * Mark a single notification as read. Idempotent — if already read, no-op.
 */
export async function markNotificationRead(
  notificationId: string,
  userId: string,
): Promise<NotificationItem> {
  const notification = await db.notification.findUnique({
    where: { id: notificationId },
  })

  if (!notification || notification.userId !== userId || notification.deletedAt) {
    throw new NotFoundError('Notification')
  }

  const updated = await db.notification.update({
    where: { id: notificationId },
    data: { readAt: notification.readAt ?? new Date() },
  })

  return mapNotification(updated)
}

/**
 * Mark all unread notifications as read for a user.
 * Returns the count of notifications that were marked.
 */
export async function markAllNotificationsRead(
  userId: string,
): Promise<{ marked: number }> {
  const result = await db.notification.updateMany({
    where: {
      userId,
      readAt: null,
      deletedAt: null,
    },
    data: { readAt: new Date() },
  })

  return { marked: result.count }
}

/**
 * Get the count of unread (and not soft-deleted) notifications for a user.
 */
export async function getUnreadCount(userId: string): Promise<number> {
  return db.notification.count({
    where: {
      userId,
      readAt: null,
      deletedAt: null,
    },
  })
}

/**
 * Soft-delete a notification by setting `deletedAt`.
 */
export async function deleteNotification(
  notificationId: string,
  userId: string,
  ctx?: CtxLike,
): Promise<void> {
  const notification = await db.notification.findUnique({
    where: { id: notificationId },
  })

  if (!notification || notification.userId !== userId || notification.deletedAt) {
    throw new NotFoundError('Notification')
  }

  await db.notification.update({
    where: { id: notificationId },
    data: { deletedAt: new Date() },
  })

  if (ctx) {
    await recordAudit(
      'NOTIFICATION_DELETE',
      { type: 'notification', id: notificationId },
      {
        actorType: 'USER',
        actorId: userId,
        workspaceId: notification.workspaceId ?? undefined,
        ...ctx,
      },
    )
  }

  logger.debug('Notification soft-deleted', { notificationId, userId })
}

// ===========================================================
// Helpers
// ===========================================================

function mapNotification(n: {
  id: string
  workspaceId: string | null
  type: string
  title: string
  body: string | null
  link: string | null
  metadataJson: string | null
  readAt: Date | null
  deletedAt: Date | null
  createdAt: Date
}): NotificationItem {
  return {
    id: n.id,
    workspaceId: n.workspaceId,
    type: n.type,
    title: n.title,
    body: n.body,
    link: n.link,
    metadataJson: n.metadataJson,
    readAt: n.readAt?.toISOString() ?? null,
    createdAt: n.createdAt.toISOString(),
  }
}
