'use client'

import { useEffect, useState, useCallback } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { Badge } from '@/components/ui/badge'

interface SubscriptionInfo {
  id: string
  status: string
  plan: {
    code: string
    name: string
    priceMonthly: number
    maxProjects: number
    maxRunsPerMonth: number
    maxPagesPerRun: number
    aiEnrichment: boolean
    scheduling: boolean
    whiteLabel: boolean
    journeys: boolean
    teamMembers: number
    retentionDays: number
    priorityQueue: boolean
  }
  stripeCustomerId: string | null
  currentPeriodStart: string | null
  currentPeriodEnd: string | null
  cancelAtPeriodEnd: boolean
  trialEndsAt: string | null
}

interface UsageSummary {
  period: {
    id: string
    periodStart: string
    periodEnd: string
    runsUsed: number
    pagesAnalyzed: number
    aiTokensUsed: number
    reportsGenerated: number
  }
  limits: {
    maxRunsPerMonth: number | null
    maxPagesPerRun: number | null
    aiEnrichment: boolean
    planCode: string | null
    planName: string | null
  }
  exceeded: { runs: boolean; pagesThisRun: boolean }
}

interface UsageEvent {
  id: string
  eventType: string
  quantity: number
  projectId: string | null
  runId: string | null
  idempotencyKey: string | null
  metadata: Record<string, unknown> | null
  createdAt: string
}

const EVENT_LABELS: Record<string, string> = {
  RUN_CREATED: 'Run created',
  PAGE_ANALYZED: 'Page analyzed',
  AI_TOKENS: 'AI tokens',
  REPORT_GENERATED: 'Report generated',
  JOURNEY_EXECUTED: 'Journey executed',
  ARTIFACT_STOREED: 'Artifact stored',
}

function formatPercent(used: number, max: number | null) {
  if (!max || max === 0) return 0
  return Math.min(100, Math.round((used / max) * 100))
}

function formatNumber(n: number) {
  return new Intl.NumberFormat('en-US').format(n)
}

