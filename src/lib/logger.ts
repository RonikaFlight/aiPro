/**
 * Structured JSON logger — ProofPilot
 *
 * Emits structured logs with standard fields. Never logs secrets.
 * In development: pretty-printed for readability.
 * In production: JSON lines for log aggregation.
 */
import { env } from './env'

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal'

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
}

const currentPriority = LEVEL_PRIORITY[env.LOG_LEVEL]

export interface LogContext {
  requestId?: string
  traceId?: string
  userId?: string
  workspaceId?: string
  projectId?: string
  runId?: string
  jobId?: string
  [key: string]: unknown
}

interface LogEntry {
  timestamp: string
  level: LogLevel
  service: string
  environment: string
  message: string
  event?: string
  duration?: number
  errorCode?: string
  [key: string]: unknown
}

function redact(obj: Record<string, unknown>): Record<string, unknown> {
  const sensitive = new Set([
    'password',
    'passwordHash',
    'token',
    'tokenHash',
    'secret',
    'apiKey',
    'authorization',
    'cookie',
    'sessionToken',
    'csrfToken',
    'accessToken',
    'refreshToken',
    'stripeSecretKey',
    'encryptionKey',
  ])
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) {
    const lower = k.toLowerCase()
    if (sensitive.has(lower) || lower.includes('secret') || lower.includes('token')) {
      out[k] = '[REDACTED]'
    } else if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
      out[k] = redact(v as Record<string, unknown>)
    } else {
      out[k] = v
    }
  }
  return out
}

function emit(level: LogLevel, message: string, ctx: LogContext = {}, event?: string): void {
  if (LEVEL_PRIORITY[level] < currentPriority) return

  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    level,
    service: env.LOG_SERVICE_NAME,
    environment: env.APP_ENV,
    message,
    ...redact(ctx),
  }
  if (event) entry.event = event

  if (env.LOG_FORMAT === 'json') {
    process.stdout.write(JSON.stringify(entry) + '\n')
  } else {
    // Pretty print
    const color =
      level === 'error' || level === 'fatal'
        ? '\x1b[31m'
        : level === 'warn'
          ? '\x1b[33m'
          : level === 'info'
            ? '\x1b[36m'
            : '\x1b[90m'
    const reset = '\x1b[0m'
    const ctxStr = Object.keys(ctx).length > 0 ? ' ' + JSON.stringify(redact(ctx)) : ''
    process.stdout.write(
      `${color}[${entry.timestamp}] ${level.toUpperCase().padEnd(5)}${reset} ${message}${ctxStr}\n`,
    )
  }
}

export const logger = {
  trace: (msg: string, ctx?: LogContext, event?: string) => emit('trace', msg, ctx, event),
  debug: (msg: string, ctx?: LogContext, event?: string) => emit('debug', msg, ctx, event),
  info: (msg: string, ctx?: LogContext, event?: string) => emit('info', msg, ctx, event),
  warn: (msg: string, ctx?: LogContext, event?: string) => emit('warn', msg, ctx, event),
  error: (msg: string, ctx?: LogContext, event?: string) => emit('error', msg, ctx, event),
  fatal: (msg: string, ctx?: LogContext, event?: string) => emit('fatal', msg, ctx, event),
}

/** Create a child logger bound to a context. */
export function withContext(base: LogContext) {
  return {
    trace: (msg: string, ctx?: LogContext, event?: string) => emit('trace', msg, { ...base, ...ctx }, event),
    debug: (msg: string, ctx?: LogContext, event?: string) => emit('debug', msg, { ...base, ...ctx }, event),
    info: (msg: string, ctx?: LogContext, event?: string) => emit('info', msg, { ...base, ...ctx }, event),
    warn: (msg: string, ctx?: LogContext, event?: string) => emit('warn', msg, { ...base, ...ctx }, event),
    error: (msg: string, ctx?: LogContext, event?: string) => emit('error', msg, { ...base, ...ctx }, event),
    fatal: (msg: string, ctx?: LogContext, event?: string) => emit('fatal', msg, { ...base, ...ctx }, event),
  }
}
