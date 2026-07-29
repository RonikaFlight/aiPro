import { NextRequest, NextResponse } from 'next/server'
import { routing } from './i18n/routing'

const validLocales = new Set(routing.locales)

export function middleware(request: NextRequest) {
  const response = NextResponse.next()
  const existingLocale = request.cookies.get('proofpilot_locale')?.value

  if (!existingLocale || !validLocales.has(existingLocale)) {
    response.cookies.set('proofpilot_locale', routing.defaultLocale, {
      path: '/',
      maxAge: 365 * 24 * 60 * 60,
      httpOnly: false,
      sameSite: 'lax',
    })
  }

  return response
}

export const config = {
  matcher: ['/', '/((?!api|_next|_vercel|.*\\..*).*)'],
}
