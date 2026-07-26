import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { problemResponse, newRequestId } from '@/lib/errors'

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  const requestId = request.headers.get('X-Request-Id') ?? newRequestId()
  try {
    const plans = await db.plan.findMany({
      orderBy: { priceMonthly: 'asc' },
    })
    return NextResponse.json({ items: plans, total: plans.length })
  } catch (err) {
    return problemResponse(err, requestId, new URL(request.url).pathname)
  }
}
