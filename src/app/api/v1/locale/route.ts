import { NextResponse } from 'next/server'
import { z } from 'zod'

const Body = z.object({
  locale: z.enum(['en', 'fa']),
})

export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  try {
    const text = await request.text()
    const body = Body.parse(JSON.parse(text || '{}'))

    const response = NextResponse.json({ success: true, locale: body.locale })
    response.cookies.set('proofpilot_locale', body.locale, {
      path: '/',
      maxAge: 365 * 24 * 60 * 60,
      httpOnly: false,
      sameSite: 'lax',
    })
    return response
  } catch {
    return NextResponse.json({ success: false }, { status: 400 })
  }
}
