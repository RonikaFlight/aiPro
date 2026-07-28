/**
 * Scheduling service — ProofPilot (Phase 11)
 *
 * CRUD and runtime evaluation for scan schedules.
 *
 * Each ScanSchedule belongs to a Project and (optionally) a ScanProfile.
 * The scheduling worker calls `shouldRunSchedule()` to determine if a
 * schedule should fire, then `recordScheduleRun()` after kicking off the run.
 *
 * Plan enforcement: the workspace's plan must have `scheduling: true`.
 *
 * Cron parsing: 5-field POSIX cron (minute hour day-of-month month day-of-week).
 * Timezone support: uses Intl.DateTimeFormat for zone conversion.
 *
 * See IMPLEMENTATION_CHECKLIST.md Phase 11 §"Scheduling".
 */
import { db } from './db'
import { logger } from './logger'
import {
  AppError,
  NotFoundError,
  PaymentRequiredError,
  ValidationError,
} from './errors'
import { recordAudit, type AuditContext } from './audit'
import { getSubscription } from './billing-service'

// ===========================================================
// Types
// ===========================================================

/** Payload for creating a schedule. */
export interface CreateScheduleInput {
  projectId: string
  cron: string
  timezone: string
  scanProfileId?: string
  enabled?: boolean
}

/** Schedule row returned from queries. */
export interface ScheduleItem {
  id: string
  projectId: string
  scanProfileId: string | null
  cron: string
  timezone: string
  enabled: boolean
  lastRunAt: string | null
  nextRunAt: string | null
  createdAt: string
  updatedAt: string
}

/** Fields that can be updated on a schedule. */
export interface UpdateScheduleInput {
  cron?: string
  timezone?: string
  scanProfileId?: string | null
  enabled?: boolean
}

/** Audit context subset. */
type CtxLike = Pick<AuditContext, 'ip' | 'userAgent' | 'requestId'>

// ===========================================================
// CRUD
// ===========================================================

/**
 * Create a new scan schedule for a project.
 *
 * Validates:
 *   - The project exists in the given workspace
 *   - The workspace's plan has scheduling enabled
 *   - The cron expression is valid
 *   - The timezone is supported
 *   - Max 10 schedules per project (sane upper bound)
 */
export async function createSchedule(
  input: CreateScheduleInput,
  actorId: string,
  ctx: CtxLike,
): Promise<ScheduleItem> {
  // Validate the project exists
  const project = await db.project.findUnique({
    where: { id: input.projectId },
    include: { workspace: { include: { plan: true } } },
  })
  if (!project) {
    throw new NotFoundError('Project')
  }

  // Plan enforcement: workspace's plan must support scheduling
  const sub = await getSubscription(project.workspaceId)
  if (!sub || !sub.plan.scheduling) {
    throw new PaymentRequiredError(
      'Scheduling requires an upgraded plan. Please upgrade to enable scheduled scans.',
    )
  }

  // Validate cron
  if (!isValidCron(input.cron)) {
    throw new ValidationError(
      `Invalid cron expression: ${input.cron}. Use 5-field POSIX format (minute hour day-of-month month day-of-week).`,
    )
  }

  // Validate timezone
  if (!isValidTimezone(input.timezone)) {
    throw new ValidationError(`Invalid timezone: ${input.timezone}`)
  }

  // Validate scan profile belongs to this project (if provided)
  if (input.scanProfileId) {
    const profile = await db.scanProfile.findUnique({
      where: { id: input.scanProfileId },
      select: { projectId: true },
    })
    if (!profile || profile.projectId !== input.projectId) {
      throw new NotFoundError('Scan profile')
    }
  }

  // Enforce max 10 schedules per project
  const existingCount = await db.scanSchedule.count({
    where: { projectId: input.projectId },
  })
  if (existingCount >= 10) {
    throw new ValidationError(
      'Maximum number of schedules (10) reached for this project',
    )
  }

  // Compute initial nextRunAt
  const nextRunAt = computeNextRun(input.cron, input.timezone, new Date())

  const schedule = await db.scanSchedule.create({
    data: {
      projectId: input.projectId,
      scanProfileId: input.scanProfileId ?? null,
      cron: input.cron,
      timezone: input.timezone,
      enabled: input.enabled ?? true,
      nextRunAt,
    },
  })

  await recordAudit(
    'SCHEDULE_CREATE',
    { type: 'scan_schedule', id: schedule.id },
    {
      actorType: 'USER',
      actorId,
      workspaceId: project.workspaceId,
      ...ctx,
    },
    { projectId: input.projectId, cron: input.cron, timezone: input.timezone },
  )

  logger.info('Scan schedule created', {
    scheduleId: schedule.id,
    projectId: input.projectId,
    cron: input.cron,
    nextRunAt,
  })

  return mapSchedule(schedule)
}

