/**
 * API route helpers — ProofPilot
 *
 * Reduces boilerplate for route handlers: error wrapping, JSON parsing,
 * Zod validation, auth context, CSRF.
 */
import { NextResponse, type NextRequest } from 'next/server'
import { z, ZodError } from 'zod'
import { problemResponse, newRequestId, ValidationError, AppError } from './errors'
import { assertCsrf } from './csrf'
import { env } from './env'
import type { AuthContext } from './auth-context'

export interface RouteContext<TParams = Record<string, string>> {
  params: TParams
}

interface HandlerOptions<TBody, TQuery> {
  bodySchema?: z.ZodType<TBody>
  querySchema?: z.ZodType<TQuery>
  requireAuth?: boolean
  requireCsrf?: boolean
}

export function apiPost<TBody = unknown, TQuery = unknown>(
  handler: (
    body: TBody,
    query: TQuery,
    request: NextRequest,
    auth: AuthContext | null,
  ) => Promise<NextResponse>,
  opts: HandlerOptions<TBody, TQuery> = {},
) {
  return async (request: NextRequest) => {
    const requestId = request.headers.get('X-Request-Id') ?? newRequestId()
    const instance = new URL(request.url).pathname
    try {
      if (opts.requireCsrf !== false) {
        assertCsrf(request)
      }

      let body: TBody = {} as TBody
      if (opts.bodySchema && request.body) {
        const text = await request.text()
        if (text) {
          try {
            body = JSON.parse(text)
          } catch {
            throw new ValidationError('Malformed JSON body')
          }
        }
        const result = opts.bodySchema.safeParse(body)
        if (!result.success) {
          throw new ValidationError('Validation failed', formatZodError(result.error))
        }
        body = result.data
      }

      let query: TQuery = {} as TQuery
      if (opts.querySchema) {
        const url = new URL(request.url)
        const queryObj = Object.fromEntries(url.searchParams.entries())
        const result = opts.querySchema.safeParse(queryObj)
        if (!result.success) {
          throw new ValidationError('Invalid query parameters', formatZodError(result.error))
        }
        query = result.data
      }

      let auth: AuthContext | null = null
      if (opts.requireAuth) {
        const { requireAuth } = await import('./auth-context')
        auth = await requireAuth()
      } else {
        const { getOptionalAuth } = await import('./auth-context')
        auth = await getOptionalAuth()
      }

      const res = await handler(body, query, request, auth)
      if (!res.headers.has('X-Request-Id')) {
        res.headers.set('X-Request-Id', requestId)
      }
      return res
    } catch (err) {
      return problemResponse(err, requestId, instance)
    }
  }
}

export function apiGet<TQuery = unknown>(
  handler: (query: TQuery, request: NextRequest, auth: AuthContext | null) => Promise<NextResponse>,
  opts: HandlerOptions<unknown, TQuery> = {},
) {
  return async (request: NextRequest) => {
    const requestId = request.headers.get('X-Request-Id') ?? newRequestId()
    const instance = new URL(request.url).pathname
    try {
      let query: TQuery = {} as TQuery
      if (opts.querySchema) {
        const url = new URL(request.url)
        const queryObj = Object.fromEntries(url.searchParams.entries())
        const result = opts.querySchema.safeParse(queryObj)
        if (!result.success) {
          throw new ValidationError('Invalid query parameters', formatZodError(result.error))
        }
        query = result.data
      }

      let auth: AuthContext | null = null
      if (opts.requireAuth) {
        const { requireAuth } = await import('./auth-context')
        auth = await requireAuth()
      } else {
        const { getOptionalAuth } = await import('./auth-context')
        auth = await getOptionalAuth()
      }

      const res = await handler(query, request, auth)
      if (!res.headers.has('X-Request-Id')) {
        res.headers.set('X-Request-Id', requestId)
      }
      return res
    } catch (err) {
      return problemResponse(err, requestId, instance)
    }
  }
}

export function apiPatch<TBody = unknown, TParams = Record<string, string>>(
  handler: (body: TBody, params: TParams, request: NextRequest, auth: AuthContext) => Promise<NextResponse>,
  bodySchema?: z.ZodType<TBody>,
) {
  return async (request: NextRequest, context: { params: Promise<TParams> | TParams }) => {
    const requestId = request.headers.get('X-Request-Id') ?? newRequestId()
    const instance = new URL(request.url).pathname
    try {
      assertCsrf(request)
      const params = typeof context.params === 'object' && 'then' in context.params
        ? await (context.params as Promise<TParams>)
        : context.params as TParams

      let body: TBody = {} as TBody
      if (bodySchema && request.body) {
        const text = await request.text()
        if (text) {
          try {
            body = JSON.parse(text)
          } catch {
            throw new ValidationError('Malformed JSON body')
          }
        }
        const result = bodySchema.safeParse(body)
        if (!result.success) {
          throw new ValidationError('Validation failed', formatZodError(result.error))
        }
        body = result.data
      }

      const { requireAuth } = await import('./auth-context')
      const auth = await requireAuth()

      const res = await handler(body, params, request, auth)
      if (!res.headers.has('X-Request-Id')) {
        res.headers.set('X-Request-Id', requestId)
      }
      return res
    } catch (err) {
      return problemResponse(err, requestId, instance)
    }
  }
}

export function apiDelete<TParams = Record<string, string>>(
  handler: (params: TParams, request: NextRequest, auth: AuthContext) => Promise<NextResponse>,
) {
  return async (request: NextRequest, context: { params: Promise<TParams> | TParams }) => {
    const requestId = request.headers.get('X-Request-Id') ?? newRequestId()
    const instance = new URL(request.url).pathname
    try {
      assertCsrf(request)
      const params = typeof context.params === 'object' && 'then' in context.params
        ? await (context.params as Promise<TParams>)
        : context.params as TParams

      const { requireAuth } = await import('./auth-context')
      const auth = await requireAuth()

      const res = await handler(params, request, auth)
      if (!res.headers.has('X-Request-Id')) {
        res.headers.set('X-Request-Id', requestId)
      }
      return res
    } catch (err) {
      return problemResponse(err, requestId, instance)
    }
  }
}

function formatZodError(error: ZodError): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const issue of error.issues) {
    const key = issue.path.join('.') || '_'
    if (!out[key]) out[key] = []
    out[key].push(issue.message)
  }
  return out
}

export function ok(data: unknown, status = 200): NextResponse {
  return NextResponse.json(data, { status })
}

export function created(data: unknown): NextResponse {
  return NextResponse.json(data, { status: 201 })
}

export function noContent(): NextResponse {
  return new NextResponse(null, { status: 204 })
}

/** Set session cookie on a NextResponse (for route handlers). */
export function setSessionCookieOnResponse(
  response: NextResponse,
  token: string,
): void {
  const isProd = env.APP_ENV === 'production'
  response.headers.append(
    'Set-Cookie',
    `${env.SESSION_COOKIE_NAME}=${token}; Path=/; SameSite=Lax; HttpOnly${isProd ? '; Secure' : ''}; Max-Age=${env.SESSION_IDLE_TTL_SECONDS}`,
  )
}

export function clearSessionCookieOnResponse(response: NextResponse): void {
  response.headers.append(
    'Set-Cookie',
    `${env.SESSION_COOKIE_NAME}=; Path=/; SameSite=Lax; HttpOnly; Max-Age=0`,
  )
}
