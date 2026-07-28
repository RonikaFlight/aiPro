'use client'

import { useEffect, useState, useCallback } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import {
  ShieldCheck,
  FolderKanban,
  Play,
  AlertTriangle,
  AlertOctagon,
  TrendingUp,
  TrendingDown,
  Minus,
  Bug,
  FileBarChart,
  Globe,
  Monitor,
  Languages,
  Route,
  Clock,
  ArrowRight,
  CheckCircle2,
  XCircle,
  Loader2,
  BarChart3,
  Target,
  Gauge,
  LayoutDashboard,
} from 'lucide-react'

// ─── Types ───────────────────────────────────────────────────────

interface ProjectInfo {
  id: string
  name: string
  description: string | null
  productionUrl: string
  productType: string
  primaryLocale: string
  supportedLocales: string
  status: string
  createdAt: string
  workspace: { id: string; name: string; slug: string }
  totalRuns: number
  totalFindings: number
  totalJourneys: number
  totalEnvironments: number
}

interface ScoreBreakdown {
  score: number
  grade: string
  readiness: string
  hasOpenBlocker: boolean
  hasOpenCritical: boolean
  totalFindings: number
  severityCounts: Record<string, number>
  categoryCounts: Record<string, number>
}

interface RunInfo {
  id: string
  status: string
  trigger: string
  runMode: string
  score: number | null
  previousScore: number | null
  pagesDiscovered: number
  pagesAnalyzed: number
  findingsCount: number
  blockerCount: number
  aiSummary: string | null
  startedAt: string | null
  completedAt: string | null
  createdAt: string
  configSnapshot: string
}

interface TrendPoint {
  id: string
  score: number | null
  createdAt: string
}

interface BlockingFinding {
  id: string
  title: string
  severity: string
  status: string
  category: string
  affectedUrl: string
  firstSeenAt: string
  lastSeenAt: string
}

interface GroupCount {
  severity?: string
  category?: string
  count: number
}

interface CoverageInfo {
  browsers: string[]
  viewports: string[]
  locales: string[]
  totalPagesAnalyzed: number
}

interface JourneyInfo {
  totalRuns: number
  completedRuns: number
  successRate: number | null
  activeJourneys: number
}

interface ReportInfo {
  id: string
  type: string
  status: string
  title: string
  score: number | null
  createdAt: string
}

interface DashboardData {
  project: ProjectInfo
  score: ScoreBreakdown
  latestRun: RunInfo | null
  trend: TrendPoint[]
  blockers: BlockingFinding[]
  findingsBySeverity: GroupCount[]
  findingsByCategory: GroupCount[]
  coverage: CoverageInfo
  journeys: JourneyInfo
  recentReports: ReportInfo[]
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
    case 'RUNNING':
    case 'ANALYZING':
      return 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300'
    default:
      return 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-300'
  }
}

function readinessColor(readiness: string): string {
  switch (readiness) {
    case 'READY':
      return 'text-emerald-600 dark:text-emerald-400'
    case 'NEEDS_WORK':
      return 'text-amber-600 dark:text-amber-400'
    case 'NOT_READY':
      return 'text-red-600 dark:text-red-400'
    default:
      return 'text-muted-foreground'
  }
}

function readinessBg(readiness: string): string {
  switch (readiness) {
    case 'READY':
      return 'bg-emerald-50 border-emerald-200 dark:bg-emerald-900/20 dark:border-emerald-800'
    case 'NEEDS_WORK':
      return 'bg-amber-50 border-amber-200 dark:bg-amber-900/20 dark:border-amber-800'
    case 'NOT_READY':
      return 'bg-red-50 border-red-200 dark:bg-red-900/20 dark:border-red-800'
    default:
      return 'bg-muted border-border'
  }
}

function gradeColor(grade: string): string {
  switch (grade) {
    case 'A': return 'bg-emerald-600'
    case 'B': return 'bg-lime-600'
    case 'C': return 'bg-amber-500'
    case 'D': return 'bg-orange-500'
    case 'F': return 'bg-red-600'
    default: return 'bg-gray-500'
  }
}