/**
 * Update a scan schedule.
 *
 * If cron or timezone changes, recomputes nextRunAt.
 */
export async function updateSchedule(
  scheduleId: string,
  data: UpdateScheduleInput,
  actorId: string,
  ctx: CtxLike,
): Promise<ScheduleItem> {
  const schedule = await db.scanSchedule.findUnique({
    where: { id: scheduleId },
    include: { project: { select: { workspaceId: true } } },
  })
  if (!schedule) {
    throw new NotFoundError('Schedule')
  }

  const updateData: Record<string, unknown> = {}

  if (data.cron !== undefined) {
    if (!isValidCron(data.cron)) {
      throw new ValidationError(`Invalid cron expression: ${data.cron}`)
    }
    updateData.cron = data.cron
  }

  if (data.timezone !== undefined) {
    if (!isValidTimezone(data.timezone)) {
      throw new ValidationError(`Invalid timezone: ${data.timezone}`)
    }
    updateData.timezone = data.timezone
  }

  if (data.scanProfileId !== undefined) {
    if (data.scanProfileId === null) {
      updateData.scanProfileId = null
    } else {
      const profile = await db.scanProfile.findUnique({
        where: { id: data.scanProfileId },
        select: { projectId: true },
      })
      if (!profile || profile.projectId !== schedule.projectId) {
        throw new NotFoundError('Scan profile')
      }
      updateData.scanProfileId = data.scanProfileId
    }
  }

  if (data.enabled !== undefined) {
    updateData.enabled = data.enabled
  }

  // Recompute nextRunAt if cron or timezone changed
  if (data.cron !== undefined || data.timezone !== undefined) {
    const cron = (updateData.cron as string) ?? schedule.cron
    const tz = (updateData.timezone as string) ?? schedule.timezone
    updateData.nextRunAt = computeNextRun(cron, tz, new Date())
  }

  const updated = await db.scanSchedule.update({
    where: { id: scheduleId },
    data: updateData,
  })

  await recordAudit(
    'SCHEDULE_UPDATE',
    { type: 'scan_schedule', id: scheduleId },
    {
      actorType: 'USER',
      actorId,
      workspaceId: schedule.project.workspaceId,
      ...ctx,
    },
    { changedFields: Object.keys(updateData) },
  )

  return mapSchedule(updated)
}

/**
 * Delete a scan schedule.
 */
export async function deleteSchedule(
  scheduleId: string,
  actorId: string,
  ctx: CtxLike,
): Promise<void> {
  const schedule = await db.scanSchedule.findUnique({
    where: { id: scheduleId },
    include: { project: { select: { workspaceId: true } } },
  })
  if (!schedule) {
    throw new NotFoundError('Schedule')
  }

  await db.scanSchedule.delete({ where: { id: scheduleId } })

  await recordAudit(
    'SCHEDULE_DELETE',
    { type: 'scan_schedule', id: scheduleId },
    {
      actorType: 'USER',
      actorId,
      workspaceId: schedule.project.workspaceId,
      ...ctx,
    },
  )

  logger.info('Scan schedule deleted', { scheduleId })
}

