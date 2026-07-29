'use client'

import { useEffect, useState, useCallback } from 'react'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Progress } from '@/components/ui/progress'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import {
  HeartPulse,
  Clock,
  Cpu,
  Layers,
  RefreshCw,
  AlertTriangle,
  ChevronDown,
  Activity,
  ShieldAlert,
  Zap,
  MemoryStick,
} from 'lucide-react'

// ─── Types ───────────────────────────────────────────────────────────────────

interface SystemHealth {
  database: { status: string; userCount: number }
  queue: {
    waiting: number
    active: number
    failed: number
    byQueueAndStatus: { queue: string; status: string; count: number }[]
  }
  recentErrorsBySeverity: Partial<Record<string, number>>
  uptime: { seconds: number; formatted: string }
  memory: {
    rssBytes: number
    heapUsedBytes: number
    heapTotalBytes: number
    externalBytes: number
    rssFormatted?: string
    heapUsedFormatted?: string
  }
  llmUsageLast7Days: { totalTokens: number; totalCost: number }
  timestamp?: string
}

// ─── Format helpers ──────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
  }
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }
  return `${(bytes / 1024).toFixed(1)} KB`
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const parts: string[] = []
  if (d > 0) parts.push(`${d}d`)
  if (h > 0) parts.push(`${h}h`)
  if (m > 0) parts.push(`${m}m`)
  return parts.length > 0 ? parts.join(' ') : '< 1m'
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(1)}M`
  }
  if (tokens >= 1_000) {
    return `${(tokens / 1_000).toFixed(1)}K`
  }
  return tokens.toLocaleString()
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function SystemHealthPage() {
  const [data, setData] = useState<SystemHealth | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [openQueues, setOpenQueues] = useState<Record<string, boolean>>({})

  const fetchHealth = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true)
    else setLoading(true)
    setError(null)

    try {
      const res = await fetch('/api/v1/admin/system-health')
      if (!res.ok) throw new Error(`Failed to fetch: ${res.status}`)
      const json = await res.json()
      setData(json)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    fetchHealth()
  }, [fetchHealth])

  const toggleQueue = (name: string) => {
    setOpenQueues((prev) => ({ ...prev, [name]: !prev[name] }))
  }

  // ── Loading skeleton ─────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="space-y-6 p-6">
        <div>
          <Skeleton className="h-8 w-48" />
          <Skeleton className="mt-2 h-4 w-80" />
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          {[...Array(4)].map((_, i) => (
            <Skeleton key={i} className="h-40 rounded-xl" />
          ))}
        </div>
        <Skeleton className="h-64 rounded-xl" />
        <div className="grid gap-4 md:grid-cols-2">
          <Skeleton className="h-48 rounded-xl" />
          <Skeleton className="h-48 rounded-xl" />
        </div>
      </div>
    )
  }

  // ── Error state ──────────────────────────────────────────────────────────
  if (error || !data) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 p-12">
        <ShieldAlert className="h-12 w-12 text-destructive" />
        <p className="text-lg font-medium text-destructive">
          {error || 'No data available'}
        </p>
        <Button
          variant="outline"
          onClick={() => fetchHealth()}
          className="gap-2"
        >
          <RefreshCw className="h-4 w-4" />
          Retry
        </Button>
      </div>
    )
  }

  // ── Derived values ───────────────────────────────────────────────────────
  const dbHealthy = data.database.status === 'healthy' || data.database.status === 'Healthy'
  const memPercent = data.memory.heapTotalBytes > 0
    ? Math.round((data.memory.heapUsedBytes / data.memory.heapTotalBytes) * 100)
    : 0

  // Build per-queue map from byQueueAndStatus array
  const queueMap: Record<string, { waiting: number; active: number; completed: number; failed: number }> = {}
  if (data.queue.byQueueAndStatus) {
    for (const item of data.queue.byQueueAndStatus) {
      if (!queueMap[item.queue]) queueMap[item.queue] = { waiting: 0, active: 0, completed: 0, failed: 0 }
      const status = item.status.toUpperCase()
      if (status === 'WAITING') queueMap[item.queue].waiting += item.count
      else if (status === 'ACTIVE') queueMap[item.queue].active += item.count
      else if (status === 'COMPLETED' || status === 'COMPLETED_WITH_WARNINGS') queueMap[item.queue].completed += item.count
      else if (status === 'FAILED') queueMap[item.queue].failed += item.count
    }
  }
  const queueNames = Object.keys(queueMap)

  const severityColor: Record<string, string> = {
    INFO: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300',
    WARN: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
    HIGH: 'bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-300',
    CRITICAL: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300',
  }

  return (
    <div className="space-y-6 p-6">
      {/* ── Header ────────────────────────────────────────────────────────── */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">System Health</h1>
          <p className="text-muted-foreground text-sm">
            Real-time monitoring of system services, resources, and error rates
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => fetchHealth(true)}
          disabled={refreshing}
          className="gap-2"
        >
          <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </Button>
      </div>

      {/* ── Status grid (2×2 on desktop) ──────────────────────────────────── */}
      <div className="grid gap-4 sm:grid-cols-2">
        {/* Database */}
        <Card>
          <CardHeader className="flex flex-row items-center gap-3 pb-2">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-emerald-100 dark:bg-emerald-900/40">
              <HeartPulse className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
            </div>
            <div className="min-w-0">
              <CardTitle className="text-base">Database</CardTitle>
              <CardDescription>Connection status</CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-3">
              <Badge
                className={dbHealthy
                  ? 'bg-emerald-100 text-emerald-800 border-emerald-200 dark:bg-emerald-900/40 dark:text-emerald-300 dark:border-emerald-800'
                  : 'bg-red-100 text-red-800 border-red-200 dark:bg-red-900/40 dark:text-red-300 dark:border-red-800'
                }
                variant="outline"
              >
                {dbHealthy ? 'Healthy' : data.database.status}
              </Badge>
              <span className="text-muted-foreground text-sm">
                {data.database.userCount.toLocaleString()} users
              </span>
            </div>
          </CardContent>
        </Card>

        {/* Queue */}
        <Card>
          <CardHeader className="flex flex-row items-center gap-3 pb-2">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-blue-100 dark:bg-blue-900/40">
              <Layers className="h-5 w-5 text-blue-600 dark:text-blue-400" />
            </div>
            <div className="min-w-0">
              <CardTitle className="text-base">Queue</CardTitle>
              <CardDescription>{queueNames.length} queue{queueNames.length !== 1 ? 's' : ''} active</CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-2">
              {queueNames.map((name) => {
                const q = queueMap[name]
                const hasIssues = q.failed > 0
                return (
                  <Badge
                    key={name}
                    variant="outline"
                    className={hasIssues
                      ? 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-900/30 dark:text-amber-300 dark:border-amber-800'
                      : 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-300 dark:border-emerald-800'
                    }
                  >
                    {name}: {q.active} active
                  </Badge>
                )
              })}
            </div>
          </CardContent>
        </Card>

        {/* Memory */}
        <Card>
          <CardHeader className="flex flex-row items-center gap-3 pb-2">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-violet-100 dark:bg-violet-900/40">
              <MemoryStick className="h-5 w-5 text-violet-600 dark:text-violet-400" />
            </div>
            <div className="min-w-0">
              <CardTitle className="text-base">Memory</CardTitle>
              <CardDescription>Heap usage</CardDescription>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-baseline gap-1">
              <span className="text-2xl font-bold">{formatBytes(data.memory.heapUsedBytes)}</span>
              <span className="text-muted-foreground text-sm">/ {formatBytes(data.memory.heapTotalBytes)}</span>
            </div>
            <div className="space-y-1.5">
              <Progress value={memPercent} className="h-2" />
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>RSS: {formatBytes(data.memory.rssBytes)}</span>
                <span className="font-medium">{memPercent}%</span>
              </div>
              <div className="text-xs text-muted-foreground">
                External: {formatBytes(data.memory.externalBytes)}
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Uptime */}
        <Card>
          <CardHeader className="flex flex-row items-center gap-3 pb-2">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-sky-100 dark:bg-sky-900/40">
              <Clock className="h-5 w-5 text-sky-600 dark:text-sky-400" />
            </div>
            <div className="min-w-0">
              <CardTitle className="text-base">Uptime</CardTitle>
              <CardDescription>Since last restart</CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            <span className="text-2xl font-bold">{data.uptime.formatted || formatUptime(data.uptime.seconds)}</span>
          </CardContent>
        </Card>
      </div>

      {/* ── Security Events / Recent Errors ────────────────────────────────── */}
      <Card>
        <CardHeader className="flex flex-row items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-amber-100 dark:bg-amber-900/40">
            <AlertTriangle className="h-5 w-5 text-amber-600 dark:text-amber-400" />
          </div>
          <div>
            <CardTitle className="text-base">Security Events</CardTitle>
            <CardDescription>Recent error counts by severity</CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Severity</TableHead>
                <TableHead className="text-right">Count</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(['INFO', 'WARN', 'HIGH', 'CRITICAL'] as const).map((sev) => (
                <TableRow key={sev}>
                  <TableCell>
                    <Badge
                      className={severityColor[sev]}
                      variant="outline"
                    >
                      {sev}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right font-mono font-medium">
                    {(data.recentErrorsBySeverity[sev] ?? 0).toLocaleString()}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* ── Bottom row: LLM Usage + Queue Details ──────────────────────────── */}
      <div className="grid gap-4 md:grid-cols-2">
        {/* LLM Usage */}
        <Card>
          <CardHeader className="flex flex-row items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-emerald-100 dark:bg-emerald-900/40">
              <Zap className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
            </div>
            <div>
              <CardTitle className="text-base">LLM Usage</CardTitle>
              <CardDescription>Token consumption &amp; cost</CardDescription>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-baseline gap-2">
              <Activity className="h-4 w-4 text-muted-foreground" />
              <span className="text-muted-foreground text-sm">Total Tokens</span>
            </div>
            <span className="text-3xl font-bold tracking-tight">
              {formatTokens(data.llmUsageLast7Days.totalTokens)}
            </span>
            <div className="flex items-baseline gap-2">
              <span className="text-muted-foreground text-sm">Total Cost</span>
            </div>
            <span className="text-2xl font-bold text-emerald-600 dark:text-emerald-400">
              ${data.llmUsageLast7Days.totalCost.toFixed(2)}
            </span>
          </CardContent>
        </Card>

        {/* Queue Details */}
        <Card>
          <CardHeader className="flex flex-row items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-teal-100 dark:bg-teal-900/40">
              <Cpu className="h-5 w-5 text-teal-600 dark:text-teal-400" />
            </div>
            <div>
              <CardTitle className="text-base">Queue Details</CardTitle>
              <CardDescription>Breakdown per queue</CardDescription>
            </div>
          </CardHeader>
          <CardContent className="space-y-2">
            {queueNames.length === 0 && (
              <p className="text-muted-foreground text-sm">No active queues</p>
            )}
            {queueNames.map((name) => {
              const q = queueMap[name]
              const isOpen = openQueues[name] ?? false
              return (
                <Collapsible
                  key={name}
                  open={isOpen}
                  onOpenChange={() => toggleQueue(name)}
                >
                  <CollapsibleTrigger asChild>
                    <Button
                      variant="ghost"
                      className="w-full justify-between px-3 py-2"
                    >
                      <span className="font-medium">{name}</span>
                      <ChevronDown
                        className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${
                          isOpen ? 'rotate-180' : ''
                        }`}
                      />
                    </Button>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <div className="ml-2 grid grid-cols-4 gap-2 rounded-lg border bg-muted/50 p-3 text-center text-sm">
                      <div>
                        <p className="text-muted-foreground text-xs">Waiting</p>
                        <p className="font-mono font-semibold">{q.waiting}</p>
                      </div>
                      <div>
                        <p className="text-muted-foreground text-xs">Active</p>
                        <p className="font-mono font-semibold text-emerald-600 dark:text-emerald-400">
                          {q.active}
                        </p>
                      </div>
                      <div>
                        <p className="text-muted-foreground text-xs">Completed</p>
                        <p className="font-mono font-semibold">{q.completed}</p>
                      </div>
                      <div>
                        <p className="text-muted-foreground text-xs">Failed</p>
                        <p className={`font-mono font-semibold ${q.failed > 0 ? 'text-red-600 dark:text-red-400' : ''}`}>
                          {q.failed}
                        </p>
                      </div>
                    </div>
                  </CollapsibleContent>
                </Collapsible>
              )
            })}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}