export default function BillingPage() {
  const params = useParams<{ workspaceId: string }>()
  const workspaceId = params.workspaceId

  const [subscription, setSubscription] = useState<SubscriptionInfo | null>(null)
  const [usage, setUsage] = useState<UsageSummary | null>(null)
  const [events, setEvents] = useState<UsageEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [actionUrl, setActionUrl] = useState<string | null>(null)

  const loadData = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [subRes, usageRes, eventsRes] = await Promise.all([
        fetch(`/api/v1/workspaces/${workspaceId}/billing/subscription`),
        fetch(`/api/v1/workspaces/${workspaceId}/usage`),
        fetch(`/api/v1/workspaces/${workspaceId}/usage/events?limit=20`),
      ])
      if (!subRes.ok) throw new Error(`Subscription: ${subRes.status}`)
      if (!usageRes.ok) throw new Error(`Usage: ${usageRes.status}`)
      const [sub, use, evts] = await Promise.all([
        subRes.json(),
        usageRes.json(),
        eventsRes.json(),
      ])
      setSubscription(sub)
      setUsage(use)
      setEvents(evts.items ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [workspaceId])

  useEffect(() => {
    void loadData()
  }, [loadData])

  async function handleCheckout(planCode: string) {
    try {
      const csrfRes = await fetch('/api/v1/csrf')
      const csrf = (await csrfRes.json()).csrfToken
      const res = await fetch(`/api/v1/workspaces/${workspaceId}/billing/checkout`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrf,
        },
        body: JSON.stringify({ planCode }),
      })
      if (!res.ok) {
        const body = await res.json()
        setError(body.detail || `Checkout failed (${res.status})`)
        return
      }
      const session = await res.json()
      // In dev mode the URL is on our own origin (synthetic). In production it's a Stripe URL.
      setActionUrl(session.url)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Checkout failed')
    }
  }

  async function handlePortal() {
    try {
      const csrfRes = await fetch('/api/v1/csrf')
      const csrf = (await csrfRes.json()).csrfToken
      const res = await fetch(`/api/v1/workspaces/${workspaceId}/billing/portal`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrf,
        },
        body: JSON.stringify({}),
      })
      if (!res.ok) {
        const body = await res.json()
        setError(body.detail || `Portal failed (${res.status})`)
        return
      }
      const session = await res.json()
      setActionUrl(session.url)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Portal failed')
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen flex flex-col bg-background">
        <header className="border-b bg-card">
          <div className="mx-auto max-w-6xl px-4 py-4">
            <span className="text-lg font-semibold">ProofPilot</span>
          </div>
        </header>
        <main className="flex-1 mx-auto max-w-6xl px-4 py-8 w-full">
          <div className="animate-pulse space-y-4">
            <div className="h-8 bg-muted rounded w-1/3" />
            <div className="h-32 bg-muted rounded" />
            <div className="h-48 bg-muted rounded" />
          </div>
        </main>
      </div>
    )
  }

  if (error) {
    return (
      <div className="min-h-screen flex flex-col bg-background">
        <header className="border-b bg-card">
          <div className="mx-auto max-w-6xl px-4 py-4">
            <span className="text-lg font-semibold">ProofPilot</span>
          </div>
        </header>
        <main className="flex-1 mx-auto max-w-6xl px-4 py-8 w-full">
          <Card>
            <CardHeader>
              <CardTitle>Failed to load billing</CardTitle>
              <CardDescription>{error}</CardDescription>
            </CardHeader>
            <CardContent>
              <Button onClick={() => void loadData()}>Retry</Button>
            </CardContent>
          </Card>
        </main>
      </div>
    )
  }

  return (
    <div className="min-h-screen flex flex-col bg-background">
      <header className="border-b bg-card">
        <div className="mx-auto max-w-6xl px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="h-8 w-8 rounded-lg bg-primary flex items-center justify-center text-primary-foreground font-bold">P</div>
            <span className="text-lg font-semibold">ProofPilot</span>
          </div>
        </div>
      </header>

      <main className="flex-1 mx-auto max-w-6xl px-4 py-8 w-full">
        <div className="flex items-center gap-2 text-sm text-muted-foreground mb-2">
          <Link href="/app" className="hover:text-foreground">Workspaces</Link>
          <span>/</span>
          <Link href={`/app/workspaces/${workspaceId}`} className="hover:text-foreground">Workspace</Link>
          <span>/</span>
          <span className="text-foreground">Usage & billing</span>
        </div>
        <h1 className="text-2xl font-bold mb-1">Usage & billing</h1>
        <p className="text-muted-foreground text-sm mb-6">
          Track metered usage for the current period and manage your subscription.
        </p>

        {actionUrl && (
          <div className="mb-6 rounded-lg border border-emerald-300 bg-emerald-50 p-4 text-sm">
            <div className="font-medium text-emerald-900 mb-1">Session created</div>
            <div className="text-emerald-700 break-all">
              Redirect URL: <a href={actionUrl} className="underline">{actionUrl}</a>
            </div>
            <p className="text-xs text-emerald-600 mt-2">
              In dev mode, the URL points back to this app. In production this would be a Stripe-hosted page.
            </p>
          </div>
        )}

        {/* Subscription card */}
        {subscription && (
          <Card className="mb-6">
            <CardHeader>
              <CardTitle className="flex items-center justify-between">
                <span>Subscription</span>
                <div className="flex items-center gap-2">
                  <Badge variant="secondary">{subscription.plan.code} plan</Badge>
                  <Badge variant={subscription.status === 'ACTIVE' ? 'default' : 'outline'}>
                    {subscription.status}
                  </Badge>
                </div>
              </CardTitle>
              <CardDescription>
                {subscription.plan.name} — ${(subscription.plan.priceMonthly / 100).toFixed(2)}/month
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4 text-sm">
                <div>
                  <div className="text-muted-foreground text-xs">Current period</div>
                  <div className="font-medium">
                    {subscription.currentPeriodStart
                      ? new Date(subscription.currentPeriodStart).toLocaleDateString()
                      : '—'}
                    {' → '}
                    {subscription.currentPeriodEnd
                      ? new Date(subscription.currentPeriodEnd).toLocaleDateString()
                      : '—'}
                  </div>
                </div>
                <div>
                  <div className="text-muted-foreground text-xs">Trial ends</div>
                  <div className="font-medium">
                    {subscription.trialEndsAt
                      ? new Date(subscription.trialEndsAt).toLocaleDateString()
                      : '—'}
                  </div>
                </div>
                <div>
                  <div className="text-muted-foreground text-xs">Max projects</div>
                  <div className="font-medium">{subscription.plan.maxProjects}</div>
                </div>
                <div>
                  <div className="text-muted-foreground text-xs">Team members</div>
                  <div className="font-medium">{subscription.plan.teamMembers}</div>
                </div>
              </div>

              <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-2 mt-4 text-xs">
                <div className={subscription.plan.aiEnrichment ? 'text-emerald-600' : 'text-muted-foreground'}>
                  {subscription.plan.aiEnrichment ? '✓' : '✗'} AI enrichment
                </div>
                <div className={subscription.plan.scheduling ? 'text-emerald-600' : 'text-muted-foreground'}>
                  {subscription.plan.scheduling ? '✓' : '✗'} Scheduling
                </div>
                <div className={subscription.plan.journeys ? 'text-emerald-600' : 'text-muted-foreground'}>
                  {subscription.plan.journeys ? '✓' : '✗'} Journeys
                </div>
                <div className={subscription.plan.whiteLabel ? 'text-emerald-600' : 'text-muted-foreground'}>
                  {subscription.plan.whiteLabel ? '✓' : '✗'} White-label
                </div>
              </div>

              <div className="mt-6 pt-4 border-t flex flex-wrap gap-2">
                <Button size="sm" onClick={() => void handleCheckout('PRO')}>
                  Upgrade to PRO
                </Button>
                <Button size="sm" onClick={() => void handleCheckout('AGENCY')}>
                  Upgrade to AGENCY
                </Button>
                <Button size="sm" variant="outline" onClick={() => void handlePortal()}>
                  Manage subscription
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Usage for current period */}
        {usage && (
          <Card className="mb-6">
            <CardHeader>
              <CardTitle>Usage this period</CardTitle>
              <CardDescription>
                Period: {new Date(usage.period.periodStart).toLocaleDateString()} →{' '}
                {new Date(usage.period.periodEnd).toLocaleDateString()}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              <div>
                <div className="flex items-center justify-between text-sm mb-1">
                  <span>Runs</span>
                  <span className={usage.exceeded.runs ? 'text-red-600 font-medium' : 'text-muted-foreground'}>
                    {formatNumber(usage.period.runsUsed)} /{' '}
                    {usage.limits.maxRunsPerMonth ? formatNumber(usage.limits.maxRunsPerMonth) : '∞'}
                  </span>
                </div>
                <Progress
                  value={formatPercent(usage.period.runsUsed, usage.limits.maxRunsPerMonth)}
                  className="h-2"
                />
                {usage.exceeded.runs && (
                  <p className="text-xs text-red-600 mt-1">
                    Run limit reached — upgrade your plan to run more scans.
                  </p>
                )}
              </div>

              <div>
                <div className="flex items-center justify-between text-sm mb-1">
                  <span>Pages analyzed</span>
                  <span className="text-muted-foreground">
                    {formatNumber(usage.period.pagesAnalyzed)} (limit:{' '}
                    {usage.limits.maxPagesPerRun ? formatNumber(usage.limits.maxPagesPerRun) + '/run' : '∞'})
                  </span>
                </div>
                <Progress
                  value={usage.limits.maxPagesPerRun
                    ? formatPercent(usage.period.pagesAnalyzed % (usage.limits.maxPagesPerRun || 1), usage.limits.maxPagesPerRun)
                    : 0}
                  className="h-2"
                />
              </div>

              <div>
                <div className="flex items-center justify-between text-sm mb-1">
                  <span>AI tokens used</span>
                  <span className="text-muted-foreground">{formatNumber(usage.period.aiTokensUsed)}</span>
                </div>
                <Progress
                  value={Math.min(100, Math.round((usage.period.aiTokensUsed / 100000) * 100))}
                  className="h-2"
                />
                <p className="text-xs text-muted-foreground mt-1">
                  Budget shown relative to a default 100K token reference.
                </p>
              </div>

              <div>
                <div className="flex items-center justify-between text-sm mb-1">
                  <span>Reports generated</span>
                  <span className="text-muted-foreground">{formatNumber(usage.period.reportsGenerated)}</span>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Recent usage events */}
        <Card>
          <CardHeader>
            <CardTitle>Recent usage events</CardTitle>
            <CardDescription>Last {events.length} metered events for this workspace.</CardDescription>
          </CardHeader>
          <CardContent>
            {events.length === 0 ? (
              <p className="text-sm text-muted-foreground py-6 text-center">
                No usage events yet. Run a scan to see metered activity here.
              </p>
            ) : (
              <div className="max-h-96 overflow-y-auto -mx-2">
                <table className="w-full text-sm">
                  <thead className="text-xs text-muted-foreground border-b">
                    <tr>
                      <th className="text-left font-medium px-2 py-2">Event</th>
                      <th className="text-right font-medium px-2 py-2">Qty</th>
                      <th className="text-left font-medium px-2 py-2">When</th>
                      <th className="text-left font-medium px-2 py-2">Idempotency key</th>
                    </tr>
                  </thead>
                  <tbody>
                    {events.map((e) => (
                      <tr key={e.id} className="border-b last:border-0">
                        <td className="px-2 py-2 font-medium">
                          {EVENT_LABELS[e.eventType] ?? e.eventType}
                        </td>
                        <td className="px-2 py-2 text-right tabular-nums">{formatNumber(e.quantity)}</td>
                        <td className="px-2 py-2 text-muted-foreground">
                          {new Date(e.createdAt).toLocaleString()}
                        </td>
                        <td className="px-2 py-2 text-muted-foreground font-mono text-xs">
                          {e.idempotencyKey ?? '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      </main>

      <footer className="border-t bg-card mt-auto">
        <div className="mx-auto max-w-6xl px-4 py-4 text-sm text-muted-foreground">
          © {new Date().getFullYear()} ProofPilot. Automated QA, not penetration testing.
        </div>
      </footer>
    </div>
  )
}