/**
 * List all schedules for a project.
 */
export async function listSchedules(projectId: string): Promise<ScheduleItem[]> {
  const schedules = await db.scanSchedule.findMany({
    where: { projectId },
    orderBy: { createdAt: 'desc' },
  })
  return schedules.map(mapSchedule)
}

/**
 * Get a single schedule by ID.
 */
export async function getSchedule(scheduleId: string): Promise<ScheduleItem> {
  const schedule = await db.scanSchedule.findUnique({
    where: { id: scheduleId },
  })
  if (!schedule) {
    throw new NotFoundError('Schedule')
  }
  return mapSchedule(schedule)
}

/**
 * Enable or disable a schedule.
 */
export async function toggleSchedule(
  scheduleId: string,
  enabled: boolean,
  actorId: string,
  ctx: CtxLike,
): Promise<ScheduleItem> {
  const schedule = await db.scanSchedule.findUnique({
    where: { id: scheduleId },
    include: { project: { select: { workspaceId: true } } },
  })
  if (!schedule) {
    throw new NotFoundError('Schedule')
  }

  // If re-enabling, recompute nextRunAt
  const updateData: Record<string, unknown> = { enabled }
  if (enabled && !schedule.enabled) {
    updateData.nextRunAt = computeNextRun(
      schedule.cron,
      schedule.timezone,
      new Date(),
    )
  } else if (!enabled) {
    updateData.nextRunAt = null
  }

  const updated = await db.scanSchedule.update({
    where: { id: scheduleId },
    data: updateData,
  })

  await recordAudit(
    'SCHEDULE_TOGGLE',
    { type: 'scan_schedule', id: scheduleId },
    {
      actorType: 'USER',
      actorId,
      workspaceId: schedule.project.workspaceId,
      ...ctx,
    },
    { enabled },
  )

  return mapSchedule(updated)
}

// ===========================================================
// Runtime evaluation
// ===========================================================

/**
 * Check if a schedule should fire now.
 *
 * A schedule should run if:
 *   - It is enabled
 *   - nextRunAt is set and is in the past (or equal to now)
 *   - It hasn't run since nextRunAt was computed
 */
export async function shouldRunSchedule(
  scheduleId: string,
): Promise<boolean> {
  const schedule = await db.scanSchedule.findUnique({
    where: { id: scheduleId },
  })
  if (!schedule) {
    throw new NotFoundError('Schedule')
  }

  if (!schedule.enabled) return false
  if (!schedule.nextRunAt) return false

  const now = new Date()
  // Schedule is due if nextRunAt is in the past
  return schedule.nextRunAt <= now
}

/**
 * Record that a schedule has run.
 *
 * Updates lastRunAt to now, and recomputes nextRunAt based on cron+timezone.
 */
export async function recordScheduleRun(
  scheduleId: string,
  runId: string,
): Promise<ScheduleItem> {
  const schedule = await db.scanSchedule.findUnique({
    where: { id: scheduleId },
  })
  if (!schedule) {
    throw new NotFoundError('Schedule')
  }

  const now = new Date()
  const nextRunAt = computeNextRun(schedule.cron, schedule.timezone, now)

  const updated = await db.scanSchedule.update({
    where: { id: scheduleId },
    data: {
      lastRunAt: now,
      nextRunAt,
    },
  })

  logger.info('Schedule run recorded', {
    scheduleId,
    runId,
    nextRunAt,
  })

  return mapSchedule(updated)
}

/**
 * Find all schedules that are due to run.
 * Used by the scheduling worker to poll for ready schedules.
 */
export async function findDueSchedules(limit = 50): Promise<ScheduleItem[]> {
  const now = new Date()
  const schedules = await db.scanSchedule.findMany({
    where: {
      enabled: true,
      nextRunAt: { lte: now },
    },
    orderBy: { nextRunAt: 'asc' },
    take: limit,
  })
  return schedules.map(mapSchedule)
}

