'use client'

import { useEffect, useState, useCallback } from 'react'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
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
import {
  PlayCircle,
  ChevronLeft,
  ChevronRight,
  Search,
  RefreshCw,
  AlertCircle,
  Filter,
} from 'lucide-react'

interface AdminRun {
  id: string
  status: string
  trigger: string
  runMode: string
  score: number | null
  pagesAnalyzed: number
  findingsCount: number
  startedAt: string | null
  completedAt: string | null
  createdAt: string
  project: { id: string; name: string; workspaceId: string }
  workspace: { id: string; name: string }
}

interface RunsResponse {
  items: AdminRun[]
  nextCursor: string | null
  total: number
}

function statusColor(status: string): string {
  switch (status) {
    case 'COMPLETED':
      return 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300'
    case 'COMPLETED_WITH_WARNINGS':
      return 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300'
    case 'RUNNING':
      return 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300'
    case 'QUEUED':
      return 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-300'
    case 'FAILED':
      return 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300'
    case 'CANCELLED':
      return 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-300'
    case 'TIMED_OUT':
      return 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300'
    default:
      return 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-300'
  }
}

function formatScore(score: number | null): string {
  if (score === null || score === undefined) return '—'
  return `${Math.round(score * 100)}%`
}

function formatDuration(start: string | null, end: string | null): string {
  if (!start) return '—'
  const startTime = new Date(start).getTime()
  const endTime = end ? new Date(end).getTime() : Date.now()
  const diff = Math.max(0, endTime - startTime)
  const seconds = Math.floor(diff / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60
  if (minutes < 60) return `${minutes}m ${remainingSeconds}s`
  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  return `${hours}h ${remainingMinutes}m`
}

function relativeTime(date: string): string {
  const diff = Date.now() - new Date(date).getTime()
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  return new Date(date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

export default function AdminRunsPage() {
  const [runs, setRuns] = useState<AdminRun[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [statusFilter, setStatusFilter] = useState<string>('ALL')
  const [workspaceFilter, setWorkspaceFilter] = useState<string>('')
  const [cursor, setCursor] = useState<string | null>(null)
  const [cursorHistory, setCursorHistory] = useState<(string | null)[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [total, setTotal] = useState(0)

  const fetchRuns = useCallback(
    async (cur: string | null) => {
      setLoading(true)
      setError(null)
      try {
        const params = new URLSearchParams({ limit: '20' })
        if (statusFilter !== 'ALL') params.set('status', statusFilter)
        if (workspaceFilter.trim()) params.set('workspaceId', workspaceFilter.trim())
        if (cur) params.set('cursor', cur)
        const res = await fetch(`/api/v1/admin/runs?${params.toString()}`)
        if (!res.ok) {
          const err = await res.json().catch(() => ({}))
          throw new Error(err.detail || `Failed (${res.status})`)
        }
        const data: RunsResponse = await res.json()
        setRuns(data.items || [])
        setNextCursor(data.nextCursor)
        setTotal(data.total || 0)
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to load runs')
      } finally {
        setLoading(false)
      }
    },
    [statusFilter, workspaceFilter],
  )

  useEffect(() => {
    setCursor(null)
    setCursorHistory([])
    fetchRuns(null)
  }, [fetchRuns])

  function goNext() {
    if (!nextCursor) return
    setCursorHistory((h) => [...h, cursor])
    setCursor(nextCursor)
    fetchRuns(nextCursor)
  }

  function goPrev() {
    if (cursorHistory.length === 0) return
    const prev = cursorHistory[cursorHistory.length - 1]
    setCursorHistory((h) => h.slice(0, -1))
    setCursor(prev)
    fetchRuns(prev)
  }

  const startIndex = cursorHistory.length * 20 + 1
  const endIndex = startIndex + runs.length - 1

  return (
    <div className="space-y-6 p-4 lg:p-6">
      {/* Header */}
      <div className="flex flex-col gap-2">
        <h1 className="flex items-center gap-2 text-2xl font-bold">
          <PlayCircle className="h-6 w-6 text-emerald-600" />
          Scan Runs
        </h1>
        <p className="text-sm text-muted-foreground">
          View all scan runs across all workspaces on the platform.
        </p>
      </div>

      {/* Filters */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Filter className="h-4 w-4" />
            Filters
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <div className="flex-1">
              <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
                Status
              </label>
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger className="w-full sm:w-48">
                  <SelectValue placeholder="All statuses" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL">All statuses</SelectItem>
                  <SelectItem value="QUEUED">Queued</SelectItem>
                  <SelectItem value="RUNNING">Running</SelectItem>
                  <SelectItem value="COMPLETED">Completed</SelectItem>
                  <SelectItem value="COMPLETED_WITH_WARNINGS">Completed (warnings)</SelectItem>
                  <SelectItem value="FAILED">Failed</SelectItem>
                  <SelectItem value="CANCELLED">Cancelled</SelectItem>
                  <SelectItem value="TIMED_OUT">Timed out</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex-1">
              <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
                Workspace ID
              </label>
              <Input
                placeholder="Filter by workspace ID…"
                value={workspaceFilter}
                onChange={(e) => setWorkspaceFilter(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    setCursor(null)
                    setCursorHistory([])
                    fetchRuns(null)
                  }
                }}
              />
            </div>
            <Button
              onClick={() => {
                setCursor(null)
                setCursorHistory([])
                fetchRuns(null)
              }}
              className="bg-emerald-600 hover:bg-emerald-700"
            >
              <Search className="mr-2 h-4 w-4" />
              Search
            </Button>
            <Button variant="outline" onClick={() => fetchRuns(cursor)}>
              <RefreshCw className="h-4 w-4" />
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Table */}
      <Card>
        <CardContent className="p-0">
          {error ? (
            <div className="flex flex-col items-center justify-center gap-3 p-12 text-center">
              <AlertCircle className="h-10 w-10 text-red-500" />
              <p className="text-sm text-red-600">{error}</p>
              <Button variant="outline" onClick={() => fetchRuns(cursor)}>
                <RefreshCw className="mr-2 h-4 w-4" />
                Retry
              </Button>
            </div>
          ) : loading ? (
            <div className="space-y-2 p-4">
              {Array.from({ length: 8 }).map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : runs.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 p-12 text-center">
              <PlayCircle className="h-10 w-10 text-muted-foreground/40" />
              <p className="text-sm font-medium">No scan runs found</p>
              <p className="text-xs text-muted-foreground">
                Try adjusting your filters or check back later.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Project</TableHead>
                    <TableHead>Workspace</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Trigger</TableHead>
                    <TableHead className="text-right">Score</TableHead>
                    <TableHead className="text-right">Pages</TableHead>
                    <TableHead className="text-right">Findings</TableHead>
                    <TableHead className="text-right">Duration</TableHead>
                    <TableHead className="text-right">Created</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {runs.map((run) => (
                    <TableRow key={run.id}>
                      <TableCell>
                        <Link
                          href={`/app/runs/${run.id}`}
                          className="font-medium text-emerald-600 hover:underline"
                        >
                          {run.project.name}
                        </Link>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {run.workspace.name}
                      </TableCell>
                      <TableCell>
                        <Badge className={statusColor(run.status)} variant="secondary">
                          {run.status.replace(/_/g, ' ')}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-sm">{run.trigger}</TableCell>
                      <TableCell className="text-right font-mono text-sm font-medium">
                        {formatScore(run.score)}
                      </TableCell>
                      <TableCell className="text-right text-sm">{run.pagesAnalyzed}</TableCell>
                      <TableCell className="text-right text-sm">{run.findingsCount}</TableCell>
                      <TableCell className="text-right text-sm text-muted-foreground">
                        {formatDuration(run.startedAt, run.completedAt)}
                      </TableCell>
                      <TableCell className="text-right text-sm text-muted-foreground">
                        {relativeTime(run.createdAt)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Pagination */}
      {!loading && runs.length > 0 && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            Showing {startIndex}–{endIndex} of {total.toLocaleString()}
          </p>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={goPrev}
              disabled={cursorHistory.length === 0}
            >
              <ChevronLeft className="mr-1 h-4 w-4" />
              Previous
            </Button>
            <Button variant="outline" size="sm" onClick={goNext} disabled={!nextCursor}>
              Next
              <ChevronRight className="ml-1 h-4 w-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
