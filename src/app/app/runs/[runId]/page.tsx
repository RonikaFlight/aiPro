'use client'

import { useEffect, useState, useCallback } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Separator } from '@/components/ui/separator'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import {
  ShieldCheck,
  ArrowLeft,
  Play,
  AlertTriangle,
  AlertOctagon,
  TrendingUp,
  TrendingDown,
  Minus,
  Globe,
  Monitor,
  Languages,
  Clock,
  CheckCircle2,
  XCircle,
  Loader2,
  Gauge,
  Bug,
  Settings2,
  Sparkles,
  FileText,
  ChevronRight,
  Pause,
} from 'lucide-react'

// ─── Types ───────────────────────────────────────────────────────

interface RunEvent {
  sequence: number
  eventType: string
  payload: Record<string, unknown>
  createdAt: string
}

interface RunData {
  id: string
  status: string
  trigger: string
  runMode: string
  pagesDiscovered: number
  pagesAnalyzed: number
  findingsCount: number
  blockerCount: number
  score: number | null
  previousScore: number | null
  startedAt: string | null
  completedAt: string | null
  failedReason: string | null
  createdAt: string
  triggeredBy: { id: string; name: string | null; email: string } | null
  config: { targetUrl: string; maxPages: number; maxDepth: number; viewports: string[]; locales: string[] } | null
  environmentId: string | null
  scanProfileId: string | null
  configSnapshot: Record<string, unknown>
  events: RunEvent[]
}

interface AiSummary {
  executiveSummary: string
  topIssues: Array<{ category: string; count: number; severity: string }>
  deliveryReadiness: string
  recommendation: string
}

// ─── Helpers ─────────────────────────────────────────────────────

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

function formatScore(score: number | null): string {
  if (score === null || score === undefined) return '—'
  return `${Math.round(score * 100)}%`
}

function statusColor(status: string): string {
  switch (status) {
    case 'COMPLETED':
      return 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300'
    case 'COMPLETED_WITH_WARNINGS':
      return 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300'
    case 'FAILED':
      return 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300'
    case 'CANCELLED':
    case 'TIMED_OUT':
      return 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-300'
    case 'QUEUED':
      return 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-300'
    case 'RUNNING':
    case 'ANALYZING':
    case 'SCORING':
      return 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300'
    default:
      return 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-300'
  }
}

function statusIcon(status: string) {
  switch (status) {
    case 'COMPLETED':
    case 'COMPLETED_WITH_WARNINGS':
      return <CheckCircle2 className="h-4 w-4 text-emerald-600" />
    case 'FAILED':
      return <XCircle className="h-4 w-4 text-red-500" />
    case 'CANCELLED':
      return <XCircle className="h-4 w-4 text-gray-500" />
    case 'RUNNING':
    case 'ANALYZING':
    case 'SCORING':
    case 'QUEUED':
      return <Loader2 className="h-4 w-4 animate-spin text-emerald-600" />
    default:
      return <Clock className="h-4 w-4 text-muted-foreground" />
  }
}

/** Timeline stage definitions ordered by typical scan lifecycle. */
const STAGE_ORDER = [
  { event: 'run.queued', label: 'Queued', icon: <Clock className="h-3.5 w-3.5" /> },
  { event: 'run.validating', label: 'Validating', icon: <ShieldCheck className="h-3.5 w-3.5" /> },
  { event: 'run.authorized', label: 'Authorized', icon: <CheckCircle2 className="h-3.5 w-3.5" /> },
  { event: 'run.crawling', label: 'Crawling', icon: <Globe className="h-3.5 w-3.5" /> },
  { event: 'run.analyzing', label: 'Analyzing', icon: <Bug className="h-3.5 w-3.5" /> },
  { event: 'run.generating_report', label: 'Generating Report', icon: <FileText className="h-3.5 w-3.5" /> },
  { event: 'run.scored', label: 'Scored', icon: <Gauge className="h-3.5 w-3.5" /> },
  { event: 'run.summarized', label: 'AI Summary', icon: <Sparkles className="h-3.5 w-3.5" /> },
  { event: 'run.completed', label: 'Completed', icon: <CheckCircle2 className="h-3.5 w-3.5" /> },
]