// ===========================================================
// Cron parsing & next-run computation
// ===========================================================

/**
 * Validate a 5-field POSIX cron expression.
 *
 * Fields: minute hour day-of-month month day-of-week
 * Supports: wildcard, specific numbers, ranges (1-5), lists (1,3,5), step values (N/15)
 * Day-of-week: 0-7 (0 and 7 are both Sunday)
 */
export function isValidCron(cron: string): boolean {
  const parts = cron.trim().split(/\s+/)
  if (parts.length !== 5) return false

  const ranges = [
    [0, 59], // minute
    [0, 23], // hour
    [1, 31], // day-of-month
    [1, 12], // month
    [0, 7], // day-of-week (0 and 7 = Sunday)
  ]

  for (let i = 0; i < 5; i++) {
    if (!isValidCronField(parts[i], ranges[i][0], ranges[i][1])) {
      return false
    }
  }

  return true
}

function isValidCronField(field: string, min: number, max: number): boolean {
  if (field === '*') return true

  // Handle step values: */15 or 1-10/2 or 1,3,5/2 (last form is unusual)
  const parts = field.split('/')
  if (parts.length > 2) return false

  const stepStr = parts.length === 2 ? parts[1] : null
  if (stepStr !== null) {
    const step = parseInt(stepStr, 10)
    if (isNaN(step) || step < 1) return false
  }

  const rangePart = parts[0]
  if (rangePart === '*') return true

  // Handle comma-separated list
  const items = rangePart.split(',')
  for (const item of items) {
    if (!isValidCronItem(item, min, max)) return false
  }

  return true
}

function isValidCronItem(item: string, min: number, max: number): boolean {
  // Range: 1-5
  if (item.includes('-')) {
    const [startStr, endStr] = item.split('-')
    const start = parseInt(startStr, 10)
    const end = parseInt(endStr, 10)
    if (isNaN(start) || isNaN(end)) return false
    if (start < min || end > max || start > end) return false
    return true
  }
  // Single number
  const num = parseInt(item, 10)
  if (isNaN(num)) return false
  // For day-of-week, 7 is valid (same as 0)
  if (max === 7 && num === 7) return true
  return num >= min && num <= max
}

/**
 * Compute the next run time for a cron expression in a given timezone,
 * starting from `from` (default: now).
 *
 * Returns a Date in UTC.
 */
export function computeNextRun(
  cron: string,
  timezone: string,
  from: Date = new Date(),
): Date {
  if (!isValidCron(cron)) {
    throw new ValidationError(`Invalid cron expression: ${cron}`)
  }

  const parts = cron.trim().split(/\s+/)
  const cronMinute = parseCronField(parts[0], 0, 59)
  const cronHour = parseCronField(parts[1], 0, 23)
  const cronDayOfMonth = parseCronField(parts[2], 1, 31)
  const cronMonth = parseCronField(parts[3], 1, 12)
  const cronDayOfWeek = parseCronField(parts[4], 0, 7)

  // Normalize day-of-week 7 to 0 (both = Sunday)
  const normalizedDow = new Set<number>()
  for (const d of cronDayOfWeek) {
    normalizedDow.add(d === 7 ? 0 : d)
  }

  // Start from the next minute after `from`, in the target timezone
  // We'll iterate minute-by-minute up to 366 days to find the next match
  const start = new Date(from.getTime())
  start.setSeconds(0, 0)
  start.setMinutes(start.getMinutes() + 1)

  // We iterate in UTC, but evaluate the cron fields in the target timezone
  const maxIterations = 366 * 24 * 60 // 366 days, in minutes
  for (let i = 0; i < maxIterations; i++) {
    const candidate = new Date(start.getTime() + i * 60 * 1000)

    // Convert candidate UTC time to the target timezone
    const local = utcToZonedTime(candidate, timezone)

    if (!cronMonth.has(local.month)) continue
    if (!cronDayOfMonth.has(local.day)) continue
    if (!normalizedDow.has(local.dow)) continue
    if (!cronHour.has(local.hour)) continue
    if (!cronMinute.has(local.minute)) continue

    return candidate
  }

  // No match found within a year — shouldn't happen for valid cron
  throw new AppError(
    'Could not compute next run time within a year',
    500,
    'cron_no_match',
  )
}

