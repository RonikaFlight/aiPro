'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Button } from '@/components/ui/button'
import {
  Users,
  Building2,
  PlayCircle,
  AlertTriangle,
  FolderKanban,
  CreditCard,
  Briefcase,
  ShieldAlert,
  Activity,
  ChevronRight,
  RefreshCw,
  AlertCircle,
} from 'lucide-react'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AdminStats {
  totalUsers: number
  activeUsers: number
  suspendedUsers: number
  adminUsers: number
  totalWorkspaces: number
  totalProjects: number
  activeProjects: number
  totalRuns: number
  completedRuns: number
  failedRuns: number
  runningRuns: number
  totalFindings: number
  openFindings: number
  totalSubscriptions: number
  activeSubscriptions: number
  totalLlmUsage: number
  totalLlmCost: number
  recentSecurityEvents: number
  totalQueueJobs: number
  activeQueueJobs: number
  failedQueueJobs: number
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatNumber(n: number): string {
  return n.toLocaleString()
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M tokens`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K tokens`
  return `${n} tokens`
}

function formatCost(n: number): string {
  return `$${n.toFixed(2)}`
}

// ---------------------------------------------------------------------------
// Skeleton loader
// ---------------------------------------------------------------------------

function DashboardSkeleton() {
  return (
    <div className="space-y-8 p-6 lg:p-8">
      {/* Title */}
      <div className="space-y-2">
        <Skeleton className="h-8 w-52" />
        <Skeleton className="h-4 w-80" />
      </div>

      {/* Top-level cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Card key={i}>
            <CardHeader>
              <div className="flex items-center gap-3">
                <Skeleton className="h-10 w-10 rounded-lg" />
                <Skeleton className="h-4 w-20" />
              </div>
            </CardHeader>
            <CardContent>
              <Skeleton className="h-8 w-24 mb-2" />
              <Skeleton className="h-4 w-32" />
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Secondary cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Card key={i}>
            <CardHeader>
              <div className="flex items-center gap-3">
                <Skeleton className="h-10 w-10 rounded-lg" />
                <Skeleton className="h-4 w-24" />
              </div>
            </CardHeader>
            <CardContent>
              <Skeleton className="h-8 w-20 mb-2" />
              <Skeleton className="h-4 w-36" />
            </CardContent>
          </Card>
        ))}
      </div>

      {/* LLM Usage card */}
      <Card>
        <CardHeader>
          <Skeleton className="h-5 w-32" />
        </CardHeader>
        <CardContent>
          <div className="flex gap-8">
            <Skeleton className="h-12 w-40" />
            <Skeleton className="h-12 w-32" />
          </div>
        </CardContent>
      </Card>

      {/* Quick links */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="h-24 rounded-xl" />
        ))}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Quick-link data
// ---------------------------------------------------------------------------

const quickLinks = [
  {
    href: '/admin/users',
    title: 'Manage Users',
    description: 'View, edit, suspend and manage user accounts.',
    icon: Users,
  },
  {
    href: '/admin/workspaces',
    title: 'View Workspaces',
    description: 'Browse all workspaces and their membership.',
    icon: Building2,
  },
  {
    href: '/admin/runs',
    title: 'Scan Runs',
    description: 'Monitor and inspect all scan runs.',
    icon: PlayCircle,
  },
  {
    href: '/admin/jobs',
    title: 'Queue Jobs',
    description: 'Inspect background job processing.',
    icon: Briefcase,
  },
  {
    href: '/admin/subscriptions',
    title: 'Subscriptions',
    description: 'View billing plans and subscription status.',
    icon: CreditCard,
  },
  {
    href: '/admin/security-events',
    title: 'Security Events',
    description: 'Review recent security incidents.',
    icon: ShieldAlert,
  },
  {
    href: '/admin/system-health',
    title: 'System Health',
    description: 'Check service availability and metrics.',
    icon: Activity,
  },
  {
    href: '/admin/feature-flags',
    title: 'Feature Flags',
    description: 'Manage feature toggles and rollouts.',
    icon: AlertTriangle,
  },
] as const

// ---------------------------------------------------------------------------
// Page component
// ---------------------------------------------------------------------------

export default function AdminDashboardPage() {
  const [stats, setStats] = useState<AdminStats | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    fetch('/api/v1/admin/stats')
      .then((res) => {
        if (!res.ok) throw new Error(`Request failed (${res.status})`)
        return res.json() as Promise<AdminStats>
      })
      .then((data) => {
        if (!cancelled) setStats(data)
      })
      .catch((err: unknown) => {
        if (!cancelled)
          setError(
            err instanceof Error ? err.message : 'Failed to load stats.',
          )
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [])

  function handleRetry() {
    setLoading(true)
    setError(null)

    fetch('/api/v1/admin/stats')
      .then((res) => {
        if (!res.ok) throw new Error(`Request failed (${res.status})`)
        return res.json() as Promise<AdminStats>
      })
      .then((data) => {
        setStats(data)
      })
      .catch((err: unknown) => {
        setError(
          err instanceof Error ? err.message : 'Failed to load stats.',
        )
      })
      .finally(() => setLoading(false))
  }

  // ---- Loading -----------------------------------------------------------
  if (loading) return <DashboardSkeleton />

  // ---- Error -------------------------------------------------------------
  if (error) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-4 p-8">
        <AlertCircle className="h-10 w-10 text-destructive" />
        <div className="text-center space-y-1">
          <p className="text-lg font-semibold">Failed to load dashboard</p>
          <p className="text-sm text-muted-foreground">{error}</p>
        </div>
        <Button onClick={handleRetry} variant="outline">
          <RefreshCw className="mr-2 h-4 w-4" />
          Retry
        </Button>
      </div>
    )
  }

  if (!stats) return null

  // ---- Content -----------------------------------------------------------
  return (
    <div className="space-y-8 p-6 lg:p-8">
      {/* Page heading */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Platform Overview</h1>
        <p className="text-sm text-muted-foreground mt-1">
          High-level metrics for the ProofPilot platform. Data is fetched live
          from the admin stats endpoint.
        </p>
      </div>

      {/* ─── Primary stat cards ─── */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {/* Users */}
        <Card>
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400">
                <Users className="h-5 w-5" />
              </div>
              <CardDescription>Users</CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-bold">{formatNumber(stats.totalUsers)}</p>
            <div className="mt-2 flex items-center gap-2">
              <Badge variant="secondary" className="text-xs">
                {formatNumber(stats.activeUsers)} active
              </Badge>
              <span className="text-xs text-muted-foreground">
                {formatNumber(stats.adminUsers)} admins &middot;{' '}
                {formatNumber(stats.suspendedUsers)} suspended
              </span>
            </div>
          </CardContent>
        </Card>

        {/* Workspaces */}
        <Card>
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400">
                <Building2 className="h-5 w-5" />
              </div>
              <CardDescription>Workspaces</CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-bold">
              {formatNumber(stats.totalWorkspaces)}
            </p>
            <p className="mt-2 text-xs text-muted-foreground">
              Registered organizations &amp; teams
            </p>
          </CardContent>
        </Card>

        {/* Scan Runs */}
        <Card>
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400">
                <PlayCircle className="h-5 w-5" />
              </div>
              <CardDescription>Scan Runs</CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-bold">{formatNumber(stats.totalRuns)}</p>
            <div className="mt-2 flex items-center gap-2">
              {stats.runningRuns > 0 && (
                <Badge className="bg-emerald-600 text-white text-xs hover:bg-emerald-700">
                  {formatNumber(stats.runningRuns)} running
                </Badge>
              )}
              <span className="text-xs text-muted-foreground">
                {formatNumber(stats.completedRuns)} completed &middot;{' '}
                {formatNumber(stats.failedRuns)} failed
              </span>
            </div>
          </CardContent>
        </Card>

        {/* Open Findings */}
        <Card>
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400">
                <AlertTriangle className="h-5 w-5" />
              </div>
              <CardDescription>Open Findings</CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-bold">
              {formatNumber(stats.openFindings)}
            </p>
            <div className="mt-2 flex items-center gap-2">
              <Badge
                variant="destructive"
                className={`text-xs ${stats.openFindings === 0 ? 'opacity-0' : ''}`}
              >
                {stats.openFindings > 100
                  ? 'High'
                  : stats.openFindings > 20
                    ? 'Medium'
                    : 'Low'}
              </Badge>
              <span className="text-xs text-muted-foreground">
                of {formatNumber(stats.totalFindings)} total
              </span>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* ─── Secondary stat cards ─── */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {/* Projects */}
        <Card>
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400">
                <FolderKanban className="h-5 w-5" />
              </div>
              <CardDescription>Projects</CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-bold">
              {formatNumber(stats.totalProjects)}
            </p>
            <p className="mt-2 text-xs text-muted-foreground">
              {formatNumber(stats.activeProjects)} active
            </p>
          </CardContent>
        </Card>

        {/* Subscriptions */}
        <Card>
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400">
                <CreditCard className="h-5 w-5" />
              </div>
              <CardDescription>Subscriptions</CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-bold">
              {formatNumber(stats.activeSubscriptions)}
            </p>
            <p className="mt-2 text-xs text-muted-foreground">
              active of {formatNumber(stats.totalSubscriptions)} total
            </p>
          </CardContent>
        </Card>

        {/* Queue Jobs */}
        <Card>
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400">
                <Briefcase className="h-5 w-5" />
              </div>
              <CardDescription>Queue Jobs</CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-bold">
              {formatNumber(stats.totalQueueJobs)}
            </p>
            <p className="mt-2 text-xs text-muted-foreground">
              {formatNumber(stats.activeQueueJobs)} active
              {stats.failedQueueJobs > 0 && (
                <span className="text-destructive font-medium">
                  {' '}
                  &middot; {formatNumber(stats.failedQueueJobs)} failed
                </span>
              )}
            </p>
          </CardContent>
        </Card>

        {/* Security Events */}
        <Card>
          <CardHeader>
            <div className="flex items-center gap-3">
              <div
                className={`flex h-10 w-10 items-center justify-center rounded-lg ${
                  stats.recentSecurityEvents > 0
                    ? 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400'
                    : 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400'
                }`}
              >
                <ShieldAlert className="h-5 w-5" />
              </div>
              <CardDescription>Security Events</CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            <p
              className={`text-3xl font-bold ${
                stats.recentSecurityEvents > 0 ? 'text-destructive' : ''
              }`}
            >
              {formatNumber(stats.recentSecurityEvents)}
            </p>
            <p className="mt-2 text-xs text-muted-foreground">
              in the last 7 days
            </p>
          </CardContent>
        </Card>
      </div>

      {/* ─── LLM Usage (full width) ─── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">LLM Usage &amp; Cost</CardTitle>
          <CardDescription>
            Total token consumption and spend across all workspaces.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col sm:flex-row sm:items-center gap-6">
            <div className="flex items-center gap-3">
              <Activity className="h-5 w-5 text-emerald-600" />
              <div>
                <p className="text-2xl font-bold">{formatTokens(stats.totalLlmUsage)}</p>
                <p className="text-xs text-muted-foreground">Total tokens consumed</p>
              </div>
            </div>
            <div className="hidden sm:block h-8 w-px bg-border" />
            <div className="flex items-center gap-3">
              <CreditCard className="h-5 w-5 text-emerald-600" />
              <div>
                <p className="text-2xl font-bold">{formatCost(stats.totalLlmCost)}</p>
                <p className="text-xs text-muted-foreground">Total LLM spend</p>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ─── Quick-access links ─── */}
      <div>
        <h2 className="text-lg font-semibold mb-4">Quick Access</h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {quickLinks.map((link) => {
            const Icon = link.icon
            return (
              <Link key={link.href} href={link.href} className="group">
                <Card className="h-full transition-colors hover:bg-muted/50">
                  <CardContent className="flex items-start justify-between gap-3 pt-6">
                    <div className="flex items-start gap-3 min-w-0">
                      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400">
                        <Icon className="h-4 w-4" />
                      </div>
                      <div className="min-w-0">
                        <p className="text-sm font-semibold leading-tight">
                          {link.title}
                        </p>
                        <p className="mt-1 text-xs text-muted-foreground leading-relaxed line-clamp-2">
                          {link.description}
                        </p>
                      </div>
                    </div>
                    <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
                  </CardContent>
                </Card>
              </Link>
            )
          })}
        </div>
      </div>
    </div>
  )
}
