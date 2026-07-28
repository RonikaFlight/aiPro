# Task 3 — Phase 11 Backend Services

**Agent**: main (Z.ai Code)
**Task**: Build Phase 11 backend services — notifications, retention cleanup, outgoing webhooks, scheduling.

## Work Log

### Schema Changes
- Added `name` field to `OutgoingWebhook` model (String, required)
- Added `metadataJson` field to `Notification` model (String?, for extra data payload)
- Added `deletedAt` field to `Notification` model (DateTime?, for soft-delete)
- Ran `db:push` to sync schema and regenerate Prisma client

### Files Created

#### 1. `src/lib/notification-service.ts`
- `createNotification()` — creates Notification row with type validation
- `listNotifications()` — cursor-paginated, most-recent-first, supports `unreadOnly` and `type` filters
- `markNotificationRead()` — idempotent single-read mark
- `markAllNotificationsRead()` — bulk mark, returns count
- `getUnreadCount()` — count unread + not soft-deleted
- `deleteNotification()` — soft-delete via `deletedAt`, audit-logged
- 9 notification types: FINDING_CREATED, FINDING_RESOLVED, RUN_COMPLETED, RUN_FAILED, JOURNEY_COMPLETED, REPORT_SHARED, INVITATION_ACCEPTED, MEMBER_REMOVED, SUBSCRIPTION_UPDATED

#### 2. `src/app/api/v1/notifications/route.ts`
- GET: list notifications with query params (cursor, limit, unreadOnly, type)

#### 3. `src/app/api/v1/notifications/[id]/read/route.ts`
- POST: mark single notification as read

#### 4. `src/app/api/v1/notifications/read-all/route.ts`
- POST: mark all unread notifications as read

#### 5. `src/app/api/v1/notifications/unread-count/route.ts`
- GET: return unread notification count

#### 6. `src/lib/retention-service.ts`
- `runRetentionCleanup()` — orchestrates all cleanup sub-tasks
- `cleanupExpiredSessions()` — removes sessions past absoluteExpiresAt
- `cleanupExpiredInvitations()` — removes invitations past expiresAt (not accepted)
- `cleanupOldExports()` — removes DataExportRequest rows past retention (default 30 days)
- `cleanupOldArtifacts()` — removes Artifact rows based on workspace retentionDays (max 90-day ceiling)
- All sub-tasks run in parallel via Promise.all
- Returns RetentionCleanupSummary with counts per entity type

#### 7. `src/lib/ssrf-guard.ts`
- `isPrivateUrl()` — async DNS lookup + private IP check
- `isPrivateIpAddress()` — validates both IPv4 and IPv6 against private ranges
- Blocked: 127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16, 0.0.0.0/8, ::1, fc00::/7, fe80::/10, ::ffff:0:0/96, ::

#### 8. `src/lib/outgoing-webhook-service.ts`
- `createWebhook()` — validates URL (SSRF), events, name; generates secret; returns raw secret once
- `updateWebhook()` — updates config, resets failure count on re-enable
- `deleteWebhook()` — hard delete with cascade of deliveries
- `listWebhooks()` / `getWebhook()` — standard CRUD queries
- `deliverEvent()` — sends POST with HMAC-SHA256 signature; headers: X-ProofPilot-Event, X-ProofPilot-Timestamp, X-ProofPilot-Delivery-ID, X-ProofPilot-Signature
- `retryFailedDelivery()` — exponential backoff (60s, 300s, 900s), max 3 retries
- Auto-disable after 5 consecutive failures
- Max 20 webhooks per workspace

#### 9. `src/app/api/v1/workspaces/[workspaceId]/webhooks/route.ts`
- GET: list webhooks for workspace
- POST: create webhook (requires integrations.manage)

#### 10. `src/app/api/v1/webhooks/[webhookId]/route.ts`
- GET/PUT/DELETE: single webhook operations (resolves workspace for auth)

#### 11. `src/app/api/v1/webhooks/[webhookId]/deliveries/[deliveryId]/retry/route.ts`
- POST: retry a failed delivery

#### 12. `src/lib/scheduling-service.ts`
- `createSchedule()` — validates cron, timezone; enforces plan.scheduling check; max 10 per project; computes initial nextRunAt
- `updateSchedule()` — updates config; recomputes nextRunAt if cron/timezone change
- `deleteSchedule()` — hard delete
- `listSchedules()` / `getSchedule()` — standard CRUD
- `toggleSchedule()` — enable/disable; recomputes nextRunAt on enable
- `shouldRunSchedule()` — checks if schedule is due (enabled + nextRunAt <= now)
- `recordScheduleRun()` — updates lastRunAt, computes nextRunAt
- `findDueSchedules()` — queries all schedules past their nextRunAt (for worker polling)
- `isValidCron()` — validates 5-field POSIX cron expressions
- `computeNextRun()` — iterates minute-by-minute in target timezone using Intl.DateTimeFormat
- `isValidTimezone()` — validates timezone via Intl.DateTimeFormat

#### 13. `src/app/api/v1/projects/[projectId]/schedules/route.ts`
- GET: list schedules for project
- POST: create schedule (requires projects.update)

#### 14. `src/app/api/v1/schedules/[scheduleId]/route.ts`
- GET/PUT/DELETE: single schedule operations

#### 15. `src/app/api/v1/schedules/[scheduleId]/toggle/route.ts`
- POST: enable/disable schedule with body `{ enabled: boolean }`

### Patterns Followed
- All services use `import { db } from '@/lib/db'` for Prisma access
- All mutations record audit logs via `recordAudit()`
- All API routes use `requireAuth()` / `requireWorkspaceAuth()` for authentication
- Error handling uses `problemResponse()` from `./errors`
- TypeScript strict types with no `any`
- SSRF protection for outgoing webhooks
- HMAC-SHA256 signature on webhook deliveries
- Plan enforcement for scheduling

### ESLint
- All 16 new files pass ESLint with zero errors
- Full project `bun run lint` passes cleanly
