import { NextResponse } from 'next/server'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

/**
 * Unauthenticated health-check endpoint used by Docker HEALTHCHECK, load
 * balancers, and orchestrators.  Returns 200 when both the HTTP server and
 * the database connection are operational.
 */
export async function GET() {
  try {
    await db.$queryRaw`SELECT 1`
    return NextResponse.json({ status: 'ok' })
  } catch {
    return NextResponse.json({ status: 'error' }, { status: 503 })
  }
}
