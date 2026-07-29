'use client'

import { useEffect, useState, useCallback } from 'react'
import {
  ShieldAlert,
  AlertCircle,
  ChevronLeft,
  ChevronRight,
  Inbox,
  RefreshCw,
} from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
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

interface AdminSecurityEvent {
  id: string
  type: string
  severity: string
  userId: string | null
  workspaceId: string | null
  ipHash: string | null
  requestId: string | null
  metadataJson: string | null
  createdAt: string
}

interface CursorResponse {
  items: AdminSecurityEvent[]
  nextCursor: string | null
  total: number
}

type EventSeverity = 'ALL' | 'INFO' | 'WARN' | 'HIGH' | 'CRITICAL'

// ── Helpers ─────────────────────────────────────────────────────────────────

const SEVERITY_OPTIONS: EventSeverity[] = ['ALL', 'INFO', 'WARN', 'HIGH', 'CRITICAL']

function severityColor(severity: string): string {
  switch (severity) {
    case 'CRITICAL':
      return 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300'
    case 'HIGH':
      return 'bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-300'
    case 'WARN':
      return 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300'
    case 'INFO':
    default:
      return 'bg-gray-100 text-gray-600 dark:bg-gray-800/60 dark:text-gray-400'
  }
}

function humanizeType(type: string): string {
  return type
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

function truncate(str: string | null, maxLen = 12): string {
  if (!str) return '—'
  if (str.length <= maxLen) return str
  return `${str.slice(0, maxLen - 2)}..`
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

export default function AdminSecurityEventsPage() {
  const [items, setItems] = useState<AdminSecurityEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [typeFilter, setTypeFilter] = useState('')
  const [severity, setSeverity] = useState<EventSeverity>('ALL')
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [cursors, setCursors] = useState<string[]>([])
  const [total, setTotal] = useState(0)

  const fetchData = useCallback(
    async (cursor?: string) => {
      setLoading(true)
      setError(null)
      try {
        const params = new URLSearchParams()
        params.set('limit', '50')
        if (typeFilter.trim()) params.set('type', typeFilter.trim())
        if (severity !== 'ALL') params.set('severity', severity)
        if (cursor) params.set('cursor', cursor)

        const res = await fetch(
          `/api/v1/admin/security-events?${params.toString()}`
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
    [typeFilter, severity],
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
      const prevCursor = prev.length > 1 ? prev[prev.length - 2] : undefined
      fetchData(prevCursor)
      return next
    })
  }

  const handleTypeSearch = () => {
    setCursors([])
    setNextCursor(null)
    fetchData()
  }

  const handleTypeKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      handleTypeSearch()
    }
  }

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6 p-4 md:p-6 lg:p-8">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
          <ShieldAlert className="h-6 w-6 text-emerald-600" />
          Security Events
        </h1>
        <p className="text-muted-foreground mt-1 flex items-center gap-1.5">
          Audit and review security-related events across the platform, filtered by
          type and severity level.
        </p>
      </div>

      {/* Filters */}
      <Card>
        <CardContent className="p-4">
          <div className="flex flex-wrap items-end gap-3">
            {/* Type filter */}
            <div className="flex flex-col gap-1.5">
              <label
                htmlFor="type-filter"
                className="text-xs font-medium text-muted-foreground"
              >
                Event Type
              </label>
              <div className="flex gap-2">
                <Input
                  id="type-filter"
                  placeholder="e.g. LOGIN_FAILED"
                  value={typeFilter}
                  onChange={(e) => setTypeFilter(e.target.value)}
                  onKeyDown={handleTypeKeyDown}
                  className="w-56"
                />
                <Button
                  variant="outline"
                  size="default"
                  onClick={handleTypeSearch}
                  disabled={loading}
                >
                  Search
                </Button>
              </div>
            </div>

            {/* Severity filter */}
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium text-muted-foreground">
                Severity
              </label>
              <Select value={severity} onValueChange={(v) => setSeverity(v as EventSeverity)}>
                <SelectTrigger className="w-40">
                  <SelectValue placeholder="All Severities" />
                </SelectTrigger>
                <SelectContent>
                  {SEVERITY_OPTIONS.map((s) => (
                    <SelectItem key={s} value={s}>
                      {s === 'ALL' ? 'All Severities' : s}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Table Card */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-base">Event Log</CardTitle>
              <CardDescription>
                {loading
                  ? 'Loading...'
                  : `${total} event${total !== 1 ? 's' : ''}${
                      severity !== 'ALL'
                        ? ` at ${severity} severity`
                        : ''
                    }${
                      typeFilter.trim()
                        ? ` matching "${typeFilter.trim()}"`
                        : ''
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
              {Array.from({ length: 8 }).map((_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          )}

          {/* Empty */}
          {!loading && !error && items.length === 0 && (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <Inbox className="h-10 w-10 text-muted-foreground/50" />
              <p className="mt-2 text-sm font-medium text-muted-foreground">
                No security events found
              </p>
              {(severity !== 'ALL' || typeFilter.trim()) && (
                <p className="mt-1 text-xs text-muted-foreground/70">
                  Try adjusting the filters
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
                      <TableHead className="px-4">Type</TableHead>
                      <TableHead className="px-4">Severity</TableHead>
                      <TableHead className="px-4">User ID</TableHead>
                      <TableHead className="px-4">Workspace</TableHead>
                      <TableHead className="px-4">Request ID</TableHead>
                      <TableHead className="px-4">IP Hash</TableHead>
                      <TableHead className="px-4">Created</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {items.map((evt) => (
                      <TableRow key={evt.id}>
                        {/* Type */}
                        <TableCell className="px-4 font-medium">
                          {humanizeType(evt.type)}
                        </TableCell>

                        {/* Severity */}
                        <TableCell className="px-4">
                          <Badge
                            variant="outline"
                            className={severityColor(evt.severity)}
                          >
                            {evt.severity}
                          </Badge>
                        </TableCell>

                        {/* User ID */}
                        <TableCell className="px-4 font-mono text-xs text-muted-foreground">
                          {truncate(evt.userId, 10)}
                        </TableCell>

                        {/* Workspace */}
                        <TableCell className="px-4 font-mono text-xs text-muted-foreground">
                          {truncate(evt.workspaceId, 10)}
                        </TableCell>

                        {/* Request ID */}
                        <TableCell className="px-4 font-mono text-xs text-muted-foreground">
                          {truncate(evt.requestId, 10)}
                        </TableCell>

                        {/* IP Hash */}
                        <TableCell className="px-4 font-mono text-xs text-muted-foreground">
                          {truncate(evt.ipHash, 10)}
                        </TableCell>

                        {/* Created */}
                        <TableCell className="px-4 text-xs text-muted-foreground whitespace-nowrap">
                          {relativeTime(evt.createdAt)}
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
