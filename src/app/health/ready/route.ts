import { NextResponse } from 'next/server'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    await db.$queryRaw`SELECT 1`
    return NextResponse.json({ status: 'ready', database: 'ok' })
  } catch (err) {
    return NextResponse.json(
      { status: 'not_ready', database: 'error', error: String(err) },
      { status: 503 },
    )
  }
}