const TERMINAL_EVENTS = ['run.completed', 'run.failed', 'run.cancelled']

function formatEventTime(date: string): string {
  return new Date(date).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function readinessBadgeColor(readiness: string): string {
  switch (readiness) {
    case 'READY':
      return 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300'
    case 'NEEDS_WORK':
      return 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300'
    case 'NOT_READY':
      return 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300'
    default:
      return 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-300'
  }
}

// ─── Stage Timeline ──────────────────────────────────────────────

function StageTimeline({ events }: { events: RunEvent[] }) {
  const eventTypes = new Set(events.map((e) => e.eventType))
  const eventMap = new Map(events.map((e) => [e.eventType, e]))

  // Find the index of the last reached terminal event, or the furthest stage
  let furthestIdx = -1
  for (let i = 0; i < STAGE_ORDER.length; i++) {
    if (eventTypes.has(STAGE_ORDER[i].event)) {
      furthestIdx = i
    }
  }
  // Check for terminal states from events
  if (eventTypes.has('run.failed')) furthestIdx = STAGE_ORDER.length - 1
  if (eventTypes.has('run.cancelled')) furthestIdx = STAGE_ORDER.length - 1

  const isFailed = eventTypes.has('run.failed')
  const isCancelled = eventTypes.has('run.cancelled')

  return (
    <div className="space-y-0">
      {STAGE_ORDER.map((stage, idx) => {
        const reached = idx <= furthestIdx
        const event = eventMap.get(stage.event)
        const isTerminal = TERMINAL_EVENTS.includes(stage.event)

        return (
          <div key={stage.event} className="flex items-start gap-3">
            {/* Vertical connector */}
            <div className="flex flex-col items-center">
              <div
                className={`flex items-center justify-center w-7 h-7 rounded-full shrink-0 border-2 ${
                  reached
                    ? isFailed && isTerminal
                      ? 'border-red-400 bg-red-100 dark:bg-red-900/40 text-red-600 dark:text-red-400'
                      : isCancelled && isTerminal
                        ? 'border-gray-400 bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400'
                        : 'border-emerald-500 bg-emerald-100 dark:bg-emerald-900/40 text-emerald-600 dark:text-emerald-400'
                    : 'border-muted-foreground/30 bg-muted text-muted-foreground/60'
                }`}
              >
                {reached ? stage.icon : <div className="w-2 h-2 rounded-full bg-muted-foreground/40" />}
              </div>
              {idx < STAGE_ORDER.length - 1 && (
                <div
                  className={`w-0.5 h-8 ${
                    reached ? 'bg-emerald-300 dark:bg-emerald-700' : 'bg-muted-foreground/20'
                  }`}
                />
              )}
            </div>

            {/* Label + timestamp */}
            <div className="pt-0.5 pb-4">
              <span className={`text-sm font-medium ${reached ? 'text-foreground' : 'text-muted-foreground'}`}>
                {stage.label}
              </span>
              {event && (
                <span className="ml-2 text-xs text-muted-foreground">
                  {formatEventTime(event.createdAt)}
                </span>
              )}
              {event?.payload && Object.keys(event.payload).length > 0 && (
                <div className="mt-0.5 text-xs text-muted-foreground">
                  {Object.entries(event.payload)
                    .filter(([k]) => k !== 'by' && k !== 'runId')
                    .slice(0, 2)
                    .map(([k, v]) => (
                      <span key={k} className="mr-3">
                        {k}: {typeof v === 'string' ? v : JSON.stringify(v)}
                      </span>
                    ))}
                </div>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ─── Component ────────────────────────────────────────────────────

export default function RunDetailsPage() {
  const params = useParams<{ runId: string }>()
  const runId = params.runId

  const [run, setRun] = useState<RunData | null>(null)
  const [aiSummary, setAiSummary] = useState<AiSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [cancelling, setCancelling] = useState(false)

  const loadData = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/v1/runs/${runId}`)
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        setError(body.detail || `Failed to load run (${res.status})`)
        return
      }
      const data = (await res.json()) as RunData
      setRun(data)

      // Fetch AI summary for completed runs
      if (
        data.status === 'COMPLETED' ||
        data.status === 'COMPLETED_WITH_WARNINGS'
      ) {
        try {
          const summaryRes = await fetch(`/api/v1/runs/${runId}/summary`)
          if (summaryRes.ok) {
            const summaryData = await summaryRes.json()
            if (summaryData.summary) {
              setAiSummary(summaryData.summary)
            }
          }
        } catch {
          // AI summary is optional; don't block the page
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [runId])

  useEffect(() => {
    void loadData()
  }, [loadData])

  const handleCancel = async () => {
    setCancelling(true)
    try {
      const res = await fetch(`/api/v1/runs/${runId}`, { method: 'DELETE' })
      if (res.ok) {
        await loadData()
      }
    } catch {
      // error handled by next refresh
    } finally {
      setCancelling(false)
    }
  }

  const canCancel = run && ['QUEUED', 'RUNNING', 'ANALYZING', 'SCORING'].includes(run.status)
  const isRunning = run && ['QUEUED', 'RUNNING', 'ANALYZING', 'SCORING', 'CRAWLING'].includes(run.status)

  // ─── Loading Skeleton ───────────────────────────────────────

  if (loading) {
    return (
      <div className="min-h-screen flex flex-col bg-background">
        <PageHeader />
        <main className="flex-1 mx-auto w-full max-w-7xl px-4 sm:px-6 lg:px-8 py-8">
          <div className="animate-pulse space-y-6">
            <Skeleton className="h-4 w-64" />
            <Skeleton className="h-8 w-48" />
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              {[1, 2, 3, 4].map((i) => (
                <Skeleton key={i} className="h-24 rounded-xl" />
              ))}
            </div>
            <div className="grid md:grid-cols-2 gap-4">
              <Skeleton className="h-72 rounded-xl" />
              <Skeleton className="h-72 rounded-xl" />
            </div>
          </div>
        </main>
      </div>
    )
  }

  // ─── Error State ───────────────────────────────────────────

  if (error || !run) {
    return (
      <div className="min-h-screen flex flex-col bg-background">
        <PageHeader />
        <main className="flex-1 mx-auto w-full max-w-7xl px-4 sm:px-6 lg:px-8 py-8">
          <Card>
            <CardHeader>
              <CardTitle>Failed to load run details</CardTitle>
              <CardDescription>{error || 'Unknown error'}</CardDescription>
            </CardHeader>
            <CardContent>
              <Button onClick={() => void loadData()} variant="outline">
                Retry
              </Button>
            </CardContent>
          </Card>
        </main>
      </div>
    )
  }

  // ─── Main Render ────────────────────────────────────────────

  const scoreTrendIcon =
    run.score !== null && run.previousScore !== null ? (
      run.score > run.previousScore ? (
        <TrendingUp className="h-4 w-4 text-emerald-600" />
      ) : run.score < run.previousScore ? (
        <TrendingDown className="h-4 w-4 text-red-500" />
      ) : (
        <Minus className="h-4 w-4 text-muted-foreground" />
      )
    ) : null

  const duration =
    run.startedAt && run.completedAt
      ? (() => {
          const ms = new Date(run.completedAt).getTime() - new Date(run.startedAt).getTime()
          const secs = Math.floor(ms / 1000)
          if (secs < 60) return `${secs}s`
          const mins = Math.floor(secs / 60)
          return `${mins}m ${secs % 60}s`
        })()
      : null

  return (
    <div className="min-h-screen flex flex-col bg-background">
      <PageHeader />

      <main className="flex-1 mx-auto w-full max-w-7xl px-4 sm:px-6 lg:px-8 py-8">
        {/* Breadcrumb */}
        <div className="flex items-center gap-2 text-sm text-muted-foreground mb-6">
          <Link href="/app" className="hover:text-foreground transition-colors">
            Dashboard
          </Link>
          <ChevronRight className="h-3.5 w-3.5" />
          <Link href="/app" className="hover:text-foreground transition-colors">
            Runs
          </Link>
          <ChevronRight className="h-3.5 w-3.5" />
          <span className="text-foreground font-medium">Run Details</span>
        </div>

        {/* Page Title */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="icon" asChild>
                <Link href="/app">
                  <ArrowLeft className="h-4 w-4" />
                </Link>
              </Button>
              <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">Run Details</h1>
            </div>
            <Badge variant="outline" className={statusColor(run.status)}>
              <span className="flex items-center gap-1.5">
                {statusIcon(run.status)}
                {run.status.replace(/_/g, ' ')}
              </span>
            </Badge>
          </div>

          <div className="flex items-center gap-2">
            {run.config?.targetUrl && (
              <span className="text-sm text-muted-foreground hidden md:flex items-center gap-1.5">
                <Globe className="h-3.5 w-3.5" />
                {new URL(run.config.targetUrl).hostname}
              </span>
            )}
            {canCancel && (
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="destructive" size="sm" disabled={cancelling}>
                    <Pause className="h-4 w-4 mr-1.5" />
                    {cancelling ? 'Cancelling...' : 'Cancel Run'}
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Cancel this scan run?</AlertDialogTitle>
                    <AlertDialogDescription>
                      This will stop the scan and mark it as cancelled. Any findings already discovered
                      will be preserved. This action cannot be undone.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Keep Running</AlertDialogCancel>
                    <AlertDialogAction onClick={handleCancel} className="bg-destructive text-white hover:bg-destructive/90">
                      Cancel Run
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            )}
          </div>
        </div>

        {/* Stats Cards */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
          <StatCard
            icon={<Gauge className="h-4 w-4" />}
            label="Score"
            value={formatScore(run.score)}
            description={
              run.previousScore !== null
                ? `Previous: ${formatScore(run.previousScore)}`
                : 'First scan'
            }
            trend={scoreTrendIcon}
          />
          <StatCard
            icon={<Globe className="h-4 w-4" />}
            label="Pages"
            value={`${run.pagesAnalyzed}`}
            description={`${run.pagesDiscovered} discovered`}
          />
          <StatCard
            icon={<Bug className="h-4 w-4" />}
            label="Findings"
            value={run.findingsCount.toString()}
            description={run.blockerCount > 0 ? `${run.blockerCount} blocker${run.blockerCount > 1 ? 's' : ''}` : 'No blockers'}
            variant={run.blockerCount > 0 ? 'warning' : 'default'}
          />
          <StatCard
            icon={<Clock className="h-4 w-4" />}
            label="Duration"
            value={duration ?? (isRunning ? 'In progress' : '—')}
            description={
              isRunning
                ? 'Currently running'
                : run.startedAt
                  ? `Started ${relativeTime(run.startedAt)}`
                  : `Created ${relativeTime(run.createdAt)}`
            }
          />
        </div>

        {/* Run Metadata Row */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
          <Card>
            <CardHeader className="pb-3">
              <CardDescription>Run Information</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <MetaRow label="Trigger">
                <Badge variant="secondary" className="text-xs">
                  {run.trigger}
                </Badge>
              </MetaRow>
              <MetaRow label="Mode">
                <Badge variant="secondary" className="text-xs">
                  {run.runMode}
                </Badge>
              </MetaRow>
              <MetaRow label="Created">
                <span className="text-sm">{relativeTime(run.createdAt)}</span>
              </MetaRow>
              {run.startedAt && (
                <MetaRow label="Started">
                  <span className="text-sm">{relativeTime(run.startedAt)}</span>
                </MetaRow>
              )}
              {run.completedAt && (
                <MetaRow label="Completed">
                  <span className="text-sm">{relativeTime(run.completedAt)}</span>
                </MetaRow>
              )}
              {run.failedReason && (
                <MetaRow label="Failure Reason">
                  <span className="text-sm text-red-600 dark:text-red-400">{run.failedReason}</span>
                </MetaRow>
              )}
              {run.triggeredBy && (
                <MetaRow label="Triggered By">
                  <span className="text-sm">
                    {run.triggeredBy.name || run.triggeredBy.email}
                  </span>
                </MetaRow>
              )}
            </CardContent>
          </Card>

          {/* Config Snapshot */}
          <Card>
            <CardHeader className="pb-3">
              <CardDescription className="flex items-center gap-1.5">
                <Settings2 className="h-3.5 w-3.5" />
                Configuration
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {run.config?.targetUrl && (
                <MetaRow label="Target URL">
                  <span className="text-sm font-mono break-all">{run.config.targetUrl}</span>
                </MetaRow>
              )}
              {run.config?.maxPages != null && (
                <MetaRow label="Max Pages">
                  <span className="text-sm">{run.config.maxPages}</span>
                </MetaRow>
              )}
              {run.config?.maxDepth != null && (
                <MetaRow label="Max Depth">
                  <span className="text-sm">{run.config.maxDepth}</span>
                </MetaRow>
              )}
              {run.config?.viewports && run.config.viewports.length > 0 && (
                <MetaRow label="Viewports">
                  <div className="flex flex-wrap gap-1">
                    {run.config.viewports.map((v) => (
                      <Badge key={v} variant="outline" className="text-xs">
                        <Monitor className="h-3 w-3 mr-1" />
                        {v}
                      </Badge>
                    ))}
                  </div>
                </MetaRow>
              )}
              {run.config?.locales && run.config.locales.length > 0 && (
                <MetaRow label="Locales">
                  <div className="flex flex-wrap gap-1">
                    {run.config.locales.map((l) => (
                      <Badge key={l} variant="outline" className="text-xs">
                        <Languages className="h-3 w-3 mr-1" />
                        {l}
                      </Badge>
                    ))}
                  </div>
                </MetaRow>
              )}
              {/* Show raw config JSON if it exists but wasn't parsed cleanly */}
              {Object.keys(run.configSnapshot).length > 0 && (
                <>
                  <Separator />
                  <div>
                    <p className="text-xs text-muted-foreground mb-2">Raw Configuration</p>
                    <pre className="text-xs font-mono bg-muted rounded-lg p-3 overflow-x-auto max-h-48 overflow-y-auto whitespace-pre-wrap break-words">
                      {JSON.stringify(run.configSnapshot, null, 2)}
                    </pre>
                  </div>
                </>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Stage Timeline */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Stage Timeline</CardTitle>
              <CardDescription>
                {isRunning ? 'Scan is in progress' : 'All stages completed'}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {run.events.length > 0 ? (
                <StageTimeline events={run.events} />
              ) : (
                <div className="flex items-center justify-center py-8 text-muted-foreground text-sm">
                  No stage events recorded
                </div>
              )}
            </CardContent>
          </Card>

          {/* AI Summary */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <Sparkles className="h-4 w-4 text-amber-500" />
                AI Summary
              </CardTitle>
            </CardHeader>
            <CardContent>
              {aiSummary ? (
                <div className="space-y-4">
                  {aiSummary.deliveryReadiness && (
                    <div>
                      <p className="text-xs text-muted-foreground mb-1">Delivery Readiness</p>
                      <Badge variant="outline" className={readinessBadgeColor(aiSummary.deliveryReadiness)}>
                        {aiSummary.deliveryReadiness.replace(/_/g, ' ')}
                      </Badge>
                    </div>
                  )}
                  {aiSummary.executiveSummary && (
                    <div>
                      <p className="text-xs text-muted-foreground mb-1">Executive Summary</p>
                      <p className="text-sm leading-relaxed">{aiSummary.executiveSummary}</p>
                    </div>
                  )}
                  {aiSummary.topIssues && aiSummary.topIssues.length > 0 && (
                    <div>
                      <p className="text-xs text-muted-foreground mb-1">Top Issues</p>
                      <div className="space-y-1.5">
                        {aiSummary.topIssues.map((issue, idx) => (
                          <div key={idx} className="flex items-center justify-between text-sm">
                            <span className="text-muted-foreground">{issue.category.replace(/_/g, ' ')}</span>
                            <div className="flex items-center gap-2">
                              <Badge variant="outline" className="text-xs">
                                {issue.count} finding{issue.count > 1 ? 's' : ''}
                              </Badge>
                              <Badge
                                variant="outline"
                                className={`text-xs ${
                                  issue.severity === 'BLOCKER'
                                    ? 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300'
                                    : issue.severity === 'CRITICAL'
                                      ? 'bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-300'
                                      : ''
                                }`}
                              >
                                {issue.severity}
                              </Badge>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  {aiSummary.recommendation && (
                    <div>
                      <p className="text-xs text-muted-foreground mb-1">Recommendation</p>
                      <p className="text-sm leading-relaxed">{aiSummary.recommendation}</p>
                    </div>
                  )}
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center py-8 text-muted-foreground text-sm">
                  <Sparkles className="h-8 w-8 mb-2 opacity-40" />
                  <p>
                    {run.status === 'COMPLETED' || run.status === 'COMPLETED_WITH_WARNINGS'
                      ? 'No AI summary available for this run.'
                      : 'AI summary will be available after the run completes.'}
                  </p>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </main>

      {/* Footer */}
      <footer className="border-t mt-auto">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-4 text-sm text-muted-foreground">
          &copy; {new Date().getFullYear()} ProofPilot. Automated QA, not penetration testing.
        </div>
      </footer>
    </div>
  )
}

// ─── Sub-Components ─────────────────────────────────────────────

function PageHeader() {
  return (
    <header className="sticky top-0 z-40 border-b bg-background/80 backdrop-blur-sm">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="flex h-14 items-center justify-between">
          <div className="flex items-center gap-6">
            <Link href="/" className="flex items-center gap-2 font-semibold">
              <ShieldCheck className="h-5 w-5 text-primary" />
              <span>ProofPilot</span>
            </Link>
            <nav className="hidden sm:flex items-center gap-1">
              <Link
                href="/app"
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-muted-foreground hover:bg-muted text-sm"
              >
                Dashboard
              </Link>
              <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-primary/10 text-primary text-sm font-medium">
                <Play className="h-3.5 w-3.5" />
                Run Details
              </div>
            </nav>
          </div>
        </div>
      </div>
    </header>
  )
}

function StatCard({
  icon,
  label,
  value,
  description,
  trend,
  variant = 'default',
}: {
  icon: React.ReactNode
  label: string
  value: string
  description: string
  trend?: React.ReactNode
  variant?: 'default' | 'warning'
}) {
  return (
    <Card className={variant === 'warning' ? 'border-amber-200 dark:border-amber-800' : ''}>
      <CardContent className="p-5">
        <div className="flex items-center gap-2 mb-3">
          <div className={variant === 'warning' ? 'text-amber-500' : 'text-muted-foreground'}>{icon}</div>
          <span className="text-sm text-muted-foreground">{label}</span>
          {trend && <span className="ml-auto">{trend}</span>}
        </div>
        <div className="text-2xl font-bold tabular-nums">{value}</div>
        <div className="text-xs text-muted-foreground mt-1">{description}</div>
      </CardContent>
    </Card>
  )
}

function MetaRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <span className="text-sm text-muted-foreground shrink-0">{label}</span>
      <div className="text-right">{children}</div>
    </div>
  )
}
