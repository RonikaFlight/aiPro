'use client'

import { useEffect, useState, useCallback } from 'react'
import {
  CreditCard,
  AlertCircle,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Inbox,
  RefreshCw,
} from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Skeleton } from '@/components/ui/skeleton'
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert'

// ── Types ────────────────────────────────────────────────────────────────────

interface AdminSubscription {
  id: string
  status: string
  stripeCustomerId: string | null
  stripeSubscriptionId: string | null
  currentPeriodStart: string | null
  currentPeriodEnd: string | null
  cancelAtPeriodEnd: boolean
  trialEndsAt: string | null
  createdAt: string
  updatedAt: string
  workspace: { id: string; name: string }
  plan: { id: string; code: string; name: string; priceMonthly: number }
}

interface CursorResponse {
  items: AdminSubscription[]
  nextCursor: string | null
  total: number
}

type SubscriptionStatus =
  | 'ALL'
  | 'TRIALING'
  | 'ACTIVE'
  | 'PAST_DUE'
  | 'CANCELLED'
  | 'EXPIRED'

// ── Helpers ─────────────────────────────────────────────────────────────────

const STATUS_OPTIONS: SubscriptionStatus[] = [
  'ALL',
  'TRIALING',
  'ACTIVE',
  'PAST_DUE',
  'CANCELLED',
  'EXPIRED',
]

function statusColor(status: string): string {
  switch (status) {
    case 'ACTIVE':
      return 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300'
    case 'TRIALING':
      return 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300'
    case 'PAST_DUE':
      return 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300'
    case 'CANCELLED':
    case 'EXPIRED':
      return 'bg-gray-100 text-gray-700 dark:bg-gray-800/60 dark:text-gray-400'
    default:
      return 'bg-gray-100 text-gray-700 dark:bg-gray-800/60 dark:text-gray-400'
  }
}

