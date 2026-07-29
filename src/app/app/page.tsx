import { redirect } from 'next/navigation'
import Link from 'next/link'
import { requireAuth } from '@/lib/auth-context'
import { listWorkspacesForUser } from '@/lib/workspace-service'
import { db } from '@/lib/db'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import {
  ShieldCheck,
  FolderKanban,
  Play,
  AlertTriangle,
  TrendingUp,
  LayoutDashboard,
  FolderSearch,
  Bug,
  FileBarChart,
  Clock,
} from 'lucide-react'

export const dynamic = 'force-dynamic'

function relativeTime(date: Date): string {
  const now = Date.now()
  const diff = now - date.getTime()
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
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
    default:
      return 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300'
  }
}

function formatScore(score: number | null): string {
  if (score === null || score === undefined) return '—'
  return `${Math.round(score * 100)}%`
}

export default async function AppDashboard() {
  let auth
  try {
    auth = await requireAuth()
  } catch {
    redirect('/login')
  }

  const workspaces = await listWorkspacesForUser(auth.userId)
  const wsIds = workspaces.map((w) => w.id)

  // Aggregate stats
  const [totalProjects, totalRuns, openFindings, recentRuns] = await Promise.all([
    db.project.count({
      where: { workspaceId: { in: wsIds }, status: 'ACTIVE' },
    }),
    db.scanRun.count({
      where: { workspaceId: { in: wsIds } },
    }),
    db.finding.count({
      where: {
        workspaceId: { in: wsIds },
        status: { in: ['OPEN', 'ACKNOWLEDGED', 'IN_PROGRESS'] },
      },
    }),
    db.scanRun.findMany({
      where: { workspaceId: { in: wsIds } },
      take: 10,
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        status: true,
        createdAt: true,
        score: true,
        project: { select: { name: true, workspace: { select: { name: true } } } },
      },
    }),
  ])

  // Average score from latest runs
  const scoredRuns = recentRuns.filter((r) => r.score !== null && r.score !== undefined)
  const avgScore =
    scoredRuns.length > 0
      ? scoredRuns.reduce((sum, r) => sum + (r.score ?? 0), 0) / scoredRuns.length
      : null

  // Per-workspace stats and latest run
  const workspaceData = await Promise.all(
    workspaces.map(async (w) => {
      const projectCount = await db.project.count({ where: { workspaceId: w.id, status: 'ACTIVE' } })
      const runCount = await db.scanRun.count({ where: { workspaceId: w.id } })
      const openFinds = await db.finding.count({
        where: { workspaceId: w.id, status: { in: ['OPEN', 'ACKNOWLEDGED', 'IN_PROGRESS'] } },
      })
      const latestRun = await db.scanRun.findFirst({
        where: { workspaceId: w.id },
        orderBy: { createdAt: 'desc' },
        select: { id: true, status: true, createdAt: true, score: true },
      })
      return { ...w, projectCount, runCount, openFindings: openFinds, latestRun }
    }),
  )

  const userName = auth.name || auth.email.split('@')[0]

  return (
    <div className="min-h-screen flex flex-col bg-background">
      {/* Top Navigation */}
      <header className="sticky top-0 z-40 border-b bg-background/80 backdrop-blur-sm">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="flex h-14 items-center justify-between">
            <div className="flex items-center gap-6">
              <Link href="/" className="flex items-center gap-2 font-semibold">
                <ShieldCheck className="h-5 w-5 text-primary" />
                <span>ProofPilot</span>
              </Link>
              <nav className="hidden sm:flex items-center gap-1">
                <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-primary/10 text-primary text-sm font-medium">
                  <LayoutDashboard className="h-3.5 w-3.5" />
                  Dashboard
                </div>
                <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-muted-foreground hover:bg-muted text-sm">
                  <FolderSearch className="h-3.5 w-3.5" />
                  Projects
                </div>
                <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-muted-foreground hover:bg-muted text-sm">
                  <Bug className="h-3.5 w-3.5" />
                  Findings
                </div>
                <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-muted-foreground hover:bg-muted text-sm">
                  <FileBarChart className="h-3.5 w-3.5" />
                  Reports
                </div>
              </nav>
            </div>
            <div className="flex items-center gap-3">
              <div className="text-right hidden sm:block">
                <div className="text-sm font-medium">{auth.email}</div>
              </div>
              <div className="h-8 w-8 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-sm font-medium">
                {userName.charAt(0).toUpperCase()}
              </div>
              <a
                href="/api/v1/auth/logout"
                className="text-sm text-muted-foreground hover:text-foreground transition-colors"
              >
                Sign out
              </a>
            </div>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 mx-auto w-full max-w-7xl px-4 sm:px-6 lg:px-8 py-8">
        {/* Welcome */}
        <section className="mb-8">
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">
            Welcome back, {userName}
          </h1>
          <p className="text-muted-foreground mt-1">
            Here&apos;s what&apos;s happening across your workspaces.
          </p>
        </section>

        {/* Stats Overview */}
        <section className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
          <StatCard
            icon={<FolderKanban className="h-4 w-4" />}
            label="Projects"
            value={totalProjects.toString()}
            description="Active projects"
          />
          <StatCard
            icon={<Play className="h-4 w-4" />}
            label="Runs"
            value={totalRuns.toString()}
            description="Total scan runs"
          />
          <StatCard
            icon={<AlertTriangle className="h-4 w-4" />}
            label="Open Findings"
            value={openFindings.toString()}
            description="Needs attention"
          />
          <StatCard
            icon={<TrendingUp className="h-4 w-4" />}
            label="Avg Score"
            value={formatScore(avgScore)}
            description={avgScore !== null ? 'Across latest runs' : 'No scans yet'}
          />
        </section>

        {/* Workspaces */}
        <section className="mb-8">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xl font-semibold">Workspaces</h2>
          </div>

          {workspaceData.length === 0 ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">No workspaces yet</CardTitle>
                <CardDescription>
                  Create your first workspace to start scanning.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Button>Create workspace</Button>
              </CardContent>
            </Card>
          ) : (
            <div className="grid md:grid-cols-2 gap-4">
              {workspaceData.map((w) => (
                <Link key={w.id} href={`/app/workspaces/${w.id}`} className="block">
                  <Card className="hover:border-primary/50 transition-colors cursor-pointer h-full">
                    <CardHeader>
                      <div className="flex items-center justify-between">
                        <CardTitle className="text-lg">{w.name}</CardTitle>
                        <Badge variant="secondary" className="text-xs">
                          {w.role}
                        </Badge>
                      </div>
                      <CardDescription>{w.slug}</CardDescription>
                    </CardHeader>
                    <CardContent>
                      <div className="grid grid-cols-3 gap-3 text-center mb-4">
                        <div>
                          <div className="text-xl font-bold">{w.projectCount}</div>
                          <div className="text-xs text-muted-foreground">Projects</div>
                        </div>
                        <div>
                          <div className="text-xl font-bold">{w.runCount}</div>
                          <div className="text-xs text-muted-foreground">Runs</div>
                        </div>
                        <div>
                          <div className="text-xl font-bold">{w.openFindings}</div>
                          <div className="text-xs text-muted-foreground">Open</div>
                        </div>
                      </div>
                      {w.latestRun && (
                        <Separator className="mb-3" />
                      )}
                      {w.latestRun ? (
                        <div className="flex items-center justify-between text-sm">
                          <div className="flex items-center gap-2">
                            <Clock className="h-3.5 w-3.5 text-muted-foreground" />
                            <span className="text-muted-foreground">Last run</span>
                          </div>
                          <div className="flex items-center gap-2">
                            <Badge variant="outline" className={`text-xs ${statusColor(w.latestRun.status)}`}>
                              {w.latestRun.status.replace(/_/g, ' ')}
                            </Badge>
                            <span className="text-xs text-muted-foreground">
                              {relativeTime(w.latestRun.createdAt)}
                            </span>
                          </div>
                        </div>
                      ) : (
                        <p className="text-xs text-muted-foreground">No scans yet</p>
                      )}
                    </CardContent>
                  </Card>
                </Link>
              ))}
            </div>
          )}
        </section>

        {/* Recent Activity */}
        <section>
          <h2 className="text-xl font-semibold mb-4">Recent Activity</h2>

          {recentRuns.length === 0 ? (
            <Card>
              <CardContent className="py-8">
                <div className="text-center">
                  <Play className="h-10 w-10 text-muted-foreground/50 mx-auto mb-3" />
                  <p className="text-muted-foreground text-sm">
                    No scan runs yet. Start your first scan to see activity here.
                  </p>
                </div>
              </CardContent>
            </Card>
          ) : (
            <Card>
              <div className="divide-y">
                {recentRuns.map((run) => (
                  <div
                    key={run.id}
                    className="flex items-center justify-between px-6 py-3 hover:bg-muted/50 transition-colors"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <Badge variant="outline" className={`shrink-0 text-xs ${statusColor(run.status)}`}>
                        {run.status.replace(/_/g, ' ')}
                      </Badge>
                      <div className="min-w-0">
                        <div className="text-sm font-medium truncate">
                          {run.project.name}
                        </div>
                        <div className="text-xs text-muted-foreground truncate">
                          {run.project.workspace?.name}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-3 shrink-0 ml-4">
                      {run.score !== null && run.score !== undefined && (
                        <div className="text-sm font-medium tabular-nums">
                          {Math.round(run.score * 100)}%
                        </div>
                      )}
                      <div className="text-xs text-muted-foreground">
                        {relativeTime(run.createdAt)}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          )}
        </section>
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

function StatCard({
  icon,
  label,
  value,
  description,
}: {
  icon: React.ReactNode
  label: string
  value: string
  description: string
}) {
  return (
    <Card>
      <CardContent className="p-5">
        <div className="flex items-center gap-2 mb-3">
          <div className="text-muted-foreground">{icon}</div>
          <span className="text-sm text-muted-foreground">{label}</span>
        </div>
        <div className="text-2xl font-bold tabular-nums">{value}</div>
        <div className="text-xs text-muted-foreground mt-1">{description}</div>
      </CardContent>
    </Card>
  )
}
