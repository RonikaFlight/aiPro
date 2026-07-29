'use client'

import { useEffect, useState, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
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
  Briefcase,
  ChevronLeft,
  ChevronRight,
  RefreshCw,
  AlertCircle,
  Filter,
} from 'lucide-react'

interface AdminJob {
  id: string
  queue: string
  status: string
  priority: number
  attempts: number
  maxAttempts: number
  runAt: string
  startedAt: string | null
  completedAt: string | null
  failedReason: string | null
  workspaceId: string | null
  correlationId: string | null
  createdAt: string
  updatedAt: string
}

interface JobsResponse {
  items: AdminJob[]
  nextCursor: string | null
  total: number
}

function statusColor(status: string): string {
  switch (status) {
    case 'ACTIVE':
      return 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300'
    case 'WAITING':
      return 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-300'
    case 'COMPLETED':
      return 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300'
    case 'FAILED':
      return 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300'
    case 'DELAYED':
      return 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300'
    default:
      return 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-300'
  }
}

function queueColor(queue: string): string {
  return 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300'
}

function truncateId(id: string | null, len = 10): string {
  if (!id) return '—'
  if (id.length <= len) return id
  return `${id.slice(0, len)}…`
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

export default function AdminJobsPage() {
  const [jobs, setJobs] = useState<AdminJob[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [queueFilter, setQueueFilter] = useState<string>('ALL')
  const [statusFilter, setStatusFilter] = useState<string>('ALL')
  const [cursor, setCursor] = useState<string | null>(null)
  const [cursorHistory, setCursorHistory] = useState<(string | null)[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [total, setTotal] = useState(0)

  const fetchJobs = useCallback(
    async (cur: string | null) => {
      setLoading(true)
      setError(null)
      try {
        const params = new URLSearchParams({ limit: '20' })
        if (queueFilter !== 'ALL') params.set('queue', queueFilter)
        if (statusFilter !== 'ALL') params.set('status', statusFilter)
        if (cur) params.set('cursor', cur)
        const res = await fetch(`/api/v1/admin/jobs?${params.toString()}`)
        if (!res.ok) {
          const err = await res.json().catch(() => ({}))
          throw new Error(err.detail || `Failed (${res.status})`)
        }
        const data: JobsResponse = await res.json()
        setJobs(data.items || [])
        setNextCursor(data.nextCursor)
        setTotal(data.total || 0)
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to load jobs')
      } finally {
        setLoading(false)
      }
    },
    [queueFilter, statusFilter],
  )

  useEffect(() => {
    setCursor(null)
    setCursorHistory([])
    fetchJobs(null)
  }, [fetchJobs])

  function goNext() {
    if (!nextCursor) return
    setCursorHistory((h) => [...h, cursor])
    setCursor(nextCursor)
    fetchJobs(nextCursor)
  }

  function goPrev() {
    if (cursorHistory.length === 0) return
    const prev = cursorHistory[cursorHistory.length - 1]
    setCursorHistory((h) => h.slice(0, -1))
    setCursor(prev)
    fetchJobs(prev)
  }

  const startIndex = cursorHistory.length * 20 + 1
  const endIndex = startIndex + jobs.length - 1

  return (
    <div className="space-y-6 p-4 lg:p-6">
      {/* Header */}
      <div className="flex flex-col gap-2">
        <h1 className="flex items-center gap-2 text-2xl font-bold">
          <Briefcase className="h-6 w-6 text-emerald-600" />
          Queue Jobs
        </h1>
        <p className="text-sm text-muted-foreground">
          Background job queue for scan orchestration and page analysis.
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
                Queue
              </label>
              <Select value={queueFilter} onValueChange={setQueueFilter}>
                <SelectTrigger className="w-full sm:w-56">
                  <SelectValue placeholder="All queues" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL">All queues</SelectItem>
                  <SelectItem value="scan-orchestration">scan-orchestration</SelectItem>
                  <SelectItem value="page-analysis">page-analysis</SelectItem>
                  <SelectItem value="journey-execution">journey-execution</SelectItem>
                  <SelectItem value="report-generation">report-generation</SelectItem>
                  <SelectItem value="webhook-delivery">webhook-delivery</SelectItem>
                  <SelectItem value="cleanup">cleanup</SelectItem>
                </SelectContent>
              </Select>
            </div>
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
                  <SelectItem value="WAITING">Waiting</SelectItem>
                  <SelectItem value="ACTIVE">Active</SelectItem>
                  <SelectItem value="COMPLETED">Completed</SelectItem>
                  <SelectItem value="FAILED">Failed</SelectItem>
                  <SelectItem value="DELAYED">Delayed</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Button
              onClick={() => {
                setCursor(null)
                setCursorHistory([])
                fetchJobs(null)
              }}
              className="bg-emerald-600 hover:bg-emerald-700"
            >
              <RefreshCw className="h-4 w-4" />
              Refresh
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
              <Button variant="outline" onClick={() => fetchJobs(cursor)}>
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
          ) : jobs.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 p-12 text-center">
              <Briefcase className="h-10 w-10 text-muted-foreground/40" />
              <p className="text-sm font-medium">No jobs found</p>
              <p className="text-xs text-muted-foreground">
                The queue is empty or no jobs match your filters.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Job ID</TableHead>
                    <TableHead>Queue</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Priority</TableHead>
                    <TableHead className="text-right">Attempts</TableHead>
                    <TableHead>Workspace</TableHead>
                    <TableHead>Failed Reason</TableHead>
                    <TableHead className="text-right">Run At</TableHead>
                    <TableHead className="text-right">Created</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {jobs.map((job) => (
                    <TableRow key={job.id}>
                      <TableCell className="font-mono text-xs">
                        {truncateId(job.id, 12)}
                      </TableCell>
                      <TableCell>
                        <Badge className={queueColor(job.queue)} variant="secondary">
                          {job.queue}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Badge className={statusColor(job.status)} variant="secondary">
                          {job.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right text-sm">{job.priority}</TableCell>
                      <TableCell className="text-right text-sm">
                        <span className={job.attempts >= job.maxAttempts ? 'text-red-600 font-medium' : ''}>
                          {job.attempts}/{job.maxAttempts}
                        </span>
                      </TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">
                        {truncateId(job.workspaceId, 10)}
                      </TableCell>
                      <TableCell className="max-w-48 truncate text-xs text-red-600" title={job.failedReason || ''}>
                        {job.failedReason ? truncateId(job.failedReason, 30) : '—'}
                      </TableCell>
                      <TableCell className="text-right text-sm text-muted-foreground">
                        {relativeTime(job.runAt)}
                      </TableCell>
                      <TableCell className="text-right text-sm text-muted-foreground">
                        {relativeTime(job.createdAt)}
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
      {!loading && jobs.length > 0 && (
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