/** Parse a cron field into a Set of matching values. */
function parseCronField(
  field: string,
  min: number,
  max: number,
): Set<number> {
  const result = new Set<number>()

  if (field === '*') {
    for (let i = min; i <= max; i++) result.add(i)
    return result
  }

  // Handle step: */N or A-B/N or A,N,.../N
  const slashIdx = field.indexOf('/')
  let step = 1
  let rangePart = field

  if (slashIdx !== -1) {
    rangePart = field.slice(0, slashIdx)
    step = parseInt(field.slice(slashIdx + 1), 10)
    if (isNaN(step) || step < 1) step = 1
  }

  const items = rangePart === '*'
    ? [`${min}-${max}`]
    : rangePart.split(',')

  for (const item of items) {
    if (item.includes('-')) {
      const [s, e] = item.split('-').map((x) => parseInt(x, 10))
      const start = Math.max(s, min)
      const end = Math.min(e, max)
      for (let i = start; i <= end; i += step) {
        result.add(i)
      }
    } else {
      const v = parseInt(item, 10)
      if (!isNaN(v)) {
        // For step with single value: e.g. "5/2" means 5,7,9,...,max
        if (slashIdx !== -1) {
          for (let i = v; i <= max; i += step) {
            if (i >= min) result.add(i)
          }
        } else {
          if (v >= min && v <= max) result.add(v)
        }
      }
    }
  }

  return result
}

/** Convert a UTC Date to {year, month, day, hour, minute, dow} in a timezone. */
function utcToZonedTime(
  utcDate: Date,
  timezone: string,
): {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  dow: number
} {
  // Use Intl.DateTimeFormat to get the wall-clock time in the target zone
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
    weekday: 'short',
  })

  const parts = formatter.formatToParts(utcDate)
  const get = (type: string): string =>
    parts.find((p) => p.type === type)?.value ?? ''

  const year = parseInt(get('year'), 10)
  const month = parseInt(get('month'), 10)
  const day = parseInt(get('day'), 10)
  let hour = parseInt(get('hour'), 10)
  if (hour === 24) hour = 0 // Midnight edge case
  const minute = parseInt(get('minute'), 10)

  // Map weekday abbreviation to 0-6 (Sunday = 0)
  const weekdayMap: Record<string, number> = {
    Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
  }
  const dow = weekdayMap[get('weekday')] ?? 0

  return { year, month, day, hour, minute, dow }
}

/**
 * Validate that a timezone string is supported by the runtime.
 */
export function isValidTimezone(timezone: string): boolean {
  try {
    Intl.DateTimeFormat('en-US', { timeZone: timezone })
    return true
  } catch {
    return false
  }
}

// ===========================================================
// Helpers
// ===========================================================

function mapSchedule(s: {
  id: string
  projectId: string
  scanProfileId: string | null
  cron: string
  timezone: string
  enabled: boolean
  lastRunAt: Date | null
  nextRunAt: Date | null
  createdAt: Date
  updatedAt: Date
}): ScheduleItem {
  return {
    id: s.id,
    projectId: s.projectId,
    scanProfileId: s.scanProfileId,
    cron: s.cron,
    timezone: s.timezone,
    enabled: s.enabled,
    lastRunAt: s.lastRunAt?.toISOString() ?? null,
    nextRunAt: s.nextRunAt?.toISOString() ?? null,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  }
}