function severityColor(severity: string): string {
  switch (severity) {
    case 'BLOCKER':
      return 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300'
    case 'CRITICAL':
      return 'bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-300'
    case 'MAJOR':
      return 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300'
    case 'MINOR':
      return 'bg-lime-100 text-lime-800 dark:bg-lime-900/40 dark:text-lime-300'
    case 'INFO':
      return 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300'
    default:
      return 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300'
  }
}

function scoreTrendIcon(current: number | null, previous: number | null) {
  if (current === null || previous === null) return <Minus className="h-4 w-4 text-muted-foreground" />
  if (current > previous) return <TrendingUp className="h-4 w-4 text-emerald-600" />
  if (current < previous) return <TrendingDown className="h-4 w-4 text-red-500" />
  return <Minus className="h-4 w-4 text-muted-foreground" />
}

// ─── Component ───────────────────────────────────────────────────

export default function ProjectDashboardPage() {
  const params = useParams<{ projectId: string }>()
  const projectId = params.projectId

  const [data, setData] = useState<DashboardData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const loadData = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/v1/projects/${projectId}/dashboard`)
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        setError(body.detail || `Failed to load dashboard (${res.status})`)
        return
      }
      setData(await res.json())
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => {
    void loadData()
  }, [loadData])

  // ─── Loading Skeleton ───────────────────────────────────────

  if (loading) {
    return (
      <div className="min-h-screen flex flex-col bg-background">
        <AppHeader projectName="" workspaceName="" workspaceId="" />
        <main className="flex-1 mx-auto w-full max-w-7xl px-4 sm:px-6 lg:px-8 py-8">
          <div className="animate-pulse space-y-6">
            <div className="h-8 bg-muted rounded w-1/3" />
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              {[1, 2, 3, 4].map((i) => (
                <Skeleton key={i} className="h-24 rounded-xl" />
              ))}
            </div>
            <div className="grid md:grid-cols-2 gap-4">
              <Skeleton className="h-64 rounded-xl" />
              <Skeleton className="h-64 rounded-xl" />
            </div>
          </div>
        </main>
      </div>
    )
  }

  // ─── Error State ───────────────────────────────────────────

  if (error || !data) {
    return (
      <div className="min-h-screen flex flex-col bg-background">
        <AppHeader projectName="" workspaceName="" workspaceId="" />
        <main className="flex-1 mx-auto w-full max-w-7xl px-4 sm:px-6 lg:px-8 py-8">
          <Card>
            <CardHeader>
              <CardTitle>Failed to load project dashboard</CardTitle>
              <CardDescription>{error || 'Unknown error'}</CardDescription>
            </CardHeader>
            <CardContent>
              <Button onClick={() => void loadData()}>Retry</Button>
            </CardContent>
          </Card>
        </main>
      </div>
    )
  }

  const { project, score, latestRun, trend, blockers, findingsBySeverity, findingsByCategory, coverage, journeys, recentReports } = data
  const totalOpenFindings = findingsBySeverity.reduce((sum, g) => sum + g.count, 0)

  return (
    <div className="min-h-screen flex flex-col bg-background">
      <AppHeader
        projectName={project.name}
        workspaceName={project.workspace.name}
        workspaceId={project.workspace.id}
      />

      <main className="flex-1 mx-auto w-full max-w-7xl px-4 sm:px-6 lg:px-8 py-8">
        {/* Breadcrumb */}
        <div className="flex items-center gap-2 text-sm text-muted-foreground mb-4">
          <Link href="/app" className="hover:text-foreground transition-colors">Dashboard</Link>
          <span>/</span>
          <Link href={`/app/workspaces/${project.workspace.id}`} className="hover:text-foreground transition-colors">
            {project.workspace.name}
          </Link>
          <span>/</span>
          <span className="text-foreground font-medium">{project.name}</span>
        </div>

        {/* Page Title */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">{project.name}</h1>
            {project.description && (
              <p className="text-muted-foreground text-sm mt-1">{project.description}</p>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" asChild>
              <Link href={`/app/projects/${project.id}/findings`}>
                <Bug className="h-4 w-4 mr-1.5" />
                All Findings
              </Link>
            </Button>
            <Button variant="outline" size="sm" asChild>
              <Link href={`/app/projects/${project.id}/reports`}>
                <FileBarChart className="h-4 w-4 mr-1.5" />
                Reports
              </Link>
            </Button>
          </div>
        </div>

        {/* ── Score + Readiness Row ─────────────────────────── */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-6">
          {/* Quality Score Card */}
          <Card className="lg:col-span-1">
            <CardHeader className="pb-3">
              <CardDescription className="flex items-center gap-1.5">
                <Gauge className="h-3.5 w-3.5" />
                Quality Score
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-4">
                <div className={`flex items-center justify-center rounded-xl w-16 h-16 ${gradeColor(score.grade)} text-white text-2xl font-bold`}>
                  {score.grade}
                </div>
                <div>
                  <div className="text-3xl font-bold tabular-nums">
                    {formatScore(score.score as number)}
                  </div>
                  {latestRun && (
                    <div className="flex items-center gap-1.5 mt-1 text-sm">
                      {scoreTrendIcon(latestRun.score, latestRun.previousScore)}
                      <span className="text-muted-foreground">
                        {latestRun.previousScore !== null
                          ? `${Math.round(((latestRun.score ?? 0) - latestRun.previousScore) * 100)} pts`
                          : 'First scan'}
                      </span>
                    </div>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Delivery Readiness */}
          <Card className={`lg:col-span-1 border ${readinessBg(score.readiness)}`}>
            <CardHeader className="pb-3">
              <CardDescription className="flex items-center gap-1.5">
                <Target className="h-3.5 w-3.5" />
                Delivery Readiness
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold mb-1">
                {score.readiness.replace(/_/g, ' ')}
              </div>
              <p className={`text-sm ${readinessColor(score.readiness)}`}>
                {score.readiness === 'READY'
                  ? 'No blockers or criticals. Ready for delivery.'
                  : score.readiness === 'NEEDS_WORK'
                    ? 'Open critical findings need resolution.'
                    : 'Open blockers prevent delivery readiness.'}
              </p>
              {score.hasOpenBlocker && (
                <div className="flex items-center gap-1.5 mt-2 text-xs text-red-600 dark:text-red-400">
                  <AlertOctagon className="h-3.5 w-3.5" />
                  {findingsBySeverity.find((s) => s.severity === 'BLOCKER')?.count ?? 0} open blocker(s)
                </div>
              )}
            </CardContent>
          </Card>

          {/* Quick Stats */}
          <Card className="lg:col-span-1">
            <CardHeader className="pb-3">
              <CardDescription className="flex items-center gap-1.5">
                <BarChart3 className="h-3.5 w-3.5" />
                Summary
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <div className="text-2xl font-bold tabular-nums">{project.totalRuns}</div>
                  <div className="text-xs text-muted-foreground">Total runs</div>
                </div>
                <div>
                  <div className="text-2xl font-bold tabular-nums">{totalOpenFindings}</div>
                  <div className="text-xs text-muted-foreground">Open findings</div>
                </div>
                <div>
                  <div className="text-2xl font-bold tabular-nums">{project.totalJourneys}</div>
                  <div className="text-xs text-muted-foreground">Journeys</div>
                </div>
                <div>
                  <div className="text-2xl font-bold tabular-nums">{project.totalEnvironments}</div>
                  <div className="text-xs text-muted-foreground">Environments</div>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* ── Trend + Latest Run ─────────────────────────────── */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
          {/* Score Trend */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Score Trend</CardTitle>
              <CardDescription>Quality score across recent runs</CardDescription>
            </CardHeader>
            <CardContent>
              {trend.length === 0 ? (
                <div className="py-8 text-center text-muted-foreground text-sm">
                  No completed runs yet. Start a scan to see trends.
                </div>
              ) : (
                <div className="space-y-2">
                  {/* Simple bar chart visualization */}
                  <div className="flex items-end gap-1 h-32">
                    {trend.map((t, i) => {
                      const s = t.score !== null ? t.score * 100 : 0
                      const color = s >= 80 ? 'bg-emerald-500' : s >= 60 ? 'bg-amber-500' : s > 0 ? 'bg-red-500' : 'bg-gray-200'
                      return (
                        <div
                          key={t.id}
                          className={`flex-1 rounded-t ${color} min-h-[4px] transition-all`}
                          style={{ height: `${Math.max(s, 4)}%` }}
                          title={`${new Date(t.createdAt).toLocaleDateString()}: ${Math.round(s)}%`}
                        />
                      )
                    })}
                  </div>
                  <div className="flex justify-between text-xs text-muted-foreground">
                    {trend.length > 0 && (
                      <>
                        <span>{new Date(trend[0].createdAt).toLocaleDateString()}</span>
                        <span>{new Date(trend[trend.length - 1].createdAt).toLocaleDateString()}</span>
                      </>
                    )}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Latest Run */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                Latest Run
                {latestRun && latestRun.status === 'RUNNING' && (
                  <Loader2 className="h-4 w-4 animate-spin text-blue-500" />
                )}
              </CardTitle>
              <CardDescription>Most recent scan execution</CardDescription>
            </CardHeader>
            <CardContent>
              {latestRun ? (
                <div className="space-y-4">
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className={`text-xs ${statusColor(latestRun.status)}`}>
                      {latestRun.status.replace(/_/g, ' ')}
                    </Badge>
                    <span className="text-xs text-muted-foreground">
                      {relativeTime(latestRun.createdAt)}
                    </span>
                    <Badge variant="secondary" className="text-xs">
                      {latestRun.trigger}
                    </Badge>
                  </div>

                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
                    <div>
                      <div className="text-xs text-muted-foreground">Pages</div>
                      <div className="font-medium tabular-nums">
                        {latestRun.pagesAnalyzed}/{latestRun.pagesDiscovered}
                      </div>
                    </div>
                    <div>
                      <div className="text-xs text-muted-foreground">Findings</div>
                      <div className="font-medium tabular-nums">{latestRun.findingsCount}</div>
                    </div>
                    <div>
                      <div className="text-xs text-muted-foreground">Blockers</div>
                      <div className="font-medium tabular-nums">{latestRun.blockerCount}</div>
                    </div>
                    <div>
                      <div className="text-xs text-muted-foreground">Score</div>
                      <div className="font-medium tabular-nums">{formatScore(latestRun.score)}</div>
                    </div>
                  </div>

                  {latestRun.aiSummary && (
                    <div className="text-sm text-muted-foreground bg-muted/50 rounded-lg p-3">
                      {latestRun.aiSummary}
                    </div>
                  )}

                  <Button variant="outline" size="sm" className="w-full" asChild>
                    <Link href={`/app/runs/${latestRun.id}`}>
                      View run details <ArrowRight className="h-3.5 w-3.5 ml-1" />
                    </Link>
                  </Button>
                </div>
              ) : (
                <div className="py-8 text-center text-muted-foreground text-sm">
                  No scans run yet. Start your first scan to see results.
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* ── Findings by Severity + Category ─────────────────── */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
          {/* By Severity */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Findings by Severity</CardTitle>
              <CardDescription>Active (open/acknowledged) findings</CardDescription>
            </CardHeader>
            <CardContent>
              {findingsBySeverity.length === 0 ? (
                <div className="py-6 text-center text-muted-foreground text-sm">
                  No active findings. Great job!
                </div>
              ) : (
                <div className="space-y-3">
                  {findingsBySeverity.map((g) => {
                    const pct = totalOpenFindings > 0 ? Math.round((g.count / totalOpenFindings) * 100) : 0
                    return (
                      <div key={g.severity} className="space-y-1">
                        <div className="flex items-center justify-between text-sm">
                          <Badge variant="outline" className={`text-xs ${severityColor(g.severity!)}`}>
                            {g.severity}
                          </Badge>
                          <span className="font-medium tabular-nums">{g.count}</span>
                        </div>
                        <Progress value={pct} className="h-1.5" />
                      </div>
                    )
                  })}
                </div>
              )}
            </CardContent>
          </Card>

          {/* By Category */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Findings by Category</CardTitle>
              <CardDescription>Distribution across check categories</CardDescription>
            </CardHeader>
            <CardContent>
              {findingsByCategory.length === 0 ? (
                <div className="py-6 text-center text-muted-foreground text-sm">
                  No active findings. Great job!
                </div>
              ) : (
                <div className="space-y-2 max-h-64 overflow-y-auto">
                  {findingsByCategory.map((g) => {
                    const maxCount = findingsByCategory[0]?.count ?? 1
                    const pct = Math.round((g.count / maxCount) * 100)
                    return (
                      <div key={g.category} className="space-y-1">
                        <div className="flex items-center justify-between text-sm">
                          <span className="text-muted-foreground truncate max-w-[200px]">{g.category}</span>
                          <span className="font-medium tabular-nums shrink-0">{g.count}</span>
                        </div>
                        <Progress value={pct} className="h-1.5" />
                      </div>
                    )
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* ── Blockers + Coverage + Journeys ───────────────────── */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-6">
          {/* Open Blockers */}
          <Card className="lg:col-span-1">
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <AlertOctagon className="h-4 w-4 text-red-500" />
                Blockers
              </CardTitle>
              <CardDescription>Open blockers need immediate attention</CardDescription>
            </CardHeader>
            <CardContent>
              {blockers.length === 0 ? (
                <div className="py-6 text-center">
                  <CheckCircle2 className="h-8 w-8 text-emerald-500 mx-auto mb-2" />
                  <p className="text-sm text-muted-foreground">No open blockers!</p>
                </div>
              ) : (
                <div className="space-y-3 max-h-64 overflow-y-auto">
                  {blockers.map((b) => (
                    <Link
                      key={b.id}
                      href={`/app/findings/${b.id}`}
                      className="block p-3 rounded-lg border border-red-200 dark:border-red-800 bg-red-50/50 dark:bg-red-900/10 hover:bg-red-100/50 dark:hover:bg-red-900/20 transition-colors"
                    >
                      <div className="text-sm font-medium text-red-800 dark:text-red-300 line-clamp-2">
                        {b.title}
                      </div>
                      <div className="text-xs text-muted-foreground mt-1 flex items-center gap-2">
                        <span className="font-mono truncate max-w-[200px]">{b.affectedUrl}</span>
                        <span>{relativeTime(b.lastSeenAt)}</span>
                      </div>
                    </Link>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Coverage */}
          <Card className="lg:col-span-1">
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <Globe className="h-4 w-4" />
                Coverage
              </CardTitle>
              <CardDescription>Tested environments and configurations</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                <div>
                  <div className="flex items-center gap-2 text-sm mb-2">
                    <Monitor className="h-3.5 w-3.5 text-muted-foreground" />
                    <span className="text-muted-foreground">Pages analyzed</span>
                  </div>
                  <div className="text-lg font-bold tabular-nums">{coverage.totalPagesAnalyzed}</div>
                </div>
                <Separator />
                <div>
                  <div className="text-xs text-muted-foreground mb-1.5">Browsers</div>
                  {coverage.browsers.length > 0 ? (
                    <div className="flex flex-wrap gap-1.5">
                      {coverage.browsers.map((b) => (
                        <Badge key={b} variant="secondary" className="text-xs">{b}</Badge>
                      ))}
                    </div>
                  ) : (
                    <span className="text-sm text-muted-foreground">Not yet scanned</span>
                  )}
                </div>
                <div>
                  <div className="text-xs text-muted-foreground mb-1.5">Viewports</div>
                  {coverage.viewports.length > 0 ? (
                    <div className="flex flex-wrap gap-1.5">
                      {coverage.viewports.map((v) => (
                        <Badge key={v} variant="secondary" className="text-xs">{v}</Badge>
                      ))}
                    </div>
                  ) : (
                    <span className="text-sm text-muted-foreground">Not yet scanned</span>
                  )}
                </div>
                <div>
                  <div className="text-xs text-muted-foreground mb-1.5">Locales</div>
                  {coverage.locales.length > 0 ? (
                    <div className="flex flex-wrap gap-1.5">
                      {coverage.locales.map((l) => (
                        <Badge key={l} variant="secondary" className="text-xs">{l}</Badge>
                      ))}
                    </div>
                  ) : (
                    <span className="text-sm text-muted-foreground">Not yet scanned</span>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Journey Success */}
          <Card className="lg:col-span-1">
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <Route className="h-4 w-4" />
                Journey Tests
              </CardTitle>
              <CardDescription>User journey execution results</CardDescription>
            </CardHeader>
            <CardContent>
              {journeys.totalRuns === 0 ? (
                <div className="py-6 text-center text-muted-foreground text-sm">
                  No journey runs yet. Create a journey to test user flows.
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="flex items-center gap-4">
                    <div className="flex-1">
                      <div className="text-xs text-muted-foreground mb-1">Success rate</div>
                      <div className="text-2xl font-bold tabular-nums">
                        {journeys.successRate ?? 0}%
                      </div>
                    </div>
                    <div className={`w-14 h-14 rounded-full flex items-center justify-center text-white font-bold ${
                      (journeys.successRate ?? 0) >= 80
                        ? 'bg-emerald-500'
                        : (journeys.successRate ?? 0) >= 50
                          ? 'bg-amber-500'
                          : 'bg-red-500'
                    }`}>
                      {journeys.successRate ?? 0}%
                    </div>
                  </div>
                  <Progress
                    value={journeys.successRate ?? 0}
                    className="h-2"
                  />
                  <div className="grid grid-cols-3 gap-3 text-center text-sm">
                    <div>
                      <div className="font-bold tabular-nums">{journeys.totalRuns}</div>
                      <div className="text-xs text-muted-foreground">Total</div>
                    </div>
                    <div>
                      <div className="font-bold tabular-nums text-emerald-600">{journeys.completedRuns}</div>
                      <div className="text-xs text-muted-foreground">Passed</div>
                    </div>
                    <div>
                      <div className="font-bold tabular-nums">{journeys.activeJourneys}</div>
                      <div className="text-xs text-muted-foreground">Active</div>
                    </div>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* ── Recent Reports ─────────────────────────────────── */}
        <Card className="mb-6">
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="text-base">Recent Reports</CardTitle>
                <CardDescription>Generated reports for this project</CardDescription>
              </div>
              <Button variant="outline" size="sm" asChild>
                <Link href={`/app/projects/${project.id}/reports`}>
                  View all <ArrowRight className="h-3.5 w-3.5 ml-1" />
                </Link>
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            {recentReports.length === 0 ? (
              <div className="py-6 text-center text-muted-foreground text-sm">
                No reports generated yet. Complete a scan and create a report.
              </div>
            ) : (
              <div className="max-h-64 overflow-y-auto">
                <div className="divide-y">
                  {recentReports.map((r) => (
                    <div key={r.id} className="flex items-center justify-between py-3">
                      <div className="flex items-center gap-3 min-w-0">
                        <FileBarChart className="h-4 w-4 text-muted-foreground shrink-0" />
                        <div className="min-w-0">
                          <div className="text-sm font-medium truncate">{r.title}</div>
                          <div className="text-xs text-muted-foreground">
                            {r.type} &middot; {relativeTime(r.createdAt)}
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 shrink-0 ml-4">
                        {r.score !== null && (
                          <span className="text-sm font-medium tabular-nums">{Math.round(r.score * 100)}%</span>
                        )}
                        <Badge
                          variant="outline"
                          className={`text-xs ${r.status === 'READY' ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300' : 'bg-gray-50 text-gray-700 dark:bg-gray-800 dark:text-gray-300'}`}
                        >
                          {r.status}
                        </Badge>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </main>

      <AppFooter />
    </div>
  )
}

