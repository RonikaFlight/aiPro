/**
 * Session cookie helpers — ProofPilot
 *
 * Cookie name: __Host-proofpilot_session
 * HttpOnly, Secure in prod, Path=/, SameSite=Lax, no Domain.
 * Token is opaque (256-bit) and only its hash is stored in DB.
 * See SECURITY_MODEL.md §"Session architecture".
 */
import { cookies } from 'next/headers'
import { env } from './env'

export const SESSION_COOKIE_NAME = env.SESSION_COOKIE_NAME

export interface CookieOptions {
  maxAge?: number
  httpOnly?: boolean
  secure?: boolean
  sameSite?: 'lax' | 'strict' | 'none'
  path?: string
}

/** Set session cookie (Server Components / Server Actions only). */
export async function setSessionCookie(token: string, opts: CookieOptions = {}): Promise<void> {
  const isProd = env.APP_ENV === 'production'
  const cookieStore = await cookies()
  cookieStore.set(SESSION_COOKIE_NAME, token, {
    httpOnly: opts.httpOnly ?? true,
    secure: opts.secure ?? isProd,
    sameSite: opts.sameSite ?? 'lax',
    path: opts.path ?? '/',
    maxAge: opts.maxAge ?? env.SESSION_IDLE_TTL_SECONDS,
  })
}

export async function clearSessionCookie(): Promise<void> {
  const cookieStore = await cookies()
  cookieStore.delete(SESSION_COOKIE_NAME)
}

export async function readSessionCookie(): Promise<string | undefined> {
  const cookieStore = await cookies()
  return cookieStore.get(SESSION_COOKIE_NAME)?.value
}

/** Read session cookie from a raw request (for route handlers that have the request object). */
export function readSessionCookieFromRequest(request: Request): string | undefined {
  const cookieHeader = request.headers.get('cookie') ?? ''
  for (const part of cookieHeader.split(';')) {
    const [name, ...rest] = part.trim().split('=')
    if (name === SESSION_COOKIE_NAME) {
      return rest.join('=')
    }
  }
  return undefined
}

/** Set cookie on a NextResponse (for route handlers). */
export function setSessionCookieOnResponse(
  response: Response,
  token: string,
  opts: CookieOptions = {},
): void {
  const isProd = env.APP_ENV === 'production'
  const parts = [
    `${SESSION_COOKIE_NAME}=${token}`,
    'Path=' + (opts.path ?? '/'),
    'SameSite=' + (opts.sameSite ?? 'lax'),
    'HttpOnly',
  ]
  if (opts.secure ?? isProd) parts.push('Secure')
  if (opts.maxAge !== undefined) parts.push(`Max-Age=${opts.maxAge}`)
  response.headers.append('Set-Cookie', parts.join('; '))
}

export function clearSessionCookieOnResponse(response: Response): void {
  response.headers.append(
    'Set-Cookie',
    `${SESSION_COOKIE_NAME}=; Path=/; Max-Age=0; SameSite=Lax; HttpOnly`,
  )
}
