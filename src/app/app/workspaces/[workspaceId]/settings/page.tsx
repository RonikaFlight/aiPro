'use client'

import { useEffect, useState, useCallback } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Separator } from '@/components/ui/separator'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
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
  Settings,
  AlertCircle,
  RefreshCw,
  Loader2,
  Palette,
  Trash2,
  ExternalLink,
  CheckCircle2,
} from 'lucide-react'

// ─── Types ───────────────────────────────────────────────────────

interface WorkspaceInfo {
  id: string
  name: string
  slug: string
  logoUrl: string | null
  accentColor: string | null
  brandName: string | null
  retentionDays: number
  plan: { code: string; name: string } | null
  role: string
  createdAt: string
}

interface WhiteLabelSettings {
  logoUrl: string | null
  accentColor: string | null
  brandName: string | null
  brandIntro: string | null
  brandFooter: string | null
  brandContactEmail: string | null
  brandContactUrl: string | null
  customDomain: string | null
  whiteLabelEnabled: boolean
}

// ─── Helpers ─────────────────────────────────────────────────────

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })
}

// ─── Component ───────────────────────────────────────────────────

export default function SettingsPage() {
  const params = useParams<{ workspaceId: string }>()
  const workspaceId = params.workspaceId

  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // White label form state
  const [whiteLabel, setWhiteLabel] = useState<WhiteLabelSettings | null>(null)
  const [wlForm, setWlForm] = useState({
    brandName: '',
    brandIntro: '',
    brandFooter: '',
    brandContactEmail: '',
    accentColor: '',
    logoUrl: '',
  })
  const [wlSaving, setWlSaving] = useState(false)
  const [wlSaved, setWlSaved] = useState(false)
  const [wlError, setWlError] = useState<string | null>(null)
  const [wlEnabled, setWlEnabled] = useState(false)

  const loadData = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [wsRes, wlRes] = await Promise.all([
        fetch(`/api/v1/workspaces/${workspaceId}`),
        fetch(`/api/v1/workspaces/${workspaceId}/white-label`).catch(() => null),
      ])
      if (!wsRes.ok) throw new Error(`Workspace: ${wsRes.status}`)
      const ws = await wsRes.json()
      setWorkspace(ws)

      if (wlRes && wlRes.ok) {
        const wl = await wlRes.json()
        setWhiteLabel(wl)
        setWlEnabled(wl.whiteLabelEnabled)
        setWlForm({
          brandName: wl.brandName ?? '',
          brandIntro: wl.brandIntro ?? '',
          brandFooter: wl.brandFooter ?? '',
          brandContactEmail: wl.brandContactEmail ?? '',
          accentColor: wl.accentColor ?? '',
          logoUrl: wl.logoUrl ?? '',
        })
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load settings')
    } finally {
      setLoading(false)
    }
  }, [workspaceId])

  useEffect(() => {
    void loadData()
  }, [loadData])

  async function handleWhiteLabelSave() {
    setWlSaving(true)
    setWlError(null)
    setWlSaved(false)
    try {
      const csrfRes = await fetch('/api/v1/csrf')
      const csrf = (await csrfRes.json()).csrfToken

      const body: Record<string, string | null> = {}
      if (wlForm.brandName !== (whiteLabel?.brandName ?? '')) body.brandName = wlForm.brandName || null
      if (wlForm.brandIntro !== (whiteLabel?.brandIntro ?? '')) body.brandIntro = wlForm.brandIntro || null
      if (wlForm.brandFooter !== (whiteLabel?.brandFooter ?? '')) body.brandFooter = wlForm.brandFooter || null
      if (wlForm.brandContactEmail !== (whiteLabel?.brandContactEmail ?? '')) body.brandContactEmail = wlForm.brandContactEmail || null
      if (wlForm.accentColor !== (whiteLabel?.accentColor ?? '')) body.accentColor = wlForm.accentColor || null
      if (wlForm.logoUrl !== (whiteLabel?.logoUrl ?? '')) body.logoUrl = wlForm.logoUrl || null

      const res = await fetch(`/api/v1/workspaces/${workspaceId}/white-label`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrf,
        },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.detail || `Save failed (${res.status})`)
      }
      const result = await res.json()
      setWhiteLabel(result.settings ?? whiteLabel)
      setWlSaved(true)
      setTimeout(() => setWlSaved(false), 3000)
    } catch (err) {
      setWlError(err instanceof Error ? err.message : 'Failed to save')
    } finally {
      setWlSaving(false)
    }
  }

  // ─── Loading skeleton ──────────────────────────────────────────

  if (loading) {
    return (
      <div className="min-h-screen flex flex-col bg-background">
        <header className="border-b bg-card sticky top-0 z-10">
          <div className="mx-auto max-w-6xl px-4 py-4 flex items-center gap-3">
            <Skeleton className="h-8 w-8 rounded-lg" />
            <Skeleton className="h-5 w-24" />
            <Skeleton className="h-5 w-4" />
            <Skeleton className="h-5 w-32" />
          </div>
        </header>
        <main className="flex-1 mx-auto max-w-6xl px-4 py-8 w-full">
          <div className="space-y-4">
            <Skeleton className="h-8 w-40" />
            <Skeleton className="h-4 w-64" />
            <Skeleton className="h-10 w-80" />
            <Skeleton className="h-[500px] w-full rounded-lg" />
          </div>
        </main>
      </div>
    )
  }

  // ─── Error state ───────────────────────────────────────────────

  if (error) {
    return (
      <div className="min-h-screen flex flex-col bg-background">
        <header className="border-b bg-card sticky top-0 z-10">
          <div className="mx-auto max-w-6xl px-4 py-4 flex items-center gap-3">
            <div className="h-8 w-8 rounded-lg bg-primary flex items-center justify-center text-primary-foreground">
              <ShieldCheck className="h-5 w-5" />
            </div>
            <span className="text-lg font-semibold">ProofPilot</span>
          </div>
        </header>
        <main className="flex-1 mx-auto max-w-6xl px-4 py-8 w-full">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <AlertCircle className="h-5 w-5 text-destructive" />
                Failed to load settings
              </CardTitle>
              <CardDescription>{error}</CardDescription>
            </CardHeader>
            <CardContent>
              <Button variant="outline" onClick={() => void loadData()}>
                <RefreshCw className="h-4 w-4 mr-2" />
                Retry
              </Button>
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

  // ─── Main content ──────────────────────────────────────────────

  return (
    <div className="min-h-screen flex flex-col bg-background">
      {/* Sticky header */}
      <header className="border-b bg-card sticky top-0 z-10">
        <div className="mx-auto max-w-6xl px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <ShieldCheck className="h-6 w-6 text-primary" />
            <span className="text-lg font-semibold">ProofPilot</span>
          </div>
          <div className="flex items-center gap-3 text-sm">
            <Link href={`/app/workspaces/${workspaceId}/team`} className="hover:underline text-muted-foreground">
              Team
            </Link>
            <Link href={`/app/workspaces/${workspaceId}/audit`} className="hover:underline text-muted-foreground">
              Audit log
            </Link>
          </div>
        </div>
      </header>

      <main className="flex-1 mx-auto max-w-6xl px-4 py-8 w-full">
        {/* Breadcrumbs */}
        <nav className="flex items-center gap-2 text-sm text-muted-foreground mb-6">
          <Link href="/app" className="hover:text-foreground">
            Dashboard
          </Link>
          <span>/</span>
          <Link href={`/app/workspaces/${workspaceId}`} className="hover:text-foreground">
            {workspace?.name ?? 'Workspace'}
          </Link>
          <span>/</span>
          <span className="text-foreground font-medium">Settings</span>
        </nav>

        <h1 className="text-2xl font-bold flex items-center gap-2 mb-1">
          <Settings className="h-6 w-6" />
          Workspace Settings
        </h1>
        <p className="text-muted-foreground text-sm mb-6">
          Manage workspace configuration, branding, and advanced options.
        </p>

        <Tabs defaultValue="general" className="space-y-6">
          <TabsList className="w-full sm:w-auto">
            <TabsTrigger value="general">General</TabsTrigger>
            <TabsTrigger value="white-label">White Label</TabsTrigger>
            <TabsTrigger value="danger" className="text-destructive data-[state=active]:text-destructive">
              Danger Zone
            </TabsTrigger>
          </TabsList>

          {/* ── General Tab ──────────────────────────────────────── */}
          <TabsContent value="general">
            <Card>
              <CardHeader>
                <CardTitle>General Information</CardTitle>
                <CardDescription>
                  Read-only workspace details. Contact support to change the workspace name or slug.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <Label className="text-muted-foreground text-xs">Workspace Name</Label>
                    <div className="text-sm font-medium">{workspace?.name}</div>
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-muted-foreground text-xs">Slug</Label>
                    <div className="text-sm font-mono">{workspace?.slug}</div>
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-muted-foreground text-xs">Created</Label>
                    <div className="text-sm">{workspace?.createdAt ? formatDate(workspace.createdAt) : '—'}</div>
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-muted-foreground text-xs">Plan</Label>
                    <div className="flex items-center gap-2">
                      <Badge variant={workspace?.plan?.code === 'FREE' ? 'outline' : 'default'}>
                        {workspace?.plan?.name ?? workspace?.plan?.code ?? '—'}
                      </Badge>
                      <Link
                        href={`/app/workspaces/${workspaceId}/billing`}
                        className="text-xs text-primary hover:underline inline-flex items-center gap-1"
                      >
                        Manage
                        <ExternalLink className="h-3 w-3" />
                      </Link>
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-muted-foreground text-xs">Your Role</Label>
                    <Badge variant="secondary">{workspace?.role}</Badge>
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-muted-foreground text-xs">Data Retention</Label>
                    <div className="text-sm">{workspace?.retentionDays ?? '—'} days</div>
                  </div>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          {/* ── White Label Tab ──────────────────────────────────── */}
          <TabsContent value="white-label">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Palette className="h-5 w-5" />
                  White-Label Branding
                </CardTitle>
                <CardDescription>
                  Customize the branding on client-facing reports.{' '}
                  {wlEnabled ? (
                    <span className="text-emerald-600 font-medium">Enabled on your plan.</span>
                  ) : (
                    <span className="text-amber-600 font-medium">
                      Upgrade to Agency plan to enable white-label branding.
                    </span>
                  )}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-center gap-3 mb-4 p-3 rounded-lg bg-muted/50">
                  <Switch checked={wlEnabled} onCheckedChange={setWlEnabled} disabled />
                  <Label>White-label enabled</Label>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <Label htmlFor="wl-brandName">Brand Name</Label>
                    <Input
                      id="wl-brandName"
                      placeholder="Acme Agency"
                      value={wlForm.brandName}
                      onChange={(e) => setWlForm((f) => ({ ...f, brandName: e.target.value }))}
                      disabled={!wlEnabled}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="wl-accentColor">Accent Color</Label>
                    <div className="flex items-center gap-2">
                      {wlForm.accentColor && (
                        <div
                          className="h-9 w-9 rounded-md border shrink-0"
                          style={{ backgroundColor: wlForm.accentColor }}
                        />
                      )}
                      <Input
                        id="wl-accentColor"
                        placeholder="#10b981"
                        value={wlForm.accentColor}
                        onChange={(e) => setWlForm((f) => ({ ...f, accentColor: e.target.value }))}
                        disabled={!wlEnabled}
                        className="font-mono"
                      />
                    </div>
                  </div>
                  <div className="space-y-1.5 sm:col-span-2">
                    <Label htmlFor="wl-brandIntro">Brand Introduction</Label>
                    <Input
                      id="wl-brandIntro"
                      placeholder="Trusted QA partner since 2024."
                      value={wlForm.brandIntro}
                      onChange={(e) => setWlForm((f) => ({ ...f, brandIntro: e.target.value }))}
                      disabled={!wlEnabled}
                    />
                  </div>
                  <div className="space-y-1.5 sm:col-span-2">
                    <Label htmlFor="wl-brandFooter">Brand Footer</Label>
                    <Input
                      id="wl-brandFooter"
                      placeholder="© 2024 Acme Agency. All rights reserved."
                      value={wlForm.brandFooter}
                      onChange={(e) => setWlForm((f) => ({ ...f, brandFooter: e.target.value }))}
                      disabled={!wlEnabled}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="wl-brandContactEmail">Contact Email</Label>
                    <Input
                      id="wl-brandContactEmail"
                      type="email"
                      placeholder="qa@acme.com"
                      value={wlForm.brandContactEmail}
                      onChange={(e) => setWlForm((f) => ({ ...f, brandContactEmail: e.target.value }))}
                      disabled={!wlEnabled}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="wl-logoUrl">Logo URL</Label>
                    <Input
                      id="wl-logoUrl"
                      type="url"
                      placeholder="https://cdn.example.com/logo.png"
                      value={wlForm.logoUrl}
                      onChange={(e) => setWlForm((f) => ({ ...f, logoUrl: e.target.value }))}
                      disabled={!wlEnabled}
                    />
                  </div>
                </div>

                {wlError && (
                  <div className="flex items-center gap-2 text-sm text-destructive">
                    <AlertCircle className="h-4 w-4" />
                    {wlError}
                  </div>
                )}

                <Separator />

                <div className="flex items-center gap-3">
                  <Button
                    onClick={() => void handleWhiteLabelSave()}
                    disabled={!wlEnabled || wlSaving}
                  >
                    {wlSaving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                    {wlSaved && <CheckCircle2 className="h-4 w-4 mr-2" />}
                    {wlSaved ? 'Saved' : 'Save changes'}
                  </Button>
                  {!wlEnabled && (
                    <span className="text-xs text-muted-foreground">
                      Upgrade your plan to enable white-label branding.
                    </span>
                  )}
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          {/* ── Danger Zone Tab ──────────────────────────────────── */}
          <TabsContent value="danger">
            <Card className="border-destructive/50">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-destructive">
                  <Trash2 className="h-5 w-5" />
                  Danger Zone
                </CardTitle>
                <CardDescription>
                  Irreversible and destructive actions. Proceed with caution.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 p-4 rounded-lg border border-destructive/30 bg-destructive/5">
                  <div className="space-y-1">
                    <div className="font-medium">Delete Workspace</div>
                    <div className="text-sm text-muted-foreground">
                      Permanently delete this workspace, all its projects, runs, findings, and reports.
                      This action cannot be undone.
                    </div>
                  </div>
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button variant="destructive" className="shrink-0">
                        <Trash2 className="h-4 w-4 mr-2" />
                        Delete workspace
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Are you absolutely sure?</AlertDialogTitle>
                        <AlertDialogDescription>
                          This will permanently delete <strong>{workspace?.name}</strong> and all
                          associated data, including projects, scan runs, findings, and reports.
                          This action cannot be undone.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction
                          className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                          onClick={() => {
                            // No actual API call — UI only
                          }}
                        >
                          Yes, delete everything
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </div>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </main>

      <footer className="border-t bg-card mt-auto">
        <div className="mx-auto max-w-6xl px-4 py-4 text-sm text-muted-foreground">
          © {new Date().getFullYear()} ProofPilot. Automated QA, not penetration testing.
        </div>
      </footer>
    </div>
  )
}