// ─── Shared Header ──────────────────────────────────────────────

function AppHeader({
  projectName,
  workspaceName,
  workspaceId,
}: {
  projectName: string
  workspaceName: string
  workspaceId: string
}) {
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
                <LayoutDashboard className="h-3.5 w-3.5" />
                Dashboard
              </Link>
              {workspaceId && (
                <Link
                  href={`/app/workspaces/${workspaceId}`}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-muted-foreground hover:bg-muted text-sm"
                >
                  <FolderKanban className="h-3.5 w-3.5" />
                  {workspaceName || 'Workspace'}
                </Link>
              )}
              {projectName && (
                <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-primary/10 text-primary text-sm font-medium">
                  <Bug className="h-3.5 w-3.5" />
                  {projectName}
                </div>
              )}
            </nav>
          </div>
          <div className="flex items-center gap-2">
            <Link href="/app" className="text-sm text-muted-foreground hover:text-foreground transition-colors sm:hidden">
              <LayoutDashboard className="h-5 w-5" />
            </Link>
          </div>
        </div>
      </div>
    </header>
  )
}

// ─── Shared Footer ──────────────────────────────────────────────

function AppFooter() {
  return (
    <footer className="border-t mt-auto">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-4 text-sm text-muted-foreground">
        &copy; {new Date().getFullYear()} ProofPilot. Automated QA, not penetration testing.
      </div>
    </footer>
  )
}