function formatPrice(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`
}

function formatDate(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

function relativeTime(iso: string): string {
  const now = Date.now()
  const then = new Date(iso).getTime()
  const diffMs = now - then
  const diffSec = Math.floor(diffMs / 1000)
  if (diffSec < 60) return 'just now'
  const diffMin = Math.floor(diffSec / 60)
  if (diffMin < 60) return `${diffMin}m ago`
  const diffHr = Math.floor(diffMin / 60)
  if (diffHr < 24) return `${diffHr}h ago`
  const diffDay = Math.floor(diffHr / 24)
  if (diffDay < 30) return `${diffDay}d ago`
  const diffMo = Math.floor(diffDay / 30)
  if (diffMo < 12) return `${diffMo}mo ago`
  const diffYr = Math.floor(diffMo / 12)
  return `${diffYr}y ago`
}

// ── Component ───────────────────────────────────────────────────────────────

export default function AdminSubscriptionsPage() {
  const [items, setItems] = useState<AdminSubscription[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<SubscriptionStatus>('ALL')
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [cursors, setCursors] = useState<string[]>([])
  const [total, setTotal] = useState(0)

  const fetchData = useCallback(
    async (cursor?: string) => {
      setLoading(true)
      setError(null)
      try {
        const params = new URLSearchParams()
        if (status !== 'ALL') params.set('status', status)
        params.set('limit', '20')
        if (cursor) params.set('cursor', cursor)

        const res = await fetch(
          `/api/v1/admin/subscriptions?${params.toString()}`
        )
        if (!res.ok) {
          const body = await res.json().catch(() => ({}))
          throw new Error(body.error || `HTTP ${res.status}`)
        }
        const data: CursorResponse = await res.json()
        setItems(data.items)
        setNextCursor(data.nextCursor)
        setTotal(data.total)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to fetch')
      } finally {
        setLoading(false)
      }
    },
    [status],
  )

  // Fetch on mount / filter change
  useEffect(() => {
    setCursors([])
    setNextCursor(null)
    fetchData()
  }, [fetchData])

  const handleNext = () => {
    if (!nextCursor) return
    setCursors((prev) => [...prev, items[items.length - 1]?.createdAt])
    fetchData(nextCursor)
  }

  const handlePrev = () => {
    setCursors((prev) => {
      const next = prev.slice(0, -1)
      // Use the last cursor from the remaining stack, or undefined for first page
      const prevCursor = prev.length > 1 ? prev[prev.length - 2] : undefined
      fetchData(prevCursor)
      return next
    })
  }

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6 p-4 md:p-6 lg:p-8">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
          <CreditCard className="h-6 w-6 text-emerald-600" />
          Subscriptions
        </h1>
        <p className="text-muted-foreground mt-1">
          Manage and monitor all platform subscription plans, billing cycles, and
          trial statuses across workspaces.
        </p>
      </div>

      {/* Status Filter */}
      <Card>
        <CardContent className="p-4">
          <div className="flex flex-wrap gap-2">
            {STATUS_OPTIONS.map((s) => (
              <Button
                key={s}
                variant={status === s ? 'default' : 'outline'}
                size="sm"
                onClick={() => setStatus(s)}
                className={
                  status === s
                    ? 'bg-emerald-600 hover:bg-emerald-700 text-white'
                    : ''
                }
              >
                {s === 'ALL' ? 'All Statuses' : s.replace('_', ' ')}
              </Button>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Table Card */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-base">Subscription Records</CardTitle>
              <CardDescription>
                {loading
                  ? 'Loading...'
                  : `${total} subscription${total !== 1 ? 's' : ''}${
                      status !== 'ALL' ? ` with status ${status.replace('_', ' ')}` : ''
                    }`}
              </CardDescription>
            </div>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => fetchData()}
              disabled={loading}
              aria-label="Refresh"
            >
              <RefreshCw
                className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`}
              />
            </Button>
          </div>
        </CardHeader>
        <CardContent className="px-0 pb-0">
          {/* Error */}
          {error && (
            <div className="px-6 pb-4">
              <Alert variant="destructive">
                <AlertCircle className="h-4 w-4" />
                <AlertTitle>Error</AlertTitle>
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            </div>
          )}

          {/* Loading */}
          {loading && !error && (
            <div className="px-6 space-y-3">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          )}

          {/* Empty */}
          {!loading && !error && items.length === 0 && (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <Inbox className="h-10 w-10 text-muted-foreground/50" />
              <p className="mt-2 text-sm font-medium text-muted-foreground">
                No subscriptions found
              </p>
              {status !== 'ALL' && (
                <p className="mt-1 text-xs text-muted-foreground/70">
                  Try changing the status filter
                </p>
              )}
            </div>
          )}

          {/* Table */}
          {!loading && !error && items.length > 0 && (
            <>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="px-4">Workspace</TableHead>
                      <TableHead className="px-4">Plan</TableHead>
                      <TableHead className="px-4">Status</TableHead>
                      <TableHead className="px-4 text-right">Price</TableHead>
                      <TableHead className="px-4">Period</TableHead>
                      <TableHead className="px-4">Cancel at End</TableHead>
                      <TableHead className="px-4">Created</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {items.map((sub) => (
                      <TableRow key={sub.id}>
                        {/* Workspace */}
                        <TableCell className="px-4 font-medium">
                          <span className="truncate max-w-[200px] inline-block">
                            {sub.workspace.name}
                          </span>
                        </TableCell>

                        {/* Plan */}
                        <TableCell className="px-4">
                          <div className="flex items-center gap-2">
                            <Badge variant="outline" className="text-[10px] font-semibold uppercase tracking-wider">
                              {sub.plan.code}
                            </Badge>
                            <span className="text-sm text-muted-foreground">
                              {sub.plan.name}
                            </span>
                          </div>
                        </TableCell>

                        {/* Status */}
                        <TableCell className="px-4">
                          <Badge
                            variant="outline"
                            className={statusColor(sub.status)}
                          >
                            {sub.status.replace('_', ' ')}
                          </Badge>
                        </TableCell>

                        {/* Price */}
                        <TableCell className="px-4 text-right tabular-nums">
                          {formatPrice(sub.plan.priceMonthly)}
                          <span className="text-muted-foreground">/mo</span>
                        </TableCell>

                        {/* Period */}
                        <TableCell className="px-4 text-xs text-muted-foreground">
                          {sub.currentPeriodStart && sub.currentPeriodEnd ? (
                            <>
                              {formatDate(sub.currentPeriodStart)}
                              <span className="mx-1">&rarr;</span>
                              {formatDate(sub.currentPeriodEnd)}
                            </>
                          ) : (
                            '—'
                          )}
                        </TableCell>

                        {/* Cancel at End */}
                        <TableCell className="px-4">
                          <Badge
                            variant="outline"
                            className={
                              sub.cancelAtPeriodEnd
                                ? 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300'
                                : 'bg-gray-100 text-gray-500 dark:bg-gray-800/40 dark:text-gray-500'
                            }
                          >
                            {sub.cancelAtPeriodEnd ? 'Yes' : 'No'}
                          </Badge>
                        </TableCell>

                        {/* Created */}
                        <TableCell className="px-4 text-xs text-muted-foreground">
                          {relativeTime(sub.createdAt)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              {/* Pagination */}
              <div className="flex items-center justify-between border-t px-4 py-3">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handlePrev}
                  disabled={cursors.length === 0 || loading}
                >
                  <ChevronLeft className="h-4 w-4" />
                  Previous
                </Button>
                <span className="text-xs text-muted-foreground">
                  Page {cursors.length + 1} &middot; {total} total
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleNext}
                  disabled={!nextCursor || loading}
                >
                  Next
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
