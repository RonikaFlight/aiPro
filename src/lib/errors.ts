/**
 * Error types and RFC 7807 Problem Details helpers — ProofPilot
 */
import { NextResponse } from 'next/server'
import { randomHex } from './crypto'

export class AppError extends Error {
  constructor(
    message: string,
    public readonly status: number = 500,
    public readonly code: string = 'internal_error',
    public readonly type: string = 'https://proofpilot.app/problems/internal-error',
    public readonly details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'AppError'
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 422, 'validation_error', 'https://proofpilot.app/problems/validation-error', details)
    this.name = 'ValidationError'
  }
}

export class AuthError extends AppError {
  constructor(message = 'Authentication required') {
    super(message, 401, 'auth_required', 'https://proofpilot.app/problems/auth-required')
    this.name = 'AuthError'
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Forbidden') {
    super(message, 403, 'forbidden', 'https://proofpilot.app/problems/forbidden')
    this.name = 'ForbiddenError'
  }
}

export class NotFoundError extends AppError {
  constructor(resource = 'Resource') {
    super(`${resource} not found`, 404, 'not_found', 'https://proofpilot.app/problems/not-found')
    this.name = 'NotFoundError'
  }
}

export class ConflictError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 409, 'conflict', 'https://proofpilot.app/problems/conflict', details)
    this.name = 'ConflictError'
  }
}

export class RateLimitError extends AppError {
  constructor(public readonly retryAfterSeconds: number) {
    super('Too many requests', 429, 'rate_limited', 'https://proofpilot.app/problems/rate-limited')
    this.name = 'RateLimitError'
  }
}

export interface ProblemDetails {
  type: string
  title: string
  status: number
  detail: string
  instance: string
  requestId: string
  code: string
  errors?: Record<string, unknown>
  [key: string]: unknown
}

export function newRequestId(): string {
  return 'req_' + randomHex(12)
}

export function problemResponse(
  err: unknown,
  requestId: string,
  instance: string,
): NextResponse {
  let status = 500
  let body: ProblemDetails = {
    type: 'https://proofpilot.app/problems/internal-error',
    title: 'Internal error',
    status: 500,
    detail: 'An unexpected error occurred.',
    instance,
    requestId,
    code: 'internal_error',
  }

  if (err instanceof AppError) {
    status = err.status
    body = {
      type: err.type,
      title: err.message,
      status: err.status,
      detail: err.message,
      instance,
      requestId,
      code: err.code,
      ...(err.details ? { errors: err.details } : {}),
    }
  } else if (err instanceof Error) {
    body.detail = err.message || body.detail
  }

  // Never leak stack traces in response
  return NextResponse.json(body, {
    status,
    headers: {
      'Content-Type': 'application/problem+json',
      'X-Request-Id': requestId,
    },
  })
}

/** Wrap an API handler with error → Problem Details conversion. */
export function withErrorHandler<TArgs extends unknown[]>(
  handler: (request: Request, ...args: TArgs) => Promise<NextResponse>,
): (request: Request, ...args: TArgs) => Promise<NextResponse> {
  return async (request: Request, ...args: TArgs) => {
    const requestId =
      request.headers.get('X-Request-Id') ?? newRequestId()
    const instance = new URL(request.url).pathname
    try {
      const res = await handler(request, ...args)
      if (!res.headers.has('X-Request-Id')) {
        res.headers.set('X-Request-Id', requestId)
      }
      return res
    } catch (err) {
      return problemResponse(err, requestId, instance)
    }
  }
}
