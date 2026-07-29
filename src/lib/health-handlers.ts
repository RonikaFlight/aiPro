/**
 * Health endpoints — ProofPilot
 *
 * GET /health/live  — process is alive (always 200 if running)
 * GET /health/ready — dependencies (DB) are reachable
 */
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

export async function GET_live() {
  return NextResponse.json({ status: 'alive' })
}

export async function GET_ready() {
  try {
    // Simple DB ping
    await db.$queryRaw`SELECT 1`
    return NextResponse.json({ status: 'ready', database: 'ok' })
  } catch (err) {
    return NextResponse.json(
      { status: 'not_ready', database: 'error', error: String(err) },
      { status: 503 },
    )
  }
}